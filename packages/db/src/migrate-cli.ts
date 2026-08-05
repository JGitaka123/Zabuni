import postgres from "postgres";

import { applyMigrations } from "./migrate.js";

const connectionString = process.env.MIGRATION_DATABASE_URL;

if (connectionString === undefined || connectionString.length === 0) {
  throw new Error("MIGRATION_DATABASE_URL is required");
}

const sql = postgres(connectionString, { max: 1, prepare: false });

try {
  await applyMigrations(sql);
} finally {
  await sql.end();
}
