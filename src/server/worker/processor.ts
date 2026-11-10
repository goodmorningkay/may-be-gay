import { processEmailJob } from "../mail";
import { processMediaJob, processMediaDeletionJob, processCachePurgeJob } from "../media/jobs";
import { processAccountDeletionJob } from "../operations/deletion";
import { closeDatabase } from "../db";
import { failureCode } from "./errors";
import { workerConnection, type Claim } from "./queue";
export async function dispatch(c: Claim) {
  if (c.payload_version !== 1) throw Object.assign(new Error(), { name: "ZodError" });
  switch (c.kind) {
    case "email": {
      const sql = workerConnection();
      try {
        const [live] = await sql`select id from jobs where id=${c.id} and state='running' and locked_by=${c.locked_by} and attempts=${c.attempts}`;
        if (!live) throw new Error("JOB_CLAIM_LOST");
        return await processEmailJob({ id: c.id, payload: c.payload });
      } finally { await sql.end({ timeout: 0 }); }
    }
    case "media": return processMediaJob(c.payload);
    case "media_deletion": return processMediaDeletionJob(c.payload);
    case "cache_purge": return processCachePurgeJob(c.payload);
    case "account_deletion": return processAccountDeletionJob(c.payload);
    default: throw Object.assign(new Error(), { name: "ZodError" });
  }
}
// Invoked only through the bounded subprocess runner, never through HTTP.
if (process.env.WORKER_PROCESSOR_CHILD === "1") {
  const watchdog = setTimeout(() => process.exit(70), 65_000);
  process.on("disconnect", () => process.exit(71));
  let size = 0, input = "";
  process.stdin.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 65536) process.exit(72); input += chunk; });
  process.stdin.on("end", async () => {
    try { await dispatch(JSON.parse(input)); process.send?.({ code: "OK" }); }
    catch (e) { process.send?.({ code: failureCode(e) }); }
    finally { clearTimeout(watchdog); await closeDatabase(); process.exit(0); }
  });
}
