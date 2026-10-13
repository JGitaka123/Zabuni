import { appendFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FixtureOtpTransport, type OtpTransport } from "@zabuni/auth";
import type { ApiConfig } from "@zabuni/core";

export class OtpDeliveryConfigurationError extends Error {
  constructor() {
    super(
      "Email OTP delivery is not configured for this integration mode; refusing to start the API"
    );
    this.name = "OtpDeliveryConfigurationError";
  }
}

/**
 * Anchors a relative mailbox path to the repository root rather than the
 * process's working directory.
 *
 * `pnpm --filter @zabuni/api start` runs with the cwd set to apps/api, so the
 * documented `fixture-otp.jsonl` landed there instead of beside the README,
 * where the handover guide tells a tester to read it -- which made the very
 * first step of signing in locally fail, and collapsed the acceptance suite to
 * 24/113 on a clean checkout. An absolute FIXTURE_OTP_MAILBOX is honoured as
 * given.
 */
export function resolveFixtureMailboxPath(configured: string): string {
  if (isAbsolute(configured)) return configured;
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(resolve(directory, "pnpm-workspace.yaml"))) {
      return resolve(directory, configured);
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return resolve(process.cwd(), configured);
}

/**
 * Constructs only a transport that can actually deliver in the selected mode.
 * Sandbox/live intentionally fail at boot until an approved provider adapter is
 * supplied; accepting traffic with a transport that rejects every send makes
 * the whole product look healthy while sign-in is impossible.
 */
export function createConfiguredOtpTransport(
  config: Pick<ApiConfig, "fixtureOtpMailbox" | "useFixtures">
): OtpTransport {
  if (!config.useFixtures) throw new OtpDeliveryConfigurationError();

  const mailboxPath = resolveFixtureMailboxPath(config.fixtureOtpMailbox);
  return new FixtureOtpTransport((delivery) => {
    appendFileSync(
      mailboxPath,
      `${JSON.stringify({ ...delivery, sentAt: new Date().toISOString() })}\n`,
      "utf8"
    );
  });
}
