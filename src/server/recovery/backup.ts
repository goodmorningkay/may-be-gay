import { MAX_PRIVATE_MEDIA_OBJECTS } from "../../domain/media";
import { setTimeout as pause } from "node:timers/promises";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { validateMedia, validateStoredWebp } from "../media/validation";
import { getMediaStorage } from "../media/storage";
import { workerConnection } from "../worker/queue";
import { MEDIA_BACKUP_LOCK } from "../db/maintenance-lock";
import { recoveryRecordSchema } from "../operations/recovery";
import { encryptFile, loadKey, type ArchiveKey } from "./crypto";
import { digest, fail, privateDirectory, recoveryWorkRoot, writePrivate } from "./files";
import { checkTool, native } from "./native";
import { configuredStores, MAX_FILE, retain, type BackupStore } from "./store";
import { MANIFEST_MAX, manifestSchema, objectSchema, type Manifest } from "./manifest";
export function databaseIdentity(url: string) {
  const u = new URL(url); return createHash("sha256").update(`${u.hostname}:${u.port || "5432"}/${decodeURIComponent(u.pathname.slice(1))}`).digest("hex");
}
export function mediaIdentity() {
  return createHash("sha256").update(process.env.MEDIA_STORAGE === "local" ? `local:${process.env.MEDIA_LOCAL_ROOT}` : `s3:${process.env.MEDIA_S3_ENDPOINT}:${process.env.MEDIA_PRIVATE_BUCKET}:${process.env.MEDIA_PUBLIC_BUCKET}`).digest("hex");
}
export async function recoveryWorkspace() {
  const root = await privateDirectory(recoveryWorkRoot());
  const dir = await mkdtemp(path.join(root, "run-")); await chmod(dir, 0o700); return dir;
}
async function saveFile(m: Manifest, source: string, work: string, key: ArchiveKey, max: number, object?: Manifest["files"][number]["object"]) {
  const info = await digest(source, max);
  if (m.files.reduce((n, f) => n + f.bytes, info.bytes) > 64 * 1024 ** 3) fail("ARCHIVE_TOTAL_LIMIT");
  const name = `file-${m.files.length}.enc`;
  await encryptFile(source, path.join(work, name), key, max);
  m.files.push({ name, ...info, ...(object ? { object } : {}) });
}
export async function commitArchive(m: Manifest, work: string, stores: BackupStore[], key: ArchiveKey, signal: AbortSignal) {
  const plain = path.join(work, "manifest.json"); const serialized = JSON.stringify(manifestSchema.parse(m));
  if (Buffer.byteLength(serialized) > MANIFEST_MAX) fail("MANIFEST_LIMIT");
  await writePrivate(plain, serialized); await encryptFile(plain, path.join(work, "manifest.enc"), key, MANIFEST_MAX);
  signal.throwIfAborted();
  if (!stores.length) fail("DURABLE_BACKUP_STORE_REQUIRED");
  let failed = false, retentionPending = 0;
  const commit = async (store: BackupStore) => {
    for (const f of m.files) { signal.throwIfAborted(); await store.put(m.id, f.name, path.join(work, f.name), signal); }
    // Authenticated manifest is the commit record, written only after all files.
    signal.throwIfAborted(); await store.put(m.id, "manifest.enc", path.join(work, "manifest.enc"), signal);
  };
  // Cleanup can never prevent another durable destination from committing.
  for (const store of stores) { try { await commit(store); } catch { failed = true; } }
  for (const store of stores) { try { if (!(await retain(store, signal)).complete) retentionPending++; } catch { failed = true; } }
  if (failed) fail("ARCHIVE_DESTINATION_OR_RETENTION_FAILED");
  return { retentionPending };
}
export async function createArchive(kind: "snapshot" | "journal", options: { url?: string; stores?: BackupStore[]; key?: ArchiveKey; signal?: AbortSignal } = {}) {
  const started = Date.now(), url = options.url || process.env.BACKUP_DATABASE_URL;
  if (!url) fail("BACKUP_DATABASE_URL_REQUIRED");
  const sql = workerConnection(url), key = options.key || await loadKey(), stores = options.stores || configuredStores();
  const work = await recoveryWorkspace();
  const timeout = AbortSignal.timeout(180000), signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const abort = () => { void sql.end({ timeout: 0 }); }; signal.addEventListener("abort", abort, { once: true });
  try {
    const conn = await sql.reserve();
    try {
      await conn`set lock_timeout='10s'`;
      // Serialize cache replacement/checkpoints through upload without holding
      // the operations or media locks during provider I/O. A crashed connection
      // releases this runner lock; there is no stale filesystem lock to clear.
      const [{ runner }] = await conn`select pg_try_advisory_lock(740304,1) as runner`;
      if (!runner) fail("BACKUP_ALREADY_RUNNING");
      // Session lock BEFORE BEGIN: no RR snapshot is taken while waiting for a writer.
      await conn`select pg_advisory_lock(740302,1)`;
      // Avoid queuing an exclusive request behind owner-first publication:
      // existing media workers can hold shared locks while waiting for that owner.
      // A queued exclusive lock would prevent the publisher's shared acquisition.
      const lockStarted = Date.now();
      for (;;) {
        const [{ acquired }] = await conn`select pg_try_advisory_lock(${MEDIA_BACKUP_LOCK[0]},${MEDIA_BACKUP_LOCK[1]}) as acquired`;
        if (acquired) break;
        if (Date.now() - lockStarted >= 10000) fail("BACKUP_LOCK_TIMEOUT");
        await pause(50, undefined, { signal });
      }
      await conn`begin isolation level repeatable read read only`;
      await conn`set local idle_in_transaction_session_timeout='180s'`;
      const [snapshot] = await conn`select pg_export_snapshot() as snapshot, current_setting('server_version_num')::int as version, now() as captured`;
      const roles = await conn`select distinct pg_get_userbyid(relowner) as name from pg_class where relnamespace='public'::regnamespace order by name limit 101`;
      if (roles.length > 100 || snapshot.version < 170000) fail("DATABASE_VERSION_OR_ROLES_INVALID");
      const m: Manifest = { version: 1, kind, id: `${kind}-${started}-${randomUUID()}`, createdAt: new Date(snapshot.captured).toISOString(), databaseVersion: snapshot.version,
        recoverySequence: 0, eventCount: 0, files: [], metadata: { roleNames: roles.map(r => r.name), siteDomain: process.env.SITE_DOMAIN || "may-be.gay", mediaStorage: process.env.MEDIA_STORAGE as "local", sourceDatabase: databaseIdentity(url), sourceMedia: mediaIdentity(), mediaPublicOrigin: process.env.MEDIA_PUBLIC_ORIGIN || "https://media.may-be.localhost" } };
      const [{ high }] = await conn`select coalesce(max(sequence),0)::text as high from recovery_events`;
      m.recoverySequence = Number(high);
      if (kind === "snapshot") {
        await conn`select pg_advisory_lock(740301,1)`;
        const command = await checkTool("dump", url, signal), dump = path.join(work, "database.dump");
        await writePrivate(dump, "");
        await native(command, ["--format=custom", "--no-owner", "--no-privileges", `--snapshot=${snapshot.snapshot}`, `--file=${dump}`], url, signal);
        await chmod(dump, 0o600); await saveFile(m, dump, work, key, MAX_FILE); await rm(dump);
        const storage = getMediaStorage(), keys = new Set<string>(); let cursor = "00000000-0000-0000-0000-000000000000";
        for (;;) {
          const rows = await conn`select asset_id,original,display from media_storage where state='ready' and asset_id>${cursor}::uuid order by asset_id limit 100`;
          if (!rows.length) break;
          for (const row of rows) {
            if (!row.original || !row.display) fail("READY_MEDIA_INCOMPLETE");
            for (const obj of [row.original, row.display]) {
              const object = objectSchema.parse({ area: obj.area, key: obj.key, bytes: obj.bytes, contentType: obj.contentType });
              if (keys.has(object.key)) continue; keys.add(object.key);
              if (keys.size > MAX_PRIVATE_MEDIA_OBJECTS) fail("MEDIA_MANIFEST_LIMIT"); signal.throwIfAborted();
              const data = await storage.get("private", object.key, object.bytes);
              if (data.length !== object.bytes) fail("BACKUP_MEDIA_MISSING");
              // Validate retained bytes too: a truncated/corrupt source must not
              // become a newly authenticated, apparently healthy backup.
              if (object.contentType === "image/webp") await validateStoredWebp(data);
              else await validateMedia(data, "mp3");
              const file = path.join(work, "media.tmp"); await writePrivate(file, data);
              await saveFile(m, file, work, key, object.bytes, object); await rm(file);
            }
            cursor = row.asset_id;
          }
        }
        await conn`select pg_advisory_unlock(740301,1)`;
      } else {
        // operationsLock shares the exclusive backup lock: no journal commit can
        // interleave while paginating. Gaps from aborted sequences are allowed.
        const file = path.join(work, "journal.ndjson");
        const { open } = await import("node:fs/promises"); const out = await open(file, "wx", 0o600);
        try {
          let after = 0;
          for (;;) {
            const raw = await conn`select sequence,version,payload,created_at from recovery_events where sequence>${after} order by sequence limit 500`;
            const rows = raw.map(r => recoveryRecordSchema.parse({ sequence: Number(r.sequence), version: Number(r.version), payload: r.payload, createdAt: new Date(r.created_at).toISOString() }));
            if (!rows.length) break;
            for (const r of rows) { await out.writeFile(JSON.stringify(r) + "\n"); after = r.sequence; if (++m.eventCount > 1000000) fail("JOURNAL_LIMIT"); }
          }
          if (after !== m.recoverySequence) fail("JOURNAL_INCOMPLETE"); await out.sync();
        } finally { await out.close(); }
        await saveFile(m, file, work, key, MAX_FILE); await rm(file);
      }
      await conn`commit`; await conn`select pg_advisory_unlock(${MEDIA_BACKUP_LOCK[0]},${MEDIA_BACKUP_LOCK[1]})`; await conn`select pg_advisory_unlock(740302,1)`;
      const retention = await commitArchive(m, work, stores, key, signal);
      return { id: m.id, kind, sequence: m.recoverySequence, capturedAt: m.createdAt, durationMs: Date.now() - started, completedAt: new Date().toISOString(), files: m.files.length, ...retention };
    } finally { conn.release(); }
  } finally { signal.removeEventListener("abort", abort); await sql.end({ timeout: 0 }); await rm(work, { recursive: true, force: true }); }
}
