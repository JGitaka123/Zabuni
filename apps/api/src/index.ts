import { serve } from "@hono/node-server";
import {
  createAuthRuntime,
  createMembershipRuntime,
  FixtureOtpTransport,
  UnconfiguredOtpTransport
} from "@zabuni/auth";
import { createTenantRuntime } from "@zabuni/db";

import { createApp } from "./app.js";

const port = Number.parseInt(process.env.PORT ?? "3001", 10);
const databaseUrl = process.env.DATABASE_URL;
const authDatabaseUrl = process.env.DATABASE_AUTH_URL;
const authSecret = process.env.BETTER_AUTH_SECRET;
const apiOrigin = process.env.BETTER_AUTH_URL ?? `http://localhost:${String(port)}`;
const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
if (databaseUrl === undefined || authDatabaseUrl === undefined || authSecret === undefined) {
  throw new Error("DATABASE_URL, DATABASE_AUTH_URL, and BETTER_AUTH_SECRET are required");
}

const integrationMode = process.env.INTEGRATION_MODE ?? "fixture";
const otpTransport =
  integrationMode === "fixture" ? new FixtureOtpTransport() : new UnconfiguredOtpTransport();
const authRuntime = createAuthRuntime(authDatabaseUrl, {
  secret: authSecret,
  baseURL: apiOrigin,
  trustedOrigins: [webOrigin],
  otpTransport,
  production: process.env.NODE_ENV === "production"
});
const memberships = createMembershipRuntime(databaseUrl);
const tenantRuntime = createTenantRuntime(databaseUrl);

serve({
  fetch: createApp({ auth: authRuntime.auth, memberships, tenants: tenantRuntime, webOrigin })
    .fetch,
  port
});
