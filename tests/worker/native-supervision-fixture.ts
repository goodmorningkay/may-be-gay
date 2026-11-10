import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function compileGuardian() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "guardian-build-"));
  const binary = path.join(dir, "guardian");
  try {
    execFileSync("cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", path.resolve("src/server/subprocess/guardian.c"), "-o", binary], { timeout: 10000, stdio: "pipe" });
    return { binary, dispose: () => rm(dir, { recursive: true, force: true }) };
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
}

export const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function started(file: string): Promise<number> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const pid = Number(await readFile(file, "utf8").catch(() => ""));
    if (Number.isInteger(pid) && pid > 1) return pid;
    await pause(10);
  }
  throw new Error(`Child did not start: ${path.basename(file)}`);
}

export function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

export async function waitGone(pid: number) {
  const deadline = Date.now() + 3000;
  while (alive(pid) && Date.now() < deadline) await pause(10);
  if (alive(pid)) throw new Error(`Owned test child ${pid} survived (including zombies)`);
}

export async function noLateMarker(marker: string) {
  // Test children attempt their write 350ms after a separate release file.
  await pause(450);
  if (existsSync(marker)) throw new Error("Descendant wrote after cancellation returned");
}
