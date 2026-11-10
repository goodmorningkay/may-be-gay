import { readFile, statfs } from "node:fs/promises";
import tls from "node:tls";
import os from "node:os";
import { z } from "zod";
import { workerConnection } from "./queue";
import { readiness } from "./maintenance";
import { operationalLog, type OperatorEvent } from "./log";
import { regularFile } from "../recovery/files";
export async function certificateDays(host: string) {
  // Fixed platform targets, never a submitted URL or arbitrary host/port.
  if (!["may-be.gay", "app.may-be.gay", "media.may-be.gay"].includes(host)) throw new Error("CERTIFICATE_TARGET_INVALID");
  return new Promise<number>((resolve, reject) => {
    const socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: true });
    const timer = setTimeout(() => socket.destroy(new Error("CERTIFICATE_TIMEOUT")), 5000);
    socket.once("secureConnect", () => { const days = (Date.parse(socket.getPeerCertificate().valid_to) - Date.now()) / 86400000; clearTimeout(timer); socket.end(); resolve(days); });
    socket.once("error", () => { clearTimeout(timer); socket.destroy(); reject(new Error("CERTIFICATE_CHECK_FAILED")); });
  });
}
export async function operationChecks(): Promise<OperatorEvent[]> {
  const result: OperatorEvent[] = [], add = (code: string, severity: OperatorEvent["severity"], value?: number) => result.push({ code, severity, ...(value === undefined ? {} : { value }) });
  const sql = workerConnection();
  try {
    await sql`select 1`; add("DATABASE", "ok");
    const [h] = await sql`select extract(epoch from now()-max(updated_at))::float as age from worker_heartbeats`;
    add("WORKER_HEARTBEAT", h.age === null || h.age > 45 ? "critical" : "ok", h.age ?? -1);
    // An upload expiry is a future scheduled check, not a removal request.
    // Its backlog starts when due. Cleanup retry backoff must not reset the
    // original removal/request age used by the other job kinds and actions.
    const queues = await sql`select kind,count(*) filter(where state='failed')::int as failed,
      coalesce(max(extract(epoch from now() - case when kind='media' and payload->>'action'='expire' then available_at else created_at end))
      filter(where state in ('pending','running','failed') and
      (kind<>'media' or payload->>'action' is distinct from 'expire' or available_at<=now())),0)::float as age
      from jobs group by kind`;
    for (const q of queues) {
      const name = ({ email: "EMAIL", media: "MEDIA", media_deletion: "MEDIA_DELETION", cache_purge: "CACHE_PURGE", account_deletion: "ACCOUNT_DELETION" } as Record<string, string>)[q.kind];
      if (!name) continue;
      add(`${name}_FAILURES`, q.failed ? "critical" : "ok", q.failed);
      const limit = ["MEDIA_DELETION", "CACHE_PURGE", "MEDIA"].includes(name) ? 300 : name === "ACCOUNT_DELETION" ? 86400 : 300;
      add(`${name}_AGE_SECONDS`, q.age > limit ? "critical" : "ok", q.age);
    }
    const [purge] = await sql`select coalesce(max(extract(epoch from now()-updated_at)),0)::float as age from media_storage where revoking_key is not null or state='deleting'`;
    add("PUBLIC_PURGE_AGE_SECONDS", purge.age > 300 ? "critical" : "ok", purge.age);
    for (const kind of ["snapshot", "journal"]) {
      const rows = await sql`select state,updated_at,details from recovery_status where id=${kind}`;
      // Recovery freshness is measured from the captured database snapshot.
      // An upload/retention delay must not make old journal contents look fresh.
      const captured = rows[0]?.details?.capturedAt || (kind === "snapshot" ? rows[0]?.details?.completedAt || (rows[0]?.state === "succeeded" ? rows[0].updated_at : undefined) : undefined);
      const elapsed = captured ? (Date.now() - new Date(captured).getTime()) / 1000 : -1;
      const age = Number.isFinite(elapsed) ? elapsed : -1;
      add(kind === "snapshot" ? "BACKUP_AGE_SECONDS" : "JOURNAL_AGE_SECONDS", age < 0 || age > (kind === "snapshot" ? 90000 : 120) || rows[0]?.state === "failed" ? "critical" : "ok", age);
    }
    const [capacity] = await sql`select coalesce((select sum(charged_bytes) from media_storage),0)::float as used,coalesce((select total_media_limit_bytes from service_settings where id=true),5368709120)::float as capacity`;
    add("STORAGE_QUOTA_PERCENT", capacity.used / capacity.capacity >= .9 ? "critical" : capacity.used / capacity.capacity >= .8 ? "warning" : "ok", capacity.used * 100 / capacity.capacity);
    const [mail] = await sql`select count(*)::int as n from jobs where kind='email' and state='succeeded' and finished_at>now()-interval '24 hours'`;
    const quota = Number(process.env.MAIL_DAILY_QUOTA);
    add("MAIL_QUOTA_PERCENT", !quota || quota < 1 ? "warning" : mail.n / quota >= .9 ? "critical" : mail.n / quota >= .8 ? "warning" : "ok", quota > 0 ? mail.n * 100 / quota : -1);
  } catch { add("DATABASE_OR_SCHEMA", "critical"); }
  finally { await sql.end({ timeout: 0 }); }
  for (const [provider, ready] of Object.entries(readiness())) add(`CONFIG_${provider.toUpperCase()}`, ready ? "ok" : "warning");
  try {
    const fs = await statfs(process.env.OPERATIONS_DISK_PATH || "/tmp");
    const percent = 100 * (1 - fs.bavail / fs.blocks);
    add("DISK_USED_PERCENT", percent > 90 ? "critical" : percent > 80 ? "warning" : "ok", percent);
  } catch { add("DISK_CHECK", "warning"); }
  let memory = 100 * (1 - os.freemem() / os.totalmem());
  try {
    const [current, max] = await Promise.all([readFile("/sys/fs/cgroup/memory.current", "utf8"), readFile("/sys/fs/cgroup/memory.max", "utf8")]);
    if (max.trim() !== "max") memory = Number(current) * 100 / Number(max);
  } catch { /* Host memory is the fallback outside cgroups. */ }
  add("MEMORY_USED_PERCENT", memory > 90 ? "critical" : memory > 80 ? "warning" : "ok", memory);
  if (process.env.OPERATIONS_CERTIFICATES === "true") {
    for (const host of ["may-be.gay", "app.may-be.gay", "media.may-be.gay"]) {
      try { const days = await certificateDays(host); add(`CERTIFICATE_${host.split(".")[0].toUpperCase().replaceAll("-", "_")}_DAYS`, days < 7 ? "critical" : days < 21 ? "warning" : "ok", days); }
      catch { add("CERTIFICATE_CHECK", "critical"); }
    }
  } else add("CERTIFICATE_CHECK_UNCONFIGURED", "warning");
  // Optional redacted collector includes provider-side usage and application
  // error totals unavailable from our DB. Private, bounded, fresh fixed file.
  if (process.env.OPERATIONS_USAGE_FILE) {
    try {
      const file = process.env.OPERATIONS_USAGE_FILE, info = await regularFile(file, 4096);
      if (info.mode & 0o077) throw new Error();
      const sample = z.object({ at: z.iso.datetime(), storagePercent: z.number().min(0).max(100), emailPercent: z.number().min(0).max(100), appErrors: z.number().int().min(0).max(1000000) }).strict().parse(JSON.parse(await readFile(file, "utf8")));
      if (Date.now() - Date.parse(sample.at) > 300000 || Date.parse(sample.at) > Date.now() + 30000) throw new Error();
      for (const [code, value] of [["PROVIDER_STORAGE_PERCENT", sample.storagePercent], ["PROVIDER_MAIL_PERCENT", sample.emailPercent], ["APPLICATION_ERRORS", sample.appErrors]] as const) add(code, value >= (code === "APPLICATION_ERRORS" ? 10 : 90) ? "critical" : value >= (code === "APPLICATION_ERRORS" ? 1 : 80) ? "warning" : "ok", value);
    } catch { add("PROVIDER_USAGE_UNAVAILABLE", "warning"); }
  } else add("PROVIDER_USAGE_UNCONFIGURED", "warning");
  await operationalLog(result); return result;
}
export async function deliverAlerts(events: OperatorEvent[]) {
  if (process.env.OPERATIONS_ALERT_TRANSPORT !== "slack") return;
  if (process.env.OPERATIONS_ALLOW_LIVE_ALERTS !== "true") throw new Error("LIVE_ALERTS_DISABLED");
  const url = process.env.OPERATIONS_SLACK_WEBHOOK || "";
  if (!/^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+$/.test(url)) throw new Error("ALERT_TARGET_INVALID");
  const failures = events.filter(e => e.severity !== "ok"); if (!failures.length) return;
  try {
    const r = await fetch(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000), headers: { "content-type": "application/json" }, body: JSON.stringify({ text: failures.map(e => `${e.severity}: ${e.code}${e.value === undefined ? "" : ` (${Math.round(e.value)})`}`).join("\n") }) });
    await r.body?.cancel(); if (!r.ok) throw new Error();
  } catch { throw new Error("ALERT_DELIVERY_FAILED"); }
}
