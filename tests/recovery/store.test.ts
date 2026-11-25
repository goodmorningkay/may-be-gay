import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredStores, LocalBackupStore, retain, type BackupStore, type StoreEntry } from "../../src/server/recovery/store";

const signal = new AbortController().signal;
let root: string | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = undefined;
  }
});

async function collect(store: BackupStore) {
  const entries: StoreEntry[] = [];
  for await (const p of store.list(signal)) entries.push(...p.entries);
  return entries;
}

describe("local backup store and retention", () => {
  it("stores real private local files and expires archives older than 30 days", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "backup-store-"));
    const store = new LocalBackupStore(path.join(root, "store"));
    const input = path.join(root, "input");
    await writeFile(input, "ciphertext", { mode: 0o600 });

    const old = `snapshot-${Date.now() - 31 * 86400000}-${randomUUID()}`;
    const current = `snapshot-${Date.now()}-${randomUUID()}`;
    await store.put(old, "file-0.enc", input);
    await store.put(old, "manifest.enc", input);
    await store.put(current, "manifest.enc", input);

    const res = await retain(store, signal, Date.now());
    expect(res).toEqual({ complete: true, removed: 2 });
    expect(await readdir(path.join(root, "store"))).toEqual([current]);

    const out = path.join(root, "output");
    await store.get(current, "manifest.enc", out);
    expect(await readFile(out, "utf8")).toBe("ciphertext");
  });

  it("rejects traversal and invalid archive entry names", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "backup-path-"));
    const store = new LocalBackupStore(root);
    await expect(store.get("../x", "manifest.enc", path.join(root, "out"))).rejects.toThrow("ARCHIVE_PATH_INVALID");
    await expect(store.put(`snapshot-${Date.now()}-${randomUUID()}`, "bad.txt", path.join(root, "in"))).rejects.toThrow("ARCHIVE_PATH_INVALID");
  });

  it("supports custom cutoff and respects AbortSignal during retention", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "backup-cutoff-"));
    const store = new LocalBackupStore(root);
    const input = path.join(root, "input");
    await writeFile(input, "sealed", { mode: 0o600 });

    const id = `journal-${Date.now() - 1000}-${randomUUID()}`;
    await store.put(id, "manifest.enc", input);

    expect(await retain(store, signal, Date.now(), Number.MAX_SAFE_INTEGER)).toEqual({ complete: true, removed: 1 });
    expect(await collect(store)).toEqual([]);

    const aborted = new AbortController();
    aborted.abort();
    await store.put(id, "manifest.enc", input);
    await expect(retain(store, aborted.signal)).rejects.toThrow();
  });

  it("requires BACKUP_LOCAL_ROOT for configuredStores", () => {
    vi.stubEnv("BACKUP_LOCAL_ROOT", "");
    expect(() => configuredStores()).toThrow("BACKUP_LOCAL_ROOT_REQUIRED");
    vi.stubEnv("BACKUP_LOCAL_ROOT", "/tmp/local-backups");
    const stores = configuredStores();
    expect(stores).toHaveLength(1);
    expect(stores[0]).toBeInstanceOf(LocalBackupStore);
  });
});
