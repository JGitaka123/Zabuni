import { sql } from "drizzle-orm";

import type { TenantDatabase } from "../tenant-context.js";

export interface CatalogItemEmbeddingMutation {
  readonly itemId: string;
  readonly embedding: readonly number[];
  readonly normalizedText: string;
  readonly contentHash: string;
  readonly provider: string;
  readonly model: string;
  readonly modelVersion: string;
}

export async function upsertCatalogItemEmbedding(
  database: TenantDatabase,
  input: CatalogItemEmbeddingMutation
): Promise<void> {
  await database.execute(sql`
    SELECT app.upsert_catalog_item_embedding(
      ${input.itemId}::uuid,
      ${JSON.stringify(input.embedding)}::public.vector,
      ${input.normalizedText},
      ${input.contentHash},
      ${input.provider},
      ${input.model},
      ${input.modelVersion}
    )
  `);
}

export async function deleteCatalogItemEmbedding(
  database: TenantDatabase,
  itemId: string
): Promise<boolean> {
  const [result] = await database.execute<{ removed: boolean }>(sql`
    SELECT app.delete_catalog_item_embedding(${itemId}::uuid) AS removed
  `);
  return result?.removed === true;
}

export async function assignCatalogItemAlias(
  database: TenantDatabase,
  input: {
    readonly aliasId: string;
    readonly itemId: string;
    readonly aliasText: string;
    readonly source: "human" | "accepted_match";
    readonly reassign: boolean;
  }
): Promise<string> {
  const [result] = await database.execute<{ aliasId: string | null }>(sql`
    SELECT app.assign_catalog_item_alias(
      ${input.aliasId}::uuid,
      ${input.itemId}::uuid,
      ${input.aliasText},
      ${input.source},
      ${input.reassign}
    ) AS "aliasId"
  `);
  if (result === undefined) throw new Error("Alias assignment failed");
  if (result.aliasId === null) throw new Error("Alias is already assigned to another item");
  return result.aliasId;
}

export async function deleteCatalogItemAlias(
  database: TenantDatabase,
  aliasId: string
): Promise<boolean> {
  const [result] = await database.execute<{ removed: boolean }>(sql`
    SELECT app.delete_catalog_item_alias(${aliasId}::uuid) AS removed
  `);
  return result?.removed === true;
}

export async function confirmCatalogItemAlias(
  database: TenantDatabase,
  aliasId: string
): Promise<void> {
  await database.execute(sql`
    SELECT app.confirm_catalog_item_alias(${aliasId}::uuid)
  `);
}

export async function consumeCatalogRateLimit(
  database: TenantDatabase,
  input: {
    readonly operation: "alias" | "match";
    readonly userId: string | null;
  }
): Promise<boolean> {
  const [result] = await database.execute<{ accepted: boolean }>(sql`
    SELECT app.consume_catalog_rate_limit(
      ${input.operation}, ${input.userId}::uuid
    ) AS accepted
  `);
  return result?.accepted === true;
}
