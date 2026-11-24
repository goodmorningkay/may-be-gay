import { defineConfig } from "drizzle-kit";

// Generation is offline. Apply reviewed SQL using scripts/migrate.ts, never push.
export default defineConfig({
  schema: [
    "./src/server/db/schema.ts",
    "./src/server/db/schema-accounts.ts",
    "./src/server/db/schema-media.ts",
    "./src/server/db/schema-operations.ts",
    "./src/server/db/schema-settings.ts",
    "./src/server/db/schema-worker.ts",
  ],
  out: "./drizzle",
  dialect: "postgresql",
  strict: true,
  verbose: false,
});
