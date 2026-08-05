import { describe, expect, it } from "vitest";

import {
  REDACTED_KRA_PIN,
  REDACTED_MESSAGE,
  REDACTED_OTP,
  REDACTED_PHONE,
  redactSensitive,
  redactText,
} from "../src/redact.js";

describe("redaction", () => {
  it("scrubs Kenyan phone formats, KRA PINs, and contextual OTPs in text", () => {
    const input =
      "Call +254 712 345 678, 0712-345-678 or 254712345678. KRA A123456789Z. OTP is 123456.";
    const output = redactText(input);

    expect(output).not.toContain("712 345 678");
    expect(output).not.toContain("A123456789Z");
    expect(output).not.toContain("123456");
    expect(output.match(/\[REDACTED_PHONE\]/g)).toHaveLength(3);
    expect(output).toContain(REDACTED_KRA_PIN);
    expect(output).toContain(`OTP is ${REDACTED_OTP}`);
  });

  it("does not redact unrelated identifiers or short numbers", () => {
    expect(redactText("invoice 123456 and codebase A1234567890Z")).toBe(
      "invoice 123456 and codebase A1234567890Z",
    );
  });

  it("scrubs fixed-line phones and broad provider body keys", () => {
    expect(redactText("Office: +254 20 1234567 or 020-1234567")).toBe(
      `Office: ${REDACTED_PHONE} or ${REDACTED_PHONE}`,
    );
    const output = redactSensitive({
      body: "private body",
      content: "private content",
      rawBody: "private raw body",
      recipient_phone: "+254201234567",
      nested: { text: "private provider text" },
    });
    expect(JSON.stringify(output)).not.toContain("private");
  });

  it("recursively scrubs sensitive structured keys and arbitrary text", () => {
    const input = {
      phone_number: "+254712345678",
      profile: {
        kraPin: "A123456789Z",
        verification_code: 123_456,
        harmless: "reach me at 0712345678",
      },
      events: [{ messageBody: "private customer text" }],
    };

    expect(redactSensitive(input)).toEqual({
      phone_number: REDACTED_PHONE,
      profile: {
        kraPin: REDACTED_KRA_PIN,
        verification_code: REDACTED_OTP,
        harmless: `reach me at ${REDACTED_PHONE}`,
      },
      events: [{ messageBody: REDACTED_MESSAGE }],
    });
    expect(input.phone_number).toBe("+254712345678");
  });

  it("preserves primitives and dates while safely retaining circular structure", () => {
    const date = new Date("2026-08-05T00:00:00Z");
    const input: { value: number; date: Date; self?: unknown } = { value: 42, date };
    input.self = input;

    const output = redactSensitive(input) as typeof input;
    expect(output).not.toBe(input);
    expect(output.value).toBe(42);
    expect(output.date).toEqual(date);
    expect(output.date).not.toBe(date);
    expect(output.self).toBe(output);
    expect(redactSensitive(null)).toBeNull();
  });
});
