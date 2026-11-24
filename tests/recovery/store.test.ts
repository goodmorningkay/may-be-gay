import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalBackupStore, retain, S3BackupStore, STORE_PAGE_SIZE, type BackupStore, type StoreEntry } from "../../src/server/recovery/store";
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, opendir: vi.fn(actual.opendir) };
});
const signal = new AbortController().signal;
let root: string | undefined;
afterEach(async () => { vi.restoreAllMocks(); vi.mocked(fs.opendir).mockImplementation((await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).opendir); if (root) await rm(root, { recursive: true, force: true }); });
async function collect(store: BackupStore) { const entries: StoreEntry[] = []; for await (const p of store.list(signal)) entries.push(...p.entries); return entries; }
function offhost() { return new S3BackupStore({ NODE_ENV: "test", BACKUP_S3_ENDPOINT: "https://backup.invalid", BACKUP_S3_REGION: "auto", BACKUP_S3_BUCKET: "separate-backups", BACKUP_S3_ACCESS_KEY_ID: "backup-id", BACKUP_S3_SECRET_ACCESS_KEY: "backup-secret", BACKUP_S3_PREFIX: "backups/fixture/" }); }
describe("archive stores without network calls", () => {
  it("stores real private local files and expires the complete encrypted namespace after 30 days", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "backup-store-")); const store = new LocalBackupStore(path.join(root, "store"));
    const input = path.join(root, "input"); await writeFile(input, "ciphertext", { mode: 0o600 });
    const old = `snapshot-${Date.now() - 31 * 86400000}-${randomUUID()}`, current = `snapshot-${Date.now()}-${randomUUID()}`;
    await store.put(old, "file-0.enc", input); await store.put(old, "manifest.enc", input); await store.put(current, "manifest.enc", input);
    await retain(store, signal, Date.now(), { progressRoot: path.join(root, "progress") }); expect(await readdir(path.join(root, "store"))).toEqual([current]);
    const out = path.join(root, "output"); await store.get(current, "manifest.enc", out); expect(await readFile(out, "utf8")).toBe("ciphertext");
  });
  it("redacts off-host provider errors and refuses oversized responses", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "backup-provider-")); const out = path.join(root, "out"), id = `snapshot-${Date.now()}-${randomUUID()}`;
    const send = vi.spyOn(S3Client.prototype, "send"); send.mockRejectedValue(new Error("PRIVATE_PROVIDER_TOKEN"));
    await expect(offhost().get(id, "manifest.enc", out, signal)).rejects.toThrow("BACKUP_STORE_READ_FAILED");
    send.mockResolvedValue({ ContentLength: 20 * 1024 ** 2, Body: Readable.from(["x"]) } as never);
    await expect(offhost().get(id, "manifest.enc", out, signal)).rejects.toThrow("BACKUP_STORE_READ_FAILED");
  });
  it("constrains S3 keys/prefixes and rejects unexpected listing paths", async () => {
    vi.spyOn(S3Client.prototype, "send").mockResolvedValue({ Contents: [{ Key: "backups/fixture/../../private" }], IsTruncated: false } as never);
    await expect(collect(offhost())).rejects.toThrow("ARCHIVE_PATH_INVALID");
    expect(() => new S3BackupStore({ NODE_ENV: "test", BACKUP_S3_PREFIX: "../media/" })).toThrow("BACKUP_STORE_CONFIG_INVALID");
  });
});

