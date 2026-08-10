import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  catalogImportRows,
  catalogImports,
  catalogTaxClassifications,
  createEntityId,
  isUuidV7,
  items,
  type TaxClass,
  type TenantDatabase
} from "@zabuni/db";
import {
  classifyCatalogImportRow,
  reclassifyCatalogItem,
  recordTaxClassification
} from "@zabuni/db/privileged/catalog-tax";

import type { CatalogInput, ImportPreview } from "./types.js";

export type CatalogItem = typeof items.$inferSelect;
export type CatalogImport = typeof catalogImports.$inferSelect;
export type CatalogImportRow = typeof catalogImportRows.$inferSelect;
export interface TaxClassificationDecision {
  readonly classifiedByUserId: string;
  readonly basisNote: string;
}
export type SerializedCatalogItem = Omit<CatalogItem, "costMinor" | "createdAt"> & {
  readonly costMinor: string | null;
  readonly createdAt: string;
};

export function serializeCatalogItem(item: CatalogItem): SerializedCatalogItem {
  return {
    ...item,
    costMinor: item.costMinor?.toString() ?? null,
    createdAt: item.createdAt.toISOString()
  };
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    if ((character.codePointAt(0) ?? 0) < 32) return true;
  }
  return false;
}

function persistenceValues(input: CatalogInput) {
  return {
    sku: input.sku,
    description: input.description,
    brand: input.brand ?? null,
    packSize: input.packSize ?? null,
    uom: input.uom ?? null,
    costMinor: input.costMinor === undefined ? null : BigInt(input.costMinor),
    costCurrency: input.costCurrency ?? null,
    fxBufferBps: input.fxBufferBps ?? null,
    taxClass: input.taxClass,
    kraItemCode: input.kraItemCode ?? null,
    hsCode: input.hsCode ?? null,
    leadTimeDays: input.leadTimeDays ?? null,
    minMarginBps: input.minMarginBps ?? null,
    active: input.active
  };
}

function mutableNonTaxValues(input: CatalogInput) {
  const values = persistenceValues(input);
  return {
    sku: values.sku,
    description: values.description,
    brand: values.brand,
    packSize: values.packSize,
    uom: values.uom,
    costMinor: values.costMinor,
    costCurrency: values.costCurrency,
    fxBufferBps: values.fxBufferBps,
    kraItemCode: values.kraItemCode,
    hsCode: values.hsCode,
    leadTimeDays: values.leadTimeDays,
    minMarginBps: values.minMarginBps,
    active: values.active
  };
}

function validatedDecision(decision: TaxClassificationDecision): TaxClassificationDecision {
  if (!isUuidV7(decision.classifiedByUserId)) {
    throw new Error("Tax classification user must be a verified UUIDv7");
  }
  const basisNote = decision.basisNote.trim();
  if (basisNote === "" || basisNote.length > 1_000 || hasControlCharacter(basisNote)) {
    throw new Error("Tax classification basis note must contain 1 to 1000 safe characters");
  }
  return { classifiedByUserId: decision.classifiedByUserId, basisNote };
}

/**
 * Catalog persistence bound to an already tenant-scoped transaction. Every
 * statement also includes the tenant key so neither RLS nor application
 * filtering is treated as a substitute for the other.
 */
export class TenantCatalogService {
  readonly #database: TenantDatabase;
  readonly #tenantId: string;

  constructor(database: TenantDatabase, verifiedTenantId: string) {
    if (!isUuidV7(verifiedTenantId)) throw new Error("Catalog tenant must be a verified UUIDv7");
    this.#database = database;
    this.#tenantId = verifiedTenantId;
  }

