import { createHash } from "node:crypto";

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
import { emailOTP, phoneNumber } from "better-auth/plugins";

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

function temporaryPhoneEmail(phone: string): string {
  const digest = createHash("sha256").update(phone).digest("hex");
  return `${digest}@phone.invalid`;
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
      database: { generateId: () => createEntityId() },
      defaultCookieAttributes: {
        httpOnly: true,
        secure: options.production === true,
        sameSite: "lax",
        path: "/"
      }
    },
    plugins: [
      phoneNumber({
        otpLength: 6,
        expiresIn: FIVE_MINUTES_SECONDS,
        allowedAttempts: 3,
        requireVerification: true,
        phoneNumberValidator: (value) => /^\+[1-9]\d{7,14}$/.test(value),
        sendOTP: ({ phoneNumber: destination, code }) =>
          options.otpTransport.sendPhoneOtp(destination, code),
        signUpOnVerification: {
          getTempEmail: temporaryPhoneEmail,
          getTempName: () => "Zabuni user"
        }
      }),
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
  readonly close: () => Promise<void>;
}

export function createAuthRuntime(
  connectionString: string,
  options: Omit<AuthServerOptions, "database">
): AuthRuntime {
  const connection = createDatabase(connectionString);
  return {
    auth: createAuthServer({ ...options, database: connection.db }),
    close: () => connection.client.end()
  };
}
