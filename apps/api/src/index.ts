import { serve } from "@hono/node-server";
import { createAuthRuntime, createMembershipRuntime } from "@zabuni/auth";
import { FixtureEmbeddingProvider } from "@zabuni/catalog";
import { loadApiConfig } from "@zabuni/core";
import { createTenantRuntime } from "@zabuni/db";
import {
  createPinoStructuredLogger,
  initializeNodeSentry,
  installFatalHandlers
} from "@zabuni/observability";

import { createApp } from "./app.js";
import { createConfiguredOtpTransport } from "./otp-transport.js";

// Fail closed: an invalid environment aborts the boot before anything listens.
// In particular this refuses to start production with fixture transports, which
// accept every OTP send and deliver nothing.
const config = loadApiConfig();

const logger = createPinoStructuredLogger({ service: "api", environment: config.environment });
const errors = initializeNodeSentry({
  environment: config.environment,
  integrationMode: config.integrationMode === "live" ? "live" : "fixture",
  ...(config.sentryDsn === undefined ? {} : { dsn: config.sentryDsn })
});

const embeddingProvider = config.useFixtures ? new FixtureEmbeddingProvider() : undefined;
// Email codes are stored hashed, so a local tester cannot recover one from the
// database. In fixture mode only, deliveries are appended to a file mailbox so
// sign-in is completable without an email provider. Production cannot reach
// this branch: loadApiConfig refuses to boot production in fixture mode.
const otpTransport = createConfiguredOtpTransport(config);

const authRuntime = createAuthRuntime(config.authDatabaseUrl, {
  secret: config.authSecret,
  baseURL: config.apiOrigin,
  trustedOrigins: [config.webOrigin],
  otpTransport,
  production: config.environment === "production"
});
const memberships = createMembershipRuntime(config.databaseUrl);
const tenantRuntime = createTenantRuntime(config.databaseUrl);

const server = serve(
  {
    fetch: createApp({
      auth: authRuntime.auth,
      memberships,
      tenants: tenantRuntime,
      ...(embeddingProvider === undefined ? {} : { embeddingProvider }),
      readiness: () => memberships.ping(),
      ...(config.trustedProxyIpHeader === undefined
        ? {}
        : { trustedProxyIpHeader: config.trustedProxyIpHeader }),
      webOrigin: config.webOrigin,
      telemetry: { logger, errors }
    }).fetch,
    port: config.port
  },
  // Reported from the listening callback, not straight after serve(): binding is
  // asynchronous, so logging early claims the service is up before it can accept
  // a connection -- and still claims it when the bind then fails.
  (info) => {
    logger.info(
      "service_started",
      { correlationId: "startup" },
      {
        port: info.port,
        environment: config.environment,
        integrationMode: config.integrationMode
      }
    );
  }
);

// A bind failure (port in use, privileged port) arrives as an 'error' event. Left
// unhandled it terminates the process with a raw stack that reaches neither
// Sentry nor the log stream.
server.on("error", (error: NodeJS.ErrnoException) => {
  errors.capture(error, { correlationId: "startup" });
  logger.error(
    "service_listen_failed",
    { correlationId: "startup" },
    { port: config.port, code: error.code ?? "unknown" }
  );
  process.exitCode = 1;
  server.close();
});

installFatalHandlers({
  logger,
  errors,
  correlationId: "api",
  onFatal: () => {
    server.close();
  }
});

const SHUTDOWN_GRACE_MS = 15_000;
let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("service_shutdown_requested", { correlationId: "shutdown" }, { signal });

  // Backstop: a hung in-flight request must not block the deploy forever.
  const forceExit = setTimeout(() => {
    logger.error(
      "service_shutdown_timed_out",
      { correlationId: "shutdown" },
      {
        graceMs: SHUTDOWN_GRACE_MS
      }
    );
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  forceExit.unref();

  // Stop accepting connections first, then release pools once in-flight
  // requests have drained, so no request loses its database mid-flight.
  server.close(() => {
    void Promise.allSettled([authRuntime.close(), memberships.close(), tenantRuntime.close()]).then(
      () => {
        logger.info("service_stopped", { correlationId: "shutdown" }, { signal });
        process.exitCode = 0;
      }
    );
  });
}

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  shutdown("SIGINT");
});
