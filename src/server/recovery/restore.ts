import { readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { and, eq, isNull } from "drizzle-orm";
import { getDatabase, closeDatabase } from "../db";
import { profiles, revisionMedia, user } from "../db/schema";
import { lockMediaOwner, publishOwnedMedia } from "../media/service";
import { getMediaStorage } from "../media/storage";
import { replayRecoveryEvents } from "../operations/recovery";
import { Queue, workerConnection } from "../worker/queue";
import { executeClaim } from "../worker/runtime";
import { enqueueMediaSweep } from "../media/jobs";
import { setTimeout as pause } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { databaseIdentity, mediaIdentity, recoveryWorkspace } from "./backup";
import { decryptFile, loadKey, type ArchiveKey } from "./crypto";
import { digest, durable, fail, privateDirectory, writePrivate } from "./files";
import { MANIFEST_MAX, manifestSchema } from "./manifest";
import { type BackupStore } from "./store";
import { journalRecords } from "./journal";
import { checkTool, native } from "./native";
async function validateArchive(store: BackupStore, id: string, work: string, key: ArchiveKey, signal: AbortSignal) {
  signal.throwIfAborted();
  await privateDirectory(work);
  const sealed = path.join(work, "manifest.enc"), plain = path.join(work, "manifest.json");
  await store.get(id, "manifest.enc", sealed, signal); await decryptFile(sealed, plain, key, MANIFEST_MAX);
  const manifest = manifestSchema.parse(JSON.parse(await readFile(plain, "utf8")));
  if (manifest.id !== id) fail("ARCHIVE_ID_MISMATCH");
  for (const f of manifest.files) {
    signal.throwIfAborted();
    const enc = path.join(work, f.name), target = path.join(work, f.name + ".plain");
    await store.get(id, f.name, enc, signal); await decryptFile(enc, target, key, f.bytes);
    const info = await digest(target, f.bytes);
    if (info.bytes !== f.bytes || info.sha256 !== f.sha256) fail("ARCHIVE_HASH_MISMATCH");
    await rm(enc);
    signal.throwIfAborted();
  }
  return manifest;
}
async function emptyMediaTarget(signal: AbortSignal) {
  if (process.env.MEDIA_STORAGE === "local") {
    const root = await privateDirectory(process.env.MEDIA_LOCAL_ROOT || "");
    if ((await readdir(root)).length) fail("RESTORE_MEDIA_TARGET_NOT_EMPTY");
  } else if (process.env.MEDIA_STORAGE === "s3") {
    const client = new S3Client({ endpoint: process.env.MEDIA_S3_ENDPOINT, region: process.env.MEDIA_S3_REGION, credentials: { accessKeyId: process.env.MEDIA_S3_ACCESS_KEY_ID || "", secretAccessKey: process.env.MEDIA_S3_SECRET_ACCESS_KEY || "" }, maxAttempts: 2 });
    try {
      for (const bucket of [process.env.MEDIA_PRIVATE_BUCKET, process.env.MEDIA_PUBLIC_BUCKET]) {
        if (!bucket) fail("RESTORE_MEDIA_CONFIG_INVALID");
        const r = await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }), { abortSignal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
        if (r.KeyCount || r.Contents?.length || r.IsTruncated) fail("RESTORE_MEDIA_TARGET_NOT_EMPTY");
      }
    } catch { fail("RESTORE_MEDIA_TARGET_UNVERIFIED"); }
    finally { client.destroy(); }
  } else fail("RESTORE_MEDIA_CONFIG_INVALID");
}
export type RestoreOptions = { targetUrl: string; targetName: string; maintenance: boolean; snapshot: string; journal: string; expectedSequence: number; recoveryThrough: string; reportDirectory: string; store: BackupStore; key?: ArchiveKey; signal?: AbortSignal };
export async function restoreArchive(o: RestoreOptions) {
  const started = Date.now(), signal = AbortSignal.any([o.signal || new AbortController().signal, AbortSignal.timeout(4 * 3600000)]);
  const u = new URL(o.targetUrl);
  if (!o.maintenance || decodeURIComponent(u.pathname.slice(1)) !== o.targetName || !/^[a-zA-Z0-9_]+$/.test(o.targetName) || !Number.isSafeInteger(o.expectedSequence) || o.expectedSequence < 0 || !Number.isFinite(Date.parse(o.recoveryThrough))) fail("RESTORE_ACK_REQUIRED");
  // The pre-SQL marker MUST be the gate consumed by app and worker. A report
  // beside an unrelated/absent service marker cannot cover pg_restore's commit.
  if (!path.isAbsolute(o.reportDirectory) || o.reportDirectory !== path.resolve(o.reportDirectory) || process.env.SERVICE_CLOSED_FILE !== path.join(o.reportDirectory, "SERVICE_CLOSED")) fail("RESTORE_SERVICE_GATE_CONFIG_INVALID");
  const report = await privateDirectory(o.reportDirectory), closed = process.env.SERVICE_CLOSED_FILE;
  // An existing marker deliberately prevents casual repeat after a failed restore.
  await writePrivate(closed, JSON.stringify({ version: 1, state: "closed", startedAt: new Date().toISOString() }));
  await durable(closed);
  let work: string | undefined;
  let sql: ReturnType<typeof workerConnection> | undefined;
  let stage = "validate";
  try {
    signal.throwIfAborted();
    work = await recoveryWorkspace();
    const key = o.key || await loadKey();
    const snapshotWork = path.join(work, "snapshot"), journalWork = path.join(work, "journal");
    const m = await validateArchive(o.store, o.snapshot, snapshotWork, key, signal), j = await validateArchive(o.store, o.journal, journalWork, key, signal);
    if (m.kind !== "snapshot" || j.kind !== "journal" || j.metadata.sourceDatabase !== m.metadata.sourceDatabase || j.metadata.sourceMedia !== m.metadata.sourceMedia || j.recoverySequence < m.recoverySequence || j.recoverySequence !== o.expectedSequence || Date.parse(j.createdAt) < Date.parse(o.recoveryThrough) || Date.parse(o.recoveryThrough) < Date.parse(m.createdAt) || Date.parse(j.createdAt) > Date.now() + 30000 || started - Date.parse(j.createdAt) > 120000) fail("CURRENT_RECOVERY_JOURNAL_REQUIRED");
    if (databaseIdentity(o.targetUrl) === m.metadata.sourceDatabase || mediaIdentity() === m.metadata.sourceMedia || (process.env.BACKUP_DATABASE_URL && databaseIdentity(o.targetUrl) === databaseIdentity(process.env.BACKUP_DATABASE_URL))) fail("RESTORE_SOURCE_TARGET_CONFLICT");
    if (process.env.MEDIA_STORAGE === "s3" && process.env.MEDIA_PUBLIC_ORIGIN !== m.metadata.mediaPublicOrigin) fail("RESTORE_PURGE_ORIGIN_MISMATCH");
    let verifiedCount = 0, verifiedSequence = 0;
    for await (const r of journalRecords(path.join(journalWork, j.files[0].name + ".plain"))) { signal.throwIfAborted(); verifiedCount++; verifiedSequence = r.sequence; }
    if (verifiedCount !== j.eventCount || verifiedSequence !== j.recoverySequence) fail("JOURNAL_INCOMPLETE");
    stage = "target-check";
    const command = await checkTool("restore", o.targetUrl, signal);
    // Authentication, strict manifest, bounds and every hash pass before SQL/media use.
    await native(command, ["--list", path.join(snapshotWork, m.files[0].name + ".plain")], o.targetUrl, signal);
    sql = workerConnection(o.targetUrl);
    const [occupied] = await sql`select count(*)::int as n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%' and c.relkind in ('r','p','v','m','S','f')`;
    if (occupied.n) fail("RESTORE_DATABASE_TARGET_NOT_EMPTY");
    await emptyMediaTarget(signal);
    // Isolated restore process: processors must connect only to this target.
    await closeDatabase(); process.env.DATABASE_URL = o.targetUrl;
    stage = "database-restore";
    await native(command, ["--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges", "--dbname=" + u.pathname.slice(1), path.join(snapshotWork, m.files[0].name + ".plain")], o.targetUrl, signal);
    await sql`insert into recovery_status(id,state) values('restore','closed') on conflict(id) do update set state='closed',updated_at=now()`;
    // Authentication revocations after the snapshot are not a content journal.
    // Never reactivate an old session or one-time auth link on recovery.
    await sql`delete from session`;
    await sql`delete from verification`;
    await sql`update jobs set state=case when attempts>=max_attempts then 'failed' else 'pending' end,locked_at=null,locked_by=null,finished_at=case when attempts>=max_attempts then now() else null end,available_at=now(),updated_at=now() where state='running'`;
    await sql`update jobs set state='failed',payload='{}'::jsonb,locked_at=null,locked_by=null,finished_at=now(),last_error_code='RESTORE_MAIL_CANCELLED',updated_at=now() where kind='email'`;
    // Retain ready private objects only. No public copy exists at this stage.
    stage = "private-media";
    const storage = getMediaStorage();
    for (const f of m.files.slice(1)) {
      signal.throwIfAborted();
      await storage.putFile("private", f.object!.key, path.join(snapshotWork, f.name + ".plain"), f.bytes, f.object!.contentType);
      signal.throwIfAborted();
    }
    stage = "journal-history";
    // Snapshot state already includes earlier events. Verify that prefix, then
    // start replay at the snapshot watermark so old reinstatements cannot erase
    // a legitimate publication made before the snapshot.
    const canonical = (value: Record<string, unknown>) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    const [{ n: oldCount }] = await sql`select count(*)::int as n from recovery_events where sequence<=${m.recoverySequence}`;
    let prefixCount = 0;
    let prefix: { sequence: number; payload: Record<string, unknown> }[] = [];
    const verifyPrefix = async () => {
      signal.throwIfAborted();
      if (!prefix.length) return;
      const rows = await sql!`select sequence,payload from recovery_events where sequence in ${sql!(prefix.map(r => r.sequence))}`;
      if (rows.length !== prefix.length) fail("RECOVERY_HISTORY_CONFLICT");
      const bySequence = new Map(rows.map(r => [Number(r.sequence), r.payload]));
      for (const r of prefix) if (canonical(bySequence.get(r.sequence)) !== canonical(r.payload)) fail("RECOVERY_HISTORY_CONFLICT");
      prefixCount += prefix.length; prefix = [];
    };
    for await (const event of journalRecords(path.join(journalWork, j.files[0].name + ".plain"))) {
      signal.throwIfAborted();
      if (event.sequence > m.recoverySequence) break;
      prefix.push(event); if (prefix.length === 500) await verifyPrefix();
    }
    await verifyPrefix();
    if (prefixCount !== oldCount) fail("RECOVERY_HISTORY_CONFLICT");
    await sql`insert into recovery_replay(id,last_sequence) values(true,${m.recoverySequence}) on conflict(id) do update set last_sequence=excluded.last_sequence,updated_at=now()`;
    stage = "journal-replay";
    let previous = 0, count = 0, batch: unknown[] = [];
    for await (const event of journalRecords(path.join(journalWork, j.files[0].name + ".plain"))) {
      signal.throwIfAborted();
      if (event.sequence <= previous || event.sequence > j.recoverySequence) fail("JOURNAL_ORDER_INVALID");
      previous = event.sequence; count++; batch.push(event);
      if (batch.length === 500) { await replayRecoveryEvents(batch); signal.throwIfAborted(); batch = []; }
    }
    signal.throwIfAborted();
    if (batch.length) await replayRecoveryEvents(batch);
    signal.throwIfAborted();
    if (previous !== j.recoverySequence || count !== j.eventCount) fail("JOURNAL_INCOMPLETE");
    // Incomplete uploads have no retained content; force their normal expiry.
    await sql`update media_storage set expires_at=now()-interval '1 second' where state in ('uploading','queued')`;
    await sql`update jobs set state='succeeded',finished_at=now(),locked_at=null,locked_by=null,last_error_code='RESTORE_UPLOAD_EXPIRED',updated_at=now()
      where kind='media' and payload->>'action'='process' and state<>'succeeded'
      and payload->>'assetId' in (select asset_id::text from media_storage where state in ('uploading','queued'))`;
    // Exhausted cleanup must be explicitly retried during the closed recovery.
    await sql`update jobs set state='pending',attempts=0,finished_at=null,available_at=now(),last_error_code=null,updated_at=now() where state='failed' and kind in ('media','media_deletion','cache_purge','account_deletion')`;
    await sql`update jobs set available_at=now(),updated_at=now() where state='pending' and kind<>'email'`;
    stage = "cleanup";
    await enqueueMediaSweep(randomUUID());
    const queue = new Queue(sql);
    for (let i = 0; i < 100000; i++) {
      signal.throwIfAborted();
      const c = await queue.claim(true);
      if (!c) {
        const [remaining] = await sql`select count(*)::int as n,count(*) filter(where state='failed' or state='running')::int as blocked,
          least(1000,greatest(50,extract(epoch from min(available_at)-now())*1000))::int as wait_ms from jobs where kind<>'email' and state<>'succeeded'`;
        if (!remaining.n) break;
        if (remaining.blocked) fail("RESTORE_CLEANUP_INCOMPLETE");
        await pause(remaining.wait_ms ?? 100, undefined, { signal }); continue;
      }
      await executeClaim(queue, c, signal);
    }
    const [pending] = await sql`select count(*)::int as n from jobs where kind<>'email' and state<>'succeeded'`;
    const [incomplete] = await sql`select count(*)::int as n from media_storage where state<>'ready' or revoking_key is not null`;
    if (pending.n || incomplete.n) fail("RESTORE_CLEANUP_INCOMPLETE");
    // Reconstitute only still-live publications through the existing contract.
    stage = "publication";
    const db = getDatabase();
    const live = await db.select({ id: profiles.id, owner: profiles.ownerId }).from(profiles).innerJoin(user, eq(user.id, profiles.ownerId)).where(and(isNull(user.deletedAt), isNull(user.suspendedAt), eq(user.emailVerified, true), isNull(profiles.deletedAt), isNull(profiles.suspendedAt)));
    for (const p of live) {
      signal.throwIfAborted();
      await db.transaction(async tx => {
        signal.throwIfAborted();
        await lockMediaOwner(tx, p.owner);
        const [profile] = await tx.select().from(profiles).where(eq(profiles.id, p.id)).for("update");
        if (!profile.currentRevisionId) return;
        const ids = await tx.select({ id: revisionMedia.mediaId }).from(revisionMedia).where(eq(revisionMedia.revisionId, profile.currentRevisionId));
        await publishOwnedMedia(tx, p.owner, ids.map(r => r.id), signal);
        signal.throwIfAborted();
      });
      signal.throwIfAborted();
    }
    signal.throwIfAborted();
    const result = { version: 1, state: "validated", reopeningRequiresOperator: true, durationMs: Date.now() - started, snapshot: m.id, journal: j.id, replayedSequence: previous, restoredPrivateFiles: m.files.length - 1, completedAt: new Date().toISOString() };
    await sql`update recovery_status set state='validated',updated_at=now(),details=${sql.json(result)} where id='restore'`;
    signal.throwIfAborted();
    await writePrivate(path.join(report, "restore-report.json.tmp"), JSON.stringify(result));
    signal.throwIfAborted();
    await rename(path.join(report, "restore-report.json.tmp"), path.join(report, "restore-report.json"));
    signal.throwIfAborted();
    return result;
  } catch {
    if (sql) await sql`update recovery_status set state='closed',updated_at=now() where id='restore'`.catch(() => {});
    await rm(path.join(report, "restore-report.json.tmp"), { force: true }).catch(() => {});
    await rm(path.join(report, "restore-report.json"), { force: true }).catch(() => {});
    await writePrivate(path.join(report, "restore-failure.json"), JSON.stringify({ version: 1, state: "closed", code: "RESTORE_FAILED", stage, durationMs: Date.now() - started })).catch(() => {});
    fail("RESTORE_FAILED_SERVICE_CLOSED");
  } finally { await sql?.end({ timeout: 0 }); await closeDatabase(); if (work) await rm(work, { recursive: true, force: true }); }
}
