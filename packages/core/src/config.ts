/**
 * Fail-closed service configuration.
 *
 * Every value a service needs from the environment is parsed and validated here,
 * once, at startup. A misconfigured service refuses to boot rather than starting
 * in a degraded state — a fixture OTP transport that silently swallows every SMS
 * is indistinguishable from a working one until a real customer cannot sign in.
 *
 * Error messages name the offending variable and never echo its value, so a
 * failed boot is safe to paste into an incident channel.
 */

export type IntegrationMode = "fixture" | "sandbox" | "live";
export type RuntimeEnvironment = "development" | "test" | "production";

const INTEGRATION_MODES: readonly IntegrationMode[] = ["fixture", "sandbox", "live"];
const RUNTIME_ENVIRONMENTS: readonly RuntimeEnvironment[] = ["development", "test", "production"];

/** Secrets that exist in committed files. Real deployments must not reuse them. */
const KNOWN_PLACEHOLDER_SECRETS: readonly string[] = [
  "replace-with-at-least-32-random-characters",
  "ci-only-secret-that-is-at-least-32-characters"
];

const MINIMUM_SECRET_LENGTH = 32;

export type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export interface CommonConfig {
  readonly environment: RuntimeEnvironment;
  readonly integrationMode: IntegrationMode;
  /** True only when fixture transports are permitted. */
  readonly useFixtures: boolean;
}

export interface ApiConfig extends CommonConfig {
  readonly port: number;
  readonly databaseUrl: string;
  readonly authDatabaseUrl: string;
  readonly authSecret: string;
  readonly apiOrigin: string;
  readonly webOrigin: string;
  readonly sentryDsn: string | undefined;
  /**
   * Where fixture OTP deliveries are appended so a local tester can read the
   * code back. Meaningful only when `useFixtures` is true.
   */
  readonly fixtureOtpMailbox: string;
  /**
   * Forwarded-for style header to trust for the client address when the API runs
   * behind a proxy. Unset means trust nothing and use the socket address, since
   * a spoofed header would let a caller pick its own rate-limit bucket.
   */
  readonly trustedProxyIpHeader: string | undefined;
}

export interface WorkerConfig extends CommonConfig {
  readonly workerDatabaseUrl: string;
  readonly workerId: string;
  readonly pollIntervalMs: number;
  readonly idlePollIntervalMs: number;
  readonly leaseSeconds: number;
  readonly shutdownGraceMs: number;
  readonly sentryDsn: string | undefined;
}

/** Aggregates every problem so one boot attempt reports the whole list. */
export class ConfigurationError extends Error {
  public readonly problems: readonly string[];

  public constructor(problems: readonly string[]) {
    super(`Invalid service configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigurationError";
    this.problems = problems;
  }
}

class Collector {
  readonly #problems: string[] = [];

  public add(problem: string): void {
    this.#problems.push(problem);
  }

  public get problems(): readonly string[] {
    return this.#problems;
  }

  public throwIfFailed(): void {
    if (this.#problems.length > 0) throw new ConfigurationError(this.#problems);
  }
}

function readEnum<Value extends string>(
  collector: Collector,
  source: EnvironmentSource,
  name: string,
  allowed: readonly Value[],
  fallback: Value
): Value {
  const raw = source[name];
  if (raw === undefined || raw === "") return fallback;
  const match = allowed.find((candidate) => candidate === raw);
  if (match === undefined) {
    collector.add(`${name} must be one of ${allowed.join(", ")}`);
    return fallback;
  }
  return match;
}

function readRequired(collector: Collector, source: EnvironmentSource, name: string): string {
  const raw = source[name];
  if (raw === undefined || raw.trim() === "") {
    collector.add(`${name} is required`);
    return "";
  }
  return raw;
}

function readPostgresUrl(collector: Collector, source: EnvironmentSource, name: string): string {
  const raw = readRequired(collector, source, name);
  if (raw === "") return raw;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    collector.add(`${name} must be a valid URL`);
    return raw;
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    collector.add(`${name} must use the postgres:// or postgresql:// scheme`);
  }
  return raw;
}

function readHttpOrigin(
  collector: Collector,
  source: EnvironmentSource,
  name: string,
  fallback: string,
  requireHttps: boolean
): string {
  const raw = source[name] ?? fallback;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    collector.add(`${name} must be a valid absolute URL`);
    return raw;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    collector.add(`${name} must use http:// or https://`);
    return raw;
  }
  if (requireHttps && parsed.protocol !== "https:") {
    collector.add(`${name} must use https:// in production`);
  }
  return raw;
}

function readInteger(
  collector: Collector,
  source: EnvironmentSource,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = source[name];
  if (raw === undefined || raw === "") return fallback;
  // Number() rather than parseInt: "3001abc" must fail rather than silently become 3001.
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    collector.add(`${name} must be an integer between ${String(minimum)} and ${String(maximum)}`);
    return fallback;
  }
  return value;
}

function parseCommon(collector: Collector, source: EnvironmentSource): CommonConfig {
  const environment = readEnum(collector, source, "NODE_ENV", RUNTIME_ENVIRONMENTS, "development");
  const integrationMode = readEnum(
    collector,
    source,
    "INTEGRATION_MODE",
    INTEGRATION_MODES,
    "fixture"
  );

  // The core safety rule: recorded fixtures must never face real users. Sandbox
  // stays legal in production so a staging deploy can run against vendor sandboxes.
  if (environment === "production" && integrationMode === "fixture") {
    collector.add(
      "INTEGRATION_MODE must not be fixture when NODE_ENV is production; " +
        "fixture transports accept every send and deliver nothing"
    );
  }

  return { environment, integrationMode, useFixtures: integrationMode === "fixture" };
}

