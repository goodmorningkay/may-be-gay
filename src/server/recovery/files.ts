import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createHash } from "node:crypto";
import path from "node:path";
export function fail(code: string): never { throw new Error(code); }
export function recoveryWorkRoot() {
  const root = process.env.BACKUP_WORK_ROOT;
  if (!root && process.env.NODE_ENV === "production") fail("BACKUP_WORK_ROOT_REQUIRED");
  return root || "/tmp/may-be-recovery";
}
export async function privateDirectory(root: string) {
  if (!path.isAbsolute(root) || root === "/" || /\/(public|\.next)(\/|$)/.test(root)) fail("PRIVATE_DIRECTORY_REQUIRED");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || await realpath(root) !== path.resolve(root)) fail("PRIVATE_DIRECTORY_REQUIRED");
  return root;
}
export async function regularFile(file: string, max: number) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > max) fail("FILE_BOUNDS_INVALID");
  return info;
}
export function bound(max: number) {
  let bytes = 0;
  return new Transform({ transform(chunk: Buffer, _, cb) { bytes += chunk.length; cb(bytes > max ? new Error("FILE_BOUNDS_INVALID") : null, chunk); } });
}
export async function digest(file: string, max: number) {
  await regularFile(file, max);
  const h = createHash("sha256");
  let bytes = 0;
  await pipeline(createReadStream(file), new Transform({ transform(chunk: Buffer, _, cb) { bytes += chunk.length; h.update(chunk); cb(bytes > max ? new Error("FILE_BOUNDS_INVALID") : null); } }));
  return { bytes, sha256: h.digest("hex") };
}
export async function durable(file: string) {
  const f = await open(file, "r"); try { await f.sync(); } finally { await f.close(); }
  const d = await open(path.dirname(file), "r"); try { await d.sync(); } finally { await d.close(); }
}
export async function writePrivate(file: string, content: string | Buffer) {
  const f = await open(file, "wx", 0o600); try { await f.writeFile(content); await f.sync(); } finally { await f.close(); }
}
export async function copyBounded(from: string, to: string, max: number) {
  await regularFile(from, max);
  await pipeline(createReadStream(from), bound(max), createWriteStream(to, { flags: "wx", mode: 0o600 }));
  await chmod(to, 0o600); await durable(to);
}
export async function size(file: string) { return (await stat(file)).size; }
