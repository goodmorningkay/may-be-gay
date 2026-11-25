import { writeSync } from "node:fs";
import { parentPort } from "node:worker_threads";

// Terminating the Node process also ends its container via the entrypoint.
const deadline = setTimeout(() => {
  writeSync(2, '{"code":"WORKER_EVENT_LOOP_STALLED"}\n');
  process.kill(process.pid, "SIGKILL");
}, 20_000);

parentPort.on("message", () => deadline.refresh());
