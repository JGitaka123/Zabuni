import {
  authAccounts,
  authIdentities,
  authRateLimits,
  authSessions,
  authVerifications,
  createEntityId
} from "@zabuni/db";
import { createDatabase, type Database } from "@zabuni/db/admin";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP } from "better-auth/plugins";
import { sql } from "drizzle-orm";

import type { OtpTransport } from "./otp-transport.js";

const FIVE_MINUTES_SECONDS = 5 * 60;

export interface AuthServerOptions {
  readonly database: Database;
  readonly secret: string;
  readonly baseURL: string;
  readonly trustedOrigins: readonly string[];
  readonly otpTransport: OtpTransport;
  readonly production?: boolean;
}

export function createAuthServer(options: AuthServerOptions) {
  return betterAuth({
    appName: "Zabuni",
    baseURL: options.baseURL,
    basePath: "/auth",
    secret: options.secret,
    trustedOrigins: [...options.trustedOrigins],
    database: drizzleAdapter(options.database, {
      provider: "pg",
      schema: { authAccounts, authIdentities, authSessions, authVerifications, authRateLimits }
    }),
    user: { modelName: "authIdentities" },
    session: {
      modelName: "authSessions",
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false }
    },
    account: { modelName: "authAccounts" },
    verification: { modelName: "authVerifications" },
    emailAndPassword: { enabled: false },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 10,
      storage: "database",
      modelName: "authRateLimits"
    },
    advanced: {
      useSecureCookies: options.production === true,
      cookiePrefix: "zabuni",
      // The API resolves the caller and always sets this header. Reading the
      // default x-forwarded-for instead would mean no header on a direct
      // connection, and Better Auth skips rate limiting when it cannot resolve
      // an address -- which silently disabled every limit configured below.
      ipAddress: { ipAddressHeaders: ["x-zabuni-client-ip"] },
      database: { generateId: () => createEntityId() },
      defaultCookieAttributes: {
        httpOnly: true,
        secure: options.production === true,
        sameSite: "lax",
        path: "/"
      }
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: FIVE_MINUTES_SECONDS,
        allowedAttempts: 3,
        storeOTP: "hashed",
        sendVerificationOTP: ({ email, otp, type }) =>
          options.otpTransport.sendEmailOtp(email, otp, type)
      })
    ]
  });
}

export type AuthServer = ReturnType<typeof createAuthServer>;

export interface AuthRuntime {
  readonly auth: AuthServer;
  /** Round-trips the dedicated authentication pool for readiness probes. */
  readonly ping: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export function createAuthRuntime(
  connectionString: string,
  options: Omit<AuthServerOptions, "database">
): AuthRuntime {
  const connection = createDatabase(connectionString);
  return {
    auth: createAuthServer({ ...options, database: connection.db }),
    ping: async () => {
      await connection.db.execute(sql`SELECT 1`);
    },
    close: () => connection.client.end()
  };
}
