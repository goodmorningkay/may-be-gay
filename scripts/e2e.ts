import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir } from "node:fs/promises";

// All mutations are confined to this fresh project. Never accept a supplied
// project/database URL or compose file and never call global Docker cleanup.
const project = `may-be-e2e-${randomBytes(6).toString("hex")}`;
const env = { ...process.env, E2E_IMAGE: "may-be-browser-acceptance:1.65.0" };
const base = ["compose", "-p", project, "-f", "infra/testing/e2e/compose.yaml"];
let active: ReturnType<typeof spawn> | undefined;
async function run(command: string, args: string[], allowFailure = false) {
  const code = await new Promise<number>((resolve, reject) => {
    active = spawn(command, args, { stdio: "inherit", env });
    active.once("error", reject);
    active.once("exit", code => { active = undefined; resolve(code ?? 1); });
  });
  if (code && !allowFailure) throw new Error(`${command} failed (${code})`);
  return code;
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => active?.kill(signal));
async function main() { try {
  await run("npm", ["run", "build"]);
  await mkdir(".next/standalone/.next", { recursive: true });
  await cp(".next/static", ".next/standalone/.next/static", { recursive: true });
  await mkdir(".next/standalone/src/server/media", { recursive: true });
  await cp("src/server/media/parser.cjs", ".next/standalone/src/server/media/parser.cjs");
  await run("docker", [...base, "build", "app"]);
  await run("docker", [...base, "up", "-d", "--wait", "db", "caddy"]);
  await run("docker", [...base, "run", "--rm", "--no-deps", "app", "node", "--import", "tsx", "scripts/migrate.ts"]);
  await run("docker", [...base, "up", "-d", "--wait", "app"]);
  const args = process.argv.slice(2);
  process.exitCode = await run("docker", [...base, "run", "--rm", "--no-deps", "browser", "node", "node_modules/@playwright/test/cli.js", "test", ...args], true);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Browser acceptance failed"); process.exitCode = 1;
} finally {
  await run("docker", [...base, "down", "--volumes", "--remove-orphans", "--timeout", "5"], true);
} }
void main();
