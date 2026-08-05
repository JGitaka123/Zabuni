import {
  verifyRequestSession,
  type AuthServer,
  type MembershipRuntime,
  type TenantSession
} from "@zabuni/auth";
import type { MiddlewareHandler } from "hono";

export interface SessionVariables {
  tenantSession: TenantSession;
}

export function requireTenantSession(
  auth: AuthServer,
  memberships: MembershipRuntime
): MiddlewareHandler<{ Variables: SessionVariables }> {
  return async (context, next) => {
    const verified = await verifyRequestSession(auth, context.req.raw.headers);
    if (verified === null) return context.json({ error: "unauthenticated" }, 401);
    const tenantSession = await memberships.resolve(verified);
    if (tenantSession === null) return context.json({ error: "tenant_access_denied" }, 403);
    context.set("tenantSession", tenantSession);
    return next();
  };
}
