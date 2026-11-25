import "server-only";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile, unlink, link, stat } from "node:fs/promises";
import path from "node:path";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSiteDomain } from "@/domain/hosts";
import { AUDIO_BYTES } from "./limits";
import { providerUnavailable, storageFailure } from "./errors";

type StorageArea = "private" | "public";
export interface MediaStorageAdapter {
  kind: "local" | "s3";
  put(area: StorageArea, key: string, body: Buffer, contentType: string): Promise<void>;
  putFile(area: StorageArea, key: string, file: string, bytes: number, contentType: string): Promise<void>;
  get(area: StorageArea, key: string, maxBytes: number): Promise<Buffer>;
  delete(area: StorageArea, key: string): Promise<void>;
  exists(area: StorageArea, key: string): Promise<boolean>;
  cleanTemporaries?(area: StorageArea, key: string): Promise<void>;
  publicUrl(key: string): string;
}
export function assertObjectKey(key: string) {
  if (key.length > 240 || !/^v1\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/[a-z0-9.-]+$/.test(key) || key.includes("..")) throw storageFailure();
}
export function objectKeys(assetId: string, token: string) {
  const prefix = `v1/${assetId}/${token}`;
  return { quarantine: `${prefix}/quarantine`, original: `${prefix}/original.webp`, display: `${prefix}/display.webp`, audio: `${prefix}/audio.mp3` };
}
export function publicObjectKey(assetId: string, token: string, kind: string) {
  return `v1/${assetId}/${token}/public-${randomUUID()}.${kind === "image" ? "webp" : "mp3"}`;
}
/** The caller holds the owner + ledger mutation locks. No active write for these
 * immutable locators can coexist, including after a process crash/retry. */
