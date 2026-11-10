import path from "node:path";
import { cancelSupervised, spawnSupervised } from "../subprocess/supervised";
import type { Claim } from "./queue";
export function runProcessor(claim: Claim, signal: AbortSignal, timeoutMs = 60_000, entry = path.resolve("src/server/worker/processor.ts")): Promise<string | undefined> {
  if (signal.aborted) return Promise.resolve("LEASE_LOST_OR_SHUTDOWN");
  return new Promise(resolve => {
    let child: ReturnType<typeof spawnSupervised>;
    try {
      child = spawnSupervised(process.execPath, ["--conditions=react-server", "--import", "tsx", entry], timeoutMs, {
        stdio: ["pipe", "ignore", "ignore", "ipc"], env: { ...process.env, WORKER_PROCESSOR_CHILD: "1" },
      });
    } catch { resolve("PROCESSOR_UNAVAILABLE"); return; }
    let result: string | undefined, stopped: string | undefined;
    const kill = (code: string) => { stopped = code; cancelSupervised(child); };
    const abort = () => kill("LEASE_LOST_OR_SHUTDOWN");
    signal.addEventListener("abort", abort, { once: true });
    child.on("message", msg => {
      const code = (msg as { code?: unknown })?.code;
      if (typeof code === "string" && /^[A-Z_]{2,50}$/.test(code)) result = code;
    });
    child.stdin!.on("error", () => {});
    child.on("error", () => { result = "PROCESSOR_UNAVAILABLE"; });
    child.on("close", code => {
      signal.removeEventListener("abort", abort);
      resolve(stopped ?? (code === 124 ? "PROCESSOR_TIMEOUT" : code === 125 || code === 126 || code === 127 ? "PROCESSOR_UNAVAILABLE" : code === 0 && result === "OK" ? undefined : result && result !== "OK" ? result : "PROCESSOR_CRASH"));
    });
    if (signal.aborted) abort();
    else child.stdin!.end(JSON.stringify(claim));
  });
}
