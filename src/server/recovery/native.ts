import { runBoundedCommand } from "../subprocess/bounded";
import { requireDatabaseUrl } from "../db/connection-options";
import { fail } from "./files";

export async function native(command: string, args: string[], url: string, signal: AbortSignal, capture = false): Promise<string> {
  const u = new URL(requireDatabaseUrl(url, "RECOVERY_DATABASE_URL"));
  if (signal.aborted) throw new Error("POSTGRES_TOOL_FAILED");
  const result = await runBoundedCommand(command, args, {
    timeoutMs: 180_000,
    signal,
    captureStdout: capture,
    maxOutputBytes: 65536,
    env: {
      NODE_ENV: process.env.NODE_ENV || "production",
      PATH: process.env.PATH,
      LANG: "C",
      PGHOST: u.hostname,
      PGPORT: u.port || "5432",
      PGUSER: decodeURIComponent(u.username),
      PGPASSWORD: decodeURIComponent(u.password),
      PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
      PGSSLMODE: u.searchParams.get("sslmode") || "prefer",
      PGCONNECT_TIMEOUT: "5",
      PGOPTIONS: "-c statement_timeout=180000 -c lock_timeout=10000",
    },
  });
  if (result.aborted || result.timedOut || result.outputExceeded) throw new Error("POSTGRES_TOOL_FAILED");
  if (result.unavailable || result.code === 125 || result.code === 126 || result.code === 127) throw new Error("POSTGRES_TOOL_UNAVAILABLE");
  if (result.code !== 0) throw new Error("POSTGRES_TOOL_FAILED");
  return result.stdout;
}

export async function checkTool(tool: "dump" | "restore", url: string, signal: AbortSignal) {
  const command = tool === "dump" ? process.env.PG_DUMP_BIN || "pg_dump" : process.env.PG_RESTORE_BIN || "pg_restore";
  const version = await native(command, ["--version"], url, signal, true);
  if (!/PostgreSQL\) (17|18|19)\./.test(version)) fail("POSTGRES_17_TOOLS_REQUIRED");
  return command;
}
