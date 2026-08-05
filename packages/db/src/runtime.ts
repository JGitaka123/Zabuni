import { createDatabase } from "./client.js";
import { withTenant, type TenantDatabase } from "./tenant-context.js";

export interface TenantRuntime {
  readonly close: () => Promise<void>;
  readonly run: <Result>(
    verifiedTenantId: string,
    operation: (database: TenantDatabase) => Promise<Result>
  ) => Promise<Result>;
}

export function createTenantRuntime(connectionString: string): TenantRuntime {
  const connection = createDatabase(connectionString);
  return {
    close: () => connection.client.end(),
    run: (verifiedTenantId, operation) => withTenant(connection.db, verifiedTenantId, operation)
  };
}
