import os from "node:os";
import { workerConnection } from "../src/server/worker/queue";
async function main() {
  const sql = workerConnection();
  try {
    const [heartbeat] = await sql`select exists(select 1 from worker_heartbeats
      where split_part(id, ':', 1)=${os.hostname()} and updated_at>now()-interval '45 seconds') as ready`;
    process.exitCode = heartbeat.ready ? 0 : 1;
  } catch { process.exitCode = 1; }
  finally { await sql.end({ timeout: 1 }); }
}
main().catch(() => { process.exitCode = 1; });
