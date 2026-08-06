import { and, asc, eq, sql } from "drizzle-orm";
import {
  catalogImportRows,
  catalogImports,
  createEntityId,
  isUuidV7,
  items,
  type TenantDatabase
} from "@zabuni/db";

import type { CatalogInput, ImportPreview } from "./types.js";

export type CatalogItem = typeof items.$inferSelect;
export type CatalogImport = typeof catalogImports.$inferSelect;
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

  async create(input: CatalogInput): Promise<CatalogItem> {
    const [created] = await this.#database
      .insert(items)
      .values({ id: createEntityId(), tenantId: this.#tenantId, ...persistenceValues(input) })
      .returning();
    if (created === undefined) throw new Error("Catalog item insert returned no row");
    return created;
  }

  async update(itemId: string, input: CatalogInput): Promise<CatalogItem | undefined> {
    const [updated] = await this.#database
      .update(items)
      .set(persistenceValues(input))
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

  async importValidated(preview: ImportPreview): Promise<readonly CatalogItem[]> {
    if (preview.stagedCount > 0 || preview.rejectedCount > 0) {
      throw new Error("Catalog import contains staged or rejected rows");
    }
    const rows = preview.rows.filter((row) => row.kind === "valid");
    if (rows.length === 0) return [];
    return this.#database
      .insert(items)
      .values(
        rows.map((row) => ({
          id: createEntityId(),
          tenantId: this.#tenantId,
          ...persistenceValues(row.value)
        }))
      )
      .returning();
  }

  async stageImport(
    sourceFilename: string,
    preview: ImportPreview,
    createdByUserId?: string
  ): Promise<CatalogImport> {
    if (
      sourceFilename.trim() === "" ||
      sourceFilename.length > 255 ||
      hasControlCharacter(sourceFilename)
    ) {
      throw new Error("Catalog import filename is invalid");
    }
    if (createdByUserId !== undefined && !isUuidV7(createdByUserId)) {
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
        ...(createdByUserId === undefined ? {} : { createdByUserId })
      })
      .returning();
    if (catalogImport === undefined) throw new Error("Catalog import insert returned no row");

    if (preview.rows.length > 0) {
      await this.#database.insert(catalogImportRows).values(
        preview.rows.map((row) => {
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
        })
      );
    }
    return catalogImport;
  }

  async commitStagedImport(importId: string): Promise<readonly CatalogItem[]> {
    const [catalogImport] = await this.#database
      .select()
      .from(catalogImports)
      .where(and(eq(catalogImports.tenantId, this.#tenantId), eq(catalogImports.id, importId)))
      .for("update")
      .limit(1);
    if (catalogImport === undefined) throw new Error("Catalog import was not found");
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
      .for("update")
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

    const committed =
      readyRows.length === 0
        ? []
        : await this.#database
            .insert(items)
            .values(
              readyRows.map((row) => ({
                id: createEntityId(),
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
              }))
            )
            .returning();

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
