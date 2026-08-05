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
      "0004_outbox.sql"
    ]);
    expect(new Set(migrations.map(({ checksum }) => checksum)).size).toBe(migrations.length);
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
