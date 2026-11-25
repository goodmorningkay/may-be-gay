import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, realpath, stat, link, unlink, readFile } from "node:fs/promises";
import path from "node:path";
import nodemailer from "nodemailer";
import { z } from "zod";
import { getSiteDomain } from "../domain/hosts";
import { getDatabase } from "./db";
import type { Transaction } from "./db/types";
import { jobs } from "./db/schema";
import { appOrigin } from "./http";

const mailPayloadSchema = z.object({
  template: z.enum(["verification", "recovery", "invite"]),
  to: z.email().max(254), url: z.url().max(4096),
}).strict();
type MailPayload = z.infer<typeof mailPayloadSchema>;

function smtpConfiguration(env: NodeJS.ProcessEnv = process.env) {
  if (env.MAIL_TRANSPORT !== "smtp" || env.MAIL_ALLOW_LIVE !== "true") return null;
  const host = env.SMTP_HOST?.trim(), user = env.SMTP_USER?.trim(), pass = env.SMTP_PASS, from = env.MAIL_FROM?.trim();
  const rawPort = env.SMTP_PORT?.trim() || "587";
  const port = /^\d+$/.test(rawPort) ? Number(rawPort) : NaN;
  if (!host || /\s/.test(host) || !user || !pass || !from || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port, user, pass, from };
}

export function isMailConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.MAIL_TRANSPORT === "local") return !!env.MAIL_OUTBOX_DIR;
  if (env.MAIL_TRANSPORT === "smtp") return smtpConfiguration(env) !== null;
  return false;
}
export async function enqueueMail(payload: MailPayload, ownerId?: string, tx?: Transaction) {
  const valid = mailPayloadSchema.parse(payload);
  if (new URL(valid.url).origin !== appOrigin()) throw new Error("Invalid mail destination");
  const key = `email:${createHash("sha256").update(JSON.stringify(valid)).digest("hex")}`;
  await (tx ?? getDatabase()).insert(jobs).values({ kind: "email", idempotencyKey: key, ownerId, payload: valid }).onConflictDoNothing({ target: jobs.idempotencyKey });
}
/** Worker owns claiming/retries. Stable job id is also the provider idempotency key. */
export async function processEmailJob(job: { id: string; payload: unknown }): Promise<void> {
  const p = mailPayloadSchema.parse(job.payload);
  if (new URL(p.url).origin !== appOrigin() || !/^[a-zA-Z0-9-]{1,80}$/.test(job.id)) throw new Error("INVALID_EMAIL_JOB");
  const subject = { verification: "Verify your may-be.gay email", recovery: "Reset your may-be.gay password", invite: "Your may-be.gay invitation" }[p.template];
  const message = { to: p.to, subject, text: `${subject}\n\n${p.url}\n\nIf you did not request this, ignore this message.` };
  if (process.env.MAIL_TRANSPORT === "local") {
    const directory = process.env.MAIL_OUTBOX_DIR;
    if (!directory || !path.isAbsolute(directory) || directory.startsWith(path.join(process.cwd(), "public"))) throw new Error("PRIVATE_MAIL_OUTBOX_REQUIRED");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const resolved = await realpath(directory);
    const info = await stat(resolved);
    if ((info.mode & 0o077) !== 0 || resolved.startsWith(path.join(process.cwd(), "public"))) throw new Error("PRIVATE_MAIL_OUTBOX_REQUIRED");
    const target = path.join(resolved, `${job.id}.json`);
    const temporary = path.join(resolved, `.${job.id}.${randomUUID()}.tmp`);
    const serialized = JSON.stringify(message);
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(serialized); await file.sync(); } finally { await file.close(); }
      try { await link(temporary, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || (await stat(target)).size > 20000 || await readFile(target, "utf8") !== serialized) throw error;
      }
      const dir = await open(resolved, "r");
      try { await dir.sync(); } finally { await dir.close(); }
    } catch { throw new Error("LOCAL_MAIL_WRITE_FAILED"); }
    finally { await unlink(temporary).catch(() => {}); }
    return;
  }
  if (process.env.MAIL_TRANSPORT === "smtp") {
    const config = smtpConfiguration();
    if (!config) throw new Error("MAIL_NOT_CONFIGURED");
    const transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      requireTLS: config.port !== 465,
      auth: { user: config.user, pass: config.pass },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
      tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    });
    try {
      await transport.sendMail({
        from: config.from,
        ...message,
        messageId: `<mbg-email-${job.id}@${getSiteDomain()}>`,
      });
    } catch {
      throw new Error("EMAIL_DELIVERY_FAILED");
    } finally {
      transport.close();
    }
    return;
  }
  throw new Error("MAIL_NOT_CONFIGURED");
}
