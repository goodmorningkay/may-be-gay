import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, realpath, stat, link, unlink, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { getDatabase } from "./db";
import type { Transaction } from "./db/types";
import { jobs } from "./db/schema";
import { appOrigin } from "./http";

export const mailPayloadSchema = z.object({
  template: z.enum(["verification", "recovery", "invite"]),
  to: z.email().max(254), url: z.url().max(4096),
}).strict();
export type MailPayload = z.infer<typeof mailPayloadSchema>;
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
  if (process.env.MAIL_TRANSPORT !== "resend" || process.env.MAIL_ALLOW_LIVE !== "true" || !process.env.RESEND_API_KEY || !process.env.MAIL_FROM) throw new Error("MAIL_NOT_CONFIGURED");
  const response = await fetch("https://api.resend.com/emails", { method: "POST", signal: AbortSignal.timeout(10000), redirect: "error", headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json", "idempotency-key": `mbg-email-${job.id}` }, body: JSON.stringify({ from: process.env.MAIL_FROM, ...message }) });
  await response.body?.cancel();
  if (!response.ok) throw new Error("EMAIL_DELIVERY_FAILED");
}
