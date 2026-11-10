import "server-only";
import { sql } from "drizzle-orm";
import type { Transaction } from "./types";

/** Backup takes the exclusive counterpart before exporting its DB snapshot and
 * copying ready private assets. Media mutations hold this shared transaction
 * lock through storage side effects, so retained files cannot disappear mid-copy. */
export const MEDIA_BACKUP_LOCK = [740303, 1] as const;

export async function lockMediaForBackupConsistency(tx: Transaction): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(${MEDIA_BACKUP_LOCK[0]}, ${MEDIA_BACKUP_LOCK[1]})`);
}