  async list(): Promise<readonly CatalogItem[]> {
    return this.#database
      .select()
      .from(items)
      .where(eq(items.tenantId, this.#tenantId))
      .orderBy(asc(items.sku));
  }

  async get(itemId: string): Promise<CatalogItem | undefined> {
    const [item] = await this.#database
      .select()
      .from(items)
      .where(and(eq(items.tenantId, this.#tenantId), eq(items.id, itemId)))
      .limit(1);
    return item;
  }

  async create(
    input: CatalogInput,
    classification: TaxClassificationDecision
  ): Promise<CatalogItem> {
    const decision = validatedDecision(classification);
    const [created] = await this.#database
      .insert(items)
      .values({ id: createEntityId(), tenantId: this.#tenantId, ...persistenceValues(input) })
      .returning();
    if (created === undefined) throw new Error("Catalog item insert returned no row");
    await recordTaxClassification(this.#database, {
      eventId: createEntityId(),
      itemId: created.id,
      taxClass: created.taxClass,
      source: "manual_create",
      basisNote: decision.basisNote,
      userId: decision.classifiedByUserId
    });
    return created;
  }

  async update(
    itemId: string,
    input: CatalogInput,
    classification?: TaxClassificationDecision
  ): Promise<CatalogItem | undefined> {
    const [existing] = await this.#database
      .select()
      .from(items)
      .where(and(eq(items.tenantId, this.#tenantId), eq(items.id, itemId)))
      .for("update")
      .limit(1);
    if (existing === undefined) return undefined;
    const taxChanged = existing.taxClass !== input.taxClass;
    const decision = taxChanged
      ? validatedDecision(
          classification ?? {
            classifiedByUserId: "",
            basisNote: ""
          }
        )
      : undefined;
    if (taxChanged && decision !== undefined) {
      await reclassifyCatalogItem(this.#database, {
        eventId: createEntityId(),
        itemId,
        taxClass: input.taxClass,
        basisNote: decision.basisNote,
        userId: decision.classifiedByUserId
      });
    }
    const [updated] = await this.#database
      .update(items)
      .set(mutableNonTaxValues(input))
      .where(and(eq(items.tenantId, this.#tenantId), eq(items.id, itemId)))
      .returning();
    return updated;
  }

  async archive(itemId: string): Promise<boolean> {
    const archived = await this.#database
      .update(items)
      .set({ active: false })
      .where(and(eq(items.tenantId, this.#tenantId), eq(items.id, itemId)))
      .returning({ id: items.id });
    return archived.length === 1;
  }

  async reclassifyItem(
    itemId: string,
    taxClass: TaxClass,
    classification: TaxClassificationDecision
  ): Promise<CatalogItem | undefined> {
    const decision = validatedDecision(classification);
    const existing = await this.get(itemId);
    if (existing === undefined) return undefined;
    if (existing.taxClass === taxClass) {
      throw new Error("Catalog item tax class is unchanged");
    }
    await reclassifyCatalogItem(this.#database, {
      eventId: createEntityId(),
      itemId,
      taxClass,
      basisNote: decision.basisNote,
      userId: decision.classifiedByUserId
    });
    return this.get(itemId);
  }

  async stageImport(
    sourceFilename: string,
    preview: ImportPreview,
    createdByUserId: string
  ): Promise<CatalogImport> {
    if (
      sourceFilename.trim() === "" ||
      sourceFilename.length > 255 ||
      hasControlCharacter(sourceFilename)
    ) {
      throw new Error("Catalog import filename is invalid");
    }
    if (!isUuidV7(createdByUserId)) {
      throw new Error("Catalog import user must be a verified UUIDv7");
    }
    const importId = createEntityId();
    const invalidRows = preview.stagedCount + preview.rejectedCount;
    const [catalogImport] = await this.#database
      .insert(catalogImports)
      .values({
        id: importId,
        tenantId: this.#tenantId,
        sourceFilename: sourceFilename.trim(),
        columnMapping: Object.fromEntries(
          Object.entries(preview.mapping).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string"
          )
        ),
        totalRows: preview.rows.length,
        validRows: preview.validCount,
        invalidRows,
        createdByUserId
      })
      .returning();
    if (catalogImport === undefined) throw new Error("Catalog import insert returned no row");

    if (preview.rows.length > 0) {
      const stagedValues = preview.rows.map((row) => {
        const validationErrors =
          row.kind === "valid"
            ? []
            : row.issues.map((problem) => `${problem.code}:${problem.field ?? "row"}`);
        const value = row.kind === "rejected" ? undefined : row.value;
        return {
          id: createEntityId(),
          tenantId: this.#tenantId,
          importId,
          rowNumber: row.rowNumber,
          rawData: { ...row.source },
          sku: value?.sku ?? null,
          description: value?.description ?? null,
          brand: value?.brand ?? null,
          packSize: value?.packSize ?? null,
          uom: value?.uom ?? null,
          costMinor: value?.costMinor === undefined ? null : BigInt(value.costMinor),
          costCurrency: value?.costCurrency ?? null,
          fxBufferBps: value?.fxBufferBps ?? null,
          taxClass: row.kind === "valid" ? row.value.taxClass : null,
          kraItemCode: value?.kraItemCode ?? null,
          hsCode: value?.hsCode ?? null,
          leadTimeDays: value?.leadTimeDays ?? null,
          minMarginBps: value?.minMarginBps ?? null,
          active: value?.active ?? null,
          validationErrors
        };
      });
      await this.#database.insert(catalogImportRows).values(stagedValues);
      const fileClassifications = stagedValues.filter(
        (row): row is typeof row & { taxClass: TaxClass } => row.taxClass !== null
      );
      if (fileClassifications.length > 0) {
        for (const row of fileClassifications) {
          await recordTaxClassification(this.#database, {
            eventId: createEntityId(),
            importRowId: row.id,
            taxClass: row.taxClass,
            source: "import_file",
            basisNote: `Explicit value from mapped tax column in ${sourceFilename.trim()}`,
            userId: createdByUserId
          });
        }
      }
    }
    return catalogImport;
  }

  async classifyStagedRow(input: {
    readonly importId: string;
    readonly rowNumber: number;
    readonly taxClass: TaxClass;
    readonly classifiedByUserId: string;
    readonly basisNote: string;
  }): Promise<CatalogImportRow> {
    if (!isUuidV7(input.importId) || !isUuidV7(input.classifiedByUserId)) {
      throw new Error("Tax classification identifiers must be verified UUIDv7 values");
    }
    const decision = validatedDecision({
      classifiedByUserId: input.classifiedByUserId,
      basisNote: input.basisNote
    });
    if (!Number.isSafeInteger(input.rowNumber) || input.rowNumber <= 0) {
      throw new Error("Catalog import row number is invalid");
    }
    if (!(["standard_16", "zero_rated", "exempt"] as const).includes(input.taxClass)) {
      throw new Error("Tax classification is invalid");
    }

    await classifyCatalogImportRow(this.#database, {
      eventId: createEntityId(),
      importId: input.importId,
      rowNumber: input.rowNumber,
      taxClass: input.taxClass,
      basisNote: decision.basisNote,
      userId: decision.classifiedByUserId
    });
    const [updated] = await this.#database
      .select()
      .from(catalogImportRows)
      .where(
        and(
          eq(catalogImportRows.tenantId, this.#tenantId),
          eq(catalogImportRows.importId, input.importId),
          eq(catalogImportRows.rowNumber, input.rowNumber)
        )
      )
      .limit(1);
    if (updated === undefined) throw new Error("Catalog import row classification failed");
    return updated;
  }

  async commitStagedImport(importId: string): Promise<readonly CatalogItem[]> {
    const [catalogImport] = await this.#database
      .select()
      .from(catalogImports)
      .where(and(eq(catalogImports.tenantId, this.#tenantId), eq(catalogImports.id, importId)))
      .for("update")
      .limit(1);
    if (catalogImport === undefined) {
      // A committed import is deliberately immutable: the RLS update policy is
      // USING (status = 'staged'), so FOR UPDATE cannot lock it and the lock
      // above returns nothing. Without this read a second commit -- a rep
      // double-clicking -- would report "not found" and look like data loss.
      // Read without locking to tell "already committed" from "never existed".
      const [existing] = await this.#database
        .select({ status: catalogImports.status })
        .from(catalogImports)
        .where(and(eq(catalogImports.tenantId, this.#tenantId), eq(catalogImports.id, importId)))
        .limit(1);
      if (existing === undefined) throw new Error("Catalog import was not found");
      throw new Error(`Catalog import is not staged (status ${existing.status})`);
    }
    if (catalogImport.status !== "staged") throw new Error("Catalog import is not staged");
    if (catalogImport.invalidRows !== 0 || catalogImport.validRows !== catalogImport.totalRows) {
      throw new Error("Catalog import contains invalid or unclassified rows");
    }

    const stagedRows = await this.#database
      .select()
      .from(catalogImportRows)
      .where(
        and(
          eq(catalogImportRows.tenantId, this.#tenantId),
          eq(catalogImportRows.importId, importId)
        )
      )
      .orderBy(asc(catalogImportRows.rowNumber));
    if (stagedRows.length !== catalogImport.totalRows) {
      throw new Error("Catalog import row count changed after validation");
    }
    const readyRows = stagedRows.map((row) => {
      if (
        row.validationErrors.length > 0 ||
        row.sku === null ||
        row.description === null ||
        row.taxClass === null ||
        row.active === null
      )
        throw new Error(`Catalog import row ${String(row.rowNumber)} is incomplete`);
      return {
        ...row,
        sku: row.sku,
        description: row.description,
        taxClass: row.taxClass,
        active: row.active
      };
    });

    const existing = await this.#database
      .select({ sku: items.sku })
      .from(items)
      .where(eq(items.tenantId, this.#tenantId));
    const existingSkus = new Set(existing.map((item) => item.sku.toLocaleLowerCase("en-KE")));
    for (const row of readyRows) {
      if (existingSkus.has(row.sku.toLocaleLowerCase("en-KE"))) {
        throw new Error(`Catalog import SKU already exists: ${row.sku}`);
      }
    }

    const classificationEvents =
      readyRows.length === 0
        ? []
        : await this.#database
            .select()
            .from(catalogTaxClassifications)
            .where(
              and(
                eq(catalogTaxClassifications.tenantId, this.#tenantId),
                inArray(
                  catalogTaxClassifications.importRowId,
                  readyRows.map((row) => row.id)
                )
              )
            );
    const evidenceByRow = new Map(
      classificationEvents.map((event) => [event.importRowId, event] as const)
    );
    const itemValues = readyRows.map((row) => {
      const id = createEntityId();
      return {
        id,
        row,
        value: {
          id,
          tenantId: this.#tenantId,
          sku: row.sku,
          description: row.description,
          brand: row.brand,
          packSize: row.packSize,
          uom: row.uom,
          costMinor: row.costMinor,
          costCurrency: row.costCurrency,
          fxBufferBps: row.fxBufferBps,
          taxClass: row.taxClass,
          kraItemCode: row.kraItemCode,
          hsCode: row.hsCode,
          leadTimeDays: row.leadTimeDays,
          minMarginBps: row.minMarginBps,
          active: row.active
        }
      };
    });
    const committed =
      itemValues.length === 0
        ? []
        : await this.#database
            .insert(items)
            .values(itemValues.map((entry) => entry.value))
            .returning();
    for (const entry of itemValues) {
      const evidence = evidenceByRow.get(entry.row.id);
      if (evidence === undefined) {
        throw new Error(`Catalog import row ${String(entry.row.rowNumber)} lacks tax evidence`);
      }
      await recordTaxClassification(this.#database, {
        eventId: createEntityId(),
        itemId: entry.id,
        importRowId: entry.row.id,
        taxClass: entry.row.taxClass,
        source: evidence.source === "import_human" ? "import_human" : "import_file",
        basisNote: evidence.basisNote,
        userId: evidence.classifiedByUserId
      });
    }

    const finalized = await this.#database
      .update(catalogImports)
      .set({
        status: "committed",
        committedAt: sql`CURRENT_TIMESTAMP`,
        updatedAt: sql`CURRENT_TIMESTAMP`
      })
      .where(
        and(
          eq(catalogImports.tenantId, this.#tenantId),
          eq(catalogImports.id, importId),
          eq(catalogImports.status, "staged")
        )
      )
      .returning({ id: catalogImports.id });
    if (finalized.length !== 1) throw new Error("Catalog import changed during commit");
    return committed;
  }
}
