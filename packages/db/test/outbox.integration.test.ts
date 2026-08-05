import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEntityId } from "../src/ids.js";
import { applyMigrations } from "../src/migrate.js";
import { createOutboxWorkerStore, type ClaimedOutboxRow } from "../src/privileged/outbox.js";

const adminUrl =
  process.env.DATABASE_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5432/zabuni";
const migratorUrl =
  process.env.MIGRATION_DATABASE_URL ??
  "postgres://zabuni_migrator:zabuni_migrator@localhost:5432/zabuni";
const workerUrl =
  process.env.DATABASE_WORKER_URL ?? "postgres://zabuni_worker:zabuni_worker@localhost:5432/zabuni";
const appUrl = process.env.DATABASE_URL ?? "postgres://zabuni_app:zabuni_app@localhost:5432/zabuni";

const admin = postgres(adminUrl, { onnotice: () => undefined, prepare: false });
const migrator = postgres(migratorUrl, { max: 1, onnotice: () => undefined, prepare: false });
const workerA = postgres(workerUrl, { max: 1, onnotice: () => undefined, prepare: false });
const workerB = postgres(workerUrl, { max: 1, onnotice: () => undefined, prepare: false });
const app = postgres(appUrl, { max: 1, onnotice: () => undefined, prepare: false });
const store = createOutboxWorkerStore(workerUrl);
const tenantA = createEntityId();
const tenantB = createEntityId();

async function provisionWorkerRoles(): Promise<void> {
  await admin.unsafe(`
    DO $roles$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zabuni_owner') THEN
        CREATE ROLE zabuni_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
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
    ALTER ROLE zabuni_migrator PASSWORD 'zabuni_migrator';
    ALTER ROLE zabuni_worker PASSWORD 'zabuni_worker';
    GRANT zabuni_owner TO zabuni_migrator;
    GRANT zabuni_outbox_claim_owner TO zabuni_owner;
    REVOKE zabuni_outbox_claim_owner, zabuni_owner, zabuni_migrator FROM zabuni_worker;
    GRANT CONNECT ON DATABASE zabuni TO zabuni_migrator, zabuni_app, zabuni_auth, zabuni_worker;
    GRANT CREATE ON DATABASE zabuni TO zabuni_owner;
    GRANT USAGE, CREATE ON SCHEMA public TO zabuni_owner;
    GRANT USAGE ON SCHEMA public TO zabuni_migrator, zabuni_app, zabuni_auth, zabuni_outbox_claim_owner, zabuni_worker;
  `);
}

async function enqueue(tenantId: string, key: string, maxAttempts = 3): Promise<string> {
  const id = createEntityId();
  await admin`
    INSERT INTO outbox (
      id, tenant_id, event_type, payload_version, payload, idempotency_key,
      max_attempts, next_attempt_at
    ) VALUES (
      ${id}, ${tenantId}, 'fixture.delivery', 1, '{}'::jsonb, ${key},
      ${maxAttempts}, '2000-01-01T00:00:00Z'
    )
  `;
  return id;
}

beforeAll(async () => {
  await provisionWorkerRoles();
  await migrator`SET ROLE zabuni_owner`;
  await applyMigrations(migrator);
  await admin`
    INSERT INTO tenants (id, legal_name, plan, status)
    VALUES (${tenantA}, 'Outbox Tenant A', 'foundation', 'active'),
           (${tenantB}, 'Outbox Tenant B', 'foundation', 'active')
  `;
});

afterAll(async () => {
  await admin`DELETE FROM tenants WHERE id IN (${tenantA}, ${tenantB})`;
  await store.close();
  await workerA.end();
  await workerB.end();
  await app.end();
  await migrator.end();
  await admin.end();
});

