import { copyFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { createEntityId } from "../src/ids.js";
import { applyMigrations } from "../src/migrate.js";

const adminUrl =
  process.env.DATABASE_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5432/zabuni";
const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

const pre0019ProvisioningBaseline = String.raw`
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zabuni_owner') THEN
    CREATE ROLE zabuni_owner NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zabuni_app') THEN
    CREATE ROLE zabuni_app NOLOGIN NOBYPASSRLS;
  END IF;
END
$roles$;

CREATE SCHEMA app;
CREATE TABLE auth_identity (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  email text,
  email_verified boolean NOT NULL DEFAULT false,
  phone_number text,
  phone_number_verified boolean NOT NULL DEFAULT false
);
CREATE TABLE tenants (
  id uuid PRIMARY KEY,
  legal_name text NOT NULL,
  plan text NOT NULL,
  status text NOT NULL
);
CREATE TABLE users (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  phone_e164 text,
  email text,
  name text NOT NULL CHECK (btrim(name) <> ''),
  role text NOT NULL
);
CREATE TABLE auth_membership (
  id uuid PRIMARY KEY,
  identity_id uuid NOT NULL REFERENCES auth_identity(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL,
  status text NOT NULL DEFAULT 'active'
);
CREATE TABLE auth_onboarding_audit (
  id uuid PRIMARY KEY,
  identity_id uuid NOT NULL REFERENCES auth_identity(id),
  scope_id uuid NOT NULL,
  membership_id uuid NOT NULL REFERENCES auth_membership(id),
  action text NOT NULL
);

GRANT SELECT, UPDATE ON auth_identity TO zabuni_owner;
GRANT SELECT ON auth_membership TO zabuni_owner;
GRANT INSERT ON tenants, users, auth_membership, auth_onboarding_audit TO zabuni_owner;

CREATE FUNCTION app.provision_tenant_owner(
  p_identity_id uuid,
  p_tenant_id uuid,
  p_user_id uuid,
  p_membership_id uuid,
  p_audit_id uuid,
  p_legal_name text
)
RETURNS TABLE (tenant_id uuid, user_id uuid, membership_id uuid, membership_role text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  identity_row auth_identity%ROWTYPE;
BEGIN
  SELECT * INTO identity_row FROM auth_identity WHERE id = p_identity_id FOR UPDATE;
  IF NOT FOUND OR NOT (identity_row.email_verified OR identity_row.phone_number_verified) THEN
    RAISE EXCEPTION 'A verified identity is required' USING ERRCODE = '28000';
  END IF;
  INSERT INTO tenants (id, legal_name, plan, status)
    VALUES (p_tenant_id, p_legal_name, 'foundation', 'active');
  INSERT INTO users (id, tenant_id, phone_e164, email, name, role)
    VALUES (
      p_user_id,
      p_tenant_id,
      identity_row.phone_number,
      identity_row.email,
      identity_row.name,
      'owner'
    );
  INSERT INTO auth_membership (id, identity_id, tenant_id, user_id, role)
    VALUES (p_membership_id, p_identity_id, p_tenant_id, p_user_id, 'owner');
  INSERT INTO auth_onboarding_audit (id, identity_id, scope_id, membership_id, action)
    VALUES (p_audit_id, p_identity_id, p_tenant_id, p_membership_id, 'tenant_owner_created');
  RETURN QUERY SELECT p_tenant_id, p_user_id, p_membership_id, 'owner'::text;
END
$function$;

ALTER FUNCTION app.provision_tenant_owner(uuid, uuid, uuid, uuid, uuid, text)
  OWNER TO zabuni_owner;
REVOKE ALL ON FUNCTION app.provision_tenant_owner(uuid, uuid, uuid, uuid, uuid, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.provision_tenant_owner(uuid, uuid, uuid, uuid, uuid, text)
  TO zabuni_app;
`;

function databaseUrls(databaseName: string): { maintenance: string; test: string } {
  const maintenance = new URL(adminUrl);
  maintenance.pathname = "/postgres";
  maintenance.search = "";
  maintenance.hash = "";
  const test = new URL(adminUrl);
  test.pathname = `/${databaseName}`;
  test.search = "";
  test.hash = "";
  return { maintenance: maintenance.toString(), test: test.toString() };
}

describe("owner-provisioning rolling upgrade", () => {
  it("keeps the old signature callable while 0019 and 0020 land atomically", async () => {
    const databaseName = `zabuni_upgrade_${String(process.pid)}_${String(Date.now())}`;
    if (!/^zabuni_upgrade_\d+_\d+$/u.test(databaseName))
      throw new Error("unsafe test database name");
    const urls = databaseUrls(databaseName);
    const maintenance = postgres(urls.maintenance, { max: 1, prepare: false });
    const directory = await mkdtemp(join(tmpdir(), "zabuni-owner-upgrade-"));
    let database: postgres.Sql | undefined;

    try {
      await maintenance.unsafe(`CREATE DATABASE "${databaseName}"`);
      database = postgres(urls.test, { max: 1, prepare: false, onnotice: () => undefined });

      await writeFile(
        join(directory, "0018_provisioning_baseline.sql"),
        pre0019ProvisioningBaseline
      );
      await applyMigrations(database, directory);

      const oldIdentityId = createEntityId();
      await database`
        INSERT INTO auth_identity (id, name, email, email_verified)
        VALUES (${oldIdentityId}, 'Previous App Owner', ${`old-${oldIdentityId}@example.test`}, true)
      `;
      const [oldProvisioned] = await database<{ userId: string }[]>`
        SELECT user_id AS "userId" FROM app.provision_tenant_owner(
          ${oldIdentityId}::uuid,
          ${createEntityId()}::uuid,
          ${createEntityId()}::uuid,
          ${createEntityId()}::uuid,
          ${createEntityId()}::uuid,
          ${"Previous App Ltd"}
        )
      `;
      const [beforeUpgrade] = await database<{ name: string }[]>`
        SELECT name FROM users WHERE id = ${oldProvisioned?.userId ?? ""}
      `;
      expect(beforeUpgrade?.name).toBe("Previous App Owner");

      await Promise.all([
        copyFile(
          join(migrationDirectory, "0019_owner_display_name.sql"),
          join(directory, "0019_owner_display_name.sql")
        ),
        copyFile(
          join(migrationDirectory, "0020_owner_provisioning_compatibility.sql"),
          join(directory, "0020_owner_provisioning_compatibility.sql")
        )
      ]);
      await database.unsafe("RESET ROLE");
      await applyMigrations(database, directory);

      const compatibilityIdentityId = createEntityId();
      await database`
        INSERT INTO auth_identity (id, name, email, email_verified)
        VALUES (
          ${compatibilityIdentityId},
          '',
          ${`compat-${compatibilityIdentityId}@example.test`},
          true
        )
      `;
      const [compatibilityProvisioned] = await database<{ userId: string }[]>`
        SELECT user_id AS "userId" FROM app.provision_tenant_owner(
          ${compatibilityIdentityId}::uuid,
          ${createEntityId()}::uuid,
          ${createEntityId()}::uuid,
          ${createEntityId()}::uuid,
          ${createEntityId()}::uuid,
          ${"Compatibility App Ltd"}
        )
      `;
      const [compatibilityCall] = await database<{ name: string }[]>`
        SELECT name FROM users WHERE id = ${compatibilityProvisioned?.userId ?? ""}
      `;
      expect(compatibilityCall?.name).toBe(`compat-${compatibilityIdentityId}`);

      const currentIdentityId = createEntityId();
      await database`
        INSERT INTO auth_identity (id, name, email, email_verified)
        VALUES (${currentIdentityId}, '', ${`current-${currentIdentityId}@example.test`}, true)
      `;
      const [currentProvisioned] = await database<{ userId: string }[]>`
        SELECT user_id AS "userId" FROM app.provision_tenant_owner(
          ${currentIdentityId}::uuid,
          ${createEntityId()}::uuid,
          ${createEntityId()}::uuid,
          ${createEntityId()}::uuid,
          ${createEntityId()}::uuid,
          ${"Current App Ltd"},
          ${"Current App Owner"}
        )
      `;
      const [currentCall] = await database<{ name: string }[]>`
        SELECT name FROM users WHERE id = ${currentProvisioned?.userId ?? ""}
      `;
      expect(currentCall?.name).toBe("Current App Owner");
    } finally {
      await database?.end();
      await maintenance`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = ${databaseName} AND pid <> pg_backend_pid()
      `;
      await maintenance.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await maintenance.end();
    }
  });
});
