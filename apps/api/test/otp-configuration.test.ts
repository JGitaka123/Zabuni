import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { FixtureOtpTransport } from "@zabuni/auth";
import { describe, expect, it } from "vitest";

import {
  createConfiguredOtpTransport,
  OtpDeliveryConfigurationError
} from "../src/otp-transport.js";

interface ProcessResult {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

function runSandboxEntrypoint(): Promise<ProcessResult> {
  const entrypoint = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
      env: {
        ...process.env,
        NODE_ENV: "development",
        INTEGRATION_MODE: "sandbox",
        DATABASE_URL: "postgres://zabuni_app:unused@127.0.0.1:1/zabuni",
        DATABASE_AUTH_URL: "postgres://zabuni_auth:unused@127.0.0.1:1/zabuni",
        BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
        BETTER_AUTH_URL: "http://127.0.0.1:39999",
        WEB_ORIGIN: "http://127.0.0.1:39998",
        PORT: "39999"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("API entrypoint did not fail closed within 90 seconds"));
    }, 90_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stderr, stdout });
    });
  });
}

describe("API OTP transport configuration", () => {
  it("constructs the offline transport only in fixture mode", () => {
    expect(
      createConfiguredOtpTransport({
        useFixtures: true,
        fixtureOtpMailbox: "fixture-otp.jsonl"
      })
    ).toBeInstanceOf(FixtureOtpTransport);
  });

  it.each(["sandbox", "live"])(
    "refuses to construct the API in %s mode without an approved email provider",
    () => {
      expect(() =>
        createConfiguredOtpTransport({
          useFixtures: false,
          fixtureOtpMailbox: "fixture-otp.jsonl"
        })
      ).toThrow(OtpDeliveryConfigurationError);
    }
  );

  it(
    "exits the real sandbox entrypoint before the API starts listening",
    async () => {
      const result = await runSandboxEntrypoint();
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.code).not.toBe(0);
      expect(output).toContain("OtpDeliveryConfigurationError");
      expect(output).not.toContain("service_started");
    },
    120_000
  );
});
