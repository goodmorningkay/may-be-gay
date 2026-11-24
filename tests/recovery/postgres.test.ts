import { setTimeout as pause } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, readdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { fixture } from "./fixture";
import { gifFixture } from "../media/gif-fixture";
import * as nativeTools from "../../src/server/recovery/native";
import * as journalSource from "../../src/server/recovery/journal";
import * as recoveryEvents from "../../src/server/operations/recovery";
import { serviceState } from "../../src/server/service-state";
import { createArchive } from "../../src/server/recovery/backup";
import { restoreArchive } from "../../src/server/recovery/restore";
import { LocalBackupStore } from "../../src/server/recovery/store";
import { decryptFile } from "../../src/server/recovery/crypto";
import { closeDatabase, getDatabase } from "../../src/server/db";
import { user, profiles, profileDrafts, profileRevisions, revisionMedia, media, usernameClaims, draftMedia } from "../../src/server/db/schema";
import { mediaStorage } from "../../src/server/db/schema-media";
import { defaultProfileDocument } from "../../src/domain/profile";
import { getMediaStorage, objectKeys, publicObjectKey, LocalMediaStorage } from "../../src/server/media/storage";
import { lockMediaOwner, publishOwnedMedia, deleteOwnedMedia, uploadMedia } from "../../src/server/media/service";
import { processMediaJob } from "../../src/server/media/jobs";
import { operationsLock } from "../../src/server/operations/core";
import { journal, markAccountDeleted, setSuspension, detachAndRemoveMedia } from "../../src/server/operations/recovery";
import { workerConnection } from "../../src/server/worker/queue";
async function inventory(store: LocalBackupStore) { const pages = []; for await (const page of store.list(new AbortController().signal)) pages.push(page); return pages; }
const source = process.env.RECOVERY_TEST_DATABASE_URL, target = process.env.RESTORE_TEST_DATABASE_URL, backupUrl = process.env.RECOVERY_READONLY_DATABASE_URL || source;
describe.skipIf(!source || !target)("full PostgreSQL 17 backup/restore", () => {
  let h: Awaited<ReturnType<typeof fixture>>, root: string;
  const key = { id: "fixture-key-v1", bytes: randomBytes(32) };
  beforeAll(async () => {
    if (!/\/[a-z0-9_]+_test$/.test(new URL(target!).pathname)) throw new Error("DISPOSABLE_TARGET_REQUIRED");
    const workRoot = process.env.RECOVERY_TEST_WORK_ROOT || "/tmp/may-be-worker-fixture";
    await mkdir(workRoot, { recursive: true, mode: 0o700 }); root = await mkdtemp(path.join(workRoot, "case-"));
    vi.stubEnv("DATABASE_URL", source!); vi.stubEnv("BACKUP_DATABASE_URL", backupUrl!); vi.stubEnv("SITE_DOMAIN", "may-be.localhost");
    vi.stubEnv("MEDIA_STORAGE", "local"); vi.stubEnv("MEDIA_LOCAL_ROOT", path.join(root, "source-media")); vi.stubEnv("BACKUP_WORK_ROOT", path.join(root, "work"));
    vi.stubEnv("PG_DUMP_BIN", process.env.PG_DUMP_BIN || path.resolve("infra/operations/test-pg-dump.sh")); vi.stubEnv("PG_RESTORE_BIN", process.env.PG_RESTORE_BIN || path.resolve("infra/operations/test-pg-restore.sh"));
    h = await fixture(source!);
    if (process.env.RECOVERY_READONLY_DATABASE_URL) {
      const role = decodeURIComponent(new URL(backupUrl!).username);
      await h.client`grant usage on schema public,drizzle to ${h.client(role)}`;
      await h.client`grant select on all tables in schema public,drizzle to ${h.client(role)}`;
      await h.client`grant select on all sequences in schema public,drizzle to ${h.client(role)}`;
    }
    const clean = workerConnection(target!);
    try { await clean`drop schema if exists public cascade`; await clean`create schema public`; await clean`drop schema if exists drizzle cascade`; } finally { await clean.end(); }
  });
  afterAll(async () => { vi.restoreAllMocks(); await closeDatabase(); await h?.close(); if (root) await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
  async function owner() {
    const db = getDatabase(), id = randomUUID(), assetId = randomUUID(), token = randomUUID(), keys = objectKeys(assetId, token);
    const body = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).webp().toBuffer();
    await db.insert(user).values({ id, email: `${id}@example.invalid`, emailVerified: true, name: "Recovery fixture" });
    await db.insert(usernameClaims).values({ username: `u-${id.slice(0, 10)}`, ownerId: id });
    const [p] = await db.insert(profiles).values({ ownerId: id }).returning();
    const document = { ...defaultProfileDocument, avatarAssetId: assetId };
    await db.insert(profileDrafts).values({ profileId: p.id, document });
    await getMediaStorage().put("private", keys.original, body, "image/webp"); await getMediaStorage().put("private", keys.display, body, "image/webp");
    const original = { area: "private" as const, key: keys.original, bytes: body.length, contentType: "image/webp" as const, width: 2, height: 2 }, display = { ...original, key: keys.display };
    await db.insert(media).values({ id: assetId, ownerId: id, kind: "image", objectKey: keys.original, state: "ready", contentType: "image/webp", actualBytes: body.length, width: 2, height: 2 });
    const publicKey = publicObjectKey(assetId, token, "image");
    await db.insert(mediaStorage).values({ assetId, ownerId: id, token, state: "ready", kind: "image", chargedBytes: body.length * 3, privateBytes: body.length * 2, publicBudgetBytes: body.length, original, display, publicKey, expiresAt: new Date(Date.now() + 60000) });
    await db.insert(draftMedia).values({ profileId: p.id, ownerId: id, mediaId: assetId });
    const [r] = await db.insert(profileRevisions).values({ profileId: p.id, revisionNumber: 1, document }).returning();
    await db.insert(revisionMedia).values({ profileId: p.id, revisionId: r.id, ownerId: id, mediaId: assetId });
    await db.transaction(async tx => { await lockMediaOwner(tx, id); await publishOwnedMedia(tx, id, [assetId]); await tx.update(profiles).set({ currentRevisionId: r.id }).where(eq(profiles.id, p.id)); });
    return { id, assetId, token, body, publicKey, original: keys.original, display: keys.display, profileId: p.id };
  }
  it("uses SELECT-only dump privileges and an isolated non-superuser target owner", async () => {
    if (!process.env.RECOVERY_READONLY_DATABASE_URL) return;
    const backup = workerConnection(backupUrl), restore = workerConnection(target);
    try {
      const [b] = await backup`select rolsuper,rolcreatedb,rolcreaterole,rolbypassrls from pg_roles where rolname=current_user`;
      const [r] = await restore`select rolsuper,rolcreatedb,rolcreaterole,rolbypassrls from pg_roles where rolname=current_user`;
      expect(Object.values(b).every(v => v === false)).toBe(true); expect(Object.values(r).every(v => v === false)).toBe(true);
      expect((await backup`select has_table_privilege(current_user,'public.media_storage','SELECT') as allowed`)[0].allowed).toBe(true);
      expect((await backup`select has_table_privilege(current_user,'public.media_storage','INSERT,UPDATE,DELETE,TRUNCATE') as allowed`)[0].allowed).toBe(false);
      await expect(backup`insert into recovery_status(id,state) values('forbidden','running')`).rejects.toThrow();
      await expect(backup`create table public.forbidden(id int)`).rejects.toThrow();
      await expect(backup`select nextval('recovery_events_sequence_seq')`).rejects.toThrow();
    } finally { await backup.end(); await restore.end(); }
  });
  it("restores private/live media while replaying post-snapshot deletion, suspension and removal", async () => {
    const deleted = await owner(), suspended = await owner(), removed = await owner(), live = await owner();
    const [liveProfile] = await getDatabase().select().from(profiles).where(eq(profiles.id, live.profileId));
    await getDatabase().transaction(async tx => {
      await operationsLock(tx);
      await setSuspension(tx, live.id, "account", true); await journal(tx, { action: "account-suspension", ownerId: live.id, suspended: true });
      await setSuspension(tx, live.id, "account", false); await journal(tx, { action: "account-suspension", ownerId: live.id, suspended: false });
      // A deliberate republish before the snapshot must survive recovery.
      await tx.update(profiles).set({ currentRevisionId: liveProfile.currentRevisionId }).where(eq(profiles.id, live.profileId));
    });
    await h.client`insert into session(id,user_id,token,expires_at) values(${randomUUID()},${live.id},${randomUUID()},now()+interval '1 day')`;
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "blue" } }).png().toBuffer();
    const incomplete = await uploadMedia(live.id, "image", new ReadableStream({ start(c) { c.enqueue(png); c.close(); } }));
    const store = new LocalBackupStore(path.join(root, "archives"));
    const snapshot = await createArchive("snapshot", { url: backupUrl, stores: [store], key });
    const cutover = new Date().toISOString();
    await getDatabase().transaction(async tx => {
      await operationsLock(tx); await markAccountDeleted(tx, deleted.id); await journal(tx, { action: "delete-account", ownerId: deleted.id });
      await setSuspension(tx, suspended.id, "account", true); await journal(tx, { action: "account-suspension", ownerId: suspended.id, suspended: true });
      await detachAndRemoveMedia(tx, removed.id, removed.assetId); await journal(tx, { action: "remove-media", ownerId: removed.id, assetId: removed.assetId });
    });
    const archived = await createArchive("journal", { url: backupUrl, stores: [store], key }); expect(archived.sequence).toBe(5);
    const capturedManifest = path.join(root, "captured-journal.json");
    await decryptFile(path.join(root, "archives", archived.id, "manifest.enc"), capturedManifest, key, 8 * 1024 ** 2);
    expect(archived.capturedAt).toBe(JSON.parse(await readFile(capturedManifest, "utf8")).createdAt);
    await closeDatabase(); vi.stubEnv("MEDIA_LOCAL_ROOT", path.join(root, "restored-media"));
    vi.stubEnv("SERVICE_CLOSED_FILE", path.join(root, "report", "SERVICE_CLOSED"));
    const report = await restoreArchive({ targetUrl: target!, targetName: new URL(target!).pathname.slice(1), maintenance: true, snapshot: snapshot.id, journal: archived.id, expectedSequence: 5, recoveryThrough: cutover, reportDirectory: path.join(root, "report"), store, key });
    expect(report.state).toBe("validated"); expect(report.replayedSequence).toBe(5);
    const sql = workerConnection(target);
    try {
      expect(await sql`select id from "user" where id=${deleted.id}`).toHaveLength(0);
      expect(await sql`select id from session`).toHaveLength(0);
      expect((await sql`select suspended_at from "user" where id=${suspended.id}`)[0].suspended_at).not.toBeNull();
      expect((await sql`select current_revision_id from profiles where id=${suspended.profileId}`)[0].current_revision_id).toBeNull();
      expect(await sql`select asset_id from media_storage where asset_id in (${deleted.assetId},${removed.assetId})`).toHaveLength(0);
      expect(await getMediaStorage().get("private", live.original, live.body.length)).toEqual(live.body);
      expect(await getMediaStorage().exists("public", live.publicKey)).toBe(true);
      expect(await getMediaStorage().exists("public", suspended.publicKey)).toBe(false);
      expect(await getMediaStorage().exists("private", deleted.original)).toBe(false);
      expect(await sql`select asset_id from media_storage where asset_id=${incomplete.id}`).toHaveLength(0);
      expect(JSON.parse(await readFile(path.join(root, "report", "restore-report.json"), "utf8")).restoredPrivateFiles).toBe(8);
      expect((await readdir(path.join(root, "report")))).toContain("SERVICE_CLOSED");
    } finally { await sql.end(); }
    if (process.env.RECOVERY_ACCEPTANCE_REPORT) await writeFile(process.env.RECOVERY_ACCEPTANCE_REPORT, JSON.stringify({ ...report, fixtureOnly: true, postgresMajor: 17, assets: 4, incompleteUploadExpired: true, bytesPerObject: live.body.length, snapshotDurationMs: snapshot.durationMs, postSnapshotActions: ["delete-account", "account-suspension", "remove-media"], hostedAcceptance: false }, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify({ fixtureRestoreDurationMs: report.durationMs, snapshotDurationMs: snapshot.durationMs, bytesPerObject: live.body.length }));
  }, 120000);
  it("rejects stale/incomplete journal acknowledgement and nonempty target without reopening", async () => {
    await closeDatabase(); vi.stubEnv("DATABASE_URL", source!); vi.stubEnv("MEDIA_LOCAL_ROOT", path.join(root, "source-media"));
    const store = new LocalBackupStore(path.join(root, "freshness-archives"));
    const snapshot = await createArchive("snapshot", { url: backupUrl, stores: [store], key });
    const through = new Date().toISOString();
    const journal = await createArchive("journal", { url: backupUrl, stores: [store], key });
    const options = { targetUrl: target!, targetName: new URL(target!).pathname.slice(1), maintenance: true, snapshot: snapshot.id, journal: journal.id, expectedSequence: journal.sequence + 1, recoveryThrough: new Date().toISOString(), reportDirectory: path.join(root, "stale-report"), store, key };
    vi.stubEnv("SERVICE_CLOSED_FILE", path.join(options.reportDirectory, "SERVICE_CLOSED"));
    await expect(restoreArchive(options)).rejects.toThrow("RESTORE_FAILED_SERVICE_CLOSED");
    expect(JSON.parse(await readFile(path.join(root, "stale-report", "restore-failure.json"), "utf8")).stage).toBe("validate");
    vi.stubEnv("MEDIA_LOCAL_ROOT", path.join(root, "other-target-media"));
    vi.stubEnv("SERVICE_CLOSED_FILE", path.join(root, "occupied-report", "SERVICE_CLOSED"));
    await expect(restoreArchive({ ...options, expectedSequence: journal.sequence, recoveryThrough: through, reportDirectory: path.join(root, "occupied-report") })).rejects.toThrow("RESTORE_FAILED_SERVICE_CLOSED");
    expect(JSON.parse(await readFile(path.join(root, "occupied-report", "restore-failure.json"), "utf8")).stage).toBe("target-check");
  }, 30000);
  it("missing/corrupt retained media prevents archive commit", async () => {
    await closeDatabase(); vi.stubEnv("DATABASE_URL", source!); vi.stubEnv("MEDIA_LOCAL_ROOT", path.join(root, "source-media"));
    const o = await owner(), store = new LocalBackupStore(path.join(root, "broken-archives"));
    vi.spyOn(LocalMediaStorage.prototype, "get").mockImplementation(async () => { throw new Error("sensitive provider details"); });
    await expect(createArchive("snapshot", { url: backupUrl, stores: [store], key })).rejects.toThrow();
    vi.restoreAllMocks(); expect(await inventory(store)).toEqual([{ entries: [] }]);
    const local = getMediaStorage(); await local.delete("private", o.original);
    await local.put("private", o.original, Buffer.alloc(o.body.length), "image/webp");
    await expect(createArchive("snapshot", { url: backupUrl, stores: [store], key })).rejects.toThrow();
    expect(await inventory(store)).toEqual([{ entries: [] }]);
    await local.delete("private", o.original); await local.put("private", o.original, o.body, "image/webp");
  }, 30000);
  it("backs up a shared animated WebP and a converted MP3 in the same snapshot", async () => {
    await closeDatabase(); vi.stubEnv("DATABASE_URL", source!); vi.stubEnv("MEDIA_LOCAL_ROOT", path.join(root, "source-media"));
    const o = await owner();
    const wav = path.join(root, "snapshot-fixture.wav");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5", "-c:a", "pcm_s16le", wav]);
    const input = [["image", await gifFixture(64, 48)], ["audio", await readFile(wav)]] as const;
    const expectedObjects = [];
    for (const [kind, bytes] of input) {
      const asset = await uploadMedia(o.id, kind, new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }));
      const [pending] = await h.db.select().from(mediaStorage).where(eq(mediaStorage.assetId, asset.id));
      await processMediaJob({ version: 1, action: "process", assetId: asset.id, token: pending.token });
      const [ready] = await h.db.select().from(mediaStorage).where(eq(mediaStorage.assetId, asset.id));
      expect(ready.original?.contentType).toBe(kind === "image" ? "image/webp" : "audio/mpeg");
      expect(ready.display).toEqual(ready.original);
      expectedObjects.push(ready.original!);
    }
    const archives = path.join(root, "mixed-media-archives");
    const snapshot = await createArchive("snapshot", { url: backupUrl, stores: [new LocalBackupStore(archives)], key });
    const manifest = path.join(root, "mixed-media.json");
    await decryptFile(path.join(archives, snapshot.id, "manifest.enc"), manifest, key, 8 * 1024 ** 2);
    const { files } = JSON.parse(await readFile(manifest, "utf8"));
    for (const { key: objectKey, bytes, contentType } of expectedObjects) {
      expect(files.filter((file: { object?: { key: string } }) => file.object?.key === objectKey)).toEqual([
        expect.objectContaining({ object: { area: "private", key: objectKey, bytes, contentType } }),
      ]);
    }
  }, 30_000);
  it("backup holds the shared media mutation lock until ready bytes are copied", async () => {
    await closeDatabase(); vi.stubEnv("DATABASE_URL", source!); vi.stubEnv("MEDIA_LOCAL_ROOT", path.join(root, "source-media"));
    const o = await owner(), store = new LocalBackupStore(path.join(root, "race-archives"));
    await getDatabase().delete(draftMedia).where(eq(draftMedia.mediaId, o.assetId));
    await getDatabase().update(profiles).set({ currentRevisionId: null }).where(eq(profiles.id, o.profileId));
    await getDatabase().delete(profileRevisions).where(eq(profileRevisions.profileId, o.profileId));
    let release!: () => void, copying!: () => void;
    const entered = new Promise<void>(r => { copying = r; }), gate = new Promise<void>(r => { release = r; });
    const original = LocalMediaStorage.prototype.get;
    vi.spyOn(LocalMediaStorage.prototype, "get").mockImplementation(async function (this: LocalMediaStorage, area, k, bytes) {
      if (k === o.original) { copying(); await gate; } return original.call(this, area, k, bytes);
    });
    const backup = createArchive("snapshot", { url: backupUrl, stores: [store], key }); await entered;
    let deleted = false; const deletion = deleteOwnedMedia(o.id, o.assetId).then(() => { deleted = true; });
    // An independent connection proves the backup lock is held while copying.
    const sql = workerConnection(source);
    const [{ held }] = await sql`select exists(select 1 from pg_locks where locktype='advisory' and classid=740303 and objid=1 and granted and mode='ExclusiveLock') as held`;
    expect(held).toBe(true); expect(deleted).toBe(false);
    release(); const archive = await backup; await deletion; expect(deleted).toBe(true); await sql.end(); vi.restoreAllMocks();
    const plain = path.join(root, "race-manifest"); await decryptFile(path.join(root, "race-archives", archive.id, "manifest.enc"), plain, key, 8 * 1024 ** 2);
    expect(JSON.parse(await readFile(plain, "utf8")).files.some((f: { object?: { key: string } }) => f.object?.key === o.original)).toBe(true);
  }, 120000);
  it("try-lock polling lets an owner-first publisher finish ahead of a shared worker", async () => {
    await closeDatabase(); vi.stubEnv("DATABASE_URL", source!); vi.stubEnv("MEDIA_LOCAL_ROOT", path.join(root, "source-media"));
    const o = await owner(), sql = workerConnection(source), inspect = workerConnection(source);
    const publisher = await sql.reserve(), worker = await sql.reserve();
    let backup: ReturnType<typeof createArchive> | undefined;
    try {
      await publisher`begin`; await publisher`select id from "user" where id=${o.id} for update`;
      await worker`begin`; await worker`select pg_advisory_xact_lock_shared(740303,1)`;
      const [{ pid }] = await worker`select pg_backend_pid() as pid`;
      const ownerWait = worker`select id from "user" where id=${o.id} for update`.execute();
      const waitFor = async (condition: () => Promise<boolean>) => {
        const started = Date.now(); while (!(await condition())) { if (Date.now() - started > 5000) throw new Error("FIXTURE_LOCK_WAIT_TIMEOUT"); await pause(10); }
      };
      await waitFor(async () => (await inspect`select cardinality(pg_blocking_pids(${pid}))>0 as blocked`)[0].blocked);
      backup = createArchive("snapshot", { url: backupUrl, stores: [new LocalBackupStore(path.join(root, "inversion-archives"))], key });
      // The backup has entered its media-lock wait after acquiring operations.
      await waitFor(async () => (await inspect`select exists(select from pg_locks where locktype='advisory' and classid=740302 and objid=1 and granted) as held`)[0].held);
      expect((await inspect`select count(*)::int as n from pg_locks where locktype='advisory' and classid=740303 and objid=1 and not granted and mode='ExclusiveLock'`)[0].n).toBe(0);
      await publisher`set local lock_timeout='1s'`;
      await publisher`select pg_advisory_xact_lock_shared(740303,1)`;
      await publisher`commit`; await ownerWait; await worker`commit`;
      expect((await backup).kind).toBe("snapshot");
    } finally {
      await publisher`rollback`.catch(() => {}); await worker`rollback`.catch(() => {});
      publisher.release(); worker.release(); await sql.end({ timeout: 0 }); await inspect.end({ timeout: 0 });
      await backup?.catch(() => {});
    }
  }, 30000);
  it("serializes archive/cache runners through upload while releasing media and operations locks", async () => {
    vi.stubEnv("MEDIA_LOCAL_ROOT", path.join(root, "source-media"));
    const store = new LocalBackupStore(path.join(root, "runner-archives"));
    let release!: () => void, uploading!: () => void;
    const gate = new Promise<void>(r => { release = r; }), entered = new Promise<void>(r => { uploading = r; });
    const put = store.put.bind(store);
    vi.spyOn(store, "put").mockImplementation(async (...args) => { uploading(); await gate; await put(...args); });
    const backup = createArchive("journal", { url: backupUrl, stores: [store], key });
    try {
      await entered;
      const sql = workerConnection(source);
      try {
        expect((await sql`select count(*)::int as n from pg_locks where locktype='advisory' and classid in (740302,740303) and objid=1 and granted and mode='ExclusiveLock'`)[0].n).toBe(0);
      } finally { await sql.end(); }
      await expect(createArchive("journal", { url: backupUrl, stores: [store], key })).rejects.toThrow("BACKUP_ALREADY_RUNNING");
    } finally { release(); await backup; vi.restoreAllMocks(); }
    expect((await createArchive("journal", { url: backupUrl, stores: [store], key })).kind).toBe("journal");
  }, 30000);
  it("requires the exact shared service marker before touching a restore target", async () => {
    vi.stubEnv("SERVICE_CLOSED_FILE", path.join(root, "wrong-marker"));
    await expect(restoreArchive({ targetUrl: target!, targetName: new URL(target!).pathname.slice(1), maintenance: true, snapshot: "unused", journal: "unused", expectedSequence: 0, recoveryThrough: new Date().toISOString(), reportDirectory: path.join(root, "gate-mismatch"), store: new LocalBackupStore(root), key })).rejects.toThrow("RESTORE_SERVICE_GATE_CONFIG_INVALID");
    expect(await readdir(root)).not.toContain("gate-mismatch");
  });
  it("stays closed on the app gate when the process fails immediately after pg_restore commits", async () => {
    const crashUrl = process.env.RECOVERY_CRASH_DATABASE_URL;
    if (!crashUrl) return;
    if (!/\/[a-z0-9_]+_test$/.test(new URL(crashUrl).pathname)) throw new Error("DISPOSABLE_TARGET_REQUIRED");
    const empty = workerConnection(crashUrl);
    try { await empty`drop schema if exists public cascade`; await empty`create schema public`; await empty`drop schema if exists drizzle cascade`; } finally { await empty.end(); }
    await closeDatabase(); vi.stubEnv("DATABASE_URL", source!); vi.stubEnv("MEDIA_LOCAL_ROOT", path.join(root, "source-media"));
    const store = new LocalBackupStore(path.join(root, "crash-archives"));
    const snapshot = await createArchive("snapshot", { url: backupUrl, stores: [store], key });
    const through = new Date().toISOString(), journal = await createArchive("journal", { url: backupUrl, stores: [store], key });
    vi.stubEnv("MEDIA_LOCAL_ROOT", path.join(root, "crash-media"));
    vi.stubEnv("SERVICE_CLOSED_FILE", path.join(root, "crash-report", "SERVICE_CLOSED"));
    const native = nativeTools.native;
    vi.spyOn(nativeTools, "native").mockImplementation(async (...args) => {
      const result = await native(...args);
      if (args[1].includes("--single-transaction")) throw new Error("injected immediately after committed pg_restore");
      return result;
    });
    await expect(restoreArchive({ targetUrl: crashUrl, targetName: new URL(crashUrl).pathname.slice(1), maintenance: true, snapshot: snapshot.id, journal: journal.id, expectedSequence: journal.sequence, recoveryThrough: through, reportDirectory: path.join(root, "crash-report"), store, key })).rejects.toThrow("RESTORE_FAILED_SERVICE_CLOSED");
    vi.restoreAllMocks();
    const sql = workerConnection(crashUrl);
    try {
      // Tables and data committed, while the post-pg_restore status row did not.
      expect((await sql`select count(*)::int as n from media_storage`)[0].n).toBeGreaterThan(0);
      expect(await sql`select id from recovery_status where id='restore'`).toHaveLength(0);
      vi.stubEnv("DATABASE_URL", crashUrl);
      expect(await serviceState()).toBe("closed");
      expect(JSON.parse(await readFile(path.join(root, "crash-report", "restore-failure.json"), "utf8")).stage).toBe("database-restore");
    } finally { await sql.end(); }
  }, 30000);

  it("runtime access and reopening require explicit operator grants and removal of both gates", async () => {
    const runtimeUrl = process.env.RECOVERY_RUNTIME_DATABASE_URL;
    if (!runtimeUrl) return;
    await closeDatabase();
    const admin = workerConnection(target), runtime = workerConnection(runtimeUrl), role = decodeURIComponent(new URL(runtimeUrl).username);
    vi.stubEnv("SERVICE_CLOSED_FILE", path.join(root, "report", "SERVICE_CLOSED"));
    vi.stubEnv("DATABASE_URL", runtimeUrl);
    try {
      // --no-privileges does not silently recreate runtime access.
      await expect(runtime`select id from public.recovery_status`).rejects.toThrow();
      await admin`grant usage on schema public to ${admin(role)}`;
      await admin`grant select,insert,update,delete on all tables in schema public to ${admin(role)}`;
      await admin`grant usage,select on all sequences in schema public to ${admin(role)}`;
      await admin`revoke all on public.recovery_events,public.recovery_replay from ${admin(role)}`;
      await admin`grant select,insert on public.recovery_events to ${admin(role)}`;
      expect(await serviceState()).toBe("closed");
      await expect(runtime`update recovery_events set version=version`).rejects.toThrow();
      await expect(runtime`truncate recovery_events`).rejects.toThrow();
      await admin`delete from recovery_status where id='restore'`;
      expect(await serviceState()).toBe("closed");
      // Explicit fixture simulation of operator reopen, never restore CLI logic.
      await unlink(path.join(root, "report", "SERVICE_CLOSED"));
      expect(await serviceState()).toBe("open");
    } finally { await admin.end(); await runtime.end(); await closeDatabase(); }
  });

  describe.skipIf(!process.env.RECOVERY_CRASH_DATABASE_URL)("restore cancellation", () => {
    it("does not replay a partial journal tail when cancellation arrives at EOF", async () => {
      const cancelTarget = process.env.RECOVERY_CRASH_DATABASE_URL!;
      if (!/^\/[a-z0-9_]+_test$/.test(new URL(cancelTarget).pathname)) throw new Error("DISPOSABLE_TARGET_REQUIRED");
      const empty = workerConnection(cancelTarget);
      try { await empty`drop schema if exists public cascade`; await empty`create schema public`; await empty`drop schema if exists drizzle cascade`; } finally { await empty.end(); }
      await closeDatabase(); vi.stubEnv("DATABASE_URL", source!); vi.stubEnv("MEDIA_LOCAL_ROOT", path.join(root, "source-media"));
      const subject = await owner();
      const store = new LocalBackupStore(path.join(root, "cancel-eof-archives"));
      const snapshot = await createArchive("snapshot", { url: backupUrl, stores: [store], key });
      const through = new Date().toISOString();
      await getDatabase().transaction(async tx => {
        await operationsLock(tx); await setSuspension(tx, subject.id, "account", true);
        await journal(tx, { action: "account-suspension", ownerId: subject.id, suspended: true });
      });
      const archived = await createArchive("journal", { url: backupUrl, stores: [store], key });
      const reportDirectory = path.join(root, "cancel-eof-report");
      vi.stubEnv("MEDIA_LOCAL_ROOT", path.join(root, "cancel-eof-media"));
      vi.stubEnv("SERVICE_CLOSED_FILE", path.join(reportDirectory, "SERVICE_CLOSED"));
      const abort = new AbortController(), records = journalSource.journalRecords;
      let readers = 0, tailLength = 0;
      vi.spyOn(journalSource, "journalRecords").mockImplementation(async function* (file) {
        const pass = ++readers;
        for await (const event of records(file)) {
          if (pass === 3) tailLength++;
          yield event;
        }
        // Preserve the real validated records; cancel only when replay's
        // iterator finishes, after its last loop-body signal check.
        if (pass === 3) abort.abort();
      });
      const replay = vi.spyOn(recoveryEvents, "replayRecoveryEvents");
      try {
        await expect(restoreArchive({ targetUrl: cancelTarget, targetName: new URL(cancelTarget).pathname.slice(1), maintenance: true,
          snapshot: snapshot.id, journal: archived.id, expectedSequence: archived.sequence, recoveryThrough: through,
          reportDirectory, store, key, signal: abort.signal })).rejects.toThrow("RESTORE_FAILED_SERVICE_CLOSED");
        expect(readers).toBe(3); expect(tailLength).toBeGreaterThan(0); expect(tailLength).toBeLessThan(500);
        expect(abort.signal.aborted).toBe(true); expect(replay).not.toHaveBeenCalled();
        const restored = workerConnection(cancelTarget);
        try {
          expect((await restored`select suspended_at from "user" where id=${subject.id}`)[0].suspended_at).toBeNull();
          expect(Number((await restored`select last_sequence from recovery_replay where id=true`)[0].last_sequence)).toBe(snapshot.sequence);
          expect((await restored`select state from recovery_status where id='restore'`)[0].state).toBe("closed");
        } finally { await restored.end(); }
        await expect(readFile(path.join(reportDirectory, "restore-report.json"))).rejects.toMatchObject({ code: "ENOENT" });
        expect(JSON.parse(await readFile(path.join(reportDirectory, "restore-failure.json"), "utf8")).stage).toBe("journal-replay");
        vi.stubEnv("DATABASE_URL", cancelTarget); expect(await serviceState()).toBe("closed");
      } finally { vi.restoreAllMocks(); await closeDatabase(); }
    }, 120000);

    it.each(["private-media", "publication"] as const)("stops after the first %s copy and never reports validation", async phase => {
      const cancelTarget = process.env.RECOVERY_CRASH_DATABASE_URL!;
      if (!/^\/[a-z0-9_]+_test$/.test(new URL(cancelTarget).pathname)) throw new Error("DISPOSABLE_TARGET_REQUIRED");
      const empty = workerConnection(cancelTarget);
      try { await empty`drop schema if exists public cascade`; await empty`create schema public`; await empty`drop schema if exists drizzle cascade`; } finally { await empty.end(); }
      await closeDatabase(); vi.stubEnv("DATABASE_URL", source!); vi.stubEnv("MEDIA_LOCAL_ROOT", path.join(root, "source-media"));
      // Ensure a cancellation has later live publications available to stop.
      await owner(); await owner();
      const store = new LocalBackupStore(path.join(root, `cancel-${phase}-archives`));
      const snapshot = await createArchive("snapshot", { url: backupUrl, stores: [store], key });
      const through = new Date().toISOString(), archived = await createArchive("journal", { url: backupUrl, stores: [store], key });
      const mediaRoot = path.join(root, `cancel-${phase}-media`), reportDirectory = path.join(root, `cancel-${phase}-report`);
      vi.stubEnv("MEDIA_LOCAL_ROOT", mediaRoot); vi.stubEnv("SERVICE_CLOSED_FILE", path.join(reportDirectory, "SERVICE_CLOSED"));
      const abort = new AbortController(); let copied = 0;
      const originalPut = LocalMediaStorage.prototype.put, originalPutFile = LocalMediaStorage.prototype.putFile;
      if (phase === "private-media") vi.spyOn(LocalMediaStorage.prototype, "putFile").mockImplementation(async function (this: LocalMediaStorage, ...args) {
        await originalPutFile.apply(this, args);
        if (this.root === mediaRoot && args[0] === "private") { copied++; abort.abort(); }
      });
      else vi.spyOn(LocalMediaStorage.prototype, "put").mockImplementation(async function (this: LocalMediaStorage, ...args) {
        await originalPut.apply(this, args);
        if (this.root === mediaRoot && args[0] === "public") { copied++; abort.abort(); }
      });
      try {
        await expect(restoreArchive({ targetUrl: cancelTarget, targetName: new URL(cancelTarget).pathname.slice(1), maintenance: true,
          snapshot: snapshot.id, journal: archived.id, expectedSequence: archived.sequence, recoveryThrough: through,
          reportDirectory, store, key, signal: abort.signal })).rejects.toThrow("RESTORE_FAILED_SERVICE_CLOSED");
        expect(copied).toBe(1);
        await expect(readFile(path.join(reportDirectory, "restore-report.json"))).rejects.toMatchObject({ code: "ENOENT" });
        expect(JSON.parse(await readFile(path.join(reportDirectory, "restore-failure.json"), "utf8")).stage).toBe(phase);
        const restored = workerConnection(cancelTarget);
        try { expect((await restored`select state from recovery_status where id='restore'`)[0].state).toBe("closed"); } finally { await restored.end(); }
        vi.stubEnv("DATABASE_URL", cancelTarget); expect(await serviceState()).toBe("closed");
      } finally { vi.restoreAllMocks(); await closeDatabase(); }
    }, 120000);
  });

});
