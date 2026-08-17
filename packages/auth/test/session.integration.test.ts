import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  authIdentities,
  authMemberships,
  authRateLimits,
  authVerifications,
  createEntityId,
  tenants,
  users
} from "@zabuni/db";
import { applyMigrations, createDatabase } from "@zabuni/db/admin";

import { resolveTenantSession } from "../src/session.js";
import type { OtpTransport } from "../src/otp-transport.js";

const adminUrl =
  process.env.DATABASE_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5432/zabuni";
const appUrl = process.env.DATABASE_URL ?? "postgres://zabuni_app:zabuni_app@localhost:5432/zabuni";
const authUrl =
  process.env.DATABASE_AUTH_URL ?? "postgres://zabuni_auth:zabuni_auth@localhost:5432/zabuni";
const migratorUrl =
  process.env.MIGRATION_DATABASE_URL ??
  "postgres://zabuni_migrator:zabuni_migrator@localhost:5432/zabuni";

const admin = createDatabase(adminUrl, { maxConnections: 1 });
const application = createDatabase(appUrl, { maxConnections: 1 });
const authentication = createDatabase(authUrl, { maxConnections: 1 });
const migrator = createDatabase(migratorUrl, { maxConnections: 1 });

beforeAll(async () => {
  await migrator.client`SET ROLE zabuni_owner`;
  await applyMigrations(migrator.client);
});

afterAll(async () => {
  await Promise.all([
    admin.client.end(),
    application.client.end(),
    authentication.client.end(),
    migrator.client.end()
  ]);
});

describe("authentication expiry and suspension boundaries", () => {
  it("rejects an email OTP after its durable verification window expires", async () => {
    const email = `expired-${createEntityId()}@example.test`;
    const ipSeed = createEntityId().replaceAll("-", "");
    const clientIp = `198.51.${String(Number.parseInt(ipSeed.slice(-4, -2), 16))}.${String(
      Number.parseInt(ipSeed.slice(-2), 16)
    )}`;
    const verificationIdentifier = `sign-in-otp-${email}`;
    let verificationId: string | undefined;
    let deliveredCode: string | undefined;
    const transport: OtpTransport = {
      sendEmailOtp: (recipient, code) => {
        if (recipient === email) deliveredCode = code;
        return Promise.resolve();
      }
    };
    const headers = {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      "x-zabuni-client-ip": clientIp
    };

    try {
      // Better Auth deliberately collapses all IPs to 127.0.0.1 in test mode.
      // Import its server after these overrides so this integration case uses
      // the real IP path without enabling anonymous telemetry or live delivery.
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("TEST", "false");
      vi.stubEnv("BETTER_AUTH_TELEMETRY", "0");
      vi.resetModules();
      const { createAuthServer } = await import("../src/server.js");
      const auth = createAuthServer({
        database: authentication.db,
        secret: "integration-only-secret-that-is-at-least-32-characters",
        baseURL: "http://localhost:3001",
        trustedOrigins: ["http://localhost:3000"],
        otpTransport: transport
      });
      const sent = await auth.handler(
        new Request("http://localhost:3001/auth/email-otp/send-verification-otp", {
          method: "POST",
          headers,
          body: JSON.stringify({ email, type: "sign-in" })
        })
      );
      expect(sent.status).toBe(200);
      expect(deliveredCode).toMatch(/^\d{6}$/u);

      const verificationRows = await admin.db
        .select({ id: authVerifications.id })
        .from(authVerifications)
        .where(eq(authVerifications.identifier, verificationIdentifier));
      expect(verificationRows).toHaveLength(1);
      verificationId = verificationRows[0]?.id;
      expect(verificationId).toBeDefined();
      const expired = await admin.db
        .update(authVerifications)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(authVerifications.id, verificationId ?? ""));
      expect(expired.count).toBe(1);

      const verified = await auth.handler(
        new Request("http://localhost:3001/auth/sign-in/email-otp", {
          method: "POST",
          headers,
          body: JSON.stringify({ email, otp: deliveredCode })
        })
      );
      expect(verified.status).toBeGreaterThanOrEqual(400);
      expect(verified.headers.get("set-cookie")).toBeNull();
    } finally {
      await admin.db.delete(authVerifications).where(eq(authVerifications.identifier, verificationIdentifier));
      await admin.db.delete(authIdentities).where(eq(authIdentities.email, email));
      await admin.db.delete(authRateLimits).where(like(authRateLimits.key, `${clientIp}%`));
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("denies expired sessions and suspended tenant memberships", async () => {
    const identityId = createEntityId();
    const tenantId = createEntityId();
    const userId = createEntityId();
    const membershipId = createEntityId();
    const futureSession = {
      identityId,
      expiresAt: new Date(Date.now() + 60_000)
    };

    try {
      await admin.db.insert(authIdentities).values({
        id: identityId,
        name: "Suspension Fixture",
        email: `suspended-${identityId}@example.test`,
        emailVerified: true
      });
      await admin.db.insert(tenants).values({
        id: tenantId,
        legalName: "Suspension Fixture Ltd",
        plan: "foundation",
        status: "active"
      });
      await admin.db.insert(users).values({
        id: userId,
        tenantId,
        email: `tenant-${identityId}@example.test`,
        name: "Suspension Fixture",
        role: "owner"
      });
      await admin.db.insert(authMemberships).values({
        id: membershipId,
        identityId,
        tenantId,
        userId,
        role: "owner",
        status: "active"
      });

      await expect(resolveTenantSession(application.db, futureSession)).resolves.toMatchObject({
        identityId,
        tenantId,
        userId,
        role: "owner"
      });

      await admin.db
        .update(authMemberships)
        .set({ status: "suspended" })
        .where(eq(authMemberships.id, membershipId));
      await expect(resolveTenantSession(application.db, futureSession)).resolves.toBeNull();

      await admin.db
        .update(authMemberships)
        .set({ status: "active" })
        .where(eq(authMemberships.id, membershipId));
      await admin.db.update(tenants).set({ status: "suspended" }).where(eq(tenants.id, tenantId));
      await expect(resolveTenantSession(application.db, futureSession)).resolves.toBeNull();

      await admin.db.update(tenants).set({ status: "active" }).where(eq(tenants.id, tenantId));
      await expect(
        resolveTenantSession(application.db, {
          identityId,
          expiresAt: new Date(Date.now() - 1)
        })
      ).resolves.toBeNull();
    } finally {
      await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
      await admin.db.delete(authIdentities).where(eq(authIdentities.id, identityId));
    }
  });
});
