import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { commitArchive, recoveryWorkspace } from "../../src/server/recovery/backup";
import { type BackupStore } from "../../src/server/recovery/store";
import { manifest } from "./manifest-fixture";

let root: string;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

const signal = new AbortController().signal,
  key = { id: "test", bytes: randomBytes(32) };

function recording(): BackupStore & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    put: async (_, name) => {
      writes.push(name);
    },
    get: async () => {},
    async *list() {
      yield { entries: [] };
    },
    remove: async () => {},
  };
}

async function setup() {
  root = await mkdtemp(path.join(os.tmpdir(), "archive-commit-"));
  vi.stubEnv("BACKUP_WORK_ROOT", path.join(root, "progress"));
}

it("requires an explicit persistent work root in production before creating recovery scratch", async () => {
  await setup();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("BACKUP_WORK_ROOT", "");
  await expect(recoveryWorkspace()).rejects.toThrow("BACKUP_WORK_ROOT_REQUIRED");
  vi.stubEnv("BACKUP_WORK_ROOT", path.join(root, "persistent"));
  expect(await recoveryWorkspace()).toMatch(new RegExp(`^${root}/persistent/run-`));
});

it("commits every destination before cleanup; retention failure remains a failed backup", async () => {
  await setup();
  const m = manifest(),
    work = path.join(root, "file-0.enc");
  await writeFile(work, "sealed");
  const local = recording(),
    secondary = recording();
  local.list = async function* () {
    throw new Error("retention failed");
  };
  await expect(commitArchive(m, root, [local, secondary], key, signal)).rejects.toThrow("ARCHIVE_DESTINATION_OR_RETENTION_FAILED");
  expect(local.writes).toEqual(["file-0.enc", "manifest.enc"]);
  expect(secondary.writes).toEqual(local.writes);
});

it("a failed destination write still attempts other stores and never commits its manifest", async () => {
  await setup();
  const bad = recording(),
    good = recording();
  bad.put = async (_, name) => {
    bad.writes.push(name);
    throw new Error("no space");
  };
  await expect(commitArchive(manifest(), root, [bad, good], key, signal)).rejects.toThrow("ARCHIVE_DESTINATION_OR_RETENTION_FAILED");
  expect(bad.writes).toEqual(["file-0.enc"]);
  expect(good.writes).toEqual(["file-0.enc", "manifest.enc"]);
});
