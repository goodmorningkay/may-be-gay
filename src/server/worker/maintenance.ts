import { lstat, unlink } from "node:fs/promises";
import path from "node:path";
import { privateDirectory } from "../recovery/files";
import { randomUUID } from "node:crypto";
import { enqueueMediaSweep } from "../media/jobs";
import { sweepMediaScratch } from "../media/validation";
import { isMailConfigured } from "../mail";
import { operationsMaintenance } from "../operations/maintenance";
import type { WorkerSql } from "./queue";
export function readiness() {
  return { mail: isMailConfigured(),
    storage: process.env.MEDIA_STORAGE === "local" ? !!process.env.MEDIA_LOCAL_ROOT : process.env.MEDIA_STORAGE === "s3" && ["MEDIA_S3_ENDPOINT", "MEDIA_S3_REGION", "MEDIA_PRIVATE_BUCKET", "MEDIA_PUBLIC_BUCKET", "MEDIA_S3_ACCESS_KEY_ID", "MEDIA_S3_SECRET_ACCESS_KEY", "MEDIA_PUBLIC_ORIGIN"].every(k => !!process.env[k]),
    purge: process.env.MEDIA_STORAGE === "local" ? !!process.env.MEDIA_LOCAL_ROOT : process.env.MEDIA_STORAGE === "s3" && ["MEDIA_CLOUDFLARE_ZONE_ID", "MEDIA_CLOUDFLARE_PURGE_TOKEN", "MEDIA_PUBLIC_ORIGIN"].every(k => !!process.env[k]),
    backup: !!process.env.BACKUP_KEY_FILE && !!process.env.BACKUP_KEY_ID && !!process.env.BACKUP_LOCAL_ROOT
      && (process.env.NODE_ENV !== "production" || !!process.env.BACKUP_WORK_ROOT) };
}
export async function maintain(sql: WorkerSql) {
  await enqueueMediaSweep(randomUUID());
  await sweepMediaScratch();
  await operationsMaintenance(500);
  await retainLocalMail();
  for (const table of ["verification", "session", "auth_rate_limits"] as const) {
    await sql`delete from ${sql(table)} where ctid in (select ctid from ${sql(table)} where expires_at<now() limit 500)`;
  }
  await sql`update jobs set payload='{}'::jsonb,state='failed',finished_at=now(),locked_at=null,locked_by=null,last_error_code='MAIL_RETRY_WINDOW_EXPIRED',updated_at=now()
    where id in (select id from jobs where kind='email' and state='pending' and created_at<now()-interval '23 hours' limit 500 for update skip locked)`;
  await sql`update jobs set payload='{}'::jsonb where id in (select id from jobs where kind='email' and state in ('succeeded','failed') and payload<>'{}'::jsonb limit 500)`;
  await sql`delete from jobs where id in (select id from jobs where state='succeeded' and finished_at<now()-interval '7 days' limit 500)`;
  await sql`delete from worker_heartbeats where updated_at<now()-interval '7 days'`;
}

export async function retainLocalMail() {
  if (process.env.MAIL_TRANSPORT !== "local" || !process.env.MAIL_OUTBOX_DIR) return;
  const root = await privateDirectory(process.env.MAIL_OUTBOX_DIR);
  // Inspect at most 1000 entries per minute; generated mail UUID names only.
  let seen = 0;
  const { opendir } = await import("node:fs/promises");
  const dir = await opendir(root);
  for await (const entry of dir) {
    if (++seen > 1000) break;
    if (!/^(\.[a-f0-9-]{36}\.[a-f0-9-]{36}\.tmp|[a-f0-9-]{36}\.json)$/.test(entry.name)) continue;
    const file = path.join(root, entry.name), info = await lstat(file);
    if (info.isFile() && !info.isSymbolicLink() && info.mtimeMs < Date.now() - 23 * 3600000) await unlink(file);
  }
}
