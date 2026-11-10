import { maintain } from "./maintenance";
import { workerConnection } from "./queue";
import { closeDatabase } from "../db";
const watchdog = setTimeout(() => process.exit(70), 30000);
process.on("disconnect", () => process.exit(71));
process.stdin.resume();
process.stdin.once("end", async () => {
  const sql = workerConnection();
  let code = "OK";
  try { await maintain(sql); }
  catch { code = "MAINTENANCE_FAILED"; }
  finally {
    process.send?.({ code }); clearTimeout(watchdog);
    await closeDatabase(); await sql.end({ timeout: 0 }); process.exit(0);
  }
});
