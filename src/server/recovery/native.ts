import { cancelSupervised, spawnSupervised } from "../subprocess/supervised";
import { requireDatabaseUrl } from "../db/connection-options";
import { fail } from "./files";
export async function native(command: string, args: string[], url: string, signal: AbortSignal, capture = false): Promise<string> {
  const u = new URL(requireDatabaseUrl(url, "RECOVERY_DATABASE_URL"));
  if (signal.aborted) throw new Error("POSTGRES_TOOL_FAILED");
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawnSupervised>;
    try {
      child = spawnSupervised(command, args, 180_000, { stdio: ["ignore", capture ? "pipe" : "ignore", "ignore"], env: {
        NODE_ENV: process.env.NODE_ENV || "production", PATH: process.env.PATH, LANG: "C", PGHOST: u.hostname, PGPORT: u.port || "5432", PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: decodeURIComponent(u.pathname.slice(1)), PGSSLMODE: u.searchParams.get("sslmode") || "prefer", PGCONNECT_TIMEOUT: "5", PGOPTIONS: "-c statement_timeout=180000 -c lock_timeout=10000",
      } });
    } catch { reject(new Error("POSTGRES_TOOL_UNAVAILABLE")); return; }
    let output = "", bytes = 0, unavailable = false;
    const kill = () => cancelSupervised(child);
    signal.addEventListener("abort", kill, { once: true }); if (signal.aborted) kill();
    child.stdout?.on("data", (c: Buffer) => { bytes += c.length; if (bytes > 65536) kill(); else output += c.toString(); });
    child.on("error", () => { unavailable = true; });
    child.on("close", code => {
      signal.removeEventListener("abort", kill);
      if (bytes > 65536 || signal.aborted) reject(new Error("POSTGRES_TOOL_FAILED"));
      else if (unavailable || code === 125 || code === 126 || code === 127) reject(new Error("POSTGRES_TOOL_UNAVAILABLE"));
      else if (code !== 0) reject(new Error("POSTGRES_TOOL_FAILED"));
      else resolve(output);
    });
  });
}
export async function checkTool(tool: "dump" | "restore", url: string, signal: AbortSignal) {
  const command = tool === "dump" ? process.env.PG_DUMP_BIN || "pg_dump" : process.env.PG_RESTORE_BIN || "pg_restore";
  const version = await native(command, ["--version"], url, signal, true);
  if (!/PostgreSQL\) (17|18|19)\./.test(version)) fail("POSTGRES_17_TOOLS_REQUIRED");
  return command;
}