export async function cleanAssetTemporaries(storage: MediaStorageAdapter, row: { assetId: string; token: string; publicKey: string; revokingKey: string | null }) {
  if (!storage.cleanTemporaries) return;
  for (const key of Object.values(objectKeys(row.assetId, row.token))) await storage.cleanTemporaries("private", key);
  for (const key of [row.publicKey, row.revokingKey]) if (key) await storage.cleanTemporaries("public", key);
}
const hash = (body: Buffer) => createHash("sha256").update(body).digest("hex");
export class LocalMediaStorage implements MediaStorageAdapter {
  readonly kind = "local" as const;
  constructor(readonly root: string, readonly origin = "https://media.may-be.localhost") {
    if (!path.isAbsolute(root) || root === "/" || /\/(public|\.next)(\/|$)/.test(root)) throw providerUnavailable();
    const url = new URL(origin);
    if (url.origin !== origin || url.username || url.password || url.protocol !== "https:") throw providerUnavailable();
  }
  private file(area: StorageArea, key: string) { assertObjectKey(key); return path.join(this.root, area, key); }
  async put(area: StorageArea, key: string, body: Buffer, _contentType: string) {
    void _contentType;
    const target = this.file(area, key);
    const temp = `${target}.${randomUUID()}.partial`;
    try {
      if (await this.exists(area, key)) {
        if (hash(await this.get(area, key, body.length)) !== hash(body)) throw storageFailure();
        return;
      }
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(temp, body, { flag: "wx", mode: 0o600 });
      try { await link(temp, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || hash(await this.get(area, key, body.length)) !== hash(body)) throw error;
      }
    } catch { throw storageFailure(); }
    finally { await unlink(temp).catch(() => {}); }
  }
  async putFile(area: StorageArea, key: string, file: string, bytes: number, contentType: string) {
    // At most 10 MiB, but use filesystem copy so concurrent uploads do not retain
    // entire request bodies in the application heap.
    const target = this.file(area, key), temp = `${target}.${randomUUID()}.partial`;
    try {
      if ((await stat(file)).size !== bytes || bytes > AUDIO_BYTES) throw storageFailure();
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(file, temp, 1);
      try { await link(temp, target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || hash(await this.get(area, key, bytes)) !== hash(await readFile(file))) throw error; }
      void contentType;
    } catch { throw storageFailure(); }
    finally { await unlink(temp).catch(() => {}); }
  }
  async get(area: StorageArea, key: string, maxBytes: number) {
    const file = this.file(area, key);
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > maxBytes) throw storageFailure();
      const data = await readFile(file);
      if (data.length > maxBytes) throw storageFailure();
      return data;
    } catch { throw storageFailure(); }
  }
  async exists(area: StorageArea, key: string) {
    try { return (await stat(this.file(area, key))).isFile(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw storageFailure(); }
  }
  async delete(area: StorageArea, key: string) {
    const target = this.file(area, key);
    try {
      await unlink(target).catch(error => { if (error.code !== "ENOENT") throw error; });
      await this.cleanTemporaries(area, key);
    } catch { throw storageFailure(); }
  }
  async cleanTemporaries(area: StorageArea, key: string) {
    const target = this.file(area, key);
    try {
      const names = await readdir(path.dirname(target)).catch(error => { if (error.code === "ENOENT") return []; throw error; });
      const prefix = `${path.basename(target)}.`;
      for (const name of names) if (name.startsWith(prefix) && /^[a-f0-9-]{36}\.partial$/.test(name.slice(prefix.length))) {
        await unlink(path.join(path.dirname(target), name)).catch(error => { if (error.code !== "ENOENT") throw error; });
      }
    } catch { throw storageFailure(); }
  }
  publicUrl(key: string) { assertObjectKey(key); return `${this.origin}/media/${key}`; }
}
type S3Config = { endpoint: string; region: string; privateBucket: string; publicBucket: string; accessKeyId: string; secretAccessKey: string; publicOrigin: string };
export class S3MediaStorage implements MediaStorageAdapter {
  readonly kind = "s3" as const;
  readonly client: S3Client;
  constructor(readonly config: S3Config) {
    try {
      const endpoint = new URL(config.endpoint), origin = new URL(config.publicOrigin);
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
        origin.protocol !== "https:" || origin.origin !== config.publicOrigin || origin.username || origin.password ||
        !config.region || !config.accessKeyId || !config.secretAccessKey || !config.privateBucket || !config.publicBucket || config.privateBucket === config.publicBucket) throw new Error();
    } catch { throw providerUnavailable(); }
    this.client = new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }, maxAttempts: 2,
      requestHandler: { connectionTimeout: 2000, requestTimeout: 8000 } });
  }
  private bucket(area: StorageArea) { return area === "private" ? this.config.privateBucket : this.config.publicBucket; }
  async put(area: StorageArea, key: string, body: Buffer, contentType: string) {
    assertObjectKey(key);
    if (!body.length || body.length > AUDIO_BYTES) throw storageFailure();
    const Bucket = this.bucket(area), digest = hash(body);
    try {
      await this.client.send(new PutObjectCommand({ Bucket, Key: area === "public" ? `media/${key}` : key, Body: body, ContentLength: body.length, ContentType: contentType,
        CacheControl: area === "public" ? "public, max-age=60, must-revalidate" : "private, no-store",
        IfNoneMatch: "*", Metadata: { sha256: digest }, }), { abortSignal: AbortSignal.timeout(10_000) });
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 412) {
        try {
          const head = await this.client.send(new HeadObjectCommand({ Bucket, Key: area === "public" ? `media/${key}` : key }), { abortSignal: AbortSignal.timeout(10_000) });
          if (head.Metadata?.sha256 === digest && head.ContentLength === body.length && head.ContentType === contentType) return;
        } catch { /* return one redacted storage error */ }
      }
      throw storageFailure();
    }
  }
  async putFile(area: StorageArea, key: string, file: string, bytes: number, contentType: string) {
    assertObjectKey(key);
    if (area !== "private" || (await stat(file)).size !== bytes || !bytes || bytes > AUDIO_BYTES) throw storageFailure();
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(file)) digest.update(chunk);
    const sha256 = digest.digest("hex"), stream = createReadStream(file);
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.config.privateBucket, Key: key, Body: stream, ContentLength: bytes,
        ContentType: contentType, CacheControl: "private, no-store", IfNoneMatch: "*", Metadata: { sha256 } }), { abortSignal: AbortSignal.timeout(10000) });
    } catch { throw storageFailure(); }
    finally { stream.destroy(); }
  }
  async get(area: StorageArea, key: string, maxBytes: number) {
    assertObjectKey(key);
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket(area), Key: area === "public" ? `media/${key}` : key }), { abortSignal: AbortSignal.timeout(10_000) });
      if (!result.Body || (result.ContentLength !== undefined && result.ContentLength > maxBytes)) {
        (result.Body as { destroy?: () => void } | undefined)?.destroy?.(); throw new Error();
      }
      const chunks: Buffer[] = []; let received = 0;
      for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
        received += chunk.length;
        if (received > maxBytes) { (result.Body as { destroy?: () => void }).destroy?.(); throw new Error(); }
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch { throw storageFailure(); }
  }
  async exists(area: StorageArea, key: string) {
    assertObjectKey(key);
    try { await this.client.send(new HeadObjectCommand({ Bucket: this.bucket(area), Key: area === "public" ? `media/${key}` : key }), { abortSignal: AbortSignal.timeout(10000) }); return true; }
    catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return false;
      throw storageFailure();
    }
  }
  async delete(area: StorageArea, key: string) {
    assertObjectKey(key);
    try { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket(area), Key: area === "public" ? `media/${key}` : key }), { abortSignal: AbortSignal.timeout(10_000) }); }
    catch { throw storageFailure(); }
  }
  publicUrl(key: string) { assertObjectKey(key); return `${this.config.publicOrigin}/media/${key}`; }
}
let cachedS3: { signature: string; storage: S3MediaStorage } | undefined;
export function getMediaStorage(): MediaStorageAdapter {
  // Explicit local-zone storage also supports a production Next build in local
  // HTTPS acceptance. The real production domain has no local-storage fallback.
  if (process.env.MEDIA_STORAGE === "local" && getSiteDomain() === "may-be.localhost" && process.env.MEDIA_LOCAL_ROOT) {
    return new LocalMediaStorage(process.env.MEDIA_LOCAL_ROOT);
  }
  if (process.env.MEDIA_STORAGE !== "s3") throw providerUnavailable();
  const required = ["MEDIA_S3_ENDPOINT", "MEDIA_S3_REGION", "MEDIA_PRIVATE_BUCKET", "MEDIA_PUBLIC_BUCKET", "MEDIA_S3_ACCESS_KEY_ID", "MEDIA_S3_SECRET_ACCESS_KEY", "MEDIA_PUBLIC_ORIGIN"] as const;
  if (required.some(key => !process.env[key])) throw providerUnavailable();
  if (process.env.MEDIA_PUBLIC_ORIGIN !== `https://media.${getSiteDomain()}`) throw providerUnavailable();
  const signature = required.map(key => process.env[key]).join("\0");
  if (cachedS3?.signature === signature) return cachedS3.storage;
  const storage = new S3MediaStorage({ endpoint: process.env.MEDIA_S3_ENDPOINT!, region: process.env.MEDIA_S3_REGION!, privateBucket: process.env.MEDIA_PRIVATE_BUCKET!,
    publicBucket: process.env.MEDIA_PUBLIC_BUCKET!, accessKeyId: process.env.MEDIA_S3_ACCESS_KEY_ID!, secretAccessKey: process.env.MEDIA_S3_SECRET_ACCESS_KEY!, publicOrigin: process.env.MEDIA_PUBLIC_ORIGIN! });
  cachedS3 = { signature, storage };
  return storage;
}
