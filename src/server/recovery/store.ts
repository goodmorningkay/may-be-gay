import { opendir, unlink, lstat, rmdir } from "node:fs/promises";
import path from "node:path";
import { copyBounded, durable, fail, privateDirectory } from "./files";

export const MAX_FILE = 16 * 1024 ** 3;
export const archiveId = /^(snapshot|journal)-\d{13}-[a-f0-9-]{36}$/;
const namePattern = /^(manifest\.enc|file-\d{1,6}\.enc)$/;

function fileLimit(name: string) {
  return name === "manifest.enc" ? 8 * 1024 ** 2 + 4096 : MAX_FILE + 4096;
}

function validate(id: string, name: string) {
  if (!archiveId.test(id) || !namePattern.test(name)) fail("ARCHIVE_PATH_INVALID");
}

export type StoreEntry = { id: string; name: string };
export type StorePage = { entries: StoreEntry[] };

export interface BackupStore {
  put(id: string, name: string, source: string, signal: AbortSignal): Promise<void>;
  get(id: string, name: string, target: string, signal: AbortSignal): Promise<void>;
  list(signal: AbortSignal, before?: number): AsyncIterable<StorePage>;
  remove(id: string, name: string, signal: AbortSignal): Promise<void>;
}

export class LocalBackupStore implements BackupStore {
  constructor(readonly root: string) {}

  private async file(id: string, name: string) {
    validate(id, name);
    await privateDirectory(this.root);
    await privateDirectory(path.join(this.root, id));
    return path.join(this.root, id, name);
  }

  async put(id: string, name: string, source: string) {
    await copyBounded(source, await this.file(id, name), MAX_FILE + 4096);
  }

  async get(id: string, name: string, target: string) {
    await copyBounded(await this.file(id, name), target, fileLimit(name));
  }

  async *list(signal: AbortSignal, before = Infinity): AsyncIterable<StorePage> {
    await privateDirectory(this.root);
    let yielded = false;
    for await (const entry of await opendir(this.root)) {
      signal.throwIfAborted();
      const id = entry.name;
      if (!archiveId.test(id) || Number(id.split("-")[1]) >= before) continue;
      await privateDirectory(path.join(this.root, id));
      const entries: StoreEntry[] = [];
      for await (const f of await opendir(path.join(this.root, id))) {
        signal.throwIfAborted();
        if (!namePattern.test(f.name)) fail("ARCHIVE_PATH_INVALID");
        entries.push({ id, name: f.name });
      }
      if (!entries.length) {
        await rmdir(path.join(this.root, id)).catch(e => {
          if (!["ENOTEMPTY", "ENOENT"].includes(e.code)) throw e;
        });
      }
      yielded = true;
      yield { entries };
    }
    if (!yielded) yield { entries: [] };
  }

  async remove(id: string, name: string) {
    const f = await this.file(id, name);
    await lstat(f)
      .then(() => unlink(f))
      .catch(e => {
        if (e.code !== "ENOENT") throw e;
      });
    await durable(path.dirname(f));
    await rmdir(path.dirname(f)).catch(e => {
      if (!["ENOTEMPTY", "ENOENT"].includes(e.code)) throw e;
    });
  }
}

export async function retain(store: BackupStore, signal: AbortSignal, now = Date.now(), cutoff = now - 30 * 86400000) {
  let removed = 0, pages = 0;
  const deadline = performance.now() + 10_000;
  for await (const { entries } of store.list(signal, cutoff)) {
    if (++pages > 16 || performance.now() >= deadline) return { complete: false, removed };
    for (const f of entries) {
      signal.throwIfAborted();
      if (performance.now() >= deadline) return { complete: false, removed };
      validate(f.id, f.name);
      if (Number(f.id.split("-")[1]) < cutoff) {
        await store.remove(f.id, f.name, signal);
        removed++;
      }
    }
  }
  return { complete: true, removed };
}

export function configuredStores(): BackupStore[] {
  if (!process.env.BACKUP_LOCAL_ROOT) fail("BACKUP_LOCAL_ROOT_REQUIRED");
  return [new LocalBackupStore(process.env.BACKUP_LOCAL_ROOT)];
}
