import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapTestDatabase } from "../db/harness";
import { gifFixture } from "../media/gif-fixture";
import { closeDatabase, getDatabase } from "@/server/db";
import { account, auditEvents, dailyLinkMetrics, dailyProfileMetrics, draftMedia, jobs, media, profileDrafts, profileRevisions, profiles, reports, session, twoFactor, user, usernameClaims, verification } from "@/server/db/schema";
import { mediaStorage } from "@/server/db/schema-media";
import { sessionAssurance } from "@/server/db/schema-accounts";
import { recoveryEvents } from "@/server/db/schema-operations";
import { defaultProfileDocument, type ProfileDocument } from "@/domain/profile";
import { getSession, requireAdmin } from "@/server/auth/session";
import { handleAuth, reauthenticate } from "@/server/auth/handler";
import { publishProfile, saveProfile } from "@/server/profile-editor";
import { getPublishedProfile } from "@/server/profiles";
import { mutateAdmin, readAdmin } from "@/server/operations/admin";
import { getReportTargets, submitReport } from "@/server/operations/reports";
import { recordMetric, readAnalytics } from "@/server/operations/analytics";
import { deleteAccount, processAccountDeletionJob } from "@/server/operations/deletion";
import { exportAccount } from "@/server/operations/export";
import { operationsMaintenance } from "@/server/operations/maintenance";
import { readRecoveryEvents, replayRecoveryEvents } from "@/server/operations/recovery";
import { getMediaStorage, objectKeys, publicObjectKey } from "@/server/media/storage";
import { processMediaDeletionJob, processMediaJob } from "@/server/media/jobs";
import { uploadMedia } from "@/server/media/service";
const testUrl = process.env.OPERATIONS_TEST_DATABASE_URL;
const origin = "https://app.may-be.localhost";
const password = "local operations password 2048";
const headers = (cookie: string) => new Headers({ host: "app.may-be.localhost", origin, cookie, "content-type": "application/json" });
const request = (cookie: string, body?: unknown) => new Request(`${origin}/api/admin/actions`, { method: body === undefined ? "GET" : "POST", headers: headers(cookie), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const downloadRequest = (cookie: string, accountId: string) => new Request(`${origin}/api/account/export`, { method: "POST", headers: { ...Object.fromEntries(headers(cookie)), "x-account-id": accountId } });
const boundRequest = (o: { cookie: string; id: string }, body: unknown) => { const r = request(o.cookie, body); r.headers.set("x-account-id", o.id); return r; };
// Intentionally separate from all account/media/profile suites. The common
// harness validates *_test before touching tables. No URL explicitly skips.
describe.skipIf(!testUrl)("operations on separate disposable PostgreSQL", () => {
  let h: Awaited<ReturnType<typeof bootstrapTestDatabase>>, root: string;
  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", testUrl!); vi.stubEnv("SITE_DOMAIN", "may-be.localhost"); vi.stubEnv("BETTER_AUTH_SECRET", "local-operations-tests-secret-with-at-least-32-characters");
    h = await bootstrapTestDatabase(testUrl!);
    root = await mkdtemp(path.join(os.tmpdir(), "operations-media-")); vi.stubEnv("MEDIA_STORAGE", "local"); vi.stubEnv("MEDIA_LOCAL_ROOT", root);
  }, 30000);
  beforeEach(async () => { await h.reset(); });
  afterAll(async () => { await closeDatabase(); if (h) await h.close(); if (root) await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
  async function owner(admin = false) {
    const id = randomUUID(), username = `u-${id.slice(0, 10)}`, email = `${id}@example.invalid`;
    await h.db.insert(user).values({ id, email, name: "Test owner", emailVerified: true });
    await h.db.insert(account).values({ id: randomUUID(), accountId: id, userId: id, providerId: "credential", password: await hashPassword(password) });
    const res = await handleAuth(new Request(`${origin}/api/auth/sign-in/email`, { method: "POST", headers: headers(""), body: JSON.stringify({ email, password }) }));
    expect(res.status, await res.clone().text()).toBe(200);
    const cookie = res.headers.getSetCookie().map(c => c.split(";", 1)[0]).join("; ");
    const principal = (await getSession(headers(cookie)))!; expect(principal).toBeTruthy();
    await h.db.insert(sessionAssurance).values({ sessionId: principal.sessionId, reauthenticatedAt: new Date(), ...(admin ? { secondFactorAt: new Date() } : {}) });
    if (admin) {
      await h.db.update(user).set({ role: "admin", twoFactorEnabled: true }).where(eq(user.id, id));
      await h.db.insert(twoFactor).values({ id: randomUUID(), userId: id, secret: "private-fixture-factor", backupCodes: "private-fixture-backup", verified: true });
    }
    await h.db.insert(usernameClaims).values({ username, ownerId: id });
    const [profile] = await h.db.insert(profiles).values({ ownerId: id }).returning();
    await h.db.insert(profileDrafts).values({ profileId: profile.id, document: defaultProfileDocument });
    return { id, username, email, cookie, profileId: profile.id, principal: (await getSession(headers(cookie)))! };
  }
  type Owner = Awaited<ReturnType<typeof owner>>;
  async function fixtureAsset(o: Owner, bytes?: number) {
    const assetId = randomUUID(), token = randomUUID(), keys = objectKeys(assetId, token), body = bytes ? Buffer.alloc(bytes, 65) : Buffer.from("validated-media-fixture");
    await getMediaStorage().put("private", keys.original, body, "image/webp"); await getMediaStorage().put("private", keys.display, body, "image/webp");
    const original = { area: "private" as const, key: keys.original, bytes: body.length, contentType: "image/webp" as const, width: 1, height: 1 }, display = { ...original, key: keys.display };
    await h.db.insert(media).values({ id: assetId, ownerId: o.id, objectKey: keys.quarantine, state: "ready", kind: "image", contentType: "image/webp", actualBytes: body.length * 2, width: 1, height: 1 });
    await h.db.insert(mediaStorage).values({ assetId, token, ownerId: o.id, kind: "image", state: "ready", chargedBytes: body.length * 3, privateBytes: body.length * 2, publicBudgetBytes: body.length, original, display, publicKey: publicObjectKey(assetId, token, "image"), expiresAt: new Date(Date.now() + 60000) });
    return { assetId, token, body };
  }
  async function publish(o: Owner, patch: Partial<ProfileDocument> = {}) {
    const [draft] = await h.db.select().from(profileDrafts).where(eq(profileDrafts.profileId, o.profileId));
    const saved = await saveProfile(o.principal, { expectedVersion: draft.editVersion, document: { ...defaultProfileDocument, ...patch } }, o.profileId);
    return publishProfile(o.principal, saved.editVersion, o.profileId);
  }
  it("enforces nonadmin, actual password assurance, successful 2FA and origin on reads and mutations", async () => {
    const a = await owner(), admin = await owner(true);
    await expect(readAdmin(request(a.cookie), "accounts")).rejects.toMatchObject({ status: 403 });
    await h.db.update(sessionAssurance).set({ reauthenticatedAt: null }).where(eq(sessionAssurance.sessionId, admin.principal.sessionId));
    await expect(readAdmin(request(admin.cookie), "accounts")).rejects.toMatchObject({ code: "REAUTHENTICATION_REQUIRED" });
    await h.db.update(sessionAssurance).set({ reauthenticatedAt: new Date(), secondFactorAt: null }).where(eq(sessionAssurance.sessionId, admin.principal.sessionId));
    await expect(requireAdmin(request(admin.cookie))).rejects.toMatchObject({ code: "ADMIN_2FA_REQUIRED" });
    await h.db.update(sessionAssurance).set({ secondFactorAt: new Date() }).where(eq(sessionAssurance.sessionId, admin.principal.sessionId));
    const cross = request(admin.cookie, {}); cross.headers.set("origin", "https://evil.invalid");
    await expect(mutateAdmin(cross, { action: "quota", userId: a.id, bytes: 100 })).rejects.toMatchObject({ code: "ORIGIN_REJECTED" });
  });
  it("grants immediate admin read access after password + 2FA sign-in without redundant reauthentication", async () => {
    const admin = await owner();
    await h.db.update(user).set({ role: "admin" }).where(eq(user.id, admin.id));
    await h.db.delete(sessionAssurance).where(eq(sessionAssurance.sessionId, admin.principal.sessionId));
    const authPost = (p: string, body: unknown, cookie = "") =>
      handleAuth(new Request(`${origin}/api/auth${p}`, { method: "POST", headers: headers(cookie), body: JSON.stringify(body) }));
    const cookiesOf = (res: Response) => res.headers.getSetCookie().map(c => c.split(";", 1)[0]).join("; ");
    const totpCode = (uri: string) => {
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
      let bits = ""; for (const c of new URL(uri).searchParams.get("secret")!) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
      const key = Buffer.from(bits.match(/.{8}/g)!.map(x => parseInt(x, 2)));
      const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
      const digest = createHmac("sha1", key).update(counter).digest(); const offset = digest[19] & 15;
      return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, "0");
    };
    const enable = await authPost("/two-factor/enable", { password, method: "totp" }, admin.cookie);
    expect(enable.status, await enable.clone().text()).toBe(200);
    const setup = await enable.json() as { totpURI: string; backupCodes: string[] };
    const enrolled = await authPost("/two-factor/verify-totp", { code: totpCode(setup.totpURI) }, admin.cookie);
    expect(enrolled.status, await enrolled.clone().text()).toBe(200);
    await expect(readAdmin(request(cookiesOf(enrolled) || admin.cookie), "reports")).resolves.toHaveProperty("rows");
    const login = await authPost("/sign-in/email", { email: admin.email, password });
    expect((await login.json()).twoFactorRedirect).toBe(true);
    const verified = await authPost("/two-factor/verify-totp", { code: totpCode(setup.totpURI) }, cookiesOf(login));
    expect(verified.status, await verified.clone().text()).toBe(200);
    const signedInCookie = cookiesOf(verified);
    await expect(readAdmin(request(signedInCookie), "reports")).resolves.toHaveProperty("rows");
    const signedInPrincipal = (await getSession(headers(signedInCookie)))!;
    await h.db.update(sessionAssurance).set({ reauthenticatedAt: new Date(Date.now() - 3600000) }).where(eq(sessionAssurance.sessionId, signedInPrincipal.sessionId));
    expect((await authPost("/two-factor/verify-totp", { code: totpCode(setup.totpURI) }, signedInCookie)).status).toBe(200);
    await expect(readAdmin(request(signedInCookie), "reports")).rejects.toMatchObject({ code: "REAUTHENTICATION_REQUIRED" });
  });
  it("issues recipient-bound invitations once, lists safe projections and atomically audits revocation", async () => {
    const admin = await owner(true);
    const issued = await mutateAdmin(request(admin.cookie, {}), { action: "invite", email: "bound@example.invalid" });
    expect(issued).toHaveProperty("invite.token");
    const listed = JSON.stringify(await readAdmin(request(admin.cookie), "invites"));
    expect(listed).not.toContain("token"); expect(listed).not.toContain("Hash");
    const invite = (issued as { invite: { id: string; token: string } }).invite;
    await mutateAdmin(request(admin.cookie, {}), { action: "revoke-invite", id: invite.id });
    const audits = await h.db.select().from(auditEvents); expect(audits.map(a => a.action)).toContain("invite.revoke"); expect(JSON.stringify(audits)).not.toContain(invite.token);
  });
  it("accepts only published profiles, visible links and currently exposed same-profile media", async () => {
    const a = await owner(), b = await owner(), asset = await fixtureAsset(a), hidden = randomUUID(), visible = randomUUID();
    await submitReport({ username: b.username, reason: "other" });
    await publish(a, { avatarAssetId: asset.assetId, links: [{ id: visible, label: "Visible", url: "https://example.invalid", visible: true }, { id: hidden, label: "Hidden", url: "https://private.invalid", visible: false }] });
    for (const target of [{}, { linkId: visible }, { mediaId: asset.assetId }]) await submitReport({ username: a.username, reason: "other", ...target });
    for (const target of [{ linkId: hidden }, { mediaId: randomUUID() }, { linkId: randomUUID() }, { website: "bot" }]) await submitReport({ username: a.username, reason: "other", ...target });
    expect(await h.db.select().from(reports)).toHaveLength(3);
    for (let i = 0; i < 4; i++) await submitReport({ username: "absent", reason: "other" });
    await expect(submitReport({ username: a.username, reason: "other" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
  it("offers only the current published projection and normalizes uppercase report targets", async () => {
    const a = await owner(), asset = await fixtureAsset(a), privateAsset = await fixtureAsset(a);
    const visible = randomUUID(), hidden = randomUUID(), draftOnly = randomUUID();
    await publish(a, { avatarAssetId: asset.assetId.toUpperCase(), backgroundAssetId: asset.assetId.toUpperCase(), links: [
      { id: visible.toUpperCase(), label: "Visible choice", url: "https://example.invalid", visible: true },
      { id: hidden, label: "Hidden choice", url: "https://private.invalid", visible: false },
    ] });
    const [draft] = await h.db.select().from(profileDrafts).where(eq(profileDrafts.profileId, a.profileId));
    await saveProfile(a.principal, { expectedVersion: draft.editVersion, document: { ...defaultProfileDocument,
      avatarAssetId: privateAsset.assetId, links: [{ id: draftOnly, label: "Draft choice", url: "https://draft.invalid", visible: true }] } }, a.profileId);
    expect(await getReportTargets(a.username)).toEqual([
      { value: `link:${visible}`, label: "Link: Visible choice" },
      { value: `media:${asset.assetId}`, label: "Avatar" },
      { value: `media:${asset.assetId}`, label: "Background" },
    ]);
    expect(await getReportTargets("unknown-owner")).toEqual([]);
  });
  it("isolates owner analytics and caps counts/cardinality without any visitor fields", async () => {
    const a = await owner(), b = await owner(), linkId = randomUUID(), hiddenId = randomUUID();
    await publish(a, { links: [{ id: linkId, label: "Link", url: "https://example.invalid", visible: true }, { id: hiddenId, label: "Hidden", url: "https://example.invalid", visible: false }] });
    await recordMetric(a.username, { event: "view" }); await recordMetric(a.username, { event: "click", linkId }); await recordMetric(a.username, { event: "click", linkId: hiddenId });
    expect((await readAnalytics(request(a.cookie))).days.reduce((n, d) => n + d.views, 0)).toBe(1);
    expect((await readAnalytics(request(b.cookie))).links).toEqual([]);
    const day = new Date().toISOString().slice(0, 10);
    await h.db.update(dailyProfileMetrics).set({ views: 1000000 }); await recordMetric(a.username, { event: "view" });
    expect((await h.db.select().from(dailyProfileMetrics))[0].views).toBe(1000000);
    await h.db.insert(dailyLinkMetrics).values(Array.from({ length: 99 }, () => ({ profileId: a.profileId, day, linkId: randomUUID(), clicks: 1 })));
    const newId = randomUUID(); await publish(a, { links: [{ id: newId, label: "new", url: "https://example.invalid", visible: true }] }); await recordMetric(a.username, { event: "click", linkId: newId });
    expect(await h.db.select().from(dailyLinkMetrics)).toHaveLength(100);
  });
  it("serializes suspension with publishing, revokes sessions and never auto-republishes on reversal", async () => {
    const admin = await owner(true), a = await owner();
    const outcomes = await Promise.allSettled([publish(a), mutateAdmin(request(admin.cookie, {}), { action: "suspend", userId: a.id, scope: "account", suspended: true })]);
    expect(outcomes[1].status).toBe("fulfilled"); expect(await getPublishedProfile(a.username)).toBeNull(); expect(await h.db.select().from(session).where(eq(session.userId, a.id))).toEqual([]);
    await expect(publish(a)).rejects.toMatchObject({ code: "ACCOUNT_UNAVAILABLE" });
    await mutateAdmin(request(admin.cookie, {}), { action: "suspend", userId: a.id, scope: "account", suspended: false }); expect(await getPublishedProfile(a.username)).toBeNull();
    expect(await readRecoveryEvents()).toHaveLength(2);
    await expect(mutateAdmin(request(admin.cookie, {}), { action: "suspend", userId: admin.id, scope: "account", suspended: true })).rejects.toMatchObject({ code: "ADMIN_SAFETY_WORKFLOW_REQUIRED" });
  });
  it("removes forbidden references without mutating revisions and invalidates stale drafts", async () => {
    const admin = await owner(true), a = await owner(), asset = await fixtureAsset(a);
    const clean = await publish(a);
    const first = await publish(a, { avatarAssetId: asset.assetId }); await publish(a, { backgroundAssetId: asset.assetId });
    const results = await Promise.allSettled([publish(a, { music: null, avatarAssetId: asset.assetId }), mutateAdmin(request(admin.cookie, {}), { action: "remove-media", userId: a.id, mediaId: asset.assetId })]);
    expect(results[1].status).toBe("fulfilled"); expect(await getPublishedProfile(a.username)).toBeNull();
    const kept = await h.db.select().from(profileRevisions).where(eq(profileRevisions.profileId, a.profileId));
    expect(kept).toHaveLength(1); expect(kept[0].id).toBe(clean.publishedRevisionId); expect(kept[0].document).toEqual(defaultProfileDocument);
    expect(await h.db.select().from(draftMedia).where(eq(draftMedia.mediaId, asset.assetId))).toHaveLength(0);
    const [draft] = await h.db.select().from(profileDrafts).where(eq(profileDrafts.profileId, a.profileId)); expect(draft.document).not.toHaveProperty("avatarAssetId", asset.assetId); expect(draft.editVersion).toBeGreaterThan(first.editVersion);
    expect((await h.db.select().from(mediaStorage).where(eq(mediaStorage.assetId, asset.assetId)))[0].state).toBe("deleting");
    await processMediaDeletionJob({ version: 1, assetId: asset.assetId, token: asset.token }); expect(await h.db.select().from(mediaStorage).where(eq(mediaStorage.assetId, asset.assetId))).toHaveLength(0);
  });
  it("keeps publication numbers above moderated latest and completely removed history", async () => {
    const admin = await owner(true), a = await owner();
    const clean = await publish(a);
    const firstAsset = await fixtureAsset(a);
    const latest = await publish(a, { avatarAssetId: firstAsset.assetId });
    expect(latest.revisions.map(r => r.revisionNumber)).toEqual([2, 1]);
    await mutateAdmin(request(admin.cookie, {}), { action: "remove-media", userId: a.id, mediaId: firstAsset.assetId });
    const third = await publish(a);
    expect(third.revisions.map(r => r.revisionNumber)).toEqual([3, 1]);
    expect(third.revisions[1].id).toBe(clean.publishedRevisionId);
    // Replace the remaining five snapshots with publications sharing a second
    // asset, then remove it through the actual moderation service.
    const secondAsset = await fixtureAsset(a);
    let previous = third;
    for (let i = 0; i < 5; i++) previous = await publish(a, { avatarAssetId: secondAsset.assetId });
    const high = previous.revisions[0].revisionNumber;
    await mutateAdmin(request(admin.cookie, {}), { action: "remove-media", userId: a.id, mediaId: secondAsset.assetId });
    expect(await h.db.select().from(profileRevisions).where(eq(profileRevisions.profileId, a.profileId))).toHaveLength(0);
    const after = await publish(a);
    expect(after.revisions.map(r => r.revisionNumber)).toEqual([high + 1]);
  });
  it("makes quota and service controls authoritative for the existing uploader", async () => {
    const admin = await owner(true), a = await owner();
    await mutateAdmin(request(admin.cookie, {}), { action: "quota", userId: a.id, bytes: 0 });
    await expect(uploadMedia(a.id, "image", new ReadableStream())).rejects.toMatchObject({ code: "MEDIA_QUOTA_EXCEEDED" });
    await mutateAdmin(request(admin.cookie, {}), { action: "settings", registrationMode: "closed", uploadsPaused: true, accountLimit: 20, totalMediaLimitBytes: 1024 ** 3 });
    await expect(uploadMedia(a.id, "image", new ReadableStream())).rejects.toMatchObject({ code: "MEDIA_UPLOADS_PAUSED" });
    expect(await readAdmin(request(admin.cookie), "settings")).toMatchObject({ settings: { registrationMode: "closed", uploadsPaused: true } });
    await mutateAdmin(request(admin.cookie, {}), { action: "settings", registrationMode: "public", uploadsPaused: false, accountLimit: 100000, totalMediaLimitBytes: 1024 ** 3 });
    expect(await readAdmin(request(admin.cookie), "settings")).toMatchObject({ settings: { registrationMode: "public", uploadsPaused: false, accountLimit: 100000 } });
    await mutateAdmin(request(admin.cookie, {}), { action: "settings", registrationMode: "public", uploadsPaused: false, accountLimit: null, totalMediaLimitBytes: 1024 ** 3 });
    expect(await readAdmin(request(admin.cookie), "settings")).toMatchObject({ settings: { registrationMode: "public", uploadsPaused: false, accountLimit: null } });
  });
  it("serializes deletion against publication without exposing the deleted account", async () => {
    const a = await owner();
    const outcomes = await Promise.allSettled([publish(a), deleteAccount(boundRequest(a, {}), { confirmation: "DELETE MY ACCOUNT" })]);
    expect(outcomes[1].status).toBe("fulfilled"); expect(await getPublishedProfile(a.username)).toBeNull();
    await processAccountDeletionJob({ version: 1, ownerId: a.id });
    expect(await h.db.select().from(profileRevisions).where(eq(profileRevisions.profileId, a.profileId))).toHaveLength(0);
  });
  it("replays media removal and deletion over restored live content without resurrecting it", async () => {
    const a = await owner(), asset = await fixtureAsset(a); await publish(a, { avatarAssetId: asset.assetId });
    const createdAt = new Date().toISOString();
    const events = [{ sequence: 201, version: 1, createdAt, payload: { action: "remove-media", ownerId: a.id, assetId: asset.assetId } }, { sequence: 202, version: 1, createdAt, payload: { action: "delete-account", ownerId: a.id } }];
    expect(await replayRecoveryEvents(events)).toEqual({ lastSequence: 202 }); expect(await getPublishedProfile(a.username)).toBeNull();
    await processAccountDeletionJob({ version: 1, ownerId: a.id }); await processMediaDeletionJob({ version: 1, assetId: asset.assetId, token: asset.token });
    expect(await replayRecoveryEvents(events)).toEqual({ lastSequence: 202 }); expect(await h.db.select().from(user).where(eq(user.id, a.id))).toHaveLength(0);
  });
  function untar(buffer: Buffer) {
    const files = new Map<string, Buffer>(); let offset = 0;
    while (offset + 512 <= buffer.length && buffer[offset]) {
      const header = buffer.subarray(offset, offset + 512), name = header.subarray(0, 100).toString().split("\0")[0], size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/, ""), 8);
      files.set(name, buffer.subarray(offset + 512, offset + 512 + size)); offset += 512 + Math.ceil(size / 512) * 512;
    }
    return files;
  }
  it("exports owned private documents and actual media without secrets or infrastructure keys", async () => {
    const a = await owner(), b = await owner(), asset = await fixtureAsset(a), foreign = await fixtureAsset(b);
    await publish(a, { avatarAssetId: asset.assetId });
    const res = await exportAccount(downloadRequest(a.cookie, a.id)), files = untar(Buffer.from(await res.arrayBuffer()));
    const manifest = files.get("account.json")!.toString(); expect(manifest).toContain(asset.assetId); expect(manifest).not.toContain(foreign.assetId); expect(manifest).not.toContain("objectKey"); expect(manifest).not.toContain("private-fixture"); expect(manifest).not.toContain("token"); expect(manifest).not.toContain("v1/");
    expect(files.get(`media/${asset.assetId}/original.webp`)).toEqual(asset.body); expect(files.get(`media/${asset.assetId}/display.webp`)).toEqual(asset.body);
    const foreignRes = await exportAccount(downloadRequest(b.cookie, b.id)); expect(untar(Buffer.from(await foreignRes.arrayBuffer())).has(`media/${asset.assetId}/original.webp`)).toBe(false);
    await expect(exportAccount(boundRequest(a, { ownerId: b.id }))).rejects.toMatchObject({ code: "EMPTY_EXPORT_BODY_REQUIRED" });
  });
  it("exports both archive paths for a GIF with one shared WebP derivative", async () => {
    const a = await owner(), gif = await gifFixture(64, 48);
    const asset = await uploadMedia(a.id, "image", new ReadableStream({ start(controller) { controller.enqueue(gif); controller.close(); } }));
    const [pending] = await h.db.select().from(mediaStorage).where(eq(mediaStorage.assetId, asset.id));
    await processMediaJob({ version: 1, action: "process", assetId: asset.id, token: pending.token });
    const [ready] = await h.db.select().from(mediaStorage).where(eq(mediaStorage.assetId, asset.id));
    expect(ready.original).not.toBeNull();
    expect(ready.display).toEqual(ready.original);
    const file = await getMediaStorage().get("private", ready.original!.key, ready.original!.bytes);

    const response = await exportAccount(downloadRequest(a.cookie, a.id));
    const archive = Buffer.from(await response.arrayBuffer());
    const files = untar(archive);
    const { media: [entry] } = JSON.parse(files.get("account.json")!.toString());
    expect(entry).toMatchObject({
      id: asset.id, originalPath: `media/${asset.id}/original.webp`, displayPath: `media/${asset.id}/display.webp`,
    });
    expect(files.get(entry.originalPath)).toEqual(file);
    expect(files.get(entry.displayPath)).toEqual(file);
    expect(archive.subarray(-1024)).toEqual(Buffer.alloc(1024));
  });
  it("rejects the account rendered in a stale tab before export bytes or deletion side effects", async () => {
    const a = await owner(), b = await owner();
    // Use the real password verifier rather than only the fixture's assurance.
    await h.db.delete(sessionAssurance).where(eq(sessionAssurance.sessionId, b.principal.sessionId));
    const confirmed = await reauthenticate(request(b.cookie, { password }));
    expect(confirmed.status).toBe(200);
    const before = await h.db.select().from(user).where(eq(user.id, b.id));
    const beforeProfile = await h.db.select().from(profiles).where(eq(profiles.ownerId, b.id));
    const staleExport = downloadRequest(b.cookie, a.id);
    const { POST: exportPost } = await import("@/app/api/account/export/route");
    const { POST: deletePost } = await import("@/app/api/account/delete/route");
    const archive = await exportPost(staleExport);
    expect(archive.status).toBe(409);
    expect(archive.headers.get("content-type")).not.toContain("application/x-tar");
    expect((await archive.json()).error.code).toBe("ACCOUNT_CHANGED");
    const staleDelete = boundRequest(b, {}); staleDelete.headers.set("x-account-id", a.id);
    const deletion = await deletePost(new Request(staleDelete, { body: JSON.stringify({ confirmation: "DELETE MY ACCOUNT" }) }));
    expect(deletion.status).toBe(409); expect((await deletion.json()).error.code).toBe("ACCOUNT_CHANGED");
    expect(await h.db.select().from(user).where(eq(user.id, b.id))).toEqual(before);
    expect(await h.db.select().from(profiles).where(eq(profiles.ownerId, b.id))).toEqual(beforeProfile);
    expect(await h.db.select().from(jobs)).toHaveLength(0);
    expect(await h.db.select().from(recoveryEvents)).toHaveLength(0);
    expect(await h.db.select().from(auditEvents)).toHaveLength(0);
    expect(await getSession(headers(b.cookie))).toBeTruthy();
  });
  it("fails closed at the export/deletion HTTP boundary without the rendered identity", async () => {
    const a = await owner();
    const { POST: exportPost } = await import("@/app/api/account/export/route");
    const { POST: deletePost } = await import("@/app/api/account/delete/route");
    for (const identity of [undefined, "invalid account id"]) {
      const e = downloadRequest(a.cookie, a.id), d = boundRequest(a, { confirmation: "DELETE MY ACCOUNT" });
      for (const input of [e, d]) {
        if (identity === undefined) input.headers.delete("x-account-id"); else input.headers.set("x-account-id", identity);
      }
      for (const response of [await exportPost(e), await deletePost(d)]) {
        expect(response.status).toBe(400);
        expect(response.headers.get("content-type")).not.toContain("application/x-tar");
        expect((await response.json()).error.code).toBe("ACCOUNT_IDENTITY_REQUIRED");
      }
    }
    expect(await h.db.select().from(jobs)).toHaveLength(0);
    expect(await h.db.select().from(recoveryEvents)).toHaveLength(0);
    expect((await h.db.select().from(user).where(eq(user.id, a.id)))[0].deletedAt).toBeNull();
  });
  it("fails an in-progress export safely if concurrent deletion revokes access", async () => {
    const a = await owner(); await fixtureAsset(a, 256 * 1024);
    const res = await exportAccount(downloadRequest(a.cookie, a.id));
    await deleteAccount(boundRequest(a, {}), { confirmation: "DELETE MY ACCOUNT" });
    await expect(res.arrayBuffer()).rejects.toThrow();
  });
  it("deletes idempotently, preserves cleanup locators/jobs and tombstones, scrubs mail/recovery PII", async () => {
    const a = await owner(), b = await owner(), asset = await fixtureAsset(a); await publish(a, { avatarAssetId: asset.assetId });
    await h.db.insert(verification).values({ id: randomUUID(), identifier: "reset-password:private-token", value: a.id, expiresAt: new Date(Date.now() + 60000) });
    await h.db.insert(jobs).values({ kind: "email", ownerId: a.id, idempotencyKey: randomUUID(), payload: { to: a.email, url: "https://private-token.invalid/" } });
    await h.db.insert(reports).values({ targetUsername: b.username, reason: "other", reporterEmail: a.email });
    await deleteAccount(boundRequest(a, {}), { confirmation: "DELETE MY ACCOUNT" }); expect(await getPublishedProfile(a.username)).toBeNull();
    await processAccountDeletionJob({ version: 1, ownerId: a.id }); await processAccountDeletionJob({ version: 1, ownerId: a.id });
    expect(await h.db.select().from(user).where(eq(user.id, b.id))).toHaveLength(1); expect(await h.db.select().from(user).where(eq(user.id, a.id))).toHaveLength(0);
    const [claim] = await h.db.select().from(usernameClaims).where(eq(usernameClaims.username, a.username)); expect(claim.ownerId).toBeNull(); expect(claim.retiredAt).toBeTruthy();
    expect(await h.db.select().from(verification)).toHaveLength(0);
    expect((await h.db.select().from(reports))[0].reporterEmail).toBeNull();
    expect(JSON.stringify(await h.db.select().from(jobs).where(eq(jobs.kind, "email")))).not.toContain("private-token");
    expect((await h.db.select().from(mediaStorage).where(eq(mediaStorage.assetId, asset.assetId)))[0].state).toBe("deleting");
    await processMediaDeletionJob({ version: 1, assetId: asset.assetId, token: asset.token }); expect(await h.db.select().from(mediaStorage)).toHaveLength(0);
  });
  it("rolls back privileged state when the same-transaction recovery insert fails", async () => {
    const admin = await owner(true), a = await owner();
    await h.client.unsafe(`ALTER TABLE recovery_events ADD CONSTRAINT test_reject_event CHECK(false) NOT VALID`);
    try { await expect(mutateAdmin(request(admin.cookie, {}), { action: "suspend", userId: a.id, scope: "account", suspended: true })).rejects.toThrow(); }
    finally { await h.client.unsafe(`ALTER TABLE recovery_events DROP CONSTRAINT test_reject_event`); }
    expect((await h.db.select().from(user).where(eq(user.id, a.id)))[0].suspendedAt).toBeNull(); expect(await h.db.select().from(session).where(eq(session.userId, a.id))).toHaveLength(1);
  });
  it("replays ordered journal idempotently, handles missing owners and advances restored sequence", async () => {
    const a = await owner(), now = new Date().toISOString();
    const events = [{ sequence: 101, version: 1, createdAt: now, payload: { action: "account-suspension", ownerId: a.id, suspended: true } }, { sequence: 102, version: 1, createdAt: now, payload: { action: "account-suspension", ownerId: a.id, suspended: false } }, { sequence: 103, version: 1, createdAt: now, payload: { action: "delete-account", ownerId: "already-missing" } }];
    expect(await replayRecoveryEvents(events)).toEqual({ lastSequence: 103 }); expect(await replayRecoveryEvents(events)).toEqual({ lastSequence: 103 });
    expect((await h.db.select().from(user).where(eq(user.id, a.id)))[0].suspendedAt).toBeNull(); expect(await readRecoveryEvents(100, 2)).toHaveLength(2);
    const [next] = await getDatabase().insert(recoveryEvents).values({ payload: { action: "delete-account", ownerId: "missing-again" } }).returning(); expect(next.sequence).toBeGreaterThan(103);
    await expect(replayRecoveryEvents([events[1], events[0]])).rejects.toThrow("RECOVERY_ORDER_INVALID");
  });
  it("retains exactly 30 UTC days and scrubs bounded report data without deleting recovery journal", async () => {
    const a = await owner(), old = new Date(Date.now() - 100 * 86400000);
    await h.db.insert(dailyProfileMetrics).values({ profileId: a.profileId, day: "2000-01-01", views: 1 }); await h.db.insert(dailyLinkMetrics).values({ profileId: a.profileId, day: "2000-01-01", linkId: randomUUID(), clicks: 1 });
    await h.db.insert(reports).values({ targetUsername: a.username, reason: "other", reporterEmail: "private@example.invalid", details: "private details", createdAt: new Date(Date.now() - 40 * 86400000) });
    await h.db.insert(reports).values({ targetUsername: a.username, reason: "other", createdAt: old });
    await getDatabase().insert(recoveryEvents).values({ payload: { action: "delete-account", ownerId: "missing" }, createdAt: old });
    const result = await operationsMaintenance(100); expect(result.views).toBe(1); expect(result.clicks).toBe(1); expect(result.reports).toBe(1);
    const retained = await h.db.select().from(reports); expect(retained).toHaveLength(1); expect(retained[0].reporterEmail).toBeNull(); expect(retained[0].details).toBeNull(); expect(await readRecoveryEvents()).toHaveLength(1);
  });
});
