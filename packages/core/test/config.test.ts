import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  loadApiConfig,
  loadWorkerConfig,
  type EnvironmentSource
} from "../src/config.js";

const VALID_SECRET = "0123456789abcdef0123456789abcdef";

const apiEnv: EnvironmentSource = {
  NODE_ENV: "development",
  INTEGRATION_MODE: "fixture",
  DATABASE_URL: "postgres://zabuni_app:zabuni_app@localhost:5432/zabuni",
  DATABASE_AUTH_URL: "postgres://zabuni_auth:zabuni_auth@localhost:5432/zabuni",
  BETTER_AUTH_SECRET: VALID_SECRET
};

const workerEnv: EnvironmentSource = {
  NODE_ENV: "development",
  INTEGRATION_MODE: "fixture",
  DATABASE_WORKER_URL: "postgres://zabuni_worker:zabuni_worker@localhost:5432/zabuni"
};

function problemsOf(load: () => unknown): readonly string[] {
  try {
    load();
  } catch (error) {
    if (error instanceof ConfigurationError) return error.problems;
    throw error;
  }
  throw new Error("Expected a ConfigurationError");
}

describe("loadApiConfig", () => {
  it("accepts a valid development environment", () => {
    const config = loadApiConfig(apiEnv);
    expect(config.environment).toBe("development");
    expect(config.integrationMode).toBe("fixture");
    expect(config.useFixtures).toBe(true);
    expect(config.port).toBe(3001);
    expect(config.apiOrigin).toBe("http://localhost:3001");
    expect(config.webOrigin).toBe("http://localhost:3000");
    expect(config.sentryDsn).toBeUndefined();
  });

  it("refuses to boot production in fixture mode", () => {
    const problems = problemsOf(() =>
      loadApiConfig({
        ...apiEnv,
        NODE_ENV: "production",
        INTEGRATION_MODE: "fixture",
        BETTER_AUTH_URL: "https://api.example.com",
        WEB_ORIGIN: "https://app.example.com"
      })
    );
    expect(
      problems.some((problem) => problem.includes("INTEGRATION_MODE must not be fixture"))
    ).toBe(true);
  });

  it("allows sandbox mode in production for staging deploys", () => {
    const config = loadApiConfig({
      ...apiEnv,
      NODE_ENV: "production",
      INTEGRATION_MODE: "sandbox",
      BETTER_AUTH_SECRET: VALID_SECRET,
      BETTER_AUTH_URL: "https://api.example.com",
      WEB_ORIGIN: "https://app.example.com",
      SENTRY_DSN: "https://public@example.invalid/1"
    });
    expect(config.integrationMode).toBe("sandbox");
    expect(config.useFixtures).toBe(false);
  });

  it("rejects an unrecognised integration mode instead of falling back", () => {
    const problems = problemsOf(() => loadApiConfig({ ...apiEnv, INTEGRATION_MODE: "fixtrue" }));
    expect(problems).toContain("INTEGRATION_MODE must be one of fixture, sandbox, live");
  });

  it("rejects a short auth secret", () => {
    const problems = problemsOf(() =>
      loadApiConfig({ ...apiEnv, BETTER_AUTH_SECRET: "too-short" })
    );
    expect(problems).toContain("BETTER_AUTH_SECRET must be at least 32 characters");
  });

  it("rejects committed placeholder secrets in production", () => {
    const problems = problemsOf(() =>
      loadApiConfig({
        ...apiEnv,
        NODE_ENV: "production",
        INTEGRATION_MODE: "live",
        BETTER_AUTH_SECRET: "replace-with-at-least-32-random-characters",
        BETTER_AUTH_URL: "https://api.example.com",
        WEB_ORIGIN: "https://app.example.com"
      })
    );
    expect(problems).toContain(
      "BETTER_AUTH_SECRET must not reuse a committed placeholder value in production"
    );
  });

  it("permits the placeholder secret outside production", () => {
    const config = loadApiConfig({
      ...apiEnv,
      BETTER_AUTH_SECRET: "replace-with-at-least-32-random-characters"
    });
    expect(config.environment).toBe("development");
  });

  it("requires https origins in production", () => {
    const problems = problemsOf(() =>
      loadApiConfig({
        ...apiEnv,
        NODE_ENV: "production",
        INTEGRATION_MODE: "live",
        BETTER_AUTH_URL: "http://api.example.com",
        WEB_ORIGIN: "http://app.example.com"
      })
    );
    expect(problems).toContain("BETTER_AUTH_URL must use https:// in production");
    expect(problems).toContain("WEB_ORIGIN must use https:// in production");
  });

  it("rejects a non-postgres database url", () => {
    const problems = problemsOf(() =>
      loadApiConfig({ ...apiEnv, DATABASE_URL: "mysql://localhost:3306/zabuni" })
    );
    expect(problems).toContain("DATABASE_URL must use the postgres:// or postgresql:// scheme");
  });

  it("requires an HTTPS Sentry destination in production", () => {
    const missing = problemsOf(() =>
      loadApiConfig({
        ...apiEnv,
        NODE_ENV: "production",
        INTEGRATION_MODE: "live",
        BETTER_AUTH_URL: "https://api.example.com",
        WEB_ORIGIN: "https://app.example.com"
      })
    );
    expect(missing).toContain("SENTRY_DSN is required in production");

    const insecure = problemsOf(() =>
      loadApiConfig({ ...apiEnv, SENTRY_DSN: "http://public@example.invalid/1" })
    );
    expect(insecure).toContain("SENTRY_DSN must be a valid HTTPS Sentry DSN");

    const malformedHttps = problemsOf(() =>
      loadApiConfig({ ...apiEnv, SENTRY_DSN: "https://example.invalid" })
    );
    expect(malformedHttps).toContain("SENTRY_DSN must be a valid HTTPS Sentry DSN");

    const trailingSlash = problemsOf(() =>
      loadApiConfig({ ...apiEnv, SENTRY_DSN: "https://public@example.invalid/1/" })
    );
    expect(trailingSlash).toContain("SENTRY_DSN must be a valid HTTPS Sentry DSN");

    const invalidKey = problemsOf(() =>
      loadApiConfig({ ...apiEnv, SENTRY_DSN: "https://public-key@example.invalid/1" })
    );
    expect(invalidKey).toContain("SENTRY_DSN must be a valid HTTPS Sentry DSN");

    const invalidPort = problemsOf(() =>
      loadApiConfig({ ...apiEnv, SENTRY_DSN: "https://public@example.invalid:99999/1" })
    );
    expect(invalidPort).toContain("SENTRY_DSN must be a valid HTTPS Sentry DSN");
  });

  it("reports every problem in one boot attempt", () => {
    const problems = problemsOf(() =>
      loadApiConfig({ NODE_ENV: "development", INTEGRATION_MODE: "fixture" })
    );
    expect(problems).toContain("DATABASE_URL is required");
    expect(problems).toContain("DATABASE_AUTH_URL is required");
    expect(problems).toContain("BETTER_AUTH_SECRET is required");
  });

  it("never echoes a secret value in the error message", () => {
    const secret = "super-secret-value-that-is-long-enough";
    const problems = problemsOf(() =>
      loadApiConfig({
        ...apiEnv,
        NODE_ENV: "production",
        INTEGRATION_MODE: "fixture",
        BETTER_AUTH_SECRET: secret,
        BETTER_AUTH_URL: "https://api.example.com",
        WEB_ORIGIN: "https://app.example.com"
      })
    );
    expect(problems.join("\n")).not.toContain(secret);
  });

  it("rejects a port that is not fully numeric", () => {
    const problems = problemsOf(() => loadApiConfig({ ...apiEnv, PORT: "3001abc" }));
    expect(problems).toContain("PORT must be an integer between 1 and 65535");
  });
});

