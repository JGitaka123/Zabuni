import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Sql } from "postgres";

export interface Migration {
  readonly checksum: string;
  readonly name: string;
  readonly sql: string;
}

const defaultMigrationsDirectory = fileURLToPath(new URL("../migrations", import.meta.url));

export async function readMigrations(
  directory = defaultMigrationsDirectory
): Promise<readonly Migration[]> {
  const names = (await readdir(directory))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
    .sort();

  return Promise.all(
    names.map(async (name) => {
      const migrationSql = await readFile(resolve(directory, name), "utf8");
      return {
        checksum: createHash("sha256").update(migrationSql).digest("hex"),
        name,
        sql: migrationSql
      };
    })
  );
}

export async function applyMigrations(sql: Sql, directory?: string): Promise<void> {
  const migrations = await readMigrations(directory);

  await sql.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(hashtext('zabuni:migrations'))`;
    await transaction.unsafe(`
      CREATE TABLE IF NOT EXISTS _zabuni_migrations (
        name text PRIMARY KEY,
        checksum char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const applied = await transaction<{ name: string; checksum: string }[]>`
      SELECT name, checksum FROM _zabuni_migrations ORDER BY name
    `;
    const appliedByName = new Map(applied.map((entry) => [entry.name, entry.checksum]));

    for (const migration of migrations) {
      const previousChecksum = appliedByName.get(migration.name);
      if (previousChecksum !== undefined) {
        if (previousChecksum !== migration.checksum) {
          throw new Error(`Applied migration ${migration.name} has been modified`);
        }
        continue;
      }

      await transaction.unsafe(migration.sql);
      await transaction`
        INSERT INTO _zabuni_migrations (name, checksum)
        VALUES (${migration.name}, ${migration.checksum})
      `;
    }
  });
}
