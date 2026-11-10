import { spawn, type SpawnOptions } from "node:child_process";
import path from "node:path";

/** The binary is built from guardian.c and installed by the runtime image.
 * Fail closed if unavailable; never fall back to an unsupervised spawn.
 * Only signal the guardian with TERM: it owns killing AND reaping descendants.
 */
export function spawnSupervised(command: string, args: string[], timeoutMs: number, options: SpawnOptions, lockFile = "") {
  const binary = process.env.NATIVE_GUARDIAN_BIN || "/usr/local/libexec/may-be-guardian";
  if (!path.isAbsolute(binary) || (lockFile && !path.isAbsolute(lockFile)) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new Error("NATIVE_GUARDIAN_UNAVAILABLE");
  const ipc = Array.isArray(options.stdio) ? options.stdio.indexOf("ipc") : -1;
  // The runtime image installs this executable outside the source tree. Keep
  // Next from tracing an environment-configured path as the entire checkout.
  return spawn(/* turbopackIgnore: true */ binary, [String(process.pid), String(timeoutMs), String(ipc > 0 ? ipc : 0), lockFile, "1", "--", command, ...args], {
    ...options,
    // The payload gets its own group inside the guardian. Nested guardians may
    // be adopted by an outer subreaper, including after abrupt JS parent death.
    detached: false,
  });
}

export function cancelSupervised(child: ReturnType<typeof spawnSupervised>) {
  child.kill("SIGTERM");
}
