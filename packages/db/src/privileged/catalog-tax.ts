import { sql } from "drizzle-orm";

import type { TaxClass, TaxClassificationSource } from "../schema.js";
import type { TenantDatabase } from "../tenant-context.js";

export interface RecordTaxClassificationInput {
  readonly eventId: string;
  readonly itemId?: string;
  readonly importRowId?: string;
  readonly taxClass: TaxClass;
  readonly source: Extract<TaxClassificationSource, "manual_create" | "import_file" | "import_human">;
  readonly basisNote: string;
  readonly userId: string;
}

export async function recordTaxClassification(
  database: TenantDatabase,
  input: RecordTaxClassificationInput
): Promise<void> {
  await database.execute(sql`
    SELECT app.record_tax_classification(
      ${input.eventId}::uuid, ${input.itemId ?? null}::uuid,
      ${input.importRowId ?? null}::uuid, ${input.taxClass}, ${input.source},
      ${input.basisNote}, ${input.userId}::uuid
    )
  `);
}

export async function reclassifyCatalogItem(
  database: TenantDatabase,
  input: {
    readonly eventId: string;
    readonly itemId: string;
    readonly taxClass: TaxClass;
    readonly basisNote: string;
    readonly userId: string;
  }
): Promise<void> {
  await database.execute(sql`
    SELECT app.reclassify_catalog_item(
      ${input.eventId}::uuid, ${input.itemId}::uuid, ${input.taxClass},
      ${input.basisNote}, ${input.userId}::uuid
    )
  `);
}

export async function classifyCatalogImportRow(
  database: TenantDatabase,
  input: {
    readonly eventId: string;
    readonly importId: string;
    readonly rowNumber: number;
    readonly taxClass: TaxClass;
    readonly basisNote: string;
    readonly userId: string;
  }
): Promise<void> {
  await database.execute(sql`
    SELECT app.classify_catalog_import_row(
      ${input.eventId}::uuid, ${input.importId}::uuid, ${input.rowNumber},
      ${input.taxClass}, ${input.basisNote}, ${input.userId}::uuid
    )
  `);
}