describe("Postgres outbox worker boundary", () => {
  it("claims concurrently with SKIP LOCKED and never duplicates a row", async () => {
    const firstId = await enqueue(tenantA, `concurrent-a-${createEntityId()}`);
    const secondId = await enqueue(tenantB, `concurrent-b-${createEntityId()}`);
    const [first, second] = await Promise.all([
      workerA<ClaimedOutboxRow[]>`SELECT * FROM app.claim_outbox('worker-a', 1, 60)`,
      workerB<ClaimedOutboxRow[]>`SELECT * FROM app.claim_outbox('worker-b', 1, 60)`
    ]);
    expect(new Set([...first, ...second].map(({ id }) => id))).toEqual(
      new Set([firstId, secondId])
    );
    await admin`
      UPDATE outbox
      SET state = 'sent', terminal_at = now(), claimed_at = NULL,
          claim_expires_at = NULL, claimed_by = NULL, claim_token = NULL
      WHERE id IN (${firstId}, ${secondId})
    `;
  });

  it("uses tenant RLS for transitions and rejects a stale claim token", async () => {
    const id = await enqueue(tenantA, `stale-${createEntityId()}`, 1);
    const [stale] = await store.claim("worker-stale", 1, 5);
    expect(stale?.id).toBe(id);
    await admin`UPDATE outbox SET claim_expires_at = now() - interval '1 second' WHERE id = ${id}`;
    const [current] = await store.claim("worker-current", 1, 5);
    if (stale === undefined || current === undefined) throw new Error("expected claims");
    await expect(store.markSent(stale, "stale-result")).resolves.toBe(false);
    await expect(store.markSent(current, "fixture-result")).resolves.toBe(true);

    const [row] = await admin<{ resultRef: string; state: string }[]>`
      SELECT result_ref AS "resultRef", state FROM outbox WHERE id = ${id}
    `;
    expect(row).toEqual({ resultRef: "fixture-result", state: "sent" });
  });

  it("atomically records a tenant-visible incident on terminal failure", async () => {
    const id = await enqueue(tenantB, `permanent-${createEntityId()}`, 1);
    const [claim] = await store.claim("worker-failure", 1, 60);
    if (claim === undefined) throw new Error("expected claim");
    expect(claim.id).toBe(id);
    await expect(
      store.markFailed(claim, {
        errorCode: "permanent_rejection",
        permanent: true,
        retryDelaySeconds: 0
      })
    ).resolves.toBe(true);
    const [row] = await admin<{ incidents: number; state: string }[]>`
      SELECT o.state, count(i.id)::int AS incidents
      FROM outbox o LEFT JOIN incidents i ON i.outbox_id = o.id AND i.tenant_id = o.tenant_id
      WHERE o.id = ${id}
      GROUP BY o.state
    `;
    expect(row).toEqual({ incidents: 1, state: "failed_permanent" });
  });

  it("fails closed without tenant context and exposes only the claim function cross-tenant", async () => {
    await expect(workerA`SELECT id FROM outbox`).rejects.toMatchObject({ code: "42501" });
    await expect(workerA`UPDATE outbox SET state = 'sent'`).rejects.toMatchObject({
      code: "42501"
    });
    await expect(
      workerA`INSERT INTO incidents (id, tenant_id, kind, summary) VALUES (${createEntityId()}, ${tenantA}, 'x', 'x')`
    ).rejects.toMatchObject({ code: "42501" });
    const [workerRole] = await admin<
      { rolbypassrls: boolean; rolinherit: boolean; rolsuper: boolean }[]
    >`SELECT rolbypassrls, rolinherit, rolsuper FROM pg_roles WHERE rolname = 'zabuni_worker'`;
    expect(workerRole).toEqual({ rolbypassrls: false, rolinherit: false, rolsuper: false });

    const [claimFunction] = await admin<{ owner: string; securityDefiner: boolean }[]>`
      SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS "securityDefiner"
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app' AND p.proname = 'claim_outbox'
    `;
    expect(claimFunction).toEqual({ owner: "zabuni_outbox_claim_owner", securityDefiner: true });

    const [claimOwner] = await admin<
      { rolbypassrls: boolean; rolcanlogin: boolean; rolsuper: boolean }[]
    >`
      SELECT rolbypassrls, rolcanlogin, rolsuper
      FROM pg_roles WHERE rolname = 'zabuni_outbox_claim_owner'
    `;
    expect(claimOwner).toEqual({ rolbypassrls: true, rolcanlogin: false, rolsuper: false });

    const executions = await admin<
      { app: boolean; functionName: string; public: boolean; worker: boolean }[]
    >`
      SELECT p.proname AS "functionName",
        has_function_privilege('zabuni_app', p.oid, 'EXECUTE') AS app,
        EXISTS (
          SELECT 1
          FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
          WHERE acl.grantee = 0
            AND acl.privilege_type = 'EXECUTE'
        ) AS public,
        has_function_privilege('zabuni_worker', p.oid, 'EXECUTE') AS worker
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app'
        AND p.proname IN ('claim_outbox', 'complete_outbox', 'fail_outbox')
      ORDER BY p.proname
    `;
    expect(executions).toEqual([
      { app: false, functionName: "claim_outbox", public: false, worker: true },
      { app: false, functionName: "complete_outbox", public: false, worker: true },
      { app: false, functionName: "fail_outbox", public: false, worker: true }
    ]);

    const updateColumns = await admin<{ columnName: string }[]>`
      SELECT column_name AS "columnName"
      FROM information_schema.column_privileges
      WHERE table_schema = 'public'
        AND table_name = 'outbox'
        AND grantee = 'zabuni_worker'
        AND privilege_type = 'UPDATE'
      ORDER BY column_name
    `;
    expect(updateColumns).toEqual([]);
  });

  it("does not let the app inject processing or lease state while enqueueing", async () => {
    await expect(
      app.begin(async (transaction) => {
        await transaction`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
        await transaction`
          INSERT INTO outbox (
            id, tenant_id, event_type, payload_version, payload, idempotency_key,
            max_attempts, state, claimed_by, claim_token, claimed_at, claim_expires_at
          ) VALUES (
            ${createEntityId()}, ${tenantA}, 'fixture.delivery', 1, '{}'::jsonb,
            ${`injected-${createEntityId()}`}, 3, 'processing', 'attacker',
            gen_random_uuid(), now(), now() + interval '1 minute'
          )
        `;
      })
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("recovers every expired processing row so none remains stuck", async () => {
    const ids = await Promise.all([
      enqueue(tenantA, `recover-a-${createEntityId()}`),
      enqueue(tenantB, `recover-b-${createEntityId()}`)
    ]);
    const claims = await store.claim("worker-crashed", 2, 5);
    expect(new Set(claims.map(({ id }) => id))).toEqual(new Set(ids));
    await admin`
      UPDATE outbox SET claim_expires_at = now() - interval '1 second'
      WHERE id = ANY(${ids})
    `;
    const recovered = await store.claim("worker-recovery", 2, 5);
    expect(new Set(recovered.map(({ id }) => id))).toEqual(new Set(ids));
    for (const claim of recovered) {
      await expect(store.markSent(claim, `recovered:${claim.id}`)).resolves.toBe(true);
    }
    const [remaining] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM outbox
      WHERE id = ANY(${ids}) AND state = 'processing'
    `;
    expect(remaining?.count).toBe(0);
  });
});
