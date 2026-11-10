import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, chmod, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptFile, encryptFile, loadKey } from "../../src/server/recovery/crypto";
import { manifestSchema } from "../../src/server/recovery/manifest";
import { LocalBackupStore, S3BackupStore } from "../../src/server/recovery/store";
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "recovery-test-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
describe("authenticated bounded archives", () => {
  it("round trips and rejects tampering/wrong keys, removing plaintext", async () => {
    const key = { id: "fixture", bytes: randomBytes(32) }, input = path.join(root, "in"), enc = path.join(root, "enc"), out = path.join(root, "out");
    await writeFile(input, randomBytes(200000)); await encryptFile(input, enc, key, 200000); await decryptFile(enc, out, key, 200000);
    expect(await readFile(out)).toEqual(await readFile(input)); await rm(out);
    await expect(decryptFile(enc, out, { id: key.id, bytes: randomBytes(32) }, 200000)).rejects.toThrow("ARCHIVE_AUTHENTICATION_FAILED");
    const data = await readFile(enc); data[data.length - 20] ^= 1; await writeFile(enc, data);
    await expect(decryptFile(enc, out, key, 200000)).rejects.toThrow("ARCHIVE_AUTHENTICATION_FAILED");
    await expect(readFile(out)).rejects.toThrow();
  });
  it("authenticates an empty journal payload", async () => {
    const key = { id: "empty", bytes: randomBytes(32) }, input = path.join(root, "empty"), enc = path.join(root, "enc"), out = path.join(root, "out");
    await writeFile(input, ""); await encryptFile(input, enc, key, 0); await decryptFile(enc, out, key, 0);
    expect((await readFile(out)).length).toBe(0);
  });
  it("requires a protected key and rejects files above bounds and symlinks", async () => {
    const input = path.join(root, "key"); await writeFile(input, randomBytes(32), { mode: 0o600 });
    expect((await loadKey(input, "fixture")).bytes.length).toBe(32); await chmod(input, 0o644);
    await expect(loadKey(input, "fixture")).rejects.toThrow("BACKUP_KEY_PERMISSIONS");
    await expect(encryptFile(input, path.join(root, "out"), { id: "a", bytes: randomBytes(32) }, 31)).rejects.toThrow("FILE_BOUNDS_INVALID");
    const link = path.join(root, "symlink"); await symlink(input, link);
    await expect(loadKey(link, "fixture")).rejects.toThrow("FILE_BOUNDS_INVALID");
  });
  it("rejects traversal and accidental media credential/bucket reuse", async () => {
    const store = new LocalBackupStore(root);
    await expect(store.get("../x", "manifest.enc", path.join(root, "out"))).rejects.toThrow("ARCHIVE_PATH_INVALID");
    expect(manifestSchema.safeParse({ files: [{ name: "../../x" }] }).success).toBe(false);
    expect(() => new S3BackupStore({ NODE_ENV: "test", BACKUP_S3_ENDPOINT: "https://backup.invalid", BACKUP_S3_REGION: "auto", BACKUP_S3_BUCKET: "media", BACKUP_S3_ACCESS_KEY_ID: "separate", BACKUP_S3_SECRET_ACCESS_KEY: "separate", BACKUP_S3_PREFIX: "backups/fixture/", MEDIA_PRIVATE_BUCKET: "media" })).toThrow("BACKUP_MEDIA_CREDENTIAL_REUSE");
  });
});
