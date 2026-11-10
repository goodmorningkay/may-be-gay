import { createArchive } from "../src/server/recovery/backup";
import { closeDatabase } from "../src/server/db";
import { workerConnection } from "../src/server/worker/queue";
const kind = process.argv.includes("--journal") ? "journal" : "snapshot";
const stop = new AbortController(); process.once("SIGTERM", () => stop.abort()); process.once("SIGINT", () => stop.abort());
async function main() {
  const status = workerConnection();
  try {
    await status`insert into recovery_status(id,state) values(${kind},'running') on conflict(id) do update set state='running',updated_at=now()`;
    const result = await createArchive(kind, { signal: stop.signal });
    await status`update recovery_status set state='succeeded',updated_at=now(),details=${status.json(result)} where id=${kind}`;
    console.log(JSON.stringify(result));
  } catch {
    await status`update recovery_status set state='failed',updated_at=now(),details='{"code":"ARCHIVE_FAILED"}'::jsonb where id=${kind}`.catch(() => {});
    console.error('{"code":"ARCHIVE_FAILED"}'); process.exitCode = 1;
  } finally { await status.end({ timeout: 0 }); await closeDatabase(); }
}
void main().catch(() => { console.error('{"code":"ARCHIVE_FAILED"}'); process.exitCode = 1; });
