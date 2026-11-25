import { writeSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { Queue, workerConnection } from "../src/server/worker/queue";
import { runWorker, WorkerInterruption } from "../src/server/worker/runtime";
import { closeDatabase } from "../src/server/db";

function exitWorker(code: string, status = 1): never {
  writeSync(2, JSON.stringify({ code }) + "\n");
  process.exit(status);
}

// A separate event loop can stop the container even if this one freezes.
const watchdog = new Worker(new URL("./worker-watchdog.mjs", import.meta.url), { execArgv: [] });
watchdog.once("error", () => exitWorker("WORKER_WATCHDOG_FAILED"));
watchdog.once("exit", () => exitWorker("WORKER_WATCHDOG_STOPPED"));
watchdog.unref();
setInterval(() => watchdog.postMessage("alive"), 1_000).unref();

const stop = new AbortController();
process.once("SIGTERM", () => stop.abort());
process.once("SIGINT", () => stop.abort());
const sql = workerConnection();
runWorker(new Queue(sql), stop.signal, process.argv.includes("--once"))
  .then(async () => { await closeDatabase(); await sql.end({ timeout: 5 }); })
  .catch(error => {
    if (error instanceof WorkerInterruption) exitWorker(error.code, error.code === "WORKER_SHUTDOWN" ? 0 : 1);
    exitWorker("WORKER_FAILED");
  });
