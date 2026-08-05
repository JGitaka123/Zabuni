import { sql } from "drizzle-orm";

import { createEntityId, isUuidV7, type TenantRole } from "@zabuni/db";
import { createDatabase, type Database } from "@zabuni/db/admin";

import type { AuthServer } from "./server.js";

export interface AuthenticatedIdentity {
  readonly id: string;
}

export interface VerifiedSession {
  readonly identityId: string;
  readonly expiresAt: Date;
}

export interface TenantSession extends VerifiedSession {
  readonly tenantId: string;
  readonly userId: string;
  readonly role: TenantRole;
}

export async function verifyRequestSession(
  auth: AuthServer,
  headers: Headers
): Promise<VerifiedSession | null> {
  const result = await auth.api.getSession({ headers });
  if (result === null || !isUuidV7(result.user.id)) return null;
  return { identityId: result.user.id, expiresAt: result.session.expiresAt };
}

export async function resolveTenantSession(
  database: Database,
  session: VerifiedSession
): Promise<TenantSession | null> {
  if (!isUuidV7(session.identityId) || session.expiresAt.getTime() <= Date.now()) return null;
  const rows = await database.execute<{
    tenantId: string;
    userId: string;
    membershipRole: TenantRole;
  }>(sql`
    SELECT tenant_id AS "tenantId", user_id AS "userId", membership_role AS "membershipRole"
    FROM app.resolve_identity_membership(${session.identityId}::uuid)
  `);
  const membership = rows[0];
  if (membership === undefined || !isUuidV7(membership.tenantId) || !isUuidV7(membership.userId)) {
    return null;
  }
  return {
    ...session,
    tenantId: membership.tenantId,
    userId: membership.userId,
    role: membership.membershipRole
  };
}

export interface ProvisionTenantInput {
  readonly identityId: string;
  readonly legalName: string;
}

export async function provisionFirstTenant(
  database: Database,
  input: ProvisionTenantInput
): Promise<Pick<TenantSession, "tenantId" | "userId" | "role">> {
  if (!isUuidV7(input.identityId)) throw new Error("A verified UUIDv7 identity is required");
  const tenantId = createEntityId();
  const userId = createEntityId();
  const membershipId = createEntityId();
  const auditId = createEntityId();
  const rows = await database.execute<{
    tenantId: string;
    userId: string;
    membershipRole: TenantRole;
  }>(sql`
    SELECT tenant_id AS "tenantId", user_id AS "userId", membership_role AS "membershipRole"
    FROM app.provision_tenant_owner(
      ${input.identityId}::uuid,
      ${tenantId}::uuid,
      ${userId}::uuid,
      ${membershipId}::uuid,
      ${auditId}::uuid,
      ${input.legalName}
    )
  `);
  const provisioned = rows[0];
  if (provisioned === undefined) throw new Error("Tenant provisioning did not complete");
  return {
    tenantId: provisioned.tenantId,
    userId: provisioned.userId,
    role: provisioned.membershipRole
  };
}

export interface MembershipRuntime {
  readonly resolve: (session: VerifiedSession) => Promise<TenantSession | null>;
  readonly provision: (
    input: ProvisionTenantInput
  ) => Promise<Pick<TenantSession, "tenantId" | "userId" | "role">>;
  readonly close: () => Promise<void>;
}

export function createMembershipRuntime(connectionString: string): MembershipRuntime {
  // Kept inside the auth boundary so apps cannot import the unrestricted DB factory.
  const connection = createDatabase(connectionString);
  return {
    resolve: (session) => resolveTenantSession(connection.db, session),
    provision: (input) => provisionFirstTenant(connection.db, input),
    close: () => connection.client.end()
  };
}
