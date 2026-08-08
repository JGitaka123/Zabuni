import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEntityId, createTenantRuntime, usageEvents } from "@zabuni/db";
import { applyMigrations } from "@zabuni/db/admin";

import { recordSyntheticLlmCall } from "../src/metering.js";

const adminUrl =
  process.env.DATABASE_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5432/zabuni";
const migratorUrl =
  process.env.MIGRATION_DATABASE_URL ??
  "postgres://zabuni_migrator:zabuni_migrator@localhost:5432/zabuni";
const appUrl = process.env.DATABASE_URL ?? "postgres://zabuni_app:zabuni_app@localhost:5432/zabuni";

const admin = postgres(adminUrl, { onnotice: () => undefined, prepare: false });
const migrator = postgres(migratorUrl, { max: 1, onnotice: () => undefined, prepare: false });
const runtime = createTenantRuntime(appUrl);
const tenantA = createEntityId();
const tenantB = createEntityId();

beforeAll(async () => {
  await migrator`SET ROLE zabuni_owner`;
  await applyMigrations(migrator);
  await admin`
    INSERT INTO tenants (id, legal_name, plan, status)
    VALUES (${tenantA}, 'Meter Tenant A', 'foundation', 'active'),
           (${tenantB}, 'Meter Tenant B', 'foundation', 'active')
    ON CONFLICT (id) DO NOTHING
  `;
}, 30_000);

afterAll(async () => {
  await admin`DELETE FROM tenants WHERE id IN (${tenantA}, ${tenantB})`;
  await runtime.close();
  await migrator.end();
  await admin.end();
}, 30_000);

describe("tenant LLM metering", () => {
  it("records one offline event, deduplicates retries, and remains tenant isolated", async () => {
    const occurredAt = new Date("2026-08-06T08:00:00.000Z");
    const idempotencyKey = "fixture-metering-proof";
    const first = await runtime.run(tenantA, (database) =>
      recordSyntheticLlmCall(database, tenantA, occurredAt, idempotencyKey)
    );
    const retry = await runtime.run(tenantA, (database) =>
      recordSyntheticLlmCall(database, tenantA, occurredAt, idempotencyKey)
    );

    expect(first).toMatchObject({ costCurrency: "KES", costMinor: 180n, deduplicated: false });
    expect(retry).toMatchObject({ eventId: first.eventId, deduplicated: true });
    await expect(
      runtime.run(tenantA, (database) =>
        recordSyntheticLlmCall(
          database,
          tenantA,
          new Date("2026-08-06T08:00:01.000Z"),
          idempotencyKey
        )
      )
    ).rejects.toThrow("idempotency key was reused");
    await runtime.run(tenantA, async (database) => {
      const rows = await database
        .select()
        .from(usageEvents)
        .where(eq(usageEvents.id, first.eventId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ metric: "llm_call", quantity: 1n, unitCostMinor: 180n });
    });
    await expect(
      runtime.run(tenantA, (database) =>
        database
          .update(usageEvents)
          .set({ unitCostMinor: 0n })
          .where(eq(usageEvents.id, first.eventId))
      )
    ).rejects.toMatchObject({ cause: { code: "42501" } });
    await runtime.run(tenantB, async (database) => {
      await expect(
        database.select().from(usageEvents).where(eq(usageEvents.id, first.eventId))
      ).resolves.toEqual([]);
    });
    const tenantBEvent = await runtime.run(tenantB, (database) =>
      recordSyntheticLlmCall(database, tenantB, occurredAt, idempotencyKey)
    );
    expect(tenantBEvent.deduplicated).toBe(false);
    expect(tenantBEvent.eventId).not.toBe(first.eventId);
    await expect(
      runtime.run(tenantA, (database) =>
        database.delete(usageEvents).where(eq(usageEvents.id, first.eventId))
      )
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });
});
