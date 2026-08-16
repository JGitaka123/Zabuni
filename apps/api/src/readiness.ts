import type { AuthRuntime, MembershipRuntime } from "@zabuni/auth";
import type { TenantRuntime } from "@zabuni/db";

type PingableAuthRuntime = Pick<AuthRuntime, "ping">;
type PingableMembershipRuntime = Pick<MembershipRuntime, "ping">;
type PingableTenantRuntime = Pick<TenantRuntime, "ping">;

/** Every independently pooled database dependency must be usable before routing traffic. */
export function createApiReadiness(
  auth: PingableAuthRuntime,
  memberships: PingableMembershipRuntime,
  tenants: PingableTenantRuntime
): () => Promise<void> {
  return async () => {
    await Promise.all([auth.ping(), memberships.ping(), tenants.ping()]);
  };
}
