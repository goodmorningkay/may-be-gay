import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createExampleProfile, defaultProfileDocument, type ProfileDocument } from "@/domain/profile";
import type { SessionPrincipal } from "@/server/auth/session";
import { closeDatabase } from "@/server/db";
import * as tables from "@/server/db/schema";
import { mediaStorage } from "@/server/db/schema-media";
import { bootstrapTestDatabase } from "../db/harness";

// Separate from the foundation suite: both bootstrap destructively and may run
// in parallel. Never point these two suites at the same PostgreSQL database.
const testUrl = process.env.TEST_PROFILE_DATABASE_URL;
const appUrl = process.env.TEST_PROFILE_APP_DATABASE_URL;
const suite = testUrl ? describe : describe.skip;

suite("profile services against real PostgreSQL (media storage preparation controlled)", () => {
  let harness: Awaited<ReturnType<typeof bootstrapTestDatabase>>;
  let editor: typeof import("@/server/profile-editor");
  let publicProfiles: typeof import("@/server/profiles");
  const prepare = vi.fn(async (_tx: unknown, _ownerId: string, ids: string[]) => Object.fromEntries(ids.map((id) => [id, { url: `https://media.example.com/${id}`, contentType: "image/webp" }])));
  const db = () => harness.db;

  beforeAll(async () => {
    if (process.env.TEST_DATABASE_URL && new URL(process.env.TEST_DATABASE_URL).pathname === new URL(testUrl!).pathname) {
      throw new Error("TEST_PROFILE_DATABASE_URL must use a separate disposable *_test database from TEST_DATABASE_URL.");
    }
    if (appUrl && (new URL(appUrl).pathname !== new URL(testUrl!).pathname || new URL(appUrl).host !== new URL(testUrl!).host)) throw new Error("Profile app role must target the same profile test database.");
    harness = await bootstrapTestDatabase(testUrl!);
    vi.stubEnv("DATABASE_URL", appUrl ?? testUrl!);
    // Only storage promotion/resolution is substituted. Ownership, readiness,
    // reference FKs, enqueue, locking, version guards and all commits are real.
    vi.doMock("@/server/media/service", async () => {
      const actual = await vi.importActual<typeof import("@/server/media/service")>("@/server/media/service");
      return { ...actual, publishOwnedMedia: prepare, getPublicMedia: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, { url: `https://media.example.com/${id}`, contentType: "image/webp" }])) };
    });
    editor = await import("@/server/profile-editor");
    publicProfiles = await import("@/server/profiles");
  }, 30_000);
  beforeEach(async () => { await db().delete(mediaStorage); await harness.reset(); prepare.mockClear(); });
  afterAll(async () => { await closeDatabase(); if (harness) await harness.close(); vi.doUnmock("@/server/media/service"); vi.unstubAllEnvs(); });

  async function owner(username: string) {
    const id = randomUUID();
    await db().insert(tables.user).values({ id, name: "PRIVATE ACCOUNT NAME", email: `${id}@private.invalid`, emailVerified: true });
    await db().insert(tables.usernameClaims).values({ username, ownerId: id });
    const [profile] = await db().insert(tables.profiles).values({ ownerId: id }).returning();
    const principal: SessionPrincipal = { userId: id, sessionId: randomUUID(), email: `${id}@private.invalid`, emailVerified: true, role: "user", authenticatedAt: new Date() };
    return { principal, profileId: profile.id, username };
  }
  async function asset(person: Awaited<ReturnType<typeof owner>>, ready = true, kind = "image") {
    const [record] = await db().insert(tables.media).values({ ownerId: person.principal.userId, objectKey: randomUUID(), kind,
      ...(ready ? { state: "ready", actualBytes: 100, contentType: kind === "image" ? "image/webp" : "audio/mpeg", width: kind === "image" ? 20 : null, height: kind === "image" ? 20 : null, durationMs: kind === "audio" ? 1000 : null } : {}),
    }).returning();
    if (ready) await db().insert(mediaStorage).values({
      assetId: record.id, ownerId: person.principal.userId, token: randomUUID(), state: "ready", kind,
      chargedBytes: 200, privateBytes: 100, publicBudgetBytes: 100, receivedBytes: 100,
      publicKey: `published/${randomUUID()}`, expiresAt: new Date(Date.now() + 86400000),
      display: { area: "private", key: record.objectKey, bytes: 100, contentType: kind === "image" ? "image/webp" : "audio/mpeg",
        ...(kind === "image" ? { width: 20, height: 20 } : { durationMs: 1000 }) },
    });
    return record.id;
  }
  async function refs(person: Awaited<ReturnType<typeof owner>>) {
    return {
      drafts: await db().select().from(tables.draftMedia).where(eq(tables.draftMedia.ownerId, person.principal.userId)),
      revisions: await db().select().from(tables.revisionMedia).where(eq(tables.revisionMedia.ownerId, person.principal.userId)),
    };
  }
  const save = (person: Awaited<ReturnType<typeof owner>>, version: number, document: ProfileDocument = createExampleProfile()) => editor.saveProfile(person.principal, { expectedVersion: version, document }, person.profileId);

  it("scopes private drafts, revisions and all media references to two distinct owners", async () => {
    const a = await owner("owner-alice"), b = await owner("owner-bob");
    const aDraft = await save(a, 1, { ...defaultProfileDocument, bio: "ALICE PRIVATE" });
    const bDraft = await save(b, 1, { ...defaultProfileDocument, bio: "BOB PRIVATE" });
    expect(aDraft.profileId).toBe(a.profileId);
    expect(bDraft.profileId).toBe(b.profileId);
    expect(JSON.stringify(await editor.getProfileEditor(a.principal))).not.toContain("BOB PRIVATE");
    const published = await editor.publishProfile(b.principal, 2, b.profileId);
    await expect(editor.restoreProfileRevision(a.principal, published.publishedRevisionId!, 2, a.profileId)).rejects.toMatchObject({ status: 404, code: "REVISION_NOT_FOUND" });
    expect((await editor.getProfileEditor(a.principal)).document.bio).toBe("ALICE PRIVATE");
    await expect(save(a, 2, { ...defaultProfileDocument, avatarAssetId: await asset(b) })).rejects.toThrow();
    expect(await refs(a)).toEqual({ drafts: [], revisions: [] });
  });
  it("rejects an old editor after an account switch even when both edit versions match", async () => {
    const a = await owner("switch-alice"), b = await owner("switch-bob");
    const beforeA = await editor.publishProfile(a.principal, 1, a.profileId);
    const beforeB = await editor.publishProfile(b.principal, 1, b.profileId);
    expect(beforeA.editVersion).toBe(beforeB.editVersion);
    const failure = { status: 409, code: "ACCOUNT_CHANGED" };
    await expect(editor.saveProfile(b.principal, { expectedVersion: beforeA.editVersion,
      document: { ...defaultProfileDocument, bio: "Alice's unsaved input" } }, a.profileId)).rejects.toMatchObject(failure);
    await expect(editor.publishProfile(b.principal, beforeA.editVersion, a.profileId)).rejects.toMatchObject(failure);
    await expect(editor.unpublishProfile(b.principal, a.profileId)).rejects.toMatchObject(failure);
    await expect(editor.restoreProfileRevision(b.principal, beforeB.publishedRevisionId!, beforeA.editVersion, a.profileId)).rejects.toMatchObject(failure);
    expect(await editor.getProfileEditor(a.principal)).toEqual(beforeA);
    expect(await editor.getProfileEditor(b.principal)).toEqual(beforeB);
  });
  it("previews the owned draft without publishing or resolving another owner's data", async () => {
    const a = await owner("preview-alice"), b = await owner("preview-bob");
    await save(a, 1, { ...defaultProfileDocument, bio: "ALICE PREVIEW" });
    await save(b, 1, { ...defaultProfileDocument, bio: "BOB PREVIEW" });
    const result = await editor.getProfilePreview(a.principal);
    expect(result.document.bio).toBe("ALICE PREVIEW");
    expect(result.publishedRevisionId).toBeNull();
    expect(result.revisions).toEqual([]);
    expect(result.media).toEqual({});
    expect(JSON.stringify(result)).not.toContain("BOB PREVIEW");
    expect(prepare).not.toHaveBeenCalled();
  });
  it("rejects injected ownership fields, stale writes and unsafe documents without changing state", async () => {
    const a = await owner("stale-owner");
    await save(a, 1);
    await expect(save(a, 1, defaultProfileDocument)).rejects.toMatchObject({ status: 409, code: "EDIT_VERSION_CONFLICT" });
    await expect(editor.saveProfile(a.principal, { expectedVersion: 2, document: { ...defaultProfileDocument, ownerId: "other" } } as never, a.profileId)).rejects.toMatchObject({ status: 422 });
    expect((await editor.getProfileEditor(a.principal)).editVersion).toBe(2);
  });
  it("serializes simultaneous saves so exactly one expectedVersion wins", async () => {
    const a = await owner("concurrent-save");
    const outcomes = await Promise.allSettled([save(a, 1, { ...defaultProfileDocument, bio: "first" }), save(a, 1, { ...defaultProfileDocument, bio: "second" })]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const failure = outcomes.find((item) => item.status === "rejected") as PromiseRejectedResult;
    expect(failure.reason).toMatchObject({ status: 409, code: "EDIT_VERSION_CONFLICT" });
    expect((await editor.getProfileEditor(a.principal)).editVersion).toBe(2);
  });
  it("serializes simultaneous publications and save/publish races with one winner", async () => {
    const a = await owner("concurrent-publish");
    const publications = await Promise.allSettled([editor.publishProfile(a.principal, 1, a.profileId), editor.publishProfile(a.principal, 1, a.profileId)]);
    expect(publications.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await editor.getProfileEditor(a.principal)).revisions).toHaveLength(1);
    const mixed = await Promise.allSettled([save(a, 2), editor.publishProfile(a.principal, 2, a.profileId)]);
    expect(mixed.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await editor.getProfileEditor(a.principal)).editVersion).toBe(3);
  });
  it("serializes restore/save/publish races without losing draft or revision invariants", async () => {
    const a = await owner("concurrent-restore");
    const original = await editor.publishProfile(a.principal, 1, a.profileId);
    await save(a, 2, { ...defaultProfileDocument, bio: "new saved draft" });
    const outcomes = await Promise.allSettled([
      editor.restoreProfileRevision(a.principal, original.publishedRevisionId!, 3, a.profileId),
      save(a, 3, { ...defaultProfileDocument, bio: "racing save" }),
      editor.publishProfile(a.principal, 3, a.profileId),
    ]);
    expect(outcomes.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    for (const failure of outcomes.filter((row) => row.status === "rejected")) {
      expect((failure as PromiseRejectedResult).reason).toMatchObject({ status: 409, code: "EDIT_VERSION_CONFLICT" });
    }
    const final = await editor.getProfileEditor(a.principal);
    expect(final.editVersion).toBe(4);
    expect(final.revisions.length).toBeLessThanOrEqual(2);
    expect(final.revisions.some((revision) => revision.id === final.publishedRevisionId)).toBe(true);
    expect(await refs(a)).toEqual({ drafts: [], revisions: [] });
  });
  it("rejects unready media and media of the wrong kind transactionally", async () => {
    const a = await owner("bad-media");
    await expect(save(a, 1, { ...defaultProfileDocument, avatarAssetId: await asset(a, false) })).rejects.toThrow();
    await expect(save(a, 1, { ...defaultProfileDocument, avatarAssetId: await asset(a, true, "audio") })).rejects.toMatchObject({ code: "INVALID_PROFILE_MEDIA" });
    await expect(save(a, 1, { ...defaultProfileDocument, music: { assetId: await asset(a), attribution: "Used by permission" } })).rejects.toMatchObject({ code: "INVALID_PROFILE_MEDIA" });
    expect((await editor.getProfileEditor(a.principal)).editVersion).toBe(1);
    expect(await refs(a)).toEqual({ drafts: [], revisions: [] });
  });
  it("retains previous publication and draft references after partial promotion fails", async () => {
    const a = await owner("failed-promotion");
    const original = await editor.publishProfile(a.principal, 1, a.profileId);
    const mediaId = await asset(a);
    await save(a, 2, { ...defaultProfileDocument, avatarAssetId: mediaId });
    const before = await refs(a);
    prepare.mockRejectedValueOnce(new Error("storage preparation failed"));
    await expect(editor.publishProfile(a.principal, 3, a.profileId)).rejects.toThrow("storage preparation failed");
    const after = await editor.getProfileEditor(a.principal);
    expect(after.publishedRevisionId).toBe(original.publishedRevisionId);
    expect(after.editVersion).toBe(3);
    expect(after.revisions).toHaveLength(1);
    expect(await refs(a)).toEqual(before);
    expect((await publicProfiles.getPublishedProfile(a.username))?.revisionId).toBe(original.publishedRevisionId);
  });
  it("recovers a failed DB commit after media preparation without changing the live revision", async () => {
    const a = await owner("failed-commit");
    const original = await editor.publishProfile(a.principal, 1, a.profileId);
    await save(a, 2, { ...defaultProfileDocument, avatarAssetId: await asset(a) });
    await harness.client.unsafe(`CREATE FUNCTION public.profile_test_fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced commit failure'; END; $$`);
    await harness.client.unsafe(`CREATE CONSTRAINT TRIGGER profile_test_commit_failure AFTER INSERT ON public.profile_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.profile_test_fail_commit()`);
    try { await expect(editor.publishProfile(a.principal, 3, a.profileId)).rejects.toThrow(); }
    finally {
      await harness.client.unsafe(`DROP TRIGGER profile_test_commit_failure ON public.profile_revisions`);
      await harness.client.unsafe(`DROP FUNCTION public.profile_test_fail_commit()`);
    }
    expect(prepare).toHaveBeenCalled();
    const after = await editor.getProfileEditor(a.principal);
    expect(after.publishedRevisionId).toBe(original.publishedRevisionId);
    expect(after.editVersion).toBe(3);
    expect(after.revisions).toHaveLength(1);
    const jobs = await db().select().from(tables.jobs).where(sql`${tables.jobs.payload}->>'ownerId' = ${a.principal.userId}`);
    expect(jobs.some((job) => job.kind === "media" || job.kind === "media_deletion")).toBe(true);
  });
  it("restores a new immutable publication and reconciles draft/history references", async () => {
    const a = await owner("restore-owner");
    const oldAsset = await asset(a), newAsset = await asset(a);
    const doc = { ...createExampleProfile(), avatarAssetId: oldAsset };
    await save(a, 1, doc);
    const old = await editor.publishProfile(a.principal, 2, a.profileId);
    await save(a, 3, { ...doc, avatarAssetId: newAsset, bio: "changed" });
    await editor.publishProfile(a.principal, 4, a.profileId);
    const restored = await editor.restoreProfileRevision(a.principal, old.publishedRevisionId!, 5, a.profileId);
    expect(restored.document).toEqual(doc);
    expect(restored.editVersion).toBe(6);
    expect(restored.publishedRevisionId).not.toBe(old.publishedRevisionId);
    expect(restored.revisions.map((row) => row.revisionNumber)).toEqual([3, 2, 1]);
    const references = await refs(a);
    expect(references.drafts.map((row) => row.mediaId)).toEqual([oldAsset]);
    expect(references.revisions.filter((row) => row.mediaId === oldAsset)).toHaveLength(2);
    expect(references.revisions.filter((row) => row.mediaId === newAsset)).toHaveLength(1);
    await expect(editor.restoreProfileRevision(a.principal, old.publishedRevisionId!, 5, a.profileId)).rejects.toMatchObject({ code: "EDIT_VERSION_CONFLICT" });
    await expect(db().update(tables.profileRevisions).set({ document: defaultProfileDocument }).where(eq(tables.profileRevisions.id, old.publishedRevisionId!))).rejects.toThrow();
  });
  it("prunes to five revisions, releases old references and never reuses revision numbers", async () => {
    const a = await owner("prune-owner");
    const oldId = await asset(a);
    await save(a, 1, { ...defaultProfileDocument, avatarAssetId: oldId });
    const first = await editor.publishProfile(a.principal, 2, a.profileId);
    let version = 3;
    for (let i = 0; i < 6; i++) {
      const draft = await save(a, version, { ...defaultProfileDocument, bio: `revision ${i}` });
      const publication = await editor.publishProfile(a.principal, draft.editVersion, a.profileId);
      version = publication.editVersion;
    }
    const final = await editor.getProfileEditor(a.principal);
    expect(final.revisions.map((row) => row.revisionNumber)).toEqual([7, 6, 5, 4, 3]);
    expect((await refs(a)).revisions.some((row) => row.mediaId === oldId)).toBe(false);
    await expect(editor.restoreProfileRevision(a.principal, first.publishedRevisionId!, version, a.profileId)).rejects.toMatchObject({ code: "REVISION_NOT_FOUND" });
    expect((await db().select().from(tables.media).where(eq(tables.media.id, oldId)))).toHaveLength(1);
  });
  it("preserves its high-water mark when every retained revision is deleted", async () => {
    const a = await owner("removed-history");
    const first = await editor.publishProfile(a.principal, 1, a.profileId);
    const second = await editor.publishProfile(a.principal, first.editVersion, a.profileId);
    await editor.unpublishProfile(a.principal, a.profileId);
    await db().delete(tables.profileRevisions).where(eq(tables.profileRevisions.profileId, a.profileId));
    const current = await editor.getProfileEditor(a.principal);
    const next = await editor.publishProfile(a.principal, current.editVersion, a.profileId);
    expect(next.revisions.map(r => r.revisionNumber)).toEqual([3]);
    expect(next.publishedRevisionId).not.toBe(second.publishedRevisionId);
    await expect(db().update(tables.profiles).set({ publicationNumber: 0 }).where(eq(tables.profiles.id, a.profileId))).rejects.toThrow();
  });
  it("projects public fields, preserves stable visible link order and excludes hidden content", async () => {
    const a = await owner("public-fields");
    const document = createExampleProfile();
    document.links[1] = { ...document.links[1], visible: false, label: "PRIVATE LABEL", url: "https://private.invalid/secret" };
    document.links.reverse();
    document.contact = { email: "deliberate-public@example.com" };
    await save(a, 1, document);
    await editor.publishProfile(a.principal, 2, a.profileId);
    await save(a, 3, { ...document, bio: "PRIVATE DRAFT" });
    const result = await publicProfiles.getPublishedProfile(a.username);
    expect(result?.document.links.map((link) => link.id)).toEqual(document.links.filter((link) => link.visible).map((link) => link.id));
    expect(result?.document.contact?.email).toBe("deliberate-public@example.com");
    for (const secret of ["PRIVATE LABEL", "private.invalid", "PRIVATE DRAFT", a.principal.email, a.principal.userId, "sessionId"]) expect(JSON.stringify(result)).not.toContain(secret);
  });
  it("unpublishes immediately and invalidates pending edits while retaining history", async () => {
    const a = await owner("unpublish-owner");
    await editor.publishProfile(a.principal, 1, a.profileId);
    const removed = await editor.unpublishProfile(a.principal, a.profileId);
    expect(removed.publishedRevisionId).toBeNull();
    expect(removed.editVersion).toBe(3);
    expect(removed.revisions).toHaveLength(1);
    expect(await publicProfiles.getPublishedProfile(a.username)).toBeNull();
    await expect(editor.publishProfile(a.principal, 2, a.profileId)).rejects.toMatchObject({ code: "EDIT_VERSION_CONFLICT" });
  });
  it.each(["owner suspended", "owner deleted", "owner unverified", "profile suspended", "profile deleted"])("rejects private mutations and public reads for %s", async (condition) => {
    const a = await owner("disabled-owner");
    const publication = await editor.publishProfile(a.principal, 1, a.profileId);
    const patch = condition.endsWith("unverified") ? { emailVerified: false } : condition.endsWith("suspended") ? { suspendedAt: new Date() } : { deletedAt: new Date() };
    if (condition.startsWith("owner")) await db().update(tables.user).set(patch).where(eq(tables.user.id, a.principal.userId));
    else await db().update(tables.profiles).set(patch).where(eq(tables.profiles.id, a.profileId));
    await expect(editor.getProfileEditor(a.principal)).rejects.toMatchObject({ status: 403 });
    await expect(save(a, 2)).rejects.toMatchObject({ status: 403 });
    await expect(editor.publishProfile(a.principal, 2, a.profileId)).rejects.toMatchObject({ status: 403 });
    await expect(editor.restoreProfileRevision(a.principal, publication.publishedRevisionId!, 2, a.profileId)).rejects.toMatchObject({ status: 403 });
    await expect(editor.unpublishProfile(a.principal, a.profileId)).rejects.toMatchObject({ status: 403 });
    expect(await publicProfiles.getPublishedProfile(a.username)).toBeNull();
  });
  it("keeps explicit profile and owner constraints on a draft update", async () => {
    const a = await owner("scope-alice"), b = await owner("scope-bob");
    await save(a, 1);
    await save(b, 1);
    const affected = await db().update(tables.profileDrafts).set({ editVersion: 3, document: defaultProfileDocument })
      .where(and(eq(tables.profileDrafts.profileId, a.profileId), eq(tables.profileDrafts.editVersion, 1))).returning();
    expect(affected).toEqual([]);
    expect((await editor.getProfileEditor(b.principal)).editVersion).toBe(2);
  });
});
