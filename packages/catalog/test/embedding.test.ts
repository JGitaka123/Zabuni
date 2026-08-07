import { describe, expect, it } from "vitest";

import {
  buildItemSearchText,
  EMBEDDING_DIMENSIONS,
  FixtureEmbeddingProvider,
  normalizeMatchText,
  validateEmbedding
} from "../src/embedding.js";

describe("catalog embedding boundary", () => {
  it("normalizes Kenyan catalog phrasing and equivalent units deterministically", () => {
    expect(normalizeMatchText("  HAND-WASH, 5 Litres  ")).toBe("hand wash 5l");
    expect(normalizeMatchText("Hand wash 5000 millilitres")).toBe("hand wash 5000ml");
    expect(
      buildItemSearchText({
        sku: "ANT-HW-5000",
        description: "Antibacterial Hand Soap",
        brand: "Safuney",
        packSize: "5 litres",
        uom: "Jerrican"
      })
    ).toBe("ant hw 5000 antibacterial hand soap safuney 5l jerrican");
  });

  it("produces stable finite fixture vectors with the required dimension", async () => {
    const provider = new FixtureEmbeddingProvider();
    const first = await provider.embed("hand wash 5l");
    const second = await provider.embed("hand wash 5 litres");
    expect(first).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(second).toEqual(first);
    expect(first.some((value) => value !== 0)).toBe(true);
    expect(first.every(Number.isFinite)).toBe(true);
  });

  it("rejects unsafe text and malformed provider output", () => {
    expect(() => normalizeMatchText("\u0000unsafe")).toThrow("safe characters");
    expect(() => normalizeMatchText(" ")).toThrow("safe characters");
    expect(() => validateEmbedding([1, 2, 3])).toThrow("exactly 1024");
    expect(() =>
      validateEmbedding(Array.from<number>({ length: EMBEDDING_DIMENSIONS }).fill(0))
    ).toThrow("zero vector");
  });
});
