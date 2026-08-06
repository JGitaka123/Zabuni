import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "../src/client.js";
import { createEntityId } from "../src/ids.js";
import { applyMigrations } from "../src/migrate.js";
import {
  authMemberships,
  catalogImportRows,
  catalogImports,
  incidents,
  items,
  outbox,
  tenantTableRegistry,
  tenants,
  usageEvents,
  users
} from "../src/schema.js";
import { withTenant } from "../src/tenant-context.js";

const adminUrl =
  process.env.DATABASE_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5432/zabuni";
const appUrl = process.env.DATABASE_URL ?? "postgres://zabuni_app:zabuni_app@localhost:5432/zabuni";
const migratorUrl =
  process.env.MIGRATION_DATABASE_URL ??
  "postgres://zabuni_migrator:zabuni_migrator@localhost:5432/zabuni";

const admin = postgres(adminUrl, { onnotice: () => undefined, prepare: false });
const migrator = postgres(migratorUrl, { max: 1, onnotice: () => undefined, prepare: false });
const app = createDatabase(appUrl, { maxConnections: 1 });
const tenantA = createEntityId();
const tenantB = createEntityId();
const ids = {
  identityA: createEntityId(),
  identityB: createEntityId(),
  membershipA: createEntityId(),
  membershipB: createEntityId(),
  userA: createEntityId(),
  userB: createEntityId(),
  itemA: createEntityId(),
  itemB: createEntityId(),
  catalogImportA: createEntityId(),
  catalogImportB: createEntityId(),
  catalogImportRowA: createEntityId(),
  catalogImportRowB: createEntityId(),
  usageA: createEntityId(),
  usageB: createEntityId(),
  outboxA: createEntityId(),
  outboxB: createEntityId(),
  incidentA: createEntityId(),
  incidentB: createEntityId()
};

async function provisionRuntimeRole(): Promise<void> {
  await admin.unsafe(`
    DO $roles$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zabuni_owner') THEN
        CREATE ROLE zabuni_owner NOLOGIN
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zabuni_migrator') THEN
        CREATE ROLE zabuni_migrator LOGIN PASSWORD 'zabuni_migrator'
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zabuni_app') THEN
        CREATE ROLE zabuni_app LOGIN PASSWORD 'zabuni_app'
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zabuni_auth') THEN
        CREATE ROLE zabuni_auth LOGIN PASSWORD 'zabuni_auth'
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zabuni_outbox_claim_owner') THEN
        CREATE ROLE zabuni_outbox_claim_owner NOLOGIN
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zabuni_worker') THEN
        CREATE ROLE zabuni_worker LOGIN PASSWORD 'zabuni_worker'
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
      END IF;
    END
    $roles$;
    ALTER ROLE zabuni_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    ALTER ROLE zabuni_migrator LOGIN PASSWORD 'zabuni_migrator' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    ALTER ROLE zabuni_app LOGIN PASSWORD 'zabuni_app' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    ALTER ROLE zabuni_auth LOGIN PASSWORD 'zabuni_auth' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    ALTER ROLE zabuni_outbox_claim_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;
    ALTER ROLE zabuni_worker LOGIN PASSWORD 'zabuni_worker' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    GRANT zabuni_owner TO zabuni_migrator;
    GRANT zabuni_outbox_claim_owner TO zabuni_owner;
    REVOKE zabuni_owner, zabuni_migrator FROM zabuni_app;
    REVOKE zabuni_owner, zabuni_migrator, zabuni_app FROM zabuni_auth;
    REVOKE zabuni_outbox_claim_owner, zabuni_owner, zabuni_migrator FROM zabuni_worker;
    GRANT CONNECT ON DATABASE zabuni TO zabuni_migrator, zabuni_app, zabuni_auth, zabuni_worker;
    GRANT CREATE ON DATABASE zabuni TO zabuni_owner;
    GRANT USAGE, CREATE ON SCHEMA public TO zabuni_owner;
    GRANT USAGE ON SCHEMA public TO zabuni_migrator;
    GRANT USAGE ON SCHEMA public TO zabuni_app;
    GRANT USAGE ON SCHEMA public TO zabuni_auth;
    GRANT USAGE ON SCHEMA public TO zabuni_outbox_claim_owner, zabuni_worker;
  `);
}

