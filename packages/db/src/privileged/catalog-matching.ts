import { sql } from "drizzle-orm";

import type { TenantDatabase } from "../tenant-context.js";

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
