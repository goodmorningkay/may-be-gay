import { Queue, workerConnection } from "../src/server/worker/queue";
import { runWorker } from "../src/server/worker/runtime";
import { closeDatabase } from "../src/server/db";
const stop = new AbortController();
process.once("SIGTERM", () => stop.abort());
process.once("SIGINT", () => stop.abort());
const sql = workerConnection();
runWorker(new Queue(sql), stop.signal, process.argv.includes("--once"))
  .catch(() => { console.error('{"code":"WORKER_FAILED"}'); process.exitCode = 1; })
  .finally(async () => { await closeDatabase(); await sql.end({ timeout: 5 }); });
