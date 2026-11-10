import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { DatabaseConfigurationError, requireDatabaseUrl } from "../src/server/db/connection-options";

async function main(): Promise<void> {
  // Never fall back to the less privileged application URL or driver defaults.
  const url = requireDatabaseUrl(process.env.MIGRATION_DATABASE_URL, "MIGRATION_DATABASE_URL");
  const client = postgres(url, {
    max: 1, connect_timeout: 10, idle_timeout: 5,
    connection: { application_name: "may-be-gay-migrate", search_path: "public" },
    onnotice: () => {},
  });
  try {
    // The CLI should have one runner per deployment. A session advisory lock also
    // serializes accidental concurrent runners on this single-connection client.
    await client`SELECT pg_advisory_lock(742609310)`;
    await migrate(drizzle(client), {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
      migrationsSchema: "drizzle",
    });
    console.log("Database migrations applied.");
  } finally {
    // Closing the session releases its advisory lock even after a migration error.
    await client.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  if (error instanceof DatabaseConfigurationError) console.error(error.message);
  else {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
    // The error message/query/cause can contain connection credentials or row data.
    console.error(`Database migration failed (code: ${/^[A-Z0-9_]+$/.test(code) ? code : "unknown"}). Check connectivity, migration-role privileges, and reviewed SQL.`);
  }
  process.exitCode = 1;
});
