import "server-only";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema-all";
import { requireDatabaseUrl, runtimeConnectionOptions } from "./connection-options";

function connect() {
  const url = requireDatabaseUrl(process.env.DATABASE_URL, "DATABASE_URL");
  const client = postgres(url, runtimeConnectionOptions);
  return { client, db: drizzle(client, { schema }) };
}

// Keep one pool per process, including across Next development module reloads.
const databaseGlobal = globalThis as typeof globalThis & {
  __mayBeGayDatabase?: ReturnType<typeof connect>;
};

/** No environment reads or network connections happen until the first call. */
export function getDatabase() {
  databaseGlobal.__mayBeGayDatabase ??= connect();
  return databaseGlobal.__mayBeGayDatabase.db;
}

/** For graceful worker shutdown and isolated integration tests. */
export async function closeDatabase(): Promise<void> {
  const current = databaseGlobal.__mayBeGayDatabase;
  delete databaseGlobal.__mayBeGayDatabase;
  if (current) await current.client.end({ timeout: 5 });
}
