import { randomUUID } from "node:crypto";
import os from "node:os";
import { setTimeout as pause } from "node:timers/promises";
import { Queue, type Claim, type WorkerSql } from "./queue";
import { dispatch, failureCode } from "./processor";
import { archiveSchedule } from "./schedules";
import { maintain, readiness } from "./maintenance";
import { serviceState } from "../service-state";

export type ClaimProcessor = (claim: Claim, signal: AbortSignal) => Promise<string | undefined>;

export class WorkerInterruption extends Error {
  constructor(readonly code: "PROCESSOR_TIMEOUT" | "JOB_LEASE_LOST" | "WORKER_SHUTDOWN" | "MAINTENANCE_TIMEOUT" | "ARCHIVE_TIMEOUT") {
    super(code);
  }
}

export async function runInProcess(claim: Claim, signal: AbortSignal, sql?: WorkerSql, timeoutMs = 60_000): Promise<string | undefined> {
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => reject(new WorkerInterruption("PROCESSOR_TIMEOUT")), timeoutMs);
      }),
      dispatch(claim, sql).then(() => undefined, failureCode),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export async function executeClaim(
  queue: Queue,
  claim: Claim,
  signal: AbortSignal,
  processor?: ClaimProcessor,
  renewalMs = 10000,
) {
  if (signal.aborted) return;
  if (claim.kind === "email" && Date.now() - new Date(claim.created_at).getTime() >= 23 * 3600_000) {
    if (!await queue.finish(claim, "MAIL_RETRY_WINDOW_EXPIRED", true)) throw new WorkerInterruption("JOB_LEASE_LOST");
    return;
  }
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason instanceof WorkerInterruption
    ? signal.reason
    : new WorkerInterruption("WORKER_SHUTDOWN"));
  signal.addEventListener("abort", abort, { once: true });
  let renewing = false;
  const timer = setInterval(async () => {
    if (renewing) return;
    renewing = true;
    try {
      if (!(await queue.renew(claim))) controller.abort(new WorkerInterruption("JOB_LEASE_LOST"));
    } catch {
      controller.abort(new WorkerInterruption("JOB_LEASE_LOST"));
    } finally {
      renewing = false;
    }
  }, renewalMs);
  try {
    const run = processor ?? ((current: Claim, s: AbortSignal) => runInProcess(current, s, queue.sql));
    const code = await run(claim, controller.signal);
    controller.signal.throwIfAborted();
    if (code === "JOB_CLAIM_LOST" || !await queue.finish(claim, code, code === "INVALID_JOB_PAYLOAD")) {
      throw new WorkerInterruption("JOB_LEASE_LOST");
    }
  } finally {
    clearInterval(timer);
    signal.removeEventListener("abort", abort);
  }
}

async function withWorkerDeadline(work: Promise<void>, timeoutMs: number, code: "MAINTENANCE_TIMEOUT" | "ARCHIVE_TIMEOUT") {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new WorkerInterruption(code)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runWorker(queue: Queue, signal: AbortSignal, once = false) {
  if ((await serviceState()) !== "open") throw new Error("SERVICE_CLOSED");
  const id = `${os.hostname()}:${randomUUID()}`;
  let ticks = 0,
    maintaining = false,
    maintenanceAt = 0;
  const maintenanceStop = new AbortController();
  const stop = AbortSignal.any([signal, maintenanceStop.signal]);
  const maintenanceFailure = new Promise<never>((_, reject) => {
    maintenanceStop.signal.addEventListener("abort", () => reject(maintenanceStop.signal.reason), { once: true });
  });
  const heartbeat = async () => {
    await queue.sql`insert into worker_heartbeats(id,status) values(${id},${queue.sql.json(readiness())}) on conflict(id) do update set updated_at=now(),status=excluded.status`;
  };
  const tick = async () => {
    if (maintaining) return;
    maintaining = true;
    try {
      await heartbeat();
      if (Date.now() >= maintenanceAt) {
        await withWorkerDeadline(maintain(queue.sql), 25_000, "MAINTENANCE_TIMEOUT");
        maintenanceAt = Date.now() + 30000;
      }
    } catch (error) {
      if (error instanceof WorkerInterruption) maintenanceStop.abort(error);
      else console.error(JSON.stringify({ code: "WORKER_MAINTENANCE_FAILED" }));
    } finally {
      maintaining = false;
    }
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  let archivesAt = 0;
  const archives = async () => {
    if (once || stop.aborted || Date.now() < archivesAt || !readiness().backup) return;
    try {
      // The archive tries to abort after 180s. A stuck filesystem operation
      // can outlive that signal, so fail the worker if the archive never settles.
      await withWorkerDeadline(archiveSchedule(queue.sql, "journal", stop), 200_000, "ARCHIVE_TIMEOUT");
      if (!stop.aborted) {
        await withWorkerDeadline(archiveSchedule(queue.sql, "snapshot", stop), 200_000, "ARCHIVE_TIMEOUT");
      }
    } catch (error) {
      if (error instanceof WorkerInterruption) throw error;
      console.error('{"code":"ARCHIVE_SCHEDULE_FAILED"}');
    } finally {
      archivesAt = Date.now() + 10_000;
    }
  };
  let wakeResolve: (() => void) | undefined;
  let notified = false;
  const wake = () => {
    notified = true;
    const resolve = wakeResolve;
    wakeResolve = undefined;
    resolve?.();
  };
  let listener: { unlisten: () => Promise<void> } | undefined;
  const waitIdle = async () => {
    if (notified || stop.aborted) {
      notified = false;
      return;
    }
    await new Promise<void>(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(idleTimer);
        stop.removeEventListener("abort", finish);
        if (wakeResolve === finish) wakeResolve = undefined;
        resolve();
      };
      wakeResolve = finish;
      const idleTimer = setTimeout(finish, 500);
      stop.addEventListener("abort", finish, { once: true });
    });
    notified = false;
  };
  const work = async () => {
    await tick();
    if (stop.aborted) return;
    timer = setInterval(() => void tick(), 10_000);
    if (!once && typeof queue.sql.listen === "function") {
      listener = await queue.sql.listen("may_be_jobs", wake).catch(() => undefined);
    }
    while (!stop.aborted) {
      await archives();
      if (stop.aborted) break;
      await queue.reclaim();
      if (stop.aborted) break;
      const claim = await queue.claim(++ticks % 8 === 0);
      if (claim) await executeClaim(queue, claim, stop);
      else if (!once) await waitIdle();
      if (once) break;
    }
  };
  try {
    await Promise.race([maintenanceFailure, work()]);
  } finally {
    clearInterval(timer);
  }
  // An interrupted job can still be executing. The CLI exits immediately on
  // failure and leaves its lease for recovery after the container stops.
  await listener?.unlisten().catch(() => {});
  while (maintaining) await pause(50);
  await queue.sql`delete from worker_heartbeats where id=${id}`;
}