beforeAll(async () => {
  await provisionRuntimeRole();
  await migrator`SET ROLE zabuni_owner`;
  await applyMigrations(migrator);

  await admin`
    INSERT INTO tenants (id, legal_name, plan, status)
    VALUES (${tenantA}, 'Tenant A', 'foundation', 'active'),
           (${tenantB}, 'Tenant B', 'foundation', 'active')
  `;
  await admin`
    INSERT INTO users (id, tenant_id, email, name, role)
    VALUES (${ids.userA}, ${tenantA}, 'a@example.test', 'A User', 'owner'),
           (${ids.userB}, ${tenantB}, 'b@example.test', 'B User', 'owner')
  `;
  await admin`
    INSERT INTO auth_identity (id, name, email, email_verified)
    VALUES (${ids.identityA}, 'A Identity', ${`identity-${ids.identityA}@example.test`}, true),
           (${ids.identityB}, 'B Identity', ${`identity-${ids.identityB}@example.test`}, true)
  `;
  await admin`
    INSERT INTO auth_membership (id, identity_id, tenant_id, user_id, role)
    VALUES (${ids.membershipA}, ${ids.identityA}, ${tenantA}, ${ids.userA}, 'owner'),
           (${ids.membershipB}, ${ids.identityB}, ${tenantB}, ${ids.userB}, 'owner')
  `;
  await admin`
    INSERT INTO items (id, tenant_id, sku, description, tax_class)
    VALUES (${ids.itemA}, ${tenantA}, 'A-1', 'A item', 'standard_16'),
           (${ids.itemB}, ${tenantB}, 'B-1', 'B item', 'zero_rated')
  `;
  await admin`
    INSERT INTO catalog_imports (id, tenant_id, source_filename, total_rows, invalid_rows)
    VALUES (${ids.catalogImportA}, ${tenantA}, 'tenant-a.csv', 1, 1),
           (${ids.catalogImportB}, ${tenantB}, 'tenant-b.xlsx', 1, 0)
  `;
  await admin`
    INSERT INTO catalog_import_rows (
      id, tenant_id, import_id, row_number, raw_data, sku, description, tax_class,
      validation_errors
    )
    VALUES (
      ${ids.catalogImportRowA}, ${tenantA}, ${ids.catalogImportA}, 1,
      '{"SKU":"A-STAGED"}'::jsonb, 'A-STAGED', 'Needs classification', NULL,
      '["tax_class is required"]'::jsonb
    ), (
      ${ids.catalogImportRowB}, ${tenantB}, ${ids.catalogImportB}, 1,
      '{"SKU":"B-STAGED"}'::jsonb, 'B-STAGED', 'Ready', 'exempt', '[]'::jsonb
    )
  `;
  await admin`
    INSERT INTO usage_events (id, tenant_id, metric, quantity, occurred_at, unit_cost_minor, cost_currency)
    VALUES (${ids.usageA}, ${tenantA}, 'llm_tokens', 1, now(), 1, 'KES'),
           (${ids.usageB}, ${tenantB}, 'llm_tokens', 1, now(), 1, 'KES')
  `;
  await admin`
    INSERT INTO outbox (id, tenant_id, event_type, payload_version, payload, idempotency_key, max_attempts)
    VALUES (${ids.outboxA}, ${tenantA}, 'fixture', 1, '{}'::jsonb, 'a-key', 3),
           (${ids.outboxB}, ${tenantB}, 'fixture', 1, '{}'::jsonb, 'b-key', 3)
  `;
  await admin`
    INSERT INTO incidents (id, tenant_id, outbox_id, kind, summary)
    VALUES (${ids.incidentA}, ${tenantA}, ${ids.outboxA}, 'fixture', 'A incident'),
           (${ids.incidentB}, ${tenantB}, ${ids.outboxB}, 'fixture', 'B incident')
  `;
});

