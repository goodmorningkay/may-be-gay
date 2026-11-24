import { operationChecks, deliverAlerts } from "../src/server/worker/checks";
import { setTimeout as pause } from "node:timers/promises";
const watch = process.argv.includes("--watch"), stop = new AbortController();
process.once("SIGTERM", () => stop.abort());
process.once("SIGINT", () => stop.abort());
async function main() {
  do {
    try {
      const result = await operationChecks();
      console.log(JSON.stringify({ version: 1, checks: result }));
      await deliverAlerts(result);
      if (!watch && result.some(c => c.severity === "critical")) process.exitCode = 1;
    } catch { console.error('{"code":"OPERATIONS_CHECK_FAILED"}'); if (!watch) process.exitCode = 1; }
    if (watch) await pause(60000, undefined, { signal: stop.signal }).catch(() => {});
  } while (watch && !stop.signal.aborted);
}
main().catch(() => { console.error('{"code":"OPERATIONS_CHECK_FAILED"}'); process.exitCode = 1; });
