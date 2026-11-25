import "server-only";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDatabase } from "./db";
import { recoveryStatus } from "./db/schema-worker";

type ServiceState = "open" | "closed" | "unavailable";

/** Every restored DB has an offline restore status. Validation never authorizes
 * reopening: an operator must explicitly remove that status and the file gate.
 * Configuration, filesystem and schema failures keep traffic closed. */
export async function serviceState(): Promise<ServiceState> {
  try {
    const marker = process.env.SERVICE_CLOSED_FILE;
    if (!marker && process.env.NODE_ENV === "production") return "unavailable";
    if (marker) {
      if (!path.isAbsolute(marker)) return "unavailable";
      try { await lstat(marker); return "closed"; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "unavailable"; }
    }
    if (!process.env.DATABASE_URL) return process.env.NODE_ENV === "production" ? "unavailable" : "open";
    const [restore] = await getDatabase().select({ id: recoveryStatus.id }).from(recoveryStatus).where(eq(recoveryStatus.id, "restore")).limit(1);
    return restore ? "closed" : "open";
  } catch { return "unavailable"; }
}
