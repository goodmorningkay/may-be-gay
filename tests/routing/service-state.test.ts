import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serviceState } from "@/server/service-state";

const readStatus = vi.hoisted(() => vi.fn());
vi.mock("@/server/db", () => ({
  getDatabase: () => ({ select: () => ({ from: () => ({ where: () => ({ limit: readStatus }) }) }) }),
}));

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "may-be-service-gate-"));
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("DATABASE_URL", "postgres://fixture/unused_test");
  vi.stubEnv("SERVICE_CLOSED_FILE", path.join(directory, "SERVICE_CLOSED"));
  readStatus.mockReset().mockResolvedValue([]);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("restore maintenance gate", () => {
  it("admits a configured database only when both gates are clear", async () => {
    expect(await serviceState()).toBe("open");
    await writeFile(path.join(directory, "SERVICE_CLOSED"), "operator review pending", { mode: 0o600 });
    expect(await serviceState()).toBe("closed");
    await rm(path.join(directory, "SERVICE_CLOSED"));
    readStatus.mockResolvedValue([{ id: "restore" }]);
    expect(await serviceState()).toBe("closed");
  });
  it("never treats a successful restore validation as permission to reopen", async () => {
    readStatus.mockResolvedValue([{ id: "restore", state: "validated" }]);
    expect(await serviceState()).toBe("closed");
  });
  it("fails closed on database/schema failure, invalid marker paths and missing production configuration", async () => {
    readStatus.mockRejectedValue(new Error("database unavailable"));
    expect(await serviceState()).toBe("unavailable");
    readStatus.mockResolvedValue([]);
    vi.stubEnv("SERVICE_CLOSED_FILE", "relative/SERVICE_CLOSED");
    expect(await serviceState()).toBe("unavailable");
    vi.stubEnv("SERVICE_CLOSED_FILE", "");
    expect(await serviceState()).toBe("unavailable");
    vi.stubEnv("SERVICE_CLOSED_FILE", path.join(directory, "SERVICE_CLOSED"));
    vi.stubEnv("DATABASE_URL", "");
    expect(await serviceState()).toBe("unavailable");
  });
  it("keeps the static development shell usable without a configured database", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SERVICE_CLOSED_FILE", "");
    vi.stubEnv("DATABASE_URL", "");
    expect(await serviceState()).toBe("open");
  });
});