describe("bounded retention traversal", () => {
  it("prunes beyond 250000 S3 objects across durable restarted pages without materializing inventory", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "retention-pages-"));
    const old = `snapshot-${Date.now() - 31 * 86400000}-${randomUUID()}`, prefix = `backups/fixture/${old}/`;
    const total = 251007, deleted = new Set<number>(); let calls = 0, maxPage = 0;
    // Computed pages simulate a large bucket. Only the test's deletion bitmap
    // grows; the production iterator can hold at most STORE_PAGE_SIZE entries.
    vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command: unknown) => {
      const c = command as { input: { StartAfter?: string; MaxKeys?: number; Key?: string } };
      if (c.input.Key) { deleted.add(Number(c.input.Key.match(/file-(\d+)/)![1])); return {} as never; }
      calls++;
      expect(c.input.MaxKeys).toBe(STORE_PAGE_SIZE);
      const start = c.input.StartAfter ? Number(c.input.StartAfter.match(/file-(\d+)/)![1]) + 1 : 0;
      const end = Math.min(start + STORE_PAGE_SIZE, total); maxPage = Math.max(maxPage, end - start);
      return { Contents: Array.from({ length: end - start }, (_, i) => ({ Key: `${prefix}file-${String(start + i).padStart(6, "0")}.enc` })), IsTruncated: end < total } as never;
    });
    let result;
    do {
      // New instance simulates process restart; the cursor comes from disk.
      result = await retain(offhost(), signal, Date.now(), { progressRoot: root, maxPages: 7, maxMs: 60000 });
      expect(result.pages).toBeLessThanOrEqual(7);
    } while (!result.complete);
    expect(deleted.size).toBe(total); expect(calls).toBe(Math.ceil(total / STORE_PAGE_SIZE)); expect(maxPage).toBe(STORE_PAGE_SIZE);
    expect(await readdir(root)).toEqual([]);
  }, 60000);
  it("streams a mocked local namespace above 250000 entries with bounded pages", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "retention-local-large-"));
    for (let n = 0; n < 26; n++) await mkdir(path.join(root, `snapshot-${Date.now() + n}-${randomUUID()}`), { mode: 0o700 });
    const { opendir } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.spyOn(fs, "opendir").mockImplementation((async (dir: string) => {
      if (dir === root) return opendir(dir);
      return { async *[Symbol.asyncIterator]() { for (let n = 0; n < 10000; n++) yield { name: `file-${String(n).padStart(6, "0")}.enc` }; } };
    }) as typeof fs.opendir);
    let count = 0, pages = 0;
    for await (const page of new LocalBackupStore(root).list(signal)) {
      expect(page.entries.length).toBeLessThanOrEqual(STORE_PAGE_SIZE); count += page.entries.length; pages++;
    }
    expect(count).toBe(260000); expect(pages).toBe(261);
  }, 30000);
  it("checkpoints within a page at the time budget and resumes after interrupted deletion", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "retention-crash-"));
    const id = `snapshot-${Date.now() - 31 * 86400000}-${randomUUID()}`;
    let failure = true, attempts = 0; const removed = new Set<string>(); const starts: (string | undefined)[] = [];
    const store: BackupStore = {
      retentionIdentity: "crash-fixture", put: async () => {}, get: async () => {},
      async *list(_, cursor) {
        starts.push(cursor); const start = cursor ? Number(cursor.match(/file-(\d+)/)![1]) + 1 : 0;
        yield { entries: Array.from({ length: 100 - start }, (_, n) => ({ id, name: `file-${String(n + start).padStart(3, "0")}.enc` })) };
      },
      remove: async (_, name) => { if (++attempts === 77 && failure) throw new Error("interrupted"); removed.add(name); },
    };
    await expect(retain(store, signal, Date.now(), { progressRoot: root })).rejects.toThrow("interrupted");
    failure = false;
    const partial = await retain(store, signal, Date.now(), { progressRoot: root, maxMs: 0 });
    expect(partial.complete).toBe(false); expect(starts[1]).toContain("file-063.enc");
    expect((await retain(store, signal, Date.now(), { progressRoot: root })).complete).toBe(true);
    expect(starts[2]).toContain("file-064.enc"); expect(removed.size).toBe(100);
  });
  it("local filesystem pages resume after deletion and restart, preserving current entries", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "retention-local-")); const storeRoot = path.join(root, "archives");
    const store = new LocalBackupStore(storeRoot), input = path.join(root, "in"), old = `snapshot-${Date.now() - 31 * 86400000}-${randomUUID()}`, current = `snapshot-${Date.now()}-${randomUUID()}`;
    await writeFile(input, "encrypted");
    // A page boundary is meaningful: two pages in one expired archive.
    for (let n = 0; n < STORE_PAGE_SIZE + 3; n++) await store.put(old, `file-${n}.enc`, input);
    await store.put(current, "manifest.enc", input);
    expect((await retain(store, signal, Date.now(), { progressRoot: root, maxPages: 1 })).complete).toBe(false);
    while (!(await retain(new LocalBackupStore(storeRoot), signal, Date.now(), { progressRoot: root, maxPages: 1 })).complete) { /* bounded resumptions */ }
    expect(await collect(store)).toEqual([{ id: current, name: "manifest.enc" }]);
  }, 30000);
});
