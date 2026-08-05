import { describe, expect, it } from "vitest";

import { FixtureOtpTransport, UnconfiguredOtpTransport } from "../src/index.js";

describe("OTP transports", () => {
  it("captures phone and email deliveries without network access", async () => {
    const transport = new FixtureOtpTransport();

    await transport.sendPhoneOtp("+254700000001", "123456");
    await transport.sendEmailOtp("owner@example.test", "654321", "sign-in");

    expect(transport.latest("phone", "+254700000001")).toEqual({
      channel: "phone",
      recipient: "+254700000001",
      code: "123456"
    });
    expect(transport.latest("email", "owner@example.test")).toEqual({
      channel: "email",
      recipient: "owner@example.test",
      code: "654321",
      purpose: "sign-in"
    });

    transport.clear();
    expect(transport.latest("phone", "+254700000001")).toBeUndefined();
  });

  it("fails closed when a live delivery provider is not configured", async () => {
    const transport = new UnconfiguredOtpTransport();
    await expect(transport.sendPhoneOtp("+254700000001", "123456")).rejects.toThrow(
      "Live SMS OTP delivery is not configured"
    );
    await expect(transport.sendEmailOtp("owner@example.test", "123456", "sign-in")).rejects.toThrow(
      "Live email OTP delivery is not configured"
    );
  });
});