function readAuthSecret(
  collector: Collector,
  source: EnvironmentSource,
  environment: RuntimeEnvironment
): string {
  const secret = readRequired(collector, source, "BETTER_AUTH_SECRET");
  if (secret === "") return secret;
  if (secret.length < MINIMUM_SECRET_LENGTH) {
    collector.add(
      `BETTER_AUTH_SECRET must be at least ${String(MINIMUM_SECRET_LENGTH)} characters`
    );
  }
  if (environment === "production" && KNOWN_PLACEHOLDER_SECRETS.includes(secret)) {
    collector.add("BETTER_AUTH_SECRET must not reuse a committed placeholder value in production");
  }
  return secret;
}

function optional(source: EnvironmentSource, name: string): string | undefined {
  const raw = source[name];
  return raw === undefined || raw.trim() === "" ? undefined : raw;
}

/** Sentry DSNs require an HTTPS endpoint, public key, and numeric project id. */
export function isValidSentryDsn(value: string): boolean {
  // Keep this aligned with @sentry/core 9.46's DSN parser: keys/passwords use
  // `\w`, hosts use [\w.-], ports are numeric, and the raw final path segment
  // is the numeric project id. The anchored form also rejects a trailing slash,
  // query, or fragment that the SDK would otherwise parse into an invalid id.
  const match = /^https:\/\/\w+(?::\w*)?@[\w.-]+(?::\d+)?\/(.+)$/u.exec(value);
  if (match === null) return false;
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    return false;
  }
  if (endpoint.port !== "") {
    const port = Number(endpoint.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return false;
  }
  const lastPath = match[1];
  const projectId = lastPath?.split("/").at(-1);
  return projectId !== undefined && /^\d+$/u.test(projectId);
}

function readSentryDsn(
  collector: Collector,
  source: EnvironmentSource,
  environment: RuntimeEnvironment
): string | undefined {
  const dsn = optional(source, "SENTRY_DSN");
  if (dsn === undefined) {
    if (environment === "production") collector.add("SENTRY_DSN is required in production");
    return undefined;
  }
  if (!isValidSentryDsn(dsn)) {
    collector.add("SENTRY_DSN must be a valid HTTPS Sentry DSN");
  }
  return dsn;
}

/**
 * The worker id is both a database claim owner and a telemetry correlation id,
 * so it must satisfy the stricter of the two: the telemetry-safe label charset.
 */
function readWorkerId(collector: Collector, source: EnvironmentSource): string {
  const raw = optional(source, "WORKER_ID");
  if (raw === undefined) return `worker-${String(process.pid)}`;
  if (!/^[a-zA-Z0-9._-]{1,100}$/u.test(raw)) {
    collector.add(
      "WORKER_ID must be 1 to 100 characters of letters, digits, dot, underscore, or hyphen"
    );
  }
  return raw;
}

export function loadApiConfig(source: EnvironmentSource = process.env): ApiConfig {
  const collector = new Collector();
  const common = parseCommon(collector, source);
  const production = common.environment === "production";
  const port = readInteger(collector, source, "PORT", 3001, 1, 65_535);

  const config: ApiConfig = {
    ...common,
    port,
    databaseUrl: readPostgresUrl(collector, source, "DATABASE_URL"),
    authDatabaseUrl: readPostgresUrl(collector, source, "DATABASE_AUTH_URL"),
    authSecret: readAuthSecret(collector, source, common.environment),
    apiOrigin: readHttpOrigin(
      collector,
      source,
      "BETTER_AUTH_URL",
      `http://localhost:${String(port)}`,
      production
    ),
    webOrigin: readHttpOrigin(collector, source, "WEB_ORIGIN", "http://localhost:3000", production),
    sentryDsn: readSentryDsn(collector, source, common.environment),
    fixtureOtpMailbox: optional(source, "FIXTURE_OTP_MAILBOX") ?? "fixture-otp.jsonl",
    trustedProxyIpHeader: optional(source, "TRUSTED_PROXY_IP_HEADER")?.toLowerCase()
  };

  collector.throwIfFailed();
  return config;
}

export function loadWorkerConfig(source: EnvironmentSource = process.env): WorkerConfig {
  const collector = new Collector();
  const common = parseCommon(collector, source);

  const pollIntervalMs = readInteger(
    collector,
    source,
    "WORKER_POLL_INTERVAL_MS",
    1_000,
    50,
    60_000
  );
  const idlePollIntervalMs = readInteger(
    collector,
    source,
    "WORKER_IDLE_POLL_INTERVAL_MS",
    5_000,
    50,
    300_000
  );
  const leaseSeconds = readInteger(collector, source, "WORKER_LEASE_SECONDS", 60, 5, 3_600);
  const shutdownGraceMs = readInteger(
    collector,
    source,
    "WORKER_SHUTDOWN_GRACE_MS",
    15_000,
    100,
    120_000
  );

  // A lease shorter than the poll interval expires before the next attempt can
  // renew it, so another worker reclaims work that is still in flight.
  if (leaseSeconds * 1_000 <= pollIntervalMs) {
    collector.add("WORKER_LEASE_SECONDS must exceed WORKER_POLL_INTERVAL_MS");
  }

  const config: WorkerConfig = {
    ...common,
    workerDatabaseUrl: readPostgresUrl(collector, source, "DATABASE_WORKER_URL"),
    workerId: readWorkerId(collector, source),
    pollIntervalMs,
    idlePollIntervalMs,
    leaseSeconds,
    shutdownGraceMs,
    sentryDsn: readSentryDsn(collector, source, common.environment)
  };

  collector.throwIfFailed();
  return config;
}
