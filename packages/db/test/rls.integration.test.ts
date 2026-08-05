import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "../src/client.js";
import { createEntityId } from "../src/ids.js";
import { applyMigrations } from "../src/migrate.js";
import {
  incidents,
  items,
  outbox,
  tenantTableRegistry,
  tenants,
  usageEvents,
  users
} from "../src/schema.js";
import { withTenant } from "../src/tenant-context.js";

const adminUrl = process.env.DATABASE_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5432/zabuni";
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
  userA: createEntityId(),
  userB: createEntityId(),
  itemA: createEntityId(),
  itemB: createEntityId(),
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
    END
    $roles$;
    ALTER ROLE zabuni_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    ALTER ROLE zabuni_migrator LOGIN PASSWORD 'zabuni_migrator' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    ALTER ROLE zabuni_app LOGIN PASSWORD 'zabuni_app' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    GRANT zabuni_owner TO zabuni_migrator;
    REVOKE zabuni_owner, zabuni_migrator FROM zabuni_app;
    GRANT CONNECT ON DATABASE zabuni TO zabuni_migrator, zabuni_app;
    GRANT CREATE ON DATABASE zabuni TO zabuni_owner;
    GRANT USAGE, CREATE ON SCHEMA public TO zabuni_owner;
    GRANT USAGE ON SCHEMA public TO zabuni_migrator;
    GRANT USAGE ON SCHEMA public TO zabuni_app;
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
    INSERT INTO items (id, tenant_id, sku, description, tax_class)
    VALUES (${ids.itemA}, ${tenantA}, 'A-1', 'A item', 'standard_16'),
           (${ids.itemB}, ${tenantB}, 'B-1', 'B item', 'zero_rated')
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
  await app.client.end();
  await migrator.end();
  await admin.end();
});

describe("tenant RLS through Drizzle", () => {
  it("isolates every tenant-owned table for tenant A", async () => {
    await withTenant(app.db, tenantA, async (db) => {
      await expect(db.select({ id: tenants.id }).from(tenants)).resolves.toEqual([{ id: tenantA }]);
      await expect(db.select({ id: users.id }).from(users)).resolves.toEqual([{ id: ids.userA }]);
      await expect(db.select({ id: items.id }).from(items)).resolves.toEqual([{ id: ids.itemA }]);
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
    });
  });

  it("mirrors isolation for tenant B", async () => {
    await withTenant(app.db, tenantB, async (db) => {
      const rows = await db.select().from(items);
      expect(rows.map(({ id }) => id)).toEqual([ids.itemB]);
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
        await expect(db.select({ id: items.id }).from(items)).resolves.toEqual([
          { id: ids.itemA }
        ]);
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
  });

  it("rejects cross-tenant parent references", async () => {
    await expect(
      admin`
        INSERT INTO incidents (id, tenant_id, outbox_id, kind, summary)
        VALUES (${createEntityId()}, ${tenantA}, ${ids.outboxB}, 'invalid', 'cross-tenant link')
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
    await expect(withTenant(app.db, "not-a-tenant", () => Promise.resolve(undefined))).rejects.toThrow(
      "verified UUIDv7"
    );
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
      WHERE relname IN ('tenants', 'users', 'items', 'usage_events', 'outbox', 'incidents')
      ORDER BY relname
    `;
    expect(tables).toHaveLength(6);
    expect(
      tables.every(({ relrowsecurity, relforcerowsecurity }) => relrowsecurity && relforcerowsecurity)
    ).toBe(true);

    const [role] = await admin<
      {
        rolbypassrls: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolinherit: boolean;
        rolsuper: boolean;
      }[]
    >`
      SELECT rolbypassrls, rolcreatedb, rolcreaterole, rolinherit, rolsuper
      FROM pg_roles WHERE rolname = 'zabuni_app'
    `;
    expect(role).toEqual({
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolinherit: false,
      rolsuper: false
    });

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
    const boundaries = policies.filter(({ policyname }) => policyname.endsWith("_boundary"));
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
    expect(grants.filter(({ privilege }) => privilege === "DELETE" || privilege === "UPDATE")).toEqual([]);
    expect(grants.filter(({ privilege }) => privilege === "INSERT")).toEqual([
      { privilege: "INSERT", tableName: "outbox" },
      { privilege: "INSERT", tableName: "usage_events" }
    ]);
    expect(grants.filter(({ privilege }) => privilege === "SELECT")).toHaveLength(registeredNames.length);

    const owners = await admin<{ owner: string }[]>`
      SELECT tableowner AS owner FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN ('tenants', 'users', 'items', 'usage_events', 'outbox', 'incidents')
    `;
    expect(owners).toHaveLength(6);
    expect(owners.every(({ owner }) => owner === "zabuni_owner")).toBe(true);
  });
});
