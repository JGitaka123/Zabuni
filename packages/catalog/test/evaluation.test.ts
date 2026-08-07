import { describe, expect, it } from "vitest";

import { evaluateTopOne } from "../src/evaluation.js";
import { MATCHER_VERSION, type CatalogMatchResult } from "../src/matching.js";

function result(sku: string | null): CatalogMatchResult {
  return {
    normalizedQuery: "fixture",
    matcherVersion: MATCHER_VERSION,
    embedding: null,
    candidates:
      sku === null
        ? []
        : [
            {
              itemId: "0197f000-0000-7000-8000-000000000001",
              sku,
              description: "Fixture",
              method: "lexical",
              score: { alias: 0, lexical: 1, pack: 0, unit: 0, vector: null, final: 0.25 },
              degraded: true,
              reasons: ["compatible current embedding unavailable"]
            }
          ]
  };
}

describe("held-out matcher evaluation", () => {
  it("reports top-1 accuracy, failures, and reproducibility checksums", async () => {
    const cases = [
      { query: "hand wash", expectedSku: "HW-1" },
      { query: "gloves", expectedSku: "GL-1" },
      { query: "masks", expectedSku: "MK-1" },
      { query: "bleach", expectedSku: "BL-1" },
      { query: "tissue", expectedSku: "TS-1" }
    ];
    const report = await evaluateTopOne({
      cases,
      catalogIdentity: cases.map(({ expectedSku }) => ({
        sku: expectedSku,
        contentHash: `hash-${expectedSku}`
      })),
      match: (query) =>
        Promise.resolve(
          result(
            query === "tissue"
              ? "WRONG"
              : (cases.find((row) => row.query === query)?.expectedSku ?? null)
          )
        )
    });
    expect(report).toMatchObject({
      correct: 4,
      total: 5,
      top1Accuracy: 0.8,
      passesEightyPercent: true,
      matcherVersion: MATCHER_VERSION
    });
    expect(report.failures).toEqual([{ query: "tissue", expectedSku: "TS-1", actualSku: "WRONG" }]);
    expect(report.datasetChecksum).toMatch(/^[0-9a-f]{64}$/u);
    expect(report.catalogChecksum).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects an empty acceptance dataset", async () => {
    await expect(
      evaluateTopOne({ cases: [], catalogIdentity: [], match: () => Promise.resolve(result(null)) })
    ).rejects.toThrow("must not be empty");
  });
});
