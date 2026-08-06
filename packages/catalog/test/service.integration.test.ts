import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { catalogImportRows, createEntityId, createTenantRuntime, items } from "@zabuni/db";
import { applyMigrations } from "@zabuni/db/admin";

import {
  parseCsv,
  previewImport,
  serializeCatalogItem,
  TenantCatalogService,
  validateCatalogInput
} from "../src/index.js";

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
const userA = createEntityId();

beforeAll(async () => {
  await migrator`SET ROLE zabuni_owner`;
  await applyMigrations(migrator);
  await admin`
    INSERT INTO tenants (id, legal_name, plan, status)
    VALUES (${tenantA}, 'Catalog Tenant A', 'foundation', 'active'),
           (${tenantB}, 'Catalog Tenant B', 'foundation', 'active')
  `;
  await admin`
    INSERT INTO users (id, tenant_id, email, name, role)
    VALUES (${userA}, ${tenantA}, 'catalog-owner@example.test', 'Catalog Owner', 'owner')
  `;
});

afterAll(async () => {
  await admin`DELETE FROM tenants WHERE id IN (${tenantA}, ${tenantB})`;
  await runtime.close();
  await migrator.end();
  await admin.end();
});

describe("tenant catalog persistence", () => {
  it("enforces case-insensitive SKU uniqueness in the database", async () => {
    await runtime.run(tenantA, async (database) => {
      const catalog = new TenantCatalogService(database, tenantA);
      await catalog.create(
        validateCatalogInput({
          sku: "CAT-CASE-1",
          description: "Case fixture",
          taxClass: "exempt",
          active: true
        })
      );
    });
    await expect(
      runtime.run(tenantA, async (database) => {
        const catalog = new TenantCatalogService(database, tenantA);
        return catalog.create(
          validateCatalogInput({
            sku: "cat-case-1",
            description: "Case collision",
            taxClass: "exempt",
            active: true
          })
        );
      })
    ).rejects.toThrow();
  });

  it("creates, serializes, lists, updates, and archives an explicitly classified item", async () => {
    const created = await runtime.run(tenantA, async (database) => {
      const catalog = new TenantCatalogService(database, tenantA);
      return catalog.create(
        validateCatalogInput({
          sku: "CAT-CRUD-1",
          description: "Catalog fixture",
          costMinor: "9007199254740993",
          costCurrency: "KES",
          taxClass: "standard_16",
          active: true
        })
      );
    });
    expect(serializeCatalogItem(created).costMinor).toBe("9007199254740993");

    await runtime.run(tenantA, async (database) => {
      const catalog = new TenantCatalogService(database, tenantA);
      const updated = await catalog.update(
        created.id,
        validateCatalogInput({
          sku: "CAT-CRUD-1",
          description: "Catalog fixture updated",
          taxClass: "standard_16",
          active: true
        })
      );
      expect(updated?.description).toBe("Catalog fixture updated");
      await expect(catalog.archive(created.id)).resolves.toBe(true);
      const rows = await catalog.list();
      expect(rows.find((row) => row.id === created.id)?.active).toBe(false);
    });

    await runtime.run(tenantB, async (database) => {
      await expect(database.select().from(items).where(eq(items.id, created.id))).resolves.toEqual(
        []
      );
    });
  });

  it("stages missing tax without creating an item and remains tenant isolated", async () => {
    const preview = previewImport(
      parseCsv(Buffer.from("sku,description,tax\nCAT-STAGE-1,Needs classification,\n")),
      { sku: "sku", description: "description", taxClass: "tax" }
    );
    const staged = await runtime.run(tenantA, async (database) => {
      const catalog = new TenantCatalogService(database, tenantA);
      return catalog.stageImport("unclassified.csv", preview, userA);
    });
    await expect(
      runtime.run(tenantA, async (database) => {
        const catalog = new TenantCatalogService(database, tenantA);
        return catalog.commitStagedImport(staged.id);
      })
    ).rejects.toThrow(/invalid or unclassified/u);
    await runtime.run(tenantB, async (database) => {
      await expect(
        database.select().from(catalogImportRows).where(eq(catalogImportRows.importId, staged.id))
      ).resolves.toEqual([]);
    });
    await runtime.run(tenantA, async (database) => {
      const rows = await database.select().from(items).where(eq(items.sku, "CAT-STAGE-1"));
      expect(rows).toEqual([]);
    });
  });

  it("commits a fully valid staged import and rejects an existing SKU without overwriting", async () => {
    const preview = previewImport(
      parseCsv(
        Buffer.from(
          "sku,description,cost,currency,tax\nCAT-IMPORT-1,Imported fixture,123456,KES,exempt\n"
        )
      ),
      {
        sku: "sku",
        description: "description",
        costMinor: "cost",
        costCurrency: "currency",
        taxClass: "tax"
      }
    );
    const staged = await runtime.run(tenantA, async (database) => {
      const catalog = new TenantCatalogService(database, tenantA);
      return catalog.stageImport("valid.xlsx", preview, userA);
    });
    const committed = await runtime.run(tenantA, async (database) => {
      const catalog = new TenantCatalogService(database, tenantA);
      return catalog.commitStagedImport(staged.id);
    });
    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({
      sku: "CAT-IMPORT-1",
      taxClass: "exempt",
      costMinor: 123456n
    });

    const duplicate = await runtime.run(tenantA, async (database) => {
      const catalog = new TenantCatalogService(database, tenantA);
      return catalog.stageImport("duplicate.csv", preview, userA);
    });
    await expect(
      runtime.run(tenantA, async (database) => {
        const catalog = new TenantCatalogService(database, tenantA);
        return catalog.commitStagedImport(duplicate.id);
      })
    ).rejects.toThrow("SKU already exists");
    await runtime.run(tenantA, async (database) => {
      const [original] = await database.select().from(items).where(eq(items.sku, "CAT-IMPORT-1"));
      expect(original?.description).toBe("Imported fixture");
      expect(original?.costMinor).toBe(123456n);
    });
  });

  it("serializes concurrent commits so exactly one transaction can finalize an import", async () => {
    const preview = previewImport(
      parseCsv(Buffer.from("sku,description,tax\nCAT-RACE-1,Race fixture,exempt\n")),
      { sku: "sku", description: "description", taxClass: "tax" }
    );
    const staged = await runtime.run(tenantA, async (database) => {
      const catalog = new TenantCatalogService(database, tenantA);
      return catalog.stageImport("race.csv", preview, userA);
    });
    const outcomes = await Promise.allSettled([
      runtime.run(tenantA, async (database) => {
        const catalog = new TenantCatalogService(database, tenantA);
        return catalog.commitStagedImport(staged.id);
      }),
      runtime.run(tenantA, async (database) => {
        const catalog = new TenantCatalogService(database, tenantA);
        return catalog.commitStagedImport(staged.id);
      })
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
  });
});
