import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, readFile, unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { bound, durable, fail, regularFile } from "./files";
export type ArchiveKey = { id: string; bytes: Buffer };
const headerSchema = z.object({ v: z.literal(1), algorithm: z.literal("aes-256-gcm"), keyId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), nonce: z.string().regex(/^[0-9a-f]{24}$/) }).strict();
export async function loadKey(file = process.env.BACKUP_KEY_FILE, id = process.env.BACKUP_KEY_ID): Promise<ArchiveKey> {
  if (!file || !id || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) fail("BACKUP_KEY_REQUIRED");
  const info = await regularFile(file, 32);
  if (info.size !== 32 || info.mode & 0o077 || info.uid !== process.getuid?.()) fail("BACKUP_KEY_PERMISSIONS");
  return { id, bytes: await readFile(file) };
}
export async function encryptFile(source: string, target: string, key: ArchiveKey, max: number) {
  await regularFile(source, max);
  const nonce = randomBytes(12);
  const json = Buffer.from(JSON.stringify({ v: 1, algorithm: "aes-256-gcm", keyId: key.id, nonce: nonce.toString("hex") }));
  const len = Buffer.alloc(4); len.writeUInt32BE(json.length);
  const header = Buffer.concat([Buffer.from("MBG1"), len, json]);
  const cipher = createCipheriv("aes-256-gcm", key.bytes, nonce); cipher.setAAD(header);
  const out = await open(target, "wx", 0o600);
  try {
    await out.write(header);
    await pipeline(createReadStream(source), bound(max), cipher, createWriteStream(target, { fd: out.fd, autoClose: false, start: header.length }));
    await out.write(cipher.getAuthTag(), 0, 16, header.length + (await regularFile(source, max)).size);
    await out.sync();
  } finally { await out.close(); }
  await durable(target);
}
export async function decryptFile(source: string, target: string, key: ArchiveKey, max: number) {
  const info = await regularFile(source, max + 4096);
  const input = await open(source, "r");
  try {
    const first = Buffer.alloc(8); await input.read(first, 0, 8, 0);
    const length = first.readUInt32BE(4);
    if (first.subarray(0, 4).toString() !== "MBG1" || length > 2048 || length < 20 || info.size < 8 + length + 16) fail("ARCHIVE_INVALID");
    const json = Buffer.alloc(length); await input.read(json, 0, length, 8);
    const h = headerSchema.parse(JSON.parse(json.toString()));
    if (h.keyId !== key.id) fail("ARCHIVE_KEY_MISMATCH");
    const tag = Buffer.alloc(16); await input.read(tag, 0, 16, info.size - 16);
    const decipher = createDecipheriv("aes-256-gcm", key.bytes, Buffer.from(h.nonce, "hex"));
    decipher.setAAD(Buffer.concat([first, json])); decipher.setAuthTag(tag);
    await pipeline((info.size === 8 + length + 16 ? Readable.from([]) : createReadStream(source, { start: 8 + length, end: info.size - 17 })), decipher, bound(max), createWriteStream(target, { flags: "wx", mode: 0o600 }));
    await durable(target);
  } catch { await unlink(target).catch(() => {}); fail("ARCHIVE_AUTHENTICATION_FAILED"); }
  finally { await input.close(); }
}
