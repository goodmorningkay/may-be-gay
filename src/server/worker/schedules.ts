import path from "node:path";
import { cancelSupervised, spawnSupervised } from "../subprocess/supervised";
import type { WorkerSql } from "./queue";
export async function archiveSchedule(sql: WorkerSql, kind: "snapshot" | "journal", signal: AbortSignal) {
  await sql`insert into worker_schedules(name) values(${kind}) on conflict do nothing`;
  const due = await sql`update worker_schedules set next_at=now()+interval '5 minutes' where name=${kind} and next_at<=now() returning name`;
  if (!due.length) return;
  const ok = await new Promise<boolean>(resolve => {
    let c: ReturnType<typeof spawnSupervised>;
    try {
      c = spawnSupervised(process.execPath, ["--conditions=react-server", "--import", "tsx", path.resolve("scripts/backup.ts"), ...(kind === "journal" ? ["--journal"] : [])], 200000, { stdio: "ignore", env: process.env });
    } catch { resolve(false); return; }
    const kill = () => cancelSupervised(c);
    signal.addEventListener("abort", kill, { once: true }); if (signal.aborted) kill();
    let unavailable = false;
    c.on("error", () => { unavailable = true; });
    c.on("close", code => { signal.removeEventListener("abort", kill); resolve(code === 0 && !unavailable && !signal.aborted); });
  });
  await sql`update worker_schedules set next_at=now()+${ok ? kind === "journal" ? 60 : 86400 : 60}*interval '1 second',last_success_at=case when ${ok} then now() else last_success_at end,last_error_code=${ok ? null : "ARCHIVE_FAILED"} where name=${kind}`;
}
