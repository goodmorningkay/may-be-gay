import { createArchive } from "../recovery/backup";
import { workerConnection, type WorkerSql } from "./queue";

export async function runRecordedArchive(kind: "snapshot" | "journal", signal?: AbortSignal, sql?: WorkerSql) {
  const ownSql = !sql;
  const status = sql ?? workerConnection();
  try {
    await status`insert into recovery_status(id,state) values(${kind},'running') on conflict(id) do update set state='running',updated_at=now()`;
    const result = await createArchive(kind, { signal });
    await status`update recovery_status set state='succeeded',updated_at=now(),details=${status.json(result)} where id=${kind}`;
    return result;
  } catch (error) {
    await status`update recovery_status set state='failed',updated_at=now(),details='{"code":"ARCHIVE_FAILED"}'::jsonb where id=${kind}`.catch(() => {});
    throw error;
  } finally {
    if (ownSql) await status.end({ timeout: 0 });
  }
}

export async function archiveSchedule(sql: WorkerSql, kind: "snapshot" | "journal", signal: AbortSignal) {
  await sql`insert into worker_schedules(name) values(${kind}) on conflict do nothing`;
  const due = await sql`update worker_schedules set next_at=now()+interval '5 minutes' where name=${kind} and next_at<=now() returning name`;
  if (!due.length) return;
  let ok = false;
  try {
    await runRecordedArchive(kind, signal, sql);
    ok = !signal.aborted;
  } catch {
    ok = false;
  }
  await sql`update worker_schedules set next_at=now()+${ok ? (kind === "journal" ? 60 : 86400) : 60}*interval '1 second',last_success_at=case when ${ok} then now() else last_success_at end,last_error_code=${ok ? null : "ARCHIVE_FAILED"} where name=${kind}`;
}