describe("loadWorkerConfig", () => {
  it("accepts a valid development environment with defaults", () => {
    const config = loadWorkerConfig(workerEnv);
    expect(config.pollIntervalMs).toBe(1_000);
    expect(config.idlePollIntervalMs).toBe(5_000);
    expect(config.leaseSeconds).toBe(60);
    expect(config.shutdownGraceMs).toBe(15_000);
    expect(config.workerId).toMatch(/^worker-\d+$/u);
  });

  it("honours an explicit worker id", () => {
    expect(loadWorkerConfig({ ...workerEnv, WORKER_ID: "drain-1" }).workerId).toBe("drain-1");
  });

  it("rejects a lease that expires before the next poll", () => {
    const problems = problemsOf(() =>
      loadWorkerConfig({
        ...workerEnv,
        WORKER_LEASE_SECONDS: "5",
        WORKER_POLL_INTERVAL_MS: "10000"
      })
    );
    expect(problems).toContain("WORKER_LEASE_SECONDS must exceed WORKER_POLL_INTERVAL_MS");
  });

  it("refuses to boot production in fixture mode", () => {
    const problems = problemsOf(() =>
      loadWorkerConfig({ ...workerEnv, NODE_ENV: "production", INTEGRATION_MODE: "fixture" })
    );
    expect(
      problems.some((problem) => problem.includes("INTEGRATION_MODE must not be fixture"))
    ).toBe(true);
  });

  it("requires the worker database url", () => {
    const problems = problemsOf(() =>
      loadWorkerConfig({ NODE_ENV: "development", INTEGRATION_MODE: "fixture" })
    );
    expect(problems).toContain("DATABASE_WORKER_URL is required");
  });

  it("requires an HTTPS Sentry destination for a production worker", () => {
    const problems = problemsOf(() =>
      loadWorkerConfig({
        ...workerEnv,
        NODE_ENV: "production",
        INTEGRATION_MODE: "live"
      })
    );
    expect(problems).toContain("SENTRY_DSN is required in production");

    const malformed = problemsOf(() =>
      loadWorkerConfig({ ...workerEnv, SENTRY_DSN: "https://public@example.invalid/not-a-project" })
    );
    expect(malformed).toContain("SENTRY_DSN must be a valid HTTPS Sentry DSN");
  });
});
