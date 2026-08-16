import { appendFileSync } from "node:fs";

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
 * Constructs only a transport that can actually deliver in the selected mode.
 * Sandbox/live intentionally fail at boot until an approved provider adapter is
 * supplied; accepting traffic with a transport that rejects every send makes
 * the whole product look healthy while sign-in is impossible.
 */
export function createConfiguredOtpTransport(
  config: Pick<ApiConfig, "fixtureOtpMailbox" | "useFixtures">
): OtpTransport {
  if (!config.useFixtures) throw new OtpDeliveryConfigurationError();

  return new FixtureOtpTransport((delivery) => {
    appendFileSync(
      config.fixtureOtpMailbox,
      `${JSON.stringify({ ...delivery, sentAt: new Date().toISOString() })}\n`,
      "utf8"
    );
  });
}
