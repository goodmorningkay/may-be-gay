import { restoreArchive } from "../src/server/recovery/restore";
import { LocalBackupStore } from "../src/server/recovery/store";
function arg(name: string) { const i = process.argv.indexOf(name); return i < 0 ? "" : process.argv[i + 1] || ""; }
const stop = new AbortController(); process.once("SIGTERM", () => stop.abort()); process.once("SIGINT", () => stop.abort());
restoreArchive({ targetUrl: process.env.RESTORE_DATABASE_URL || "", targetName: arg("--target-name"), maintenance: process.argv.includes("--ack-maintenance"), snapshot: arg("--snapshot"), journal: arg("--journal"), expectedSequence: /^\d+$/.test(arg("--expected-recovery-sequence")) ? Number(arg("--expected-recovery-sequence")) : -1,
  recoveryThrough: arg("--recovery-through"), reportDirectory: process.env.RESTORE_REPORT_DIRECTORY || "", store: new LocalBackupStore(process.env.BACKUP_LOCAL_ROOT || ""), signal: stop.signal })
  .then(r => console.log(JSON.stringify(r)))
  .catch(() => { console.error('{"code":"RESTORE_FAILED_SERVICE_CLOSED"}'); process.exitCode = 1; });
