import { describe, expect, it, vi } from "vitest";

import { FIXTURE_LLM_PRICE, recordLlmUsage, recordSyntheticLlmCall } from "../src/metering.js";

function databaseFixture() {
  const builder: {
    returning: ReturnType<typeof vi.fn>;
    onConflictDoNothing: ReturnType<typeof vi.fn>;
  } = {
    returning: vi.fn(),
    onConflictDoNothing: vi.fn()
  };
  builder.returning.mockReturnValue(builder);
  builder.onConflictDoNothing.mockResolvedValue([{ id: "0198a000-0000-7000-8000-000000000002" }]);
  const values = vi.fn((row: Record<string, unknown>) => {
    void row;
    return builder;
  });
  const insert = vi.fn(() => ({ values }));
  return { database: { insert }, insert, values };
}

describe("LLM metering", () => {
  it("writes a synthetic offline LLM event with cost and strict metadata", async () => {
    const fixture = databaseFixture();
    const occurredAt = new Date("2026-08-06T08:00:00.000Z");
    const result = await recordSyntheticLlmCall(
      fixture.database as never,
      "0198a000-0000-7000-8000-000000000001",
      occurredAt
    );

    expect(result.totalTokens).toBe(1_000n);
    expect(result.costMinor).toBe(180n);
    expect(fixture.values).toHaveBeenCalledOnce();
    const row = fixture.values.mock.calls[0]?.[0];
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      tenantId: "0198a000-0000-7000-8000-000000000001",
      metric: "llm_call",
      quantity: 1n,
      occurredAt,
      unitCostMinor: 180n,
      costCurrency: "KES",
      metadata: {
        schemaVersion: 1,
        source: "fixture",
        model: "fixture-haiku",
        priceVersion: "fixture-2026-01",
        inputTokens: "800",
        outputTokens: "200",
        latencyMs: 25
      }
    });
    const metadata = row?.metadata as Record<string, unknown>;
    expect(Object.keys(metadata).sort()).toEqual([
      "costBasis",
      "eventFingerprint",
      "inputMinorPerMillionTokens",
      "inputTokens",
      "latencyMs",
      "model",
      "outputMinorPerMillionTokens",
      "outputTokens",
      "priceCurrency",
      "priceVersion",
      "promptHash",
      "requestId",
      "schemaVersion",
      "source"
    ]);
    expect(metadata.promptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(metadata)).not.toContain("classify a synthetic RFQ");
  });

  it("validates before inserting", async () => {
    const fixture = databaseFixture();
    await expect(
      recordLlmUsage(fixture.database as never, {
        tenantId: "0198a000-0000-7000-8000-000000000001",
        model: "wrong-model",
        prompt: "safe",
        inputTokens: 1n,
        outputTokens: 0n,
        latencyMs: 0,
        occurredAt: new Date(),
        requestId: "request",
        idempotencyKey: "request",
        source: "fixture",
        price: FIXTURE_LLM_PRICE
      })
    ).rejects.toThrow(/price model/);
    expect(fixture.insert).not.toHaveBeenCalled();
  });
});
