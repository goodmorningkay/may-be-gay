import { mkdtemp, readFile, readdir, rm, stat, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodemailer from "nodemailer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isMailConfigured, processEmailJob } from "@/server/mail";

describe("private local mail and explicit provider configuration", () => {
  let directory: string | undefined;
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });
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
    vi.stubEnv("MAIL_TRANSPORT", "smtp"); vi.stubEnv("MAIL_ALLOW_LIVE", "false");
    const fetcher = vi.spyOn(globalThis, "fetch");
    await expect(processEmailJob(job)).rejects.toThrow("MAIL_NOT_CONFIGURED");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("sends authenticated STARTTLS SMTP mail only when explicitly enabled and redacts provider errors", async () => {
    vi.stubEnv("SITE_DOMAIN", "may-be.localhost");
    vi.stubEnv("MAIL_TRANSPORT", "smtp");
    vi.stubEnv("MAIL_ALLOW_LIVE", "false");
    vi.stubEnv("SMTP_HOST", "smtp.purelymail.com");
    vi.stubEnv("SMTP_PORT", "587");
    vi.stubEnv("SMTP_USER", "noreply@may-be.gay");
    vi.stubEnv("SMTP_PASS", "app-password");
    vi.stubEnv("MAIL_FROM", "noreply@may-be.gay");
    const createTransport = vi.spyOn(nodemailer, "createTransport");
    expect(isMailConfigured()).toBe(false);
    await expect(processEmailJob(job)).rejects.toThrow("MAIL_NOT_CONFIGURED");
    expect(createTransport).not.toHaveBeenCalled();

    vi.stubEnv("MAIL_ALLOW_LIVE", "true");
    vi.stubEnv("SMTP_PORT", "not-a-port");
    expect(isMailConfigured()).toBe(false);
    await expect(processEmailJob(job)).rejects.toThrow("MAIL_NOT_CONFIGURED");

    vi.stubEnv("SMTP_PORT", "587");
    expect(isMailConfigured()).toBe(true);
    const sendMail = vi.fn().mockResolvedValue({ messageId: "ok" });
    const close = vi.fn();
    createTransport.mockReturnValue({ sendMail, close } as unknown as ReturnType<typeof nodemailer.createTransport>);

    await processEmailJob(job);
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: "smtp.purelymail.com",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: "noreply@may-be.gay", pass: "app-password" },
      tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    }));
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: "noreply@may-be.gay",
      to: "owner@example.invalid",
      subject: "Verify your may-be.gay email",
      messageId: "<mbg-email-local-email-test@may-be.localhost>",
    }));
    expect(close).toHaveBeenCalledTimes(1);

    sendMail.mockRejectedValueOnce(new Error("535 5.7.8 Authentication failed for noreply@may-be.gay"));
    await expect(processEmailJob(job)).rejects.toThrow("EMAIL_DELIVERY_FAILED");
    expect(close).toHaveBeenCalledTimes(2);
  });
});
