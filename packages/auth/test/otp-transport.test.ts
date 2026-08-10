import { describe, expect, it } from "vitest";

import { FixtureOtpTransport, UnconfiguredOtpTransport } from "../src/index.js";

describe("OTP transports", () => {
  it("captures email deliveries without network access", async () => {
    const transport = new FixtureOtpTransport();

    await transport.sendEmailOtp("owner@example.test", "654321", "sign-in");

    expect(transport.latest("owner@example.test")).toEqual({
      recipient: "owner@example.test",
      code: "654321",
      purpose: "sign-in"
    });

    transport.clear();
    expect(transport.latest("owner@example.test")).toBeUndefined();
  });

  it("returns the most recent code when one address requests several", async () => {
    const transport = new FixtureOtpTransport();

    await transport.sendEmailOtp("owner@example.test", "111111", "sign-in");
    await transport.sendEmailOtp("owner@example.test", "222222", "sign-in");

    expect(transport.latest("owner@example.test")?.code).toBe("222222");
  });

  it("fails closed when a live delivery provider is not configured", async () => {
    const transport = new UnconfiguredOtpTransport();

    await expect(transport.sendEmailOtp("owner@example.test", "123456", "sign-in")).rejects.toThrow(
      "Live email OTP delivery is not configured"
    );
  });
});
