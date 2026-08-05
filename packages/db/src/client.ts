import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { schema } from "./schema.js";

export interface DatabaseOptions {
  readonly maxConnections?: number;
}

export function createDatabase(connectionString: string, options: DatabaseOptions = {}) {
  const client = postgres(connectionString, {
    ...(options.maxConnections === undefined ? {} : { max: options.maxConnections }),
    prepare: false
  });
  return {
    client,
    db: drizzle(client, { schema })
  };
}

export type Database = ReturnType<typeof createDatabase>["db"];
