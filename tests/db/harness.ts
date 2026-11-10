import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import * as schema from "../../src/server/db/schema";
import { requireDatabaseUrl } from "../../src/server/db/connection-options";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** Destructive bootstrap: only use a disposable, migrator-owned *_test database. */
export async function bootstrapTestDatabase(rawUrl: string) {
  const url = requireDatabaseUrl(rawUrl, "TEST_DATABASE_URL");
  if (!/^\/[a-z0-9_]+_test$/.test(new URL(url).pathname)) {
    throw new Error("TEST_DATABASE_URL must name a disposable database ending in _test; its foundation tables will be reset.");
  }
  const client = postgres(url, { max: 4, connect_timeout: 5, onnotice: () => {} });
  const db = drizzle(client, { schema });
  const applyMigrations = () => migrate(db, { migrationsFolder });
  try {
    // Preserve the public schema and infrastructure's default grants/ownership.
    await client`DROP SCHEMA IF EXISTS drizzle CASCADE`;
    await client`DROP TABLE IF EXISTS public.account, public.audit_events,
      public.daily_link_metrics, public.daily_profile_metrics, public.draft_media,
      public.invites, public.jobs, public.media, public.profile_drafts,
      public.profile_revisions, public.profiles, public.reports,
      public.revision_media, public.session, public.two_factor, public."user",
      public.username_claims, public.verification CASCADE`;
    await client`DROP FUNCTION IF EXISTS public.guard_username_claim(),
      public.guard_profile_identity(), public.guard_profile_revision(),
      public.guard_draft_version(), public.guard_invite() CASCADE`;
    await applyMigrations();
    return {
      client, db, applyMigrations,
      async reset() {
        // TRUNCATE is intentional in this test-only migrator harness; the app
        // role must not have that privilege and cannot bypass tombstone guards.
        await client`TRUNCATE public."user", public.verification,
          public.username_claims, public.invites, public.jobs RESTART IDENTITY CASCADE`;
      },
      async close() { await client.end({ timeout: 5 }); },
    };
  } catch (error) {
    await client.end({ timeout: 5 });
    throw error;
  }
}
