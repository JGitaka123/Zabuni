import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  catalogImportRows,
  catalogImports,
  catalogTaxClassifications,
  createEntityId,
  createTenantRuntime,
  items
} from "@zabuni/db";
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
        }),
        { classifiedByUserId: userA, basisNote: "Case fixture source" }
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
          }),
          { classifiedByUserId: userA, basisNote: "Case collision fixture source" }
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
        }),
        { classifiedByUserId: userA, basisNote: "Catalog fixture source" }
      );
    });
    expect(serializeCatalogItem(created).costMinor).toBe("9007199254740993");

    await runtime.run(tenantA, async (database) => {
      const catalog = new TenantCatalogService(database, tenantA);
      const initialEvents = await database
        .select()
        .from(catalogTaxClassifications)
        .where(eq(catalogTaxClassifications.itemId, created.id));
      expect(initialEvents).toHaveLength(1);
      expect(initialEvents[0]).toMatchObject({ source: "manual_create", taxClass: "standard_16" });
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
      const changedInput = validateCatalogInput({
        sku: "CAT-CRUD-1",
        description: "Catalog fixture updated",
        taxClass: "zero_rated",
        active: true
      });
      await expect(catalog.update(created.id, changedInput)).rejects.toThrow(/user/u);
      await expect(
        catalog.update(created.id, changedInput, {
          classifiedByUserId: userA,
          basisNote: "Reviewed reclassification fixture"
        })
      ).resolves.toMatchObject({ taxClass: "zero_rated" });
      const changedEvents = await database
        .select()
        .from(catalogTaxClassifications)
        .where(eq(catalogTaxClassifications.itemId, created.id));
      expect(changedEvents).toHaveLength(2);
      expect(changedEvents.find((event) => event.source === "manual_change")).toMatchObject({
        source: "manual_change",
        previousTaxClass: "standard_16",
        taxClass: "zero_rated"
      });
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

  it("classifies a staged row explicitly, recounts atomically, audits, and permits commit", async () => {
    const preview = previewImport(
      parseCsv(Buffer.from("sku,description,tax\nCAT-CLASS-1,Classification fixture,\n")),
      { sku: "sku", description: "description", taxClass: "tax" }
    );
    const staged = await runtime.run(tenantA, async (database) => {
      const catalog = new TenantCatalogService(database, tenantA);
      return catalog.stageImport("classification.csv", preview, userA);
    });
    await runtime.run(tenantA, async (database) => {
      const catalog = new TenantCatalogService(database, tenantA);
      const classified = await catalog.classifyStagedRow({
        importId: staged.id,
        rowNumber: 2,
        taxClass: "zero_rated",
        classifiedByUserId: userA,
        basisNote: "Reviewed against the tenant-provided classification record"
      });
      expect(classified).toMatchObject({ taxClass: "zero_rated", validationErrors: [] });
      const [batch] = await database
        .select()
        .from(catalogImports)
        .where(eq(catalogImports.id, staged.id));
      expect(batch).toMatchObject({ validRows: 1, invalidRows: 0 });
      const events = await database
        .select()
        .from(catalogTaxClassifications)
        .where(eq(catalogTaxClassifications.importRowId, classified.id));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        taxClass: "zero_rated",
        source: "import_human",
        classifiedByUserId: userA
      });
    });
    await expect(
      runtime.run(tenantA, async (database) => {
        const catalog = new TenantCatalogService(database, tenantA);
        return catalog.classifyStagedRow({
          importId: staged.id,
          rowNumber: 2,
          taxClass: "exempt",
          classifiedByUserId: userA,
          basisNote: "Attempted second decision"
        });
      })
    ).rejects.toThrow();
    const committed = await runtime.run(tenantA, async (database) => {
      const catalog = new TenantCatalogService(database, tenantA);
      return catalog.commitStagedImport(staged.id);
    });
    expect(committed).toHaveLength(1);
    await runtime.run(tenantA, async (database) => {
      const itemEvents = await database
        .select()
        .from(catalogTaxClassifications)
        .where(eq(catalogTaxClassifications.itemId, committed[0]?.id ?? ""));
      expect(itemEvents).toHaveLength(1);
      expect(itemEvents[0]).toMatchObject({
        source: "import_human",
        taxClass: "zero_rated",
        classifiedByUserId: userA
      });
      expect(itemEvents[0]?.importRowId).not.toBeNull();
    });
  });

  it("allows only one winner when the same staged row is classified concurrently", async () => {
    const preview = previewImport(
      parseCsv(Buffer.from("sku,description,tax\nCAT-CLASS-RACE,Classification race,\n")),
      { sku: "sku", description: "description", taxClass: "tax" }
    );
    const staged = await runtime.run(tenantA, async (database) => {
      const catalog = new TenantCatalogService(database, tenantA);
      return catalog.stageImport("classification-race.csv", preview, userA);
    });
    const classify = (taxClass: "standard_16" | "exempt") =>
      runtime.run(tenantA, async (database) => {
        const catalog = new TenantCatalogService(database, tenantA);
        return catalog.classifyStagedRow({
          importId: staged.id,
          rowNumber: 2,
          taxClass,
          classifiedByUserId: userA,
          basisNote: `Concurrent fixture decision ${taxClass}`
        });
      });
    const outcomes = await Promise.allSettled([classify("standard_16"), classify("exempt")]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
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

  it("reports an already-committed import as not staged rather than missing", async () => {
    const preview = previewImport(
      parseCsv(Buffer.from("sku,description,tax\nCAT-RECOMMIT-1,Recommit fixture,exempt\n")),
      { sku: "sku", description: "description", taxClass: "tax" }
    );
    const staged = await runtime.run(tenantA, async (database) => {
      const catalog = new TenantCatalogService(database, tenantA);
      return catalog.stageImport("recommit.csv", preview, userA);
    });
    await runtime.run(tenantA, async (database) => {
      const catalog = new TenantCatalogService(database, tenantA);
      return catalog.commitStagedImport(staged.id);
    });

    // A committed import is immutable, so the FOR UPDATE lock finds nothing.
    // Reporting that as "not found" made a double-click look like data loss.
    await expect(
      runtime.run(tenantA, async (database) => {
        const catalog = new TenantCatalogService(database, tenantA);
        return catalog.commitStagedImport(staged.id);
      })
    ).rejects.toThrow(/not staged/u);

    // A genuinely absent import still reports as missing.
    await expect(
      runtime.run(tenantA, async (database) => {
        const catalog = new TenantCatalogService(database, tenantA);
        return catalog.commitStagedImport(createEntityId());
      })
    ).rejects.toThrow(/not found/u);
  });
});
