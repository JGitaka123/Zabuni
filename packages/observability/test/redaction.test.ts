import { describe, expect, it } from "vitest";

import {
  CIRCULAR_VALUE,
  REDACTED_VALUE,
  TRUNCATED_VALUE,
  sanitizeTelemetry
} from "../src/redaction.js";

describe("sanitizeTelemetry", () => {
  it("redacts sensitive keys and PII embedded in strings", () => {
    expect(
      sanitizeTelemetry({
        phoneNumber: "+254 712 345 678",
        email: "owner@example.test",
        note: "Call 0712345678 for PIN A123456789Z",
        context: "preserved",
        nested: { authorization: "Bearer secret", ok: true }
      })
    ).toEqual({
      phoneNumber: REDACTED_VALUE,
      email: REDACTED_VALUE,
      note: "Call [REDACTED_PHONE] for PIN [REDACTED_KRA_PIN]",
      context: "preserved",
      nested: { authorization: REDACTED_VALUE, ok: true }
    });
  });

  it("breaks cycles and bounds depth and string length", () => {
    const cyclic: { self?: unknown; deep: unknown; values: number[]; label: string } = {
      deep: { child: { hidden: true } },
      values: [1, 2, 3],
      label: "abcdefgh"
    };
    cyclic.self = cyclic;

    expect(sanitizeTelemetry(cyclic, { maxDepth: 2, maxEntries: 20, maxStringLength: 4 })).toEqual({
      deep: { redacted_field_0: TRUNCATED_VALUE },
      redacted_field_1: [1, 2, 3],
      redacted_field_2: `abcd${TRUNCATED_VALUE}`,
      self: CIRCULAR_VALUE
    });
  });

  it("enforces a global entry budget", () => {
    expect(sanitizeTelemetry([1, 2, 3], { maxEntries: 2 })).toEqual([1, 2, TRUNCATED_VALUE]);
  });

  it("does not leak PII placed in an object key", () => {
    expect(sanitizeTelemetry({ "+254712345678": "value" })).toEqual({
      redacted_field_0: "value"
    });
  });

  it("renders cycles when they occur within the entry limit", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(sanitizeTelemetry(cyclic)).toEqual({ self: CIRCULAR_VALUE });
  });

  it("validates resource limits", () => {
    expect(() => sanitizeTelemetry({}, { maxDepth: 0 })).toThrow(/maxDepth/);
  });
});
