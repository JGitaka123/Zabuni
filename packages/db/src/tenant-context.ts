import { sql } from "drizzle-orm";

import type { Database } from "./client.js";
import { isUuidV7 } from "./ids.js";

export type TenantDatabase = Parameters<Parameters<Database["transaction"]>[0]>[0];

export async function withTenant<Result>(
  database: Database,
  verifiedTenantId: string,
  operation: (database: TenantDatabase) => Promise<Result>
): Promise<Result> {
  if (!isUuidV7(verifiedTenantId)) {
    throw new Error("Tenant context must be a verified UUIDv7");
  }

  return database.transaction(async (transaction) => {
    const [setting] = await transaction.execute<{ tenantId: string }>(
      sql`SELECT set_config('app.tenant_id', ${verifiedTenantId}, true) AS "tenantId"`
    );
    if (setting?.tenantId !== verifiedTenantId) {
      throw new Error("Failed to establish tenant database context");
    }
    return operation(transaction);
  });
}
