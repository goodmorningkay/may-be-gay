import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { commitArchive, recoveryWorkspace } from "../../src/server/recovery/backup";
import { LocalBackupStore, type BackupStore, type StoreEntry } from "../../src/server/recovery/store";
import { manifest } from "./manifest-fixture";
let root: string;
afterEach(async () => { vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });
const signal = new AbortController().signal, key = { id: "test", bytes: randomBytes(32) };
function recording(): BackupStore & { writes: string[] } {
  const writes: string[] = [];
  return { retentionIdentity: randomUUID(), writes, put: async (_, name) => { writes.push(name); }, get: async () => {}, async *list() { yield { entries: [] }; }, remove: async () => {} };
}
async function setup() { root = await mkdtemp(path.join(os.tmpdir(), "archive-commit-")); vi.stubEnv("BACKUP_WORK_ROOT", path.join(root, "progress")); }
it("requires an explicit persistent work root in production before creating recovery scratch", async () => {
  await setup(); vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("BACKUP_WORK_ROOT", "");
  await expect(recoveryWorkspace()).rejects.toThrow("BACKUP_WORK_ROOT_REQUIRED");
  vi.stubEnv("BACKUP_WORK_ROOT", path.join(root, "persistent"));
  expect(await recoveryWorkspace()).toMatch(new RegExp(`^${root}/persistent/run-`));
});
it("commits every destination before cleanup; retention failure remains a failed backup", async () => {
  await setup(); const m = manifest(), work = path.join(root, "file-0.enc"); await writeFile(work, "sealed");
  const local = recording(), offhost = recording();
  local.list = async function* () { throw new Error("retention failed"); };
  await expect(commitArchive(m, root, [local, offhost], key, signal)).rejects.toThrow("ARCHIVE_DESTINATION_OR_RETENTION_FAILED");
  expect(local.writes).toEqual(["file-0.enc", "manifest.enc"]); expect(offhost.writes).toEqual(local.writes);
});
it("a failed destination write still attempts other stores and never commits its manifest", async () => {
  await setup(); const bad = recording(), good = recording();
  bad.put = async (_, name) => { bad.writes.push(name); throw new Error("no space"); };
  await expect(commitArchive(manifest(), root, [bad, good], key, signal)).rejects.toThrow("ARCHIVE_DESTINATION_OR_RETENTION_FAILED");
  expect(bad.writes).toEqual(["file-0.enc"]); expect(good.writes).toEqual(["file-0.enc", "manifest.enc"]);
});
it("off-host cache keeps only one archive of each kind after durable commits", async () => {
  await setup(); const offhost = recording(), cache = new LocalBackupStore(path.join(root, "cache"), true);
  const input = path.join(root, "input"); await writeFile(input, "old sealed");
  const old = `snapshot-${Date.now() - 86400000}-${randomUUID()}`, journal = `journal-${Date.now() - 86400000}-${randomUUID()}`;
  await cache.put(old, "file-0.enc", input); await cache.put(old, "manifest.enc", input); await cache.put(journal, "manifest.enc", input);
  const m = manifest(); await writeFile(path.join(root, "file-0.enc"), "sealed");
  await commitArchive(m, root, [cache, offhost], key, signal);
  const inventory: StoreEntry[] = []; for await (const p of cache.list(signal)) inventory.push(...p.entries);
  expect(inventory.filter(f => f.id === old)).toEqual([]);
  expect(inventory.filter(f => f.id === m.id).map(f => f.name).sort()).toEqual(["file-0.enc", "manifest.enc"]);
  expect(inventory.some(f => f.id === journal)).toBe(true);
});
it("an off-host failure leaves the existing local cache and does not add a new snapshot", async () => {
  await setup(); const offhost = recording(), cache = new LocalBackupStore(path.join(root, "cache"), true);
  const input = path.join(root, "input"); await writeFile(input, "old"); const old = manifest();
  await cache.put(old.id, "manifest.enc", input);
  offhost.put = async () => { throw new Error("offline"); };
  await expect(commitArchive(manifest(), root, [cache, offhost], key, signal)).rejects.toThrow("ARCHIVE_DESTINATION_OR_RETENTION_FAILED");
  const entries: StoreEntry[] = []; for await (const p of cache.list(signal)) entries.push(...p.entries);
  expect(entries).toEqual([{ id: old.id, name: "manifest.enc" }]);
});
