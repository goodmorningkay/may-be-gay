import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { defaultProfileDocument, type ProfileDocument } from "@/domain/profile";
import { reservedUsernames } from "@/domain/hosts";
import { closeDatabase } from "@/server/db";
import { getPublishedProfile } from "@/server/profiles";
import * as tables from "@/server/db/schema";
import { requireDatabaseUrl } from "@/server/db/connection-options";
import { bootstrapTestDatabase } from "./harness";
import migrationJournal from "../../drizzle/meta/_journal.json";

const testUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
if (process.env.CI && (!testUrl || !appUrl)) throw new Error("CI must set both TEST_DATABASE_URL and TEST_APP_DATABASE_URL to run PostgreSQL migration and runtime-role isolation checks.");

// CI must supply TEST_DATABASE_URL. A missing URL skips, a broken URL fails.
const dbSuite = testUrl ? describe : describe.skip;

dbSuite("PostgreSQL persistence (disposable *_test database)", () => {
  let harness: Awaited<ReturnType<typeof bootstrapTestDatabase>>;
  const db = () => harness.db;

  beforeAll(async () => {
    harness = await bootstrapTestDatabase(testUrl!);
    if (appUrl && (new URL(appUrl).pathname !== new URL(testUrl!).pathname || new URL(appUrl).host !== new URL(testUrl!).host)) {
      throw new Error("TEST_APP_DATABASE_URL must target the same disposable test database.");
    }
    vi.stubEnv("DATABASE_URL", appUrl ?? testUrl!);
  }, 30_000);
  beforeEach(async () => { await harness.reset(); });
  afterAll(async () => {
    await closeDatabase();
    if (harness) await harness.close();
    vi.unstubAllEnvs();
  });

  async function owner(username: string) {
    const id = randomUUID();
    await db().insert(tables.user).values({ id, email: `${id}@private.invalid`, name: "Private account name", emailVerified: true });
    await db().insert(tables.usernameClaims).values({ username, ownerId: id });
    const [profile] = await db().insert(tables.profiles).values({ ownerId: id }).returning();
    await db().insert(tables.profileDrafts).values({ profileId: profile.id, document: { ...defaultProfileDocument, bio: "PRIVATE DRAFT ONLY" } });
    return { id, profileId: profile.id, username };
  }

  async function publish(person: Awaited<ReturnType<typeof owner>>, document: unknown = defaultProfileDocument, revisionNumber = 1) {
    const [revision] = await db().insert(tables.profileRevisions).values({ profileId: person.profileId, document, revisionNumber }).returning();
    await db().update(tables.profiles).set({ currentRevisionId: revision.id }).where(eq(tables.profiles.id, person.profileId));
    return revision;
  }

  it("migrates an empty database and reapplying the journal is a no-op", async () => {
    await harness.applyMigrations();
    const [row] = await harness.client`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
    expect(row.count).toBe(migrationJournal.entries.length);
    const [trigger] = await harness.client`SELECT count(*)::int AS count FROM pg_trigger WHERE tgname = 'draft_version_guard' AND NOT tgisinternal`;
    expect(trigger.count).toBe(1);
  });

  it("upgrades retained history to a durable counter and prevents lowering it", async () => {
    const existing = await owner("counter-upgrade"), empty = await owner("counter-empty");
    await publish(existing, defaultProfileDocument, 7);
    await publish(existing, defaultProfileDocument, 12);
    const oldGuards = await readFile(new URL("../../drizzle/0001_persistence_guards.sql", import.meta.url), "utf8");
    const oldGuard = oldGuards.split("--> statement-breakpoint").find(statement => statement.includes("CREATE FUNCTION public.guard_profile_identity()"))!;
    const upgrade = await readFile(new URL("../../drizzle/0007_publication_counter.sql", import.meta.url), "utf8");
    const rollback = new Error("rollback isolated migration probe");
    await expect(harness.client.begin(async tx => {
      // Restore the pre-counter shape/guard inside a rollback-only transaction,
      // then execute the actual migration against existing retained history.
      await tx.unsafe(oldGuard.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION"));
      await tx`ALTER TABLE public.profiles DROP COLUMN publication_number`;
      for (const statement of upgrade.split("--> statement-breakpoint")) await tx.unsafe(statement);
      expect((await tx`SELECT publication_number FROM profiles WHERE id=${existing.profileId}`)[0].publication_number).toBe(12);
      expect((await tx`SELECT publication_number FROM profiles WHERE id=${empty.profileId}`)[0].publication_number).toBe(0);
      await expect(tx.savepoint(async probe => {
        await probe`UPDATE profiles SET publication_number=11 WHERE id=${existing.profileId}`;
      })).rejects.toMatchObject({ code: "23514" });
      await tx`UPDATE profiles SET publication_number=13 WHERE id=${existing.profileId}`;
      throw rollback;
    })).rejects.toBe(rollback);
  });

  it("has working Better Auth core and pinned 1.7 second-factor fields", async () => {
    const person = await owner("auth-fields");
    await db().insert(tables.session).values({ id: randomUUID(), userId: person.id, token: "private-session-token", expiresAt: new Date(Date.now() + 60_000) });
    await db().insert(tables.account).values({ id: randomUUID(), userId: person.id, accountId: person.id, providerId: "credential", password: "private-library-hash" });
    await db().insert(tables.verification).values({ id: randomUUID(), identifier: person.id, value: "private-verification", expiresAt: new Date(Date.now() + 60_000) });
    await db().insert(tables.twoFactor).values({ id: randomUUID(), userId: person.id, secret: "library-encrypted-secret", backupCodes: "library-encrypted-codes", verified: false, failedVerificationCount: 2 });
    const [factor] = await db().select().from(tables.twoFactor);
    expect(factor).toMatchObject({ verified: false, failedVerificationCount: 2, lockedUntil: null });
  });

  it.each(["ab", "a".repeat(31), "Mixed", "-start", "end-", "has.dot", "has_underscore", "éclair", "xn--example", "app", "media", "support", "admin", "staging"])("rejects invalid or reserved username %s", async (username) => {
    const person = await owner("valid-owner");
    await db().update(tables.usernameClaims).set({ ownerId: null }).where(eq(tables.usernameClaims.username, person.username));
    const reserved = ["app", "media", "support", "admin", "staging"].includes(username);
    await expect(harness.client`INSERT INTO public.username_claims (username, owner_id) VALUES (${username}, ${person.id})`).rejects.toMatchObject({
      code: "23514", constraint_name: reserved ? "username_reserved_check" : "username_format_check",
    });
  });

  it("resolves simultaneous claims by different owners with exactly one winner", async () => {
    const a = await owner("first-owner");
    const b = await owner("second-owner");
    // Retire the setup reservations without deleting their tombstones.
    await db().update(tables.usernameClaims).set({ ownerId: null }).where(sql`${tables.usernameClaims.ownerId} IN (${a.id}, ${b.id})`);
    const results = await Promise.allSettled([
      db().insert(tables.usernameClaims).values({ username: "contested", ownerId: a.id }),
      db().insert(tables.usernameClaims).values({ username: "contested", ownerId: b.id }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [claim] = await db().select().from(tables.usernameClaims).where(eq(tables.usernameClaims.username, "contested"));
    expect([a.id, b.id]).toContain(claim.ownerId);
  });

  it("reserves every hostname used by the application at the database boundary too", async () => {
    const person = await owner("reserved-test-owner");
    await db().update(tables.usernameClaims).set({ ownerId: null }).where(eq(tables.usernameClaims.username, person.username));
    for (const username of reservedUsernames) {
      await expect(harness.client`INSERT INTO public.username_claims (username, owner_id) VALUES (${username}, ${person.id})`)
        .rejects.toMatchObject({ code: "23514", constraint_name: "username_reserved_check" });
    }
  });

  it("permits one claim per owner and forbids moving a reservation to another owner", async () => {
    const a = await owner("one-owner");
    const b = await owner("other-owner");
    await expect(db().insert(tables.usernameClaims).values({ username: "second-name", ownerId: a.id })).rejects.toThrow();
    await expect(db().update(tables.usernameClaims).set({ ownerId: b.id }).where(eq(tables.usernameClaims.username, a.username))).rejects.toThrow();
  });

  it("deletes account data and retains a permanent name without its former identity", async () => {
    const person = await owner("retained-name");
    const revision = await publish(person);
    const [asset] = await db().insert(tables.media).values({ ownerId: person.id, objectKey: randomUUID(), kind: "image" }).returning();
    await db().insert(tables.revisionMedia).values({ profileId: person.profileId, revisionId: revision.id, ownerId: person.id, mediaId: asset.id });
    await db().insert(tables.draftMedia).values({ profileId: person.profileId, ownerId: person.id, mediaId: asset.id });
    await db().delete(tables.user).where(eq(tables.user.id, person.id));
    const [claim] = await db().select().from(tables.usernameClaims);
    expect(claim).toMatchObject({ username: person.username, ownerId: null });
    expect(claim.retiredAt).toBeInstanceOf(Date);
    expect(await db().select().from(tables.profiles)).toHaveLength(0);
    expect(await db().select().from(tables.profileRevisions)).toHaveLength(0);
    expect(await db().select().from(tables.media)).toHaveLength(0);
    expect(await db().select().from(tables.revisionMedia)).toHaveLength(0);
    expect(await getPublishedProfile(person.username)).toBeNull();
    const next = await owner("replacement-owner");
    await expect(db().insert(tables.usernameClaims).values({ username: person.username, ownerId: next.id })).rejects.toThrow();
    await expect(db().update(tables.usernameClaims).set({ ownerId: next.id, retiredAt: null }).where(eq(tables.usernameClaims.username, person.username))).rejects.toThrow();
    await expect(db().delete(tables.usernameClaims).where(eq(tables.usernameClaims.username, person.username))).rejects.toThrow();
  });

  it("rejects cross-profile publication and leaves the previous revision published", async () => {
    const a = await owner("profile-alice");
    const b = await owner("profile-bob");
    const original = await publish(a);
    const other = await publish(b);
    await expect(db().update(tables.profiles).set({ currentRevisionId: other.id }).where(eq(tables.profiles.id, a.profileId))).rejects.toThrow();
    expect((await getPublishedProfile(a.username))?.revisionId).toBe(original.id);
    await expect(db().delete(tables.profileRevisions).where(eq(tables.profileRevisions.id, original.id))).rejects.toThrow();
    await expect(db().update(tables.profileRevisions).set({ document: { ...defaultProfileDocument, bio: "changed" } }).where(eq(tables.profileRevisions.id, original.id))).rejects.toThrow();
  });

  it("rejects stale optimistic draft saves and unchanged edit versions", async () => {
    const person = await owner("draft-version");
    await expect(db().update(tables.profileDrafts).set({ document: defaultProfileDocument }).where(eq(tables.profileDrafts.profileId, person.profileId))).rejects.toThrow();
    const save = () => db().update(tables.profileDrafts).set({ editVersion: 2, document: defaultProfileDocument }).where(and(eq(tables.profileDrafts.profileId, person.profileId), eq(tables.profileDrafts.editVersion, 1))).returning();
    const saves = await Promise.all([save(), save()]);
    expect(saves.map((rows) => rows.length).sort()).toEqual([0, 1]);
    await expect(db().update(tables.profileDrafts).set({ editVersion: 4 }).where(eq(tables.profileDrafts.profileId, person.profileId))).rejects.toThrow();
  });

  it("rejects unsupported document versions and requires versioned JSON objects", async () => {
    const person = await owner("json-versions");
    for (const document of [[], {}, { schemaVersion: 2 }]) {
      await expect(db().insert(tables.profileRevisions).values({ profileId: person.profileId, revisionNumber: 1, document })).rejects.toThrow();
    }
    await expect(db().insert(tables.profileRevisions).values({ profileId: person.profileId, revisionNumber: 1, schemaVersion: 2, document: { schemaVersion: 2 } })).rejects.toThrow();
  });

  it("returns null for unknown/unpublished profiles and never serves draft data", async () => {
    const person = await owner("unpublished");
    await db().insert(tables.profileRevisions).values({ profileId: person.profileId, revisionNumber: 1, document: defaultProfileDocument });
    expect(await getPublishedProfile("unknown-name")).toBeNull();
    expect(await getPublishedProfile(person.username)).toBeNull();
  });

  it.each(["owner suspended", "owner deleted", "profile suspended", "profile deleted"])("excludes public reads when %s", async (state) => {
    const person = await owner("excluded-profile");
    await publish(person);
    expect(await getPublishedProfile(person.username)).not.toBeNull();
    const values = state.endsWith("suspended") ? { suspendedAt: new Date() } : { deletedAt: new Date() };
    if (state.startsWith("owner")) await db().update(tables.user).set(values).where(eq(tables.user.id, person.id));
    else await db().update(tables.profiles).set(values).where(eq(tables.profiles.id, person.profileId));
    expect(await getPublishedProfile(person.username)).toBeNull();
  });

  it("selects only public fields, strips hidden links, and keeps two profiles separate", async () => {
    const a = await owner("public-alice");
    const b = await owner("public-bob");
    const document: ProfileDocument = { ...defaultProfileDocument, displayName: "Public Alice", links: [
      { id: randomUUID(), label: "Visible", url: "https://example.com/public", visible: true },
      { id: randomUUID(), label: "SECRET HIDDEN LABEL", url: "https://private.invalid/hidden-destination", visible: false },
    ] };
    const revision = await publish(a, document);
    await publish(b, { ...defaultProfileDocument, displayName: "Public Bob" });
    const result = await getPublishedProfile(a.username);
    expect(Object.keys(result!).sort()).toEqual(["document", "id", "revisionId", "username"]);
    expect(result).toMatchObject({ id: a.profileId, revisionId: revision.id, document: { displayName: "Public Alice" } });
    expect(result!.document.links).toHaveLength(1);
    const serialized = JSON.stringify(result);
    for (const secret of [a.id, "private.invalid", "PRIVATE DRAFT", "SECRET HIDDEN", "Private account name", "Public Bob", "ownerId", "emailVerified"]) expect(serialized).not.toContain(secret);
    expect((await getPublishedProfile(b.username))?.document.displayName).toBe("Public Bob");
  });

  it("fails closed on a structurally versioned but invalid stored snapshot", async () => {
    const person = await owner("malformed-json");
    await publish(person, { ...defaultProfileDocument, links: [{ id: randomUUID(), label: "Bad", url: "javascript:alert(1)", visible: false }] });
    expect(await getPublishedProfile(person.username)).toBeNull();
  });

  it("does not publish an unverified account even if a revision pointer was assigned", async () => {
    const person = await owner("unverified-owner");
    await publish(person);
    await db().update(tables.user).set({ emailVerified: false }).where(eq(tables.user.id, person.id));
    expect(await getPublishedProfile(person.username)).toBeNull();
  });

  it("enforces same-owner media references for both drafts and revisions", async () => {
    const a = await owner("asset-alice");
    const b = await owner("asset-bob");
    const revision = await publish(a);
    const [asset] = await db().insert(tables.media).values({ ownerId: b.id, objectKey: randomUUID(), kind: "image" }).returning();
    for (const ownerId of [a.id, b.id]) {
      await expect(db().insert(tables.revisionMedia).values({ profileId: a.profileId, revisionId: revision.id, ownerId, mediaId: asset.id })).rejects.toThrow();
      await expect(db().insert(tables.draftMedia).values({ profileId: a.profileId, ownerId, mediaId: asset.id })).rejects.toThrow();
    }
    const [owned] = await db().insert(tables.media).values({ ownerId: a.id, objectKey: randomUUID(), kind: "image" }).returning();
    await db().insert(tables.revisionMedia).values({ profileId: a.profileId, revisionId: revision.id, ownerId: a.id, mediaId: owned.id });
    await db().insert(tables.draftMedia).values({ profileId: a.profileId, ownerId: a.id, mediaId: owned.id });
    await expect(db().delete(tables.media).where(eq(tables.media.id, owned.id))).rejects.toThrow();
  });

  it("does not accept uninspected media as ready or negative aggregate counts", async () => {
    const person = await owner("media-state");
    await expect(db().insert(tables.media).values({ ownerId: person.id, objectKey: randomUUID(), kind: "image", state: "ready", actualBytes: 100, width: 2, height: 2 })).rejects.toThrow();
    await expect(db().insert(tables.dailyProfileMetrics).values({ profileId: person.profileId, day: "2026-11-10", views: -1 })).rejects.toThrow();
    await expect(db().insert(tables.jobs).values({ kind: "email", idempotencyKey: randomUUID(), payload: {}, state: "running" })).rejects.toThrow();
  });

  it("stores only invite hashes and normalized email; enforces recipient, expiry and single use", async () => {
    const person = await owner("invite-owner");
    const other = await owner("invite-other");
    const [recipient] = await db().select().from(tables.user).where(eq(tables.user.id, person.id));
    const insert = (overrides = {}) => db().insert(tables.invites).values({ tokenHash: randomUUID().replaceAll("-", "").repeat(2), email: recipient.email, expiresAt: new Date(Date.now() + 60_000), ...overrides }).returning();
    await expect(insert({ tokenHash: "raw-secret" })).rejects.toThrow();
    await expect(insert({ email: " Mixed@Example.com " })).rejects.toThrow();
    const [invite] = await insert();
    await expect(db().update(tables.invites).set({ redeemedAt: new Date(), redeemedBy: other.id }).where(eq(tables.invites.id, invite.id))).rejects.toThrow();
    await db().update(tables.invites).set({ redeemedAt: new Date(), redeemedBy: person.id }).where(eq(tables.invites.id, invite.id));
    await expect(db().update(tables.invites).set({ redeemedAt: null, redeemedBy: null }).where(eq(tables.invites.id, invite.id))).rejects.toThrow();
    await db().delete(tables.user).where(eq(tables.user.id, person.id));
    const [redeemed] = await db().select().from(tables.invites).where(eq(tables.invites.id, invite.id));
    expect(redeemed.redeemedBy).toBeNull();
    expect(redeemed.redeemedAt).toBeInstanceOf(Date);
    const [expired] = await insert({ email: `${other.id}@private.invalid`, createdAt: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 60_000) });
    await expect(db().update(tables.invites).set({ redeemedAt: new Date(Date.now() - 90_000), redeemedBy: other.id }).where(eq(tables.invites.id, expired.id))).rejects.toThrow();
    const [revoked] = await insert({ email: `${other.id}@private.invalid`, revokedAt: new Date() });
    await expect(db().update(tables.invites).set({ redeemedAt: new Date(), redeemedBy: other.id }).where(eq(tables.invites.id, revoked.id))).rejects.toThrow();
    await expect(db().update(tables.invites).set({ revokedAt: null }).where(eq(tables.invites.id, revoked.id))).rejects.toThrow();
  });

  it.skipIf(!appUrl)("uses an app role with CRUD only, no superuser or DDL/TRUNCATE access", async () => {
    const client = postgres(requireDatabaseUrl(appUrl, "TEST_APP_DATABASE_URL"), { max: 1, onnotice: () => {} });
    try {
      const [role] = await client`SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
      expect(role).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
      const [rights] = await client`SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS create_schema_objects, has_table_privilege(current_user, 'public.username_claims', 'TRUNCATE') AS truncate_names,
        (has_table_privilege(current_user, 'public.profiles', 'SELECT')
          AND has_table_privilege(current_user, 'public.profiles', 'INSERT')
          AND has_table_privilege(current_user, 'public.profiles', 'UPDATE')
          AND has_table_privilege(current_user, 'public.profiles', 'DELETE')) AS crud`;
      expect(rights).toEqual({ create_schema_objects: false, truncate_names: false, crud: true });
      await expect(client`CREATE TABLE public.app_must_not_create (id int)`).rejects.toThrow();
      await expect(client`TRUNCATE public.username_claims`).rejects.toThrow();
    } finally { await client.end({ timeout: 5 }); }
  });

  it.skipIf(!appUrl)("protects the append-only recovery journal and offline replay checkpoint", async () => {
    const client = postgres(requireDatabaseUrl(appUrl, "TEST_APP_DATABASE_URL"), { max: 1, onnotice: () => {} });
    try {
      await client`INSERT INTO public.recovery_events (payload) VALUES ('{"action":"delete-account","ownerId":"journal-fixture"}'::jsonb)`;
      expect(await client`SELECT sequence FROM public.recovery_events`).toHaveLength(1);
      await expect(client`UPDATE public.recovery_events SET payload = '{}'::jsonb`).rejects.toThrow();
      await expect(client`DELETE FROM public.recovery_events`).rejects.toThrow();
      await expect(client`TRUNCATE public.recovery_events`).rejects.toThrow();
      await expect(client`SELECT * FROM public.recovery_replay`).rejects.toThrow();
      await expect(client`SELECT setval('public.recovery_events_sequence_seq', 1)`).rejects.toThrow();
      await expect(harness.client`UPDATE public.recovery_events SET payload = '{}'::jsonb`).rejects.toThrow("append-only");
      await expect(harness.client`TRUNCATE public.recovery_events`).rejects.toThrow("append-only");
    } finally { await client.end({ timeout: 5 }); }
  });
});
