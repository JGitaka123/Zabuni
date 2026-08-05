import { describe, expect, it } from "vitest";

import { calculateLlmCost, type LlmPrice } from "../src/cost.js";

const price: LlmPrice = {
  model: "fixture-haiku",
  version: "fixture-v1",
  currency: "kes",
  inputMinorPerMillionTokens: 100_000n,
  outputMinorPerMillionTokens: 500_000n
};

describe("calculateLlmCost", () => {
  it("uses exact bigint arithmetic and half-up minor-unit rounding", () => {
    expect(calculateLlmCost({ inputTokens: 800n, outputTokens: 200n }, price)).toEqual({
      amountMinor: 180n,
      currency: "KES",
      priceVersion: "fixture-v1"
    });
    expect(
      calculateLlmCost(
        { inputTokens: 1n, outputTokens: 0n },
        { ...price, inputMinorPerMillionTokens: 500_000n }
      ).amountMinor
    ).toBe(1n);
  });

  it("retains bigint precision beyond Number.MAX_SAFE_INTEGER", () => {
    expect(
      calculateLlmCost({ inputTokens: 9_007_199_254_740_993n, outputTokens: 0n }, price).amountMinor
    ).toBe(900_719_925_474_099n);
  });

  it("rejects invalid usage and pricing", () => {
    expect(() => calculateLlmCost({ inputTokens: -1n, outputTokens: 0n }, price)).toThrow(
      /inputTokens/
    );
    expect(() =>
      calculateLlmCost({ inputTokens: 1n, outputTokens: 0n }, { ...price, currency: "$" })
    ).toThrow(/ISO-4217/);
    expect(() =>
      calculateLlmCost({ inputTokens: 1n, outputTokens: 0n }, { ...price, version: "" })
    ).toThrow(/version/);
  });
});
