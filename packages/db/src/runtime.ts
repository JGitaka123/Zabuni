import { sql } from "drizzle-orm";

import { createDatabase } from "./client.js";
import { withTenant, type TenantDatabase } from "./tenant-context.js";

export interface TenantRuntime {
  readonly close: () => Promise<void>;
  /** Round-trips the tenant-operation pool for readiness probes. */
  readonly ping: () => Promise<void>;
  readonly run: <Result>(
    verifiedTenantId: string,
    operation: (database: TenantDatabase) => Promise<Result>
  ) => Promise<Result>;
}

export function createTenantRuntime(connectionString: string): TenantRuntime {
  const connection = createDatabase(connectionString);
  return {
    close: () => connection.client.end(),
    ping: async () => {
      await connection.db.execute(sql`SELECT 1`);
    },
    run: (verifiedTenantId, operation) => withTenant(connection.db, verifiedTenantId, operation)
  };
}
