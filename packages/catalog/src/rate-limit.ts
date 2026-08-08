import { sql } from "drizzle-orm";

import type { TenantDatabase } from "@zabuni/db";
import { consumeCatalogRateLimit } from "@zabuni/db/privileged/catalog-matching";

export type CatalogBudgetOperation = "alias" | "match";

export class CatalogRateLimitError extends Error {
  constructor() {
    super("Catalog request rate limit reached");
    this.name = "CatalogRateLimitError";
  }
}

async function consumeWindow(
  database: TenantDatabase,
  operation: CatalogBudgetOperation,
  userId: string | null
): Promise<void> {
  const accepted = await consumeCatalogRateLimit(database, { operation, userId });
  if (!accepted) throw new CatalogRateLimitError();
}

export async function consumeCatalogRequestRate(
  database: TenantDatabase,
  userId: string,
  operation: CatalogBudgetOperation
): Promise<void> {
  await consumeWindow(database, operation, userId);
  await consumeWindow(database, operation, null);
}

export async function acquireCatalogMatchConcurrency(
  database: TenantDatabase,
  tenantId: string,
  userId: string
): Promise<void> {
  await database.execute(sql.raw("SET LOCAL statement_timeout = '2000ms'"));
  const acquireSlot = async (scope: string, slots: number): Promise<void> => {
    const [lock] = await database.execute<{ slot: number }>(sql`
      SELECT slot
      FROM generate_series(0, ${slots - 1}) AS slot
      WHERE pg_try_advisory_xact_lock(hashtextextended(${scope}, 891733) + slot)
      LIMIT 1
    `);
    if (lock === undefined) throw new CatalogRateLimitError();
  };
  await acquireSlot(`${tenantId}:catalog-match:tenant`, 4);
  await acquireSlot(`${tenantId}:${userId}:catalog-match:user`, 2);
}
