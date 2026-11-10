import { defineConfig } from "drizzle-kit";

// Generation is offline. Apply reviewed SQL using scripts/migrate.ts, never push.
export default defineConfig({
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  strict: true,
  verbose: false,
});
