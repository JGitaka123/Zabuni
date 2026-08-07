import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEntityId, createTenantRuntime, items } from "@zabuni/db";
import { applyMigrations } from "@zabuni/db/admin";

import { FixtureEmbeddingProvider, normalizeMatchText } from "../src/embedding.js";
import { TenantCatalogMatcher } from "../src/matching.js";
import {
  acquireCatalogMatchConcurrency,
  CatalogRateLimitError,
  consumeCatalogRequestRate
} from "../src/rate-limit.js";

const adminUrl =
  process.env.DATABASE_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5432/zabuni";
const appUrl = process.env.DATABASE_URL ?? "postgres://zabuni_app:zabuni_app@localhost:5432/zabuni";
const migratorUrl =
  process.env.MIGRATION_DATABASE_URL ??
  "postgres://zabuni_migrator:zabuni_migrator@localhost:5432/zabuni";

const admin = postgres(adminUrl, { onnotice: () => undefined, prepare: false });
const migrator = postgres(migratorUrl, { max: 1, onnotice: () => undefined, prepare: false });
const runtime = createTenantRuntime(appUrl);
const tenantId = createEntityId();
const userId = createEntityId();
const handWashFive = createEntityId();
const handWashSmall = createEntityId();
const inactiveGloves = createEntityId();
const tieItemA = createEntityId();
const tieItemB = createEntityId();
const provider = new FixtureEmbeddingProvider();

beforeAll(async () => {
  await migrator`SET ROLE zabuni_owner`;
  await applyMigrations(migrator);
  await admin`
    INSERT INTO tenants (id, legal_name, plan, status)
    VALUES (${tenantId}, 'Matcher Fixture Tenant', 'foundation', 'active')
  `;
  await admin`
    INSERT INTO users (id, tenant_id, email, name, role)
    VALUES (${userId}, ${tenantId}, ${`matcher-${userId}@example.test`}, 'Matcher Owner', 'owner')
  `;
  await admin.begin(async (transaction) => {
    await transaction`
      INSERT INTO items (id, tenant_id, sku, description, brand, pack_size, uom, tax_class, active)
      VALUES
        (${handWashFive}, ${tenantId}, 'HW-5L', 'Antibacterial hand soap', 'Safuney', '5 litres', 'jerrican', 'standard_16', true),
        (${handWashSmall}, ${tenantId}, 'HW-500', 'Antibacterial hand soap', 'Safuney', '500 ml', 'bottle', 'standard_16', true),
        (${inactiveGloves}, ${tenantId}, 'GL-INACTIVE', 'Nitrile gloves', NULL, '100 pc', 'box', 'standard_16', false),
        (${tieItemA}, ${tenantId}, 'TIE-A', 'Generic tied item', NULL, NULL, NULL, 'standard_16', true),
        (${tieItemB}, ${tenantId}, 'TIE-B', 'Generic tied item', NULL, NULL, NULL, 'standard_16', true)
    `;
    for (const itemId of [handWashFive, handWashSmall, inactiveGloves, tieItemA, tieItemB]) {
      await transaction`
        INSERT INTO catalog_tax_classifications (
          id, tenant_id, item_id, tax_class, source, basis_note, classified_by_user_id
        ) VALUES (
          ${createEntityId()}, ${tenantId}, ${itemId}, 'standard_16',
          'manual_create', 'Matcher fixture classification', ${userId}
        )
      `;
    }
  });
});

afterAll(async () => {
  await admin`DELETE FROM tenants WHERE id = ${tenantId}`;
  await runtime.close();
  await migrator.end();
  await admin.end();
});

