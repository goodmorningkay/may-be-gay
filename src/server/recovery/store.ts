import { createReadStream, createWriteStream } from "node:fs";
import { opendir, unlink, lstat, rmdir, readFile, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import { bound, copyBounded, durable, fail, privateDirectory, recoveryWorkRoot, regularFile, writePrivate } from "./files";
export const MAX_FILE = 16 * 1024 ** 3;
export const archiveId = /^(snapshot|journal)-\d{13}-[a-f0-9-]{36}$/;
const namePattern = /^(manifest\.enc|file-\d{1,6}\.enc)$/;
function fileLimit(name: string) { return name === "manifest.enc" ? 8 * 1024 ** 2 + 4096 : MAX_FILE + 4096; }
function validate(id: string, name: string) { if (!archiveId.test(id) || !namePattern.test(name)) fail("ARCHIVE_PATH_INVALID"); }
export type StoreEntry = { id: string; name: string };
export type StorePage = { entries: StoreEntry[]; cursor?: string };
export const STORE_PAGE_SIZE = 1000;
export interface BackupStore {
  /** Stable, non-secret identity for a private local retention checkpoint. */
  readonly retentionIdentity: string;
  /** Staging stores may be pruned only after every durable destination commits. */
  readonly staging?: boolean;
  put(id: string, name: string, source: string, signal: AbortSignal): Promise<void>;
  get(id: string, name: string, target: string, signal: AbortSignal): Promise<void>;
  list(signal: AbortSignal, cursor?: string): AsyncIterable<StorePage>;
  remove(id: string, name: string, signal: AbortSignal): Promise<void>;
}
export class LocalBackupStore implements BackupStore {
  readonly retentionIdentity: string;
  constructor(readonly root: string, readonly staging = false) { this.retentionIdentity = `local:${path.resolve(root)}`; }
  private async file(id: string, name: string) { validate(id, name); await privateDirectory(this.root); await privateDirectory(path.join(this.root, id)); return path.join(this.root, id, name); }
  async put(id: string, name: string, source: string) { await copyBounded(source, await this.file(id, name), MAX_FILE + 4096); }
  async get(id: string, name: string, target: string) { await copyBounded(await this.file(id, name), target, fileLimit(name)); }
  async *list(signal: AbortSignal, cursor?: string): AsyncIterable<StorePage> {
    await privateDirectory(this.root);
    let resume: StoreEntry | undefined;
    if (cursor) { const parts = cursor.split("/"); if (parts.length !== 2) fail("STORE_CURSOR_INVALID"); validate(parts[0], parts[1]); resume = { id: parts[0], name: parts[1] }; }
    // Keep the cursor directory until traversal moves past it. If an operator
    // removed it, restart safely; deletion is idempotent and never advances first.
    if (resume) { try { await lstat(path.join(this.root, resume.id)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; resume = undefined; } }
    let seeking = !!resume;
    const directories = await opendir(this.root);
    for await (const entry of directories) {
      signal.throwIfAborted(); const id = entry.name;
      if (!archiveId.test(id)) continue;
      if (seeking && id !== resume!.id) continue;
      seeking = false;
      await privateDirectory(path.join(this.root, id));
      let after = id === resume?.id ? resume.name : "";
      for (;;) {
        // Directory order is unspecified. Keep only the next bounded lexical
        // page, so removing entries cannot invalidate an offset on restart.
        const names: string[] = [];
        for await (const f of await opendir(path.join(this.root, id))) {
          signal.throwIfAborted(); if (!namePattern.test(f.name)) fail("ARCHIVE_PATH_INVALID");
          if (f.name <= after) continue;
          if (names.length === STORE_PAGE_SIZE && f.name >= names[names.length - 1]) continue;
          let lo = 0, hi = names.length;
          while (lo < hi) { const mid = (lo + hi) >>> 1; if (names[mid] < f.name) lo = mid + 1; else hi = mid; }
          names.splice(lo, 0, f.name); if (names.length > STORE_PAGE_SIZE) names.pop();
        }
        if (!names.length) break;
        after = names[names.length - 1];
        yield { entries: names.map(name => ({ id, name })), cursor: `${id}/${after}` };
      }
      // Empty expired directories need no permanent index. A crash before the
      // next page checkpoint can cause a safe restart from the beginning.
      await rmdir(path.join(this.root, id)).catch(e => { if (!["ENOTEMPTY", "ENOENT"].includes(e.code)) throw e; });
    }
    yield { entries: [] };
  }
  async remove(id: string, name: string) { const f = await this.file(id, name); await lstat(f).then(() => unlink(f)).catch(e => { if (e.code !== "ENOENT") throw e; }); await durable(path.dirname(f)); }
}
export class S3BackupStore implements BackupStore {
  readonly retentionIdentity: string;
  private readonly client: S3Client;
  private readonly prefix: string;
  private readonly bucket: string;
  constructor(env: NodeJS.ProcessEnv = process.env) {
    const { BACKUP_S3_ENDPOINT: endpoint, BACKUP_S3_REGION: region, BACKUP_S3_BUCKET: bucket, BACKUP_S3_ACCESS_KEY_ID: accessKeyId, BACKUP_S3_SECRET_ACCESS_KEY: secretAccessKey, BACKUP_S3_PREFIX: prefix } = env;
    if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey || !prefix || !/^backups\/[a-z0-9_-]{1,48}\/$/.test(prefix)) fail("BACKUP_STORE_CONFIG_INVALID");
    const u = new URL(endpoint);
    if (u.protocol !== "https:" || u.username || u.password || u.pathname !== "/" || u.search || u.hash) fail("BACKUP_STORE_CONFIG_INVALID");
    if ([env.MEDIA_PRIVATE_BUCKET, env.MEDIA_PUBLIC_BUCKET].includes(bucket) || accessKeyId === env.MEDIA_S3_ACCESS_KEY_ID || secretAccessKey === env.MEDIA_S3_SECRET_ACCESS_KEY) fail("BACKUP_MEDIA_CREDENTIAL_REUSE");
    this.prefix = prefix; this.bucket = bucket; this.retentionIdentity = `s3:${endpoint}:${bucket}/${prefix}`;
    this.client = new S3Client({ endpoint, region, credentials: { accessKeyId, secretAccessKey }, maxAttempts: 2, requestChecksumCalculation: "WHEN_REQUIRED" });
  }
  private key(id: string, name: string) { validate(id, name); return `${this.prefix}${id}/${name}`; }
  private deadline(signal: AbortSignal) { return AbortSignal.any([signal, AbortSignal.timeout(120000)]); }
  async put(id: string, name: string, source: string, signal: AbortSignal) {
    const info = await regularFile(source, MAX_FILE + 4096);
    try { await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.key(id, name), Body: createReadStream(source), ContentLength: info.size, ContentType: "application/octet-stream", IfNoneMatch: "*" }), { abortSignal: this.deadline(signal) }); }
    catch { fail("BACKUP_STORE_WRITE_FAILED"); }
  }
  async get(id: string, name: string, target: string, signal: AbortSignal) {
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(id, name) }), { abortSignal: this.deadline(signal) });
      if (!r.Body || r.ContentLength === undefined || r.ContentLength > fileLimit(name)) fail("FILE_BOUNDS_INVALID");
      await pipeline(r.Body as Readable, bound(fileLimit(name)), createWriteStream(target, { mode: 0o600, flags: "wx" }), { signal: this.deadline(signal) });
      await durable(target);
    } catch { fail("BACKUP_STORE_READ_FAILED"); }
  }
  async *list(signal: AbortSignal, cursor?: string): AsyncIterable<StorePage> {
    if (cursor) { const parts = cursor.split("/"); if (parts.length !== 2) fail("STORE_CURSOR_INVALID"); validate(parts[0], parts[1]); }
    for (;;) {
      signal.throwIfAborted(); let r;
      try { r = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.prefix, MaxKeys: STORE_PAGE_SIZE, StartAfter: cursor ? this.prefix + cursor : undefined }), { abortSignal: this.deadline(signal) }); }
      catch { fail("BACKUP_STORE_LIST_FAILED"); }
      const entries: StoreEntry[] = [];
      for (const o of r.Contents ?? []) {
        if (!o.Key?.startsWith(this.prefix)) fail("ARCHIVE_PATH_INVALID");
        const parts = o.Key.slice(this.prefix.length).split("/");
        if (parts.length !== 2) fail("ARCHIVE_PATH_INVALID"); validate(parts[0], parts[1]);
        const next = parts.join("/"); if (cursor && next <= cursor) fail("STORE_LIST_INVALID"); cursor = next;
        entries.push({ id: parts[0], name: parts[1] });
        if (entries.length > STORE_PAGE_SIZE) fail("STORE_PAGE_INVALID");
      }
      if (r.IsTruncated && !entries.length) fail("STORE_LIST_INVALID");
      // StartAfter survives deleted keys, process restarts and token expiry.
      yield { entries, ...(r.IsTruncated ? { cursor } : {}) };
      if (!r.IsTruncated) return;
    }
  }
  async remove(id: string, name: string, signal: AbortSignal) {
    try { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(id, name) }), { abortSignal: this.deadline(signal) }); }
    catch { fail("BACKUP_STORE_DELETE_FAILED"); }
  }
}
export type RetentionOptions = { progressRoot?: string; maxPages?: number; maxMs?: number; cutoff?: number; kind?: "snapshot" | "journal" };
/** Checkpoint only AFTER deletions are durable. Interrupted batches replay.
 * One runner per store (backup's archive runner lock); no secret is saved. */
