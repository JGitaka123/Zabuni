import { serve } from "@hono/node-server";
import {
  createAuthRuntime,
  createMembershipRuntime,
  FixtureOtpTransport,
  UnconfiguredOtpTransport
} from "@zabuni/auth";
import { FixtureEmbeddingProvider } from "@zabuni/catalog";
import { loadApiConfig } from "@zabuni/core";
import { createTenantRuntime } from "@zabuni/db";
import { createPinoStructuredLogger, initializeNodeSentry } from "@zabuni/observability";

import { createApp } from "./app.js";

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
const otpTransport = config.useFixtures
  ? new FixtureOtpTransport()
  : new UnconfiguredOtpTransport();

const authRuntime = createAuthRuntime(config.authDatabaseUrl, {
  secret: config.authSecret,
  baseURL: config.apiOrigin,
  trustedOrigins: [config.webOrigin],
  otpTransport,
  production: config.environment === "production"
});
const memberships = createMembershipRuntime(config.databaseUrl);
const tenantRuntime = createTenantRuntime(config.databaseUrl);

const server = serve({
  fetch: createApp({
    auth: authRuntime.auth,
    memberships,
    tenants: tenantRuntime,
    ...(embeddingProvider === undefined ? {} : { embeddingProvider }),
    readiness: () => memberships.ping(),
    webOrigin: config.webOrigin,
    telemetry: { logger, errors }
  }).fetch,
  port: config.port
});

logger.info(
  "service_started",
  { correlationId: "startup" },
  { port: config.port, environment: config.environment, integrationMode: config.integrationMode }
);

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
