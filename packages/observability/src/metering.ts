import { createHash } from "node:crypto";

import { createEntityId, isUuidV7, usageEvents, type TenantDatabase } from "@zabuni/db";
import { redactText } from "@zabuni/core";
import { and, eq, sql } from "drizzle-orm";

import { calculateLlmCost, type LlmPrice, type LlmTokenUsage } from "./cost.js";

export interface RecordLlmUsageInput extends LlmTokenUsage {
  readonly tenantId: string;
  readonly model: string;
  readonly prompt: string;
  readonly latencyMs: number;
  readonly occurredAt: Date;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly source: "fixture" | "anthropic";
  readonly price: LlmPrice;
}

export interface RecordedLlmUsage {
  readonly eventId: string;
  readonly totalTokens: bigint;
  readonly costMinor: bigint;
  readonly costCurrency: string;
  readonly deduplicated: boolean;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function nonblank(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${name} must not be blank`);
  return normalized;
}

function safeIdentifier(value: string, name: string): string {
  const normalized = nonblank(value, name);
  if (normalized.length > 128 || !/^[a-zA-Z0-9._:-]+$/.test(normalized)) {
    throw new Error(`${name} must be a telemetry-safe identifier`);
  }
  if (redactText(normalized) !== normalized) throw new Error(`${name} must not contain PII`);
  return normalized;
}

export async function recordLlmUsage(
  database: TenantDatabase,
  input: RecordLlmUsageInput
): Promise<RecordedLlmUsage> {
  const model = safeIdentifier(input.model, "model");
  const requestId = safeIdentifier(input.requestId, "requestId");
  const idempotencyKey = safeIdentifier(input.idempotencyKey, "idempotencyKey");
  const priceVersion = safeIdentifier(input.price.version, "price version");
  const latencyMs = positiveSafeInteger(input.latencyMs, "latencyMs");
  if (!isUuidV7(input.tenantId)) throw new Error("tenantId must be a UUIDv7");
  if (input.price.model !== model) throw new Error("price model must match the metered model");
  if (Number.isNaN(input.occurredAt.getTime())) throw new Error("occurredAt must be a valid date");

  const totalTokens = input.inputTokens + input.outputTokens;
  if (totalTokens <= 0n) throw new RangeError("an LLM usage event must contain at least one token");
  const cost = calculateLlmCost(input, input.price);
  const eventId = createEntityId();
  const promptHash = createHash("sha256").update(input.prompt).digest("hex");
  const eventFingerprint = createHash("sha256")
    .update(
      [
        input.tenantId,
        model,
        promptHash,
        input.inputTokens.toString(),
        input.outputTokens.toString(),
        String(latencyMs),
        input.occurredAt.toISOString(),
        requestId,
        input.source,
        priceVersion,
        input.price.inputMinorPerMillionTokens.toString(),
        input.price.outputMinorPerMillionTokens.toString(),
        cost.currency
      ].join("\u001f")
    )
    .digest("hex");
  const metadata = {
    schemaVersion: 1,
    source: input.source,
    model,
    priceVersion,
    inputMinorPerMillionTokens: input.price.inputMinorPerMillionTokens.toString(),
    outputMinorPerMillionTokens: input.price.outputMinorPerMillionTokens.toString(),
    priceCurrency: cost.currency,
    costBasis: "total_event",
    promptHash,
    eventFingerprint,
    inputTokens: input.inputTokens.toString(),
    outputTokens: input.outputTokens.toString(),
    latencyMs,
    requestId
  } as const;

  const insert = database
    .insert(usageEvents)
    .values({
      id: eventId,
      tenantId: input.tenantId,
      metric: "llm_call",
      quantity: 1n,
      occurredAt: input.occurredAt,
      unitCostMinor: cost.amountMinor,
      costCurrency: cost.currency,
      idempotencyKey,
      metadata
    })
    .returning({ id: usageEvents.id });
  const inserted = await insert.onConflictDoNothing({
    target: [usageEvents.tenantId, usageEvents.idempotencyKey],
    where: sql`${usageEvents.idempotencyKey} IS NOT NULL`
  });

  if (inserted.length === 0) {
    const [existing] = await database
      .select({
        id: usageEvents.id,
        costMinor: usageEvents.unitCostMinor,
        costCurrency: usageEvents.costCurrency,
        metadata: usageEvents.metadata
      })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.tenantId, input.tenantId),
          eq(usageEvents.idempotencyKey, idempotencyKey)
        )
      );
    if (existing === undefined) throw new Error("deduplicated usage event could not be read");
    if (existing.metadata.eventFingerprint !== eventFingerprint) {
      throw new Error("idempotency key was reused with different LLM usage data");
    }
    return {
      eventId: existing.id,
      totalTokens,
      costMinor: existing.costMinor,
      costCurrency: existing.costCurrency,
      deduplicated: true
    };
  }

  return {
    eventId,
    totalTokens,
    costMinor: cost.amountMinor,
    costCurrency: cost.currency,
    deduplicated: false
  };
}

export const FIXTURE_LLM_PRICE: LlmPrice = {
  model: "fixture-haiku",
  version: "fixture-2026-01",
  currency: "KES",
  inputMinorPerMillionTokens: 100_000n,
  outputMinorPerMillionTokens: 500_000n
};

/** A deterministic, network-free call used to prove the complete metering path. */
export async function recordSyntheticLlmCall(
  database: TenantDatabase,
  tenantId: string,
  occurredAt: Date = new Date(),
  idempotencyKey = `fixture-${createEntityId()}`
): Promise<RecordedLlmUsage> {
  return recordLlmUsage(database, {
    tenantId,
    model: FIXTURE_LLM_PRICE.model,
    prompt: "fixture: classify a synthetic RFQ",
    inputTokens: 800n,
    outputTokens: 200n,
    latencyMs: 25,
    occurredAt,
    requestId: idempotencyKey,
    idempotencyKey,
    source: "fixture",
    price: FIXTURE_LLM_PRICE
  });
}