describe("tenant catalog hybrid matcher", () => {
  it("refreshes embeddings idempotently and excludes inactive items", async () => {
    await runtime.run(tenantId, async (database) => {
      const matcher = new TenantCatalogMatcher(database, tenantId);
      await expect(matcher.refreshItemEmbedding(handWashFive, provider)).resolves.toBe("refreshed");
      await expect(matcher.refreshItemEmbedding(handWashFive, provider)).resolves.toBe("unchanged");
      await expect(matcher.refreshItemEmbedding(handWashSmall, provider)).resolves.toBe(
        "refreshed"
      );
      await expect(matcher.refreshItemEmbedding(inactiveGloves, provider)).resolves.toBe(
        "unchanged"
      );

      const result = await matcher.match("antibacterial hand wash 5 litres jerrican", {
        provider
      });
      expect(result.candidates[0]).toMatchObject({
        itemId: handWashFive,
        sku: "HW-5L",
        method: "hybrid",
        degraded: false,
        score: { pack: 1, unit: 1 }
      });
      expect(result.candidates.map(({ itemId }) => itemId)).not.toContain(inactiveGloves);
    });
  });

  it("learns only explicit aliases and records confirmed use", async () => {
    await runtime.run(tenantId, async (database) => {
      const matcher = new TenantCatalogMatcher(database, tenantId);
      const alias = await matcher.addAlias({
        itemId: handWashFive,
        aliasText: "pink soap 5 litres",
        source: "human"
      });
      expect(alias).toMatchObject({ itemId: handWashFive, hitCount: 0, lastUsedAt: null });

      const result = await matcher.match("pink soap 5l", { provider });
      expect(result.candidates[0]).toMatchObject({ itemId: handWashFive, method: "alias" });
      expect((await matcher.listAliases(handWashFive))[0]?.hitCount).toBe(0);

      const confirmed = await matcher.confirmMatch("pink soap 5 litres", handWashFive);
      expect(confirmed.hitCount).toBe(1);
      expect(confirmed.lastUsedAt).toBeInstanceOf(Date);
    });
  });

  it("requires explicit alias reassignment and detects stale embeddings", async () => {
    await runtime.run(tenantId, async (database) => {
      const matcher = new TenantCatalogMatcher(database, tenantId);
      await expect(
        matcher.addAlias({
          itemId: handWashSmall,
          aliasText: "pink soap 5l",
          source: "human"
        })
      ).rejects.toThrow("already assigned");
      await expect(
        matcher.addAlias({
          itemId: handWashSmall,
          aliasText: "pink soap 5l",
          source: "human",
          reassign: true
        })
      ).resolves.toMatchObject({ itemId: handWashSmall, hitCount: 0, lastUsedAt: null });

      await database
        .update(items)
        .set({ description: "Changed after embedding" })
        .where(eq(items.id, handWashSmall));
      const result = await matcher.match("changed after embedding 500ml bottle", { provider });
      const candidate = result.candidates.find(({ itemId }) => itemId === handWashSmall);
      expect(candidate).toMatchObject({ degraded: true, score: { vector: null } });
      expect(candidate?.reasons).toContain("compatible current embedding unavailable");
      await database
        .update(items)
        .set({ description: "Antibacterial hand soap" })
        .where(eq(items.id, handWashSmall));
    });
  });

  it("serializes concurrent first-use alias confirmations without losing usage", async () => {
    const aliasText = `concurrent soap ${createEntityId()}`;
    const confirmations = await Promise.all([
      runtime.run(tenantId, (database) =>
        new TenantCatalogMatcher(database, tenantId).confirmMatch(aliasText, handWashFive)
      ),
      runtime.run(tenantId, (database) =>
        new TenantCatalogMatcher(database, tenantId).confirmMatch(aliasText, handWashFive)
      )
    ]);
    expect(
      confirmations.map(({ hitCount }) => hitCount).sort((left, right) => left - right)
    ).toEqual([1, 2]);
    await runtime.run(tenantId, async (database) => {
      const aliases = await new TenantCatalogMatcher(database, tenantId).listAliases(handWashFive, {
        limit: 100
      });
      expect(
        aliases.find(({ aliasText: value }) => value === normalizeMatchText(aliasText))?.hitCount
      ).toBe(2);
    });
  });

  it("excludes incompatible vectors and applies deterministic lexical tie-breaking", async () => {
    const incompatibleProvider = {
      descriptor: {
        provider: "fixture",
        model: "different-model",
        version: "1",
        dimensions: 1_024
      },
      embed: (text: string) => provider.embed(text)
    };
    await runtime.run(tenantId, async (database) => {
      const matcher = new TenantCatalogMatcher(database, tenantId);
      const incompatible = await matcher.match("antibacterial hand soap", {
        provider: incompatibleProvider
      });
      expect(incompatible.candidates[0]).toMatchObject({ degraded: true, score: { vector: null } });

      const lexical = await matcher.match("antibacterial hand soap");
      const repeated = await matcher.match("antibacterial hand soap");
      expect(lexical.candidates.slice(0, 2).map(({ sku }) => sku)).toEqual(
        repeated.candidates.slice(0, 2).map(({ sku }) => sku)
      );
      expect(lexical.candidates).toHaveLength(2);

      const tied = await matcher.match("generic tied item");
      expect(tied.candidates.slice(0, 2).map(({ sku }) => sku)).toEqual(["TIE-A", "TIE-B"]);

      const unitConflict = await matcher.match("antibacterial hand soap 500 ml jerrican");
      expect(unitConflict.candidates.find(({ itemId }) => itemId === handWashSmall)?.score).toEqual(
        expect.objectContaining({ pack: 1, unit: -1 })
      );
    });
  });

  it("enforces shared request windows and two cross-connection match slots", async () => {
    const rateUserId = createEntityId();
    for (let request = 0; request < 30; request += 1) {
      await runtime.run(tenantId, (database) =>
        consumeCatalogRequestRate(database, tenantId, rateUserId, "match")
      );
    }
    await expect(
      runtime.run(tenantId, (database) =>
        consumeCatalogRequestRate(database, tenantId, rateUserId, "match")
      )
    ).rejects.toBeInstanceOf(CatalogRateLimitError);
    await admin`
      UPDATE catalog_match_rate_limits
      SET window_started_at = CURRENT_TIMESTAMP - INTERVAL '61 seconds'
      WHERE key = ${`${tenantId}:match:user:${rateUserId}`}
    `;
    await expect(
      runtime.run(tenantId, (database) =>
        consumeCatalogRequestRate(database, tenantId, rateUserId, "match")
      )
    ).resolves.toBeUndefined();

    const concurrencyUserId = createEntityId();
    let ready = 0;
    let signalReady: (() => void) | undefined;
    let release: (() => void) | undefined;
    const bothReady = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = () =>
      runtime.run(tenantId, async (database) => {
        await acquireCatalogMatchConcurrency(database, tenantId, concurrencyUserId);
        ready += 1;
        if (ready === 2) signalReady?.();
        await hold;
      });
    const holders = [holder(), holder()];
    await bothReady;
    await expect(
      runtime.run(tenantId, (database) =>
        acquireCatalogMatchConcurrency(database, tenantId, concurrencyUserId)
      )
    ).rejects.toBeInstanceOf(CatalogRateLimitError);
    release?.();
    await Promise.all(holders);

    ready = 0;
    const tenantUsers = Array.from({ length: 4 }, () => createEntityId());
    let signalTenantReady: (() => void) | undefined;
    let releaseTenant: (() => void) | undefined;
    const tenantReady = new Promise<void>((resolve) => {
      signalTenantReady = resolve;
    });
    const holdTenant = new Promise<void>((resolve) => {
      releaseTenant = resolve;
    });
    const tenantHolders = tenantUsers.map((tenantUserId) =>
      runtime.run(tenantId, async (database) => {
        await acquireCatalogMatchConcurrency(database, tenantId, tenantUserId);
        ready += 1;
        if (ready === tenantUsers.length) signalTenantReady?.();
        await holdTenant;
      })
    );
    await tenantReady;
    await expect(
      runtime.run(tenantId, (database) =>
        acquireCatalogMatchConcurrency(database, tenantId, createEntityId())
      )
    ).rejects.toBeInstanceOf(CatalogRateLimitError);
    releaseTenant?.();
    await Promise.all(tenantHolders);
  }, 20_000);

  it("keeps existing aliases confirmable at the atomic tenant cap", async () => {
    const existingAlias = "pink soap 5l";
    await admin`
      UPDATE catalog_alias_quotas
      SET alias_count = 10000
      WHERE tenant_id = ${tenantId}
    `;
    await runtime.run(tenantId, async (database) => {
      const matcher = new TenantCatalogMatcher(database, tenantId);
      await expect(matcher.confirmMatch(existingAlias, handWashSmall)).resolves.toMatchObject({
        itemId: handWashSmall,
        hitCount: 1
      });
    });
    await expect(
      runtime.run(tenantId, (database) =>
        new TenantCatalogMatcher(database, tenantId).addAlias({
          itemId: handWashFive,
          aliasText: "one alias beyond the cap",
          source: "human"
        })
      )
    ).rejects.toThrow("Tenant alias limit reached");
  });
});
