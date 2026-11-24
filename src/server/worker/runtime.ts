import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { Queue, type Claim } from "./queue";
import { runProcessor } from "./process";
import { archiveSchedule } from "./schedules";
import { readiness } from "./maintenance";
import { serviceState } from "../service-state";
export async function executeClaim(queue: Queue, claim: Claim, signal: AbortSignal, processor = runProcessor, renewalMs = 10000) {
  if (claim.kind === "email" && Date.now() - new Date(claim.created_at).getTime() >= 23 * 3600_000) {
    await queue.finish(claim, "MAIL_RETRY_WINDOW_EXPIRED", true); return;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let renewing = false;
  const timer = setInterval(async () => {
    if (renewing) return; renewing = true;
    try { if (!await queue.renew(claim)) controller.abort(); } catch { controller.abort(); }
    finally { renewing = false; }
  }, renewalMs);
  try {
    const code = await processor(claim, controller.signal);
    if (!controller.signal.aborted) await queue.finish(claim, code, code === "INVALID_JOB_PAYLOAD");
  } finally { clearInterval(timer); signal.removeEventListener("abort", abort); }
}
export async function runWorker(queue: Queue, signal: AbortSignal, once = false) {
  if (await serviceState() !== "open") throw new Error("SERVICE_CLOSED");
  const id = `${os.hostname()}:${randomUUID()}`;
  let ticks = 0, maintaining = false, maintenanceAt = 0;
  const heartbeat = async () => {
    await queue.sql`insert into worker_heartbeats(id,status) values(${id},${queue.sql.json(readiness())}) on conflict(id) do update set updated_at=now(),status=excluded.status`;
  };
  const tick = async () => {
    if (maintaining) return; maintaining = true;
    try {
      await heartbeat();
      if (Date.now() >= maintenanceAt) {
        const code = await runProcessor({} as Claim, signal, 25000, path.resolve("src/server/worker/maintenance-child.ts"));
        if (code) throw new Error("MAINTENANCE_FAILED");
        maintenanceAt = Date.now() + 30000;
      }
    } catch { console.error(JSON.stringify({ code: "WORKER_MAINTENANCE_FAILED" })); }
    finally { maintaining = false; }
  };
  await tick();
  const timer = setInterval(() => { void tick(); }, 10_000);
  let archiving = false;
  const archives = async () => {
    if (archiving || !readiness().backup || signal.aborted) return;
    archiving = true;
    try { await archiveSchedule(queue.sql, "journal", signal); await archiveSchedule(queue.sql, "snapshot", signal); }
    catch { console.error('{"code":"ARCHIVE_SCHEDULE_FAILED"}'); }
    finally { archiving = false; }
  };
  if (!once) void archives();
  const archiveTimer = once ? undefined : setInterval(() => { void archives(); }, 10000);
  let wakeResolve: (() => void) | undefined;
  let notified = false;
  const wake = () => {
    notified = true;
    const resolve = wakeResolve;
    wakeResolve = undefined;
    resolve?.();
  };
  let listener: { unlisten: () => Promise<void> } | undefined;
  if (!once && typeof queue.sql.listen === "function") {
    listener = await queue.sql.listen("may_be_jobs", wake).catch(() => undefined);
  }
  const waitIdle = async () => {
    if (notified || signal.aborted) { notified = false; return; }
    await new Promise<void>(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(idleTimer);
        signal.removeEventListener("abort", finish);
        if (wakeResolve === finish) wakeResolve = undefined;
        resolve();
      };
      wakeResolve = finish;
      const idleTimer = setTimeout(finish, 500);
      signal.addEventListener("abort", finish, { once: true });
    });
    notified = false;
  };
  try {
    do {
      await queue.reclaim();
      const claim = await queue.claim(++ticks % 8 === 0);
      if (claim) await executeClaim(queue, claim, signal);
      else if (!once) await waitIdle();
    } while (!signal.aborted && !once);
  } finally {
    clearInterval(timer); clearInterval(archiveTimer);
    await listener?.unlisten().catch(() => {});
    while (maintaining || archiving) await pause(50);
    await queue.sql`delete from worker_heartbeats where id=${id}`;
  }
}
