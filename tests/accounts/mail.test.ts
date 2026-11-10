import { mkdtemp, readFile, readdir, rm, stat, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { processEmailJob } from "@/server/mail";

describe("private local mail and explicit provider configuration", () => {
  let directory: string | undefined;
  afterEach(async () => { vi.unstubAllEnvs(); if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });
  const job = { id: "local-email-test", payload: { template: "verification", to: "owner@example.invalid", url: "https://app.may-be.localhost/api/auth/verify-email?token=private-token" } };
  it("writes idempotent private files atomically without logging secrets", async () => {
    directory = await mkdtemp(join(tmpdir(), "accounts-mail-"));
    vi.stubEnv("SITE_DOMAIN", "may-be.localhost"); vi.stubEnv("MAIL_TRANSPORT", "local"); vi.stubEnv("MAIL_OUTBOX_DIR", directory);
    const log = vi.spyOn(console, "log");
    await Promise.all([processEmailJob(job), processEmailJob(job)]);
    expect(await readdir(directory)).toEqual(["local-email-test.json"]);
    expect((await stat(join(directory, "local-email-test.json"))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(directory, "local-email-test.json"), "utf8")).text).toContain("private-token");
    expect(log).not.toHaveBeenCalled();
    // A corrupt existing final file cannot silently count as successful delivery.
    await writeFile(join(directory, "local-email-test.json"), "partial");
    await expect(processEmailJob(job)).rejects.toThrow("LOCAL_MAIL_WRITE_FAILED");
  });
  it("rejects a readable outbox and unconfigured live delivery", async () => {
    directory = await mkdtemp(join(tmpdir(), "accounts-mail-")); await chmod(directory, 0o755);
    vi.stubEnv("SITE_DOMAIN", "may-be.localhost"); vi.stubEnv("MAIL_TRANSPORT", "local"); vi.stubEnv("MAIL_OUTBOX_DIR", directory);
    await expect(processEmailJob(job)).rejects.toThrow("PRIVATE_MAIL_OUTBOX_REQUIRED");
    vi.stubEnv("MAIL_TRANSPORT", "resend"); vi.stubEnv("MAIL_ALLOW_LIVE", "false");
    const fetcher = vi.spyOn(globalThis, "fetch");
    await expect(processEmailJob(job)).rejects.toThrow("MAIL_NOT_CONFIGURED");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