afterAll(async () => {
  await admin`DELETE FROM tenants WHERE id IN (${tenantA}, ${tenantB})`;
  await app.client.end();
  await migrator.end();
  await admin.end();
});

describe("tenant RLS through Drizzle", () => {
  it("isolates every tenant-owned table for tenant A", async () => {
    await withTenant(app.db, tenantA, async (db) => {
      await expect(db.select({ id: tenants.id }).from(tenants)).resolves.toEqual([{ id: tenantA }]);
      await expect(db.select({ id: users.id }).from(users)).resolves.toEqual([{ id: ids.userA }]);
      await expect(db.select({ id: authMemberships.id }).from(authMemberships)).resolves.toEqual([
        { id: ids.membershipA }
      ]);
      await expect(db.select({ id: items.id }).from(items)).resolves.toEqual([{ id: ids.itemA }]);
      await expect(db.select({ id: catalogImports.id }).from(catalogImports)).resolves.toEqual([
        { id: ids.catalogImportA }
      ]);
      await expect(
        db.select({ id: catalogImportRows.id }).from(catalogImportRows)
      ).resolves.toEqual([{ id: ids.catalogImportRowA }]);
      await expect(db.select({ id: usageEvents.id }).from(usageEvents)).resolves.toEqual([
        { id: ids.usageA }
      ]);
      await expect(db.select({ id: outbox.id }).from(outbox)).resolves.toEqual([
        { id: ids.outboxA }
      ]);
      await expect(db.select({ id: incidents.id }).from(incidents)).resolves.toEqual([
        { id: ids.incidentA }
      ]);
      await expect(db.select().from(items).where(eq(items.id, ids.itemB))).resolves.toEqual([]);
      await expect(
        db.select().from(catalogImports).where(eq(catalogImports.id, ids.catalogImportB))
      ).resolves.toEqual([]);
    });
  });

  it("mirrors isolation for tenant B", async () => {
    await withTenant(app.db, tenantB, async (db) => {
      const rows = await db.select().from(items);
      expect(rows.map(({ id }) => id)).toEqual([ids.itemB]);
      await expect(db.select({ id: authMemberships.id }).from(authMemberships)).resolves.toEqual([
        { id: ids.membershipB }
      ]);
      await expect(
        db.select({ id: catalogImportRows.id }).from(catalogImportRows)
      ).resolves.toEqual([{ id: ids.catalogImportRowB }]);
    });
  });

  it("keeps concurrent pooled transactions isolated", async () => {
    const [aRows, bRows] = await Promise.all([
      withTenant(app.db, tenantA, (db) => db.select({ id: items.id }).from(items)),
      withTenant(app.db, tenantB, (db) => db.select({ id: items.id }).from(items))
    ]);
    expect(aRows).toEqual([{ id: ids.itemA }]);
    expect(bRows).toEqual([{ id: ids.itemB }]);
  });

  it("clears context after rollback on a reused connection", async () => {
    await expect(
      withTenant(app.db, tenantA, async (db) => {
        await expect(db.select({ id: items.id }).from(items)).resolves.toEqual([{ id: ids.itemA }]);
        throw new Error("force rollback");
      })
    ).rejects.toThrow("force rollback");
    await expect(app.db.select().from(items)).resolves.toEqual([]);
  });

  it("requires an explicit audited FORCE-RLS window for data migrations", async () => {
    await migrator.begin(async (transaction) => {
      await transaction`ALTER TABLE items NO FORCE ROW LEVEL SECURITY`;
      await transaction`UPDATE items SET description = 'A item migrated' WHERE id = ${ids.itemA}`;
      await transaction`ALTER TABLE items FORCE ROW LEVEL SECURITY`;
    });
    await withTenant(app.db, tenantA, async (db) => {
      const [item] = await db.select().from(items).where(eq(items.id, ids.itemA));
      expect(item?.description).toBe("A item migrated");
    });
  });

  it("blocks cross-tenant writes through the ORM", async () => {
    await expect(
      withTenant(app.db, tenantA, async (db) =>
        db.insert(usageEvents).values({
          id: createEntityId(),
          tenantId: tenantB,
          metric: "llm_tokens",
          quantity: 1n,
          occurredAt: new Date(),
          unitCostMinor: 1n,
          costCurrency: "KES"
        })
      )
    ).rejects.toMatchObject({ cause: { code: "42501" } });

    await expect(
      withTenant(app.db, tenantA, (db) =>
        db.insert(catalogImports).values({
          id: createEntityId(),
          tenantId: tenantB,
          sourceFilename: "forged.csv"
        })
      )
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });

  it("permits safe catalog writes but forbids physical item deletion", async () => {
    const itemId = createEntityId();
    await withTenant(app.db, tenantA, async (db) => {
      await db.insert(items).values({
        id: itemId,
        tenantId: tenantA,
        sku: `SAFE-${itemId}`,
        description: "Safe item",
        taxClass: "exempt"
      });
      await db.update(items).set({ active: false }).where(eq(items.id, itemId));
      const [archived] = await db.select().from(items).where(eq(items.id, itemId));
      expect(archived?.active).toBe(false);
    });
    await expect(
      withTenant(app.db, tenantA, (db) => db.delete(items).where(eq(items.id, itemId)))
    ).rejects.toMatchObject({
      cause: { code: "42501" }
    });
    await admin`DELETE FROM items WHERE id = ${itemId}`;
  });

  it("preserves committed import audit history", async () => {
    const importId = createEntityId();
    const rowId = createEntityId();
    await withTenant(app.db, tenantA, async (db) => {
      await db.insert(catalogImports).values({
        id: importId,
        tenantId: tenantA,
        sourceFilename: "audit.csv",
        totalRows: 1,
        validRows: 1
      });
      await db.insert(catalogImportRows).values({
        id: rowId,
        tenantId: tenantA,
        importId,
        rowNumber: 1,
        rawData: { SKU: "AUDIT-1" },
        sku: "AUDIT-1",
        description: "Audit row",
        taxClass: "standard_16"
      });
      await db
        .update(catalogImports)
        .set({ status: "committed", committedAt: new Date() })
        .where(eq(catalogImports.id, importId));
      await expect(
        db
          .update(catalogImports)
          .set({ sourceFilename: "tampered.csv" })
          .where(eq(catalogImports.id, importId))
          .returning({ id: catalogImports.id })
      ).resolves.toEqual([]);
      await expect(
        db
          .update(catalogImportRows)
          .set({ sku: "TAMPERED" })
          .where(eq(catalogImportRows.id, rowId))
          .returning({ id: catalogImportRows.id })
      ).resolves.toEqual([]);
    });
    await expect(
      withTenant(app.db, tenantA, (db) =>
        db.delete(catalogImportRows).where(eq(catalogImportRows.id, rowId))
      )
    ).rejects.toMatchObject({ cause: { code: "42501" } });
    await expect(
      withTenant(app.db, tenantA, (db) =>
        db
          .delete(catalogImports)
          .where(eq(catalogImports.id, importId))
          .returning({ id: catalogImports.id })
      )
    ).resolves.toEqual([]);
  });

  it("rejects cross-tenant parent references", async () => {
    await expect(
      admin`
        INSERT INTO incidents (id, tenant_id, outbox_id, kind, summary)
        VALUES (${createEntityId()}, ${tenantA}, ${ids.outboxB}, 'invalid', 'cross-tenant link')
      `
    ).rejects.toMatchObject({ code: "23503" });

    await expect(
      admin`
        INSERT INTO catalog_import_rows (
          id, tenant_id, import_id, row_number, raw_data, validation_errors
        ) VALUES (
          ${createEntityId()}, ${tenantA}, ${ids.catalogImportB}, 99, '{}'::jsonb, '[]'::jsonb
        )
      `
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("fails closed without context and does not leak pooled context", async () => {
    await withTenant(app.db, tenantA, async (db) => {
      await expect(db.select().from(items)).resolves.toHaveLength(1);
    });
    await expect(app.db.select().from(items)).resolves.toEqual([]);
    await expect(
      app.db.insert(usageEvents).values({
        id: createEntityId(),
        tenantId: tenantA,
        metric: "llm_tokens",
        quantity: 1n,
        occurredAt: new Date(),
        unitCostMinor: 1n,
        costCurrency: "KES"
      })
    ).rejects.toMatchObject({ cause: { code: "42501" } });
    await expect(
      withTenant(app.db, "not-a-tenant", () => Promise.resolve(undefined))
    ).rejects.toThrow("verified UUIDv7");
  });

  it("serializes first-tenant provisioning for one verified identity", async () => {
    const concurrentApp = createDatabase(appUrl, { maxConnections: 2 });
    const identityId = createEntityId();
    const legalName = `Concurrent Tenant ${identityId}`;
    await admin`
      INSERT INTO auth_identity (id, name, email, email_verified)
      VALUES (${identityId}, 'Concurrent Owner', ${`concurrent-${identityId}@example.test`}, true)
    `;
    const provision = () =>
      concurrentApp.db.execute(sql`
        SELECT * FROM app.provision_tenant_owner(
          ${identityId}::uuid,
          ${createEntityId()}::uuid,
          ${createEntityId()}::uuid,
          ${createEntityId()}::uuid,
          ${createEntityId()}::uuid,
          ${legalName}
        )
      `);

    const outcomes = await Promise.allSettled([provision(), provision()]);
    await concurrentApp.client.end();
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const [counts] = await admin<{ audits: number; memberships: number; tenants: number }[]>`
      SELECT
        (SELECT count(*)::int FROM auth_membership WHERE identity_id = ${identityId}) AS memberships,
        (SELECT count(*)::int FROM auth_onboarding_audit WHERE identity_id = ${identityId}) AS audits,
        (SELECT count(*)::int FROM tenants WHERE legal_name = ${legalName}) AS tenants
    `;
    expect(counts).toEqual({ audits: 1, memberships: 1, tenants: 1 });
  });

  it("proves policies and runtime role posture in Postgres metadata", async () => {
    const registeredNames = tenantTableRegistry.map(({ sqlName }) => sqlName).sort();
    const discovered = await admin<{ tableName: string }[]>`
      SELECT DISTINCT c.relname AS "tableName"
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attribute a
        ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND (c.relname = 'tenants' OR a.attname = 'tenant_id')
      ORDER BY c.relname
    `;
    expect(discovered.map(({ tableName }) => tableName)).toEqual(registeredNames);

    const tables = await admin<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relname = ANY(${registeredNames})
      ORDER BY relname
    `;
    expect(tables).toHaveLength(registeredNames.length);
    expect(
      tables.every(
        ({ relrowsecurity, relforcerowsecurity }) => relrowsecurity && relforcerowsecurity
      )
    ).toBe(true);

    const roles = await admin<
      {
        rolname: string;
        rolbypassrls: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolinherit: boolean;
        rolsuper: boolean;
      }[]
    >`
      SELECT rolname, rolbypassrls, rolcreatedb, rolcreaterole, rolinherit, rolsuper
      FROM pg_roles WHERE rolname IN ('zabuni_app', 'zabuni_auth') ORDER BY rolname
    `;
    expect(roles).toEqual([
      expect.objectContaining({ rolname: "zabuni_app", rolbypassrls: false, rolsuper: false }),
      expect.objectContaining({ rolname: "zabuni_auth", rolbypassrls: false, rolsuper: false })
    ]);

    const policies = await admin<
      {
        cmd: string;
        permissive: string;
        policyname: string;
        qual: string | null;
        roles: string[];
        tablename: string;
        withCheck: string | null;
      }[]
    >`
      SELECT cmd, permissive, policyname, qual, roles, tablename, with_check AS "withCheck"
      FROM pg_policies WHERE schemaname = 'public'
    `;
    const boundaries = policies.filter(
      ({ policyname, roles }) => policyname.endsWith("_boundary") && roles.includes("zabuni_app")
    );
    expect(boundaries).toHaveLength(registeredNames.length);
    for (const { scopeColumn, sqlName } of tenantTableRegistry) {
      const boundary = boundaries.find(({ tablename }) => tablename === sqlName);
      expect(boundary).toMatchObject({
        cmd: "ALL",
        permissive: "RESTRICTIVE",
        roles: ["zabuni_app"]
      });
      expect(boundary?.qual).toContain(`${scopeColumn} = app.current_tenant_id()`);
      expect(boundary?.withCheck).toContain(`${scopeColumn} = app.current_tenant_id()`);
      expect(policies).toContainEqual(
        expect.objectContaining({
          cmd: "SELECT",
          permissive: "PERMISSIVE",
          roles: ["zabuni_app"],
          tablename: sqlName
        })
      );
    }

    const grants = await admin<{ privilege: string; tableName: string }[]>`
      SELECT table_name AS "tableName", privilege_type AS privilege
      FROM information_schema.role_table_grants
      WHERE grantee = 'zabuni_app' AND table_schema = 'public'
      ORDER BY table_name, privilege_type
    `;
    expect(grants.filter(({ privilege }) => privilege === "DELETE")).toEqual([
      { privilege: "DELETE", tableName: "catalog_imports" }
    ]);
    expect(grants.filter(({ privilege }) => privilege === "UPDATE")).toEqual([
      { privilege: "UPDATE", tableName: "catalog_import_rows" },
      { privilege: "UPDATE", tableName: "catalog_imports" }
    ]);
    expect(grants.filter(({ privilege }) => privilege === "INSERT")).toEqual([
      { privilege: "INSERT", tableName: "catalog_import_rows" },
      { privilege: "INSERT", tableName: "catalog_imports" },
      { privilege: "INSERT", tableName: "usage_events" }
    ]);
    expect(grants.filter(({ privilege }) => privilege === "SELECT")).toHaveLength(
      registeredNames.length
    );

    const itemColumnGrants = await admin<{ columnName: string; privilege: string }[]>`
      SELECT column_name AS "columnName", privilege_type AS privilege
      FROM information_schema.column_privileges
      WHERE grantee = 'zabuni_app' AND table_schema = 'public' AND table_name = 'items'
        AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
      ORDER BY privilege_type, column_name
    `;
    expect(itemColumnGrants.some(({ privilege }) => privilege === "INSERT")).toBe(true);
    expect(itemColumnGrants.some(({ privilege }) => privilege === "UPDATE")).toBe(true);
    expect(itemColumnGrants).not.toContainEqual({ columnName: "tenant_id", privilege: "UPDATE" });
    expect(itemColumnGrants).not.toContainEqual({ columnName: "id", privilege: "UPDATE" });
    expect(itemColumnGrants.some(({ privilege }) => privilege === "DELETE")).toBe(false);

    const owners = await admin<{ owner: string }[]>`
      SELECT tableowner AS owner FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename = ANY(${registeredNames})
    `;
    expect(owners).toHaveLength(registeredNames.length);
    expect(owners.every(({ owner }) => owner === "zabuni_owner")).toBe(true);

    const authGrants = await admin<{ privilege: string; tableName: string }[]>`
      SELECT table_name AS "tableName", privilege_type AS privilege
      FROM information_schema.role_table_grants
      WHERE grantee = 'zabuni_auth' AND table_schema = 'public'
      ORDER BY table_name, privilege_type
    `;
    expect(new Set(authGrants.map(({ tableName }) => tableName))).toEqual(
      new Set([
        "auth_account",
        "auth_identity",
        "auth_rate_limit",
        "auth_session",
        "auth_verification"
      ])
    );
  });
});
