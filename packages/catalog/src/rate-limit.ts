import { sql } from "drizzle-orm";

import type { TenantDatabase } from "@zabuni/db";

export type CatalogBudgetOperation = "alias" | "match";

export class CatalogRateLimitError extends Error {
  constructor() {
    super("Catalog request rate limit reached");
    this.name = "CatalogRateLimitError";
  }
}

async function consumeWindow(
  database: TenantDatabase,
  tenantId: string,
  key: string,
  limit: number
): Promise<void> {
  const rows = await database.execute<{ accepted: boolean }>(sql`
    INSERT INTO catalog_match_rate_limits (
      key, tenant_id, request_count, window_started_at
    ) VALUES (
      ${key}, ${tenantId}, 1, CURRENT_TIMESTAMP
    )
    ON CONFLICT (key) DO UPDATE SET
      request_count = CASE
        WHEN catalog_match_rate_limits.window_started_at <= CURRENT_TIMESTAMP - INTERVAL '60 seconds'
          THEN 1
        ELSE catalog_match_rate_limits.request_count + 1
      END,
      window_started_at = CASE
        WHEN catalog_match_rate_limits.window_started_at <= CURRENT_TIMESTAMP - INTERVAL '60 seconds'
          THEN CURRENT_TIMESTAMP
        ELSE catalog_match_rate_limits.window_started_at
      END
    WHERE catalog_match_rate_limits.tenant_id = EXCLUDED.tenant_id
      AND (
        catalog_match_rate_limits.window_started_at <= CURRENT_TIMESTAMP - INTERVAL '60 seconds'
        OR catalog_match_rate_limits.request_count < ${limit}
      )
    RETURNING true AS accepted
  `);
  if (rows[0]?.accepted !== true) throw new CatalogRateLimitError();
}

export async function consumeCatalogRequestRate(
  database: TenantDatabase,
  tenantId: string,
  userId: string,
  operation: CatalogBudgetOperation
): Promise<void> {
  const userLimit = operation === "match" ? 30 : 20;
  const tenantLimit = operation === "match" ? 300 : 200;
  await consumeWindow(database, tenantId, `${tenantId}:${operation}:user:${userId}`, userLimit);
  await consumeWindow(database, tenantId, `${tenantId}:${operation}:tenant`, tenantLimit);
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