export async function retain(store: BackupStore, signal: AbortSignal, now = Date.now(), options: RetentionOptions = {}) {
  const root = await privateDirectory(options.progressRoot || recoveryWorkRoot());
  const checkpoint = path.join(root, `retention-${createHash("sha256").update(`${store.retentionIdentity}:${options.kind || "all"}`).digest("hex")}.json`);
  let cursor: string | undefined;
  const cutoff = options.cutoff ?? now - 30 * 86400000;
  try {
    await regularFile(checkpoint, 4096);
    const saved = JSON.parse(await readFile(checkpoint, "utf8"));
    if (saved.version !== 1 || typeof saved.cursor !== "string" || saved.cursor.length > 256 || !Number.isFinite(saved.cutoff)) fail("RETENTION_PROGRESS_INVALID");
    // A policy change restarts the scan rather than skipping newly eligible keys.
    if (!options.kind || saved.cutoff === cutoff) cursor = saved.cursor;
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const save = async (next: string) => {
    const tmp = checkpoint + `.${randomUUID()}.tmp`;
    try { await writePrivate(tmp, JSON.stringify({ version: 1, cutoff, cursor: next })); await rename(tmp, checkpoint); await durable(checkpoint); }
    finally { await rm(tmp, { force: true }); }
  };
  const started = Date.now(); let pages = 0, removed = 0;
  for await (const page of store.list(signal, cursor)) {
    for (const f of page.entries) {
      signal.throwIfAborted(); validate(f.id, f.name);
      if ((!options.kind || f.id.startsWith(options.kind + "-")) && Number(f.id.split("-")[1]) < cutoff) { await store.remove(f.id, f.name, signal); removed++;
        // Bound crash replay to 63 deletions; also checkpoint at the time budget.
        if (removed % 64 === 0) await save(`${f.id}/${f.name}`);
      }
      if (Date.now() - started >= (options.maxMs ?? 15000)) { await save(`${f.id}/${f.name}`); return { complete: false, pages: pages + 1, removed }; }
    }
    if (!page.cursor) { await rm(checkpoint, { force: true }); return { complete: true, pages: pages + 1, removed }; }
    await save(page.cursor);
    if (++pages >= (options.maxPages ?? 16) || Date.now() - started >= (options.maxMs ?? 15000)) return { complete: false, pages, removed };
  }
  fail("STORE_LIST_INVALID");
}
export function configuredStores(): BackupStore[] {
  if (!process.env.BACKUP_LOCAL_ROOT) fail("BACKUP_LOCAL_ROOT_REQUIRED");
  if (process.env.BACKUP_OFFHOST && process.env.BACKUP_OFFHOST !== "s3") fail("BACKUP_STORE_CONFIG_INVALID");
  const offhost = process.env.BACKUP_OFFHOST === "s3";
  return [new LocalBackupStore(process.env.BACKUP_LOCAL_ROOT, offhost), ...(offhost ? [new S3BackupStore()] : [])];
}
