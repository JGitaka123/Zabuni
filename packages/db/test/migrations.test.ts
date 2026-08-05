import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readMigrations } from "../src/migrate.js";

describe("forward-only migrations", () => {
  it("discovers the complete ordered Phase 0 F-2 sequence", async () => {
    const migrations = await readMigrations();

    expect(migrations.map(({ name }) => name)).toEqual([
      "0000_foundation.sql",
      "0001_tenancy.sql",
      "0002_items.sql",
      "0003_usage_events.sql",
      "0004_outbox.sql",
      "0005_rls.sql",
      "0006_auth.sql",
      "0007_outbox_worker.sql"
    ]);
    expect(new Set(migrations.map(({ checksum }) => checksum)).size).toBe(migrations.length);
  });

  it("enables and forces tenant RLS with restrictive boundaries", async () => {
    const migrations = await readMigrations();
    const rls = migrations.find(({ name }) => name === "0005_rls.sql")?.sql ?? "";

    for (const table of ["tenants", "users", "items", "usage_events", "outbox", "incidents"]) {
      expect(rls).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(rls).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      expect(rls).toContain(`CREATE POLICY ${table}_boundary ON ${table} AS RESTRICTIVE`);
    }
    expect(rls).toContain("current_setting('app.tenant_id', true)");
  });

  it("sorts migration files and ignores unrelated files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zabuni-migrations-"));
    await Promise.all([
      writeFile(join(directory, "0001_second.sql"), "SELECT 2;"),
      writeFile(join(directory, "0000_first.sql"), "SELECT 1;"),
      writeFile(join(directory, "README.md"), "not a migration")
    ]);

    const migrations = await readMigrations(directory);
    expect(migrations.map(({ name }) => name)).toEqual(["0000_first.sql", "0001_second.sql"]);
  });

  it("keeps tax classification explicit and constrained", async () => {
    const migrations = await readMigrations();
    const itemsMigration = migrations.find(({ name }) => name === "0002_items.sql");

    expect(itemsMigration?.sql).toMatch(/tax_class text NOT NULL/u);
    expect(itemsMigration?.sql).not.toMatch(/tax_class text NOT NULL DEFAULT/u);
    expect(itemsMigration?.sql).toContain("'standard_16', 'zero_rated', 'exempt'");
  });

  it("never uses database-generated UUID defaults or floating-point money", async () => {
    const migrations = await readMigrations();
    const source = migrations.map(({ sql }) => sql).join("\n");

    expect(source).not.toMatch(/uuid[^,\n]*DEFAULT/iu);
    expect(source).not.toMatch(/\b(real|double precision|numeric|decimal)\b/iu);
    expect(source).toMatch(/cost_minor bigint/u);
    expect(source).toMatch(/unit_cost_minor bigint/u);
  });
});
