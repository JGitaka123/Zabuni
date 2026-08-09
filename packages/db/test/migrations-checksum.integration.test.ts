import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { applyMigrations } from "../src/migrate.js";

const adminUrl =
  process.env.DATABASE_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5432/zabuni";

const admin = postgres(adminUrl, { onnotice: () => undefined, prepare: false, max: 1 });
const createdSchemas: string[] = [];
const createdConnections: postgres.Sql[] = [];

/**
 * Applies migrations inside a throwaway schema so the ledger under test is
 * isolated from the real `_zabuni_migrations` table.
 */
async function scopedRunner(label: string): Promise<postgres.Sql> {
  const schema = `migration_checksum_${label}`;
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  createdSchemas.push(schema);
  const connection = postgres(adminUrl, {
    onnotice: () => undefined,
    prepare: false,
    max: 1,
    connection: { search_path: schema }
  });
  createdConnections.push(connection);
  return connection;
}

afterAll(async () => {
  await Promise.all(createdConnections.map((connection) => connection.end()));
  for (const schema of createdSchemas) {
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }
  await admin.end();
});

describe("forward-only migration ledger", () => {
  it("refuses to run when an already-applied migration is edited", async () => {
    const runner = await scopedRunner("mutation");
    const directory = await mkdtemp(join(tmpdir(), "zabuni-migrations-"));
    const first = join(directory, "0000_initial.sql");
    await writeFile(first, "CREATE TABLE demo (id integer PRIMARY KEY);");

    await applyMigrations(runner, directory);
    // Re-running an unchanged set is a no-op, not an error.
    await expect(applyMigrations(runner, directory)).resolves.toBeUndefined();

    // Editing a shipped migration is the failure this ledger exists to catch.
    await writeFile(first, "CREATE TABLE demo (id integer PRIMARY KEY, extra integer);");
    await expect(applyMigrations(runner, directory)).rejects.toThrow(
      "Applied migration 0000_initial.sql has been modified"
    );

    // The edit must not have been partially applied.
    const columns = await runner<{ columnName: string }[]>`
      SELECT column_name AS "columnName"
      FROM information_schema.columns
      WHERE table_name = 'demo' AND table_schema = current_schema()
    `;
    expect(columns.map(({ columnName }) => columnName)).toEqual(["id"]);
  });

  it("still applies genuinely new migrations appended after the ledger exists", async () => {
    const runner = await scopedRunner("append");
    const directory = await mkdtemp(join(tmpdir(), "zabuni-migrations-"));
    await writeFile(join(directory, "0000_initial.sql"), "CREATE TABLE demo (id integer);");
    await applyMigrations(runner, directory);

    await writeFile(
      join(directory, "0001_extend.sql"),
      "ALTER TABLE demo ADD COLUMN extra integer;"
    );
    await applyMigrations(runner, directory);

    const applied = await runner<{ name: string }[]>`
      SELECT name FROM _zabuni_migrations ORDER BY name
    `;
    expect(applied.map(({ name }) => name)).toEqual(["0000_initial.sql", "0001_extend.sql"]);
  });

  it("rolls the whole batch back when a later migration fails", async () => {
    const runner = await scopedRunner("rollback");
    const directory = await mkdtemp(join(tmpdir(), "zabuni-migrations-"));
    await writeFile(join(directory, "0000_initial.sql"), "CREATE TABLE demo (id integer);");
    await writeFile(join(directory, "0001_broken.sql"), "ALTER TABLE nope ADD COLUMN x integer;");

    await expect(applyMigrations(runner, directory)).rejects.toThrow();

    // The valid first migration must not survive a failed batch, or the ledger
    // and the schema would disagree on the next run.
    const tables = await runner<{ tableName: string }[]>`
      SELECT table_name AS "tableName"
      FROM information_schema.tables
      WHERE table_schema = current_schema()
    `;
    expect(tables.map(({ tableName }) => tableName)).not.toContain("demo");
  });
});
