import "server-only";
import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { getDatabase, getDatabaseClient } from "@/server/db";
import type { Transaction } from "@/server/db/types";
import { jobs, media } from "@/server/db/schema";
import { mediaStorage, type MediaObject } from "@/server/db/schema-media";
import { DISPLAY_BYTES, IMAGE_BYTES, inputLimit } from "./limits";
import { invalidMedia, MediaError } from "./errors";
import { cleanAssetTemporaries, getMediaStorage, LocalMediaStorage, objectKeys, publicObjectKey, type MediaStorageAdapter } from "./storage";
import { getMediaPurge } from "./purge";
import { deleteAssetScratch, inspectStoredWebp, validateMedia } from "./validation";
import { activePublication, assetIdSchema, enqueueMediaDeletion, enqueuePublicPurge, lockMediaOwner, pruneMediaFeedback, retainedMedia } from "./service";

const locator = { version: z.literal(1), assetId: assetIdSchema, token: z.string().uuid() };
const mediaJobPayload = z.discriminatedUnion("action", [
  z.object({ ...locator, action: z.enum(["process", "expire", "reconcileAsset", "trim"]), periodic: z.literal(true).optional() }).strict(),
  z.object({ version: z.literal(1), action: z.literal("reconcile"), ownerId: z.string().min(1).max(200), eventId: z.string().regex(/^[0-9]+$/).optional() }).strict(),
  z.object({ version: z.literal(1), action: z.literal("sweep"), cursor: assetIdSchema.optional(), sweepId: z.string().uuid() }).strict(),
]);
const mediaDeletionJobPayload = z.object(locator).strict();
const cachePurgeJobPayload = z.object({ ...locator, key: z.string().min(1).max(240) }).strict();

function privateDerivativeBytes(original: MediaObject, display: MediaObject) {
  return original.bytes + (display.key === original.key ? 0 : display.bytes);
}

async function trimReadyAsset(tx: Transaction, storage: MediaStorageAdapter, row: typeof mediaStorage.$inferSelect) {
  if (!row.original || !row.display) return;
  const bytes = privateDerivativeBytes(row.original, row.display);
  if (row.privateBytes === bytes) return;
  const keys = objectKeys(row.assetId, row.token);
  await storage.delete("private", keys.quarantine);
  // If a shared-variant commit succeeded after a prior attempt left a
  // separate display.webp, remove the obsolete display before reducing charge.
  if (row.kind === "image" && row.display.key === row.original.key && row.privateBytes > row.receivedBytes + bytes) {
    await storage.delete("private", keys.display);
  }
  await tx.update(mediaStorage).set({ privateBytes: bytes, chargedBytes: bytes + row.publicBudgetBytes, updatedAt: new Date() }).where(eq(mediaStorage.assetId, row.assetId));
}

async function enqueueAssets(rows: { id: string; token: string }[], eventId: string, periodic = false) {
  if (!rows.length) return;
  const values = rows.map(({ id: assetId, token }) => ({ kind: "media", idempotencyKey: periodic ? `media:check:${assetId}:${token}` : `media:reconcileAsset:${assetId}:${eventId}`, maxAttempts: 20,
    payload: { version: 1, action: "reconcileAsset", assetId, token, ...(periodic ? { periodic: true } : {}) } }));
  if (!periodic) { await getDatabase().insert(jobs).values(values).onConflictDoNothing(); return; }
  // At most one outstanding periodic check per asset. Terminal rows are reused
  // so both backlog and successful check history stay bounded. Never rewrite a
  // pending/running job or its claim fence. Explicit events keep independent keys
  // so an event racing a running check cannot lose its later reconciliation.
  await getDatabase().insert(jobs).values(values).onConflictDoUpdate({ target: jobs.idempotencyKey,
    set: { state: "pending", attempts: 0, availableAt: new Date(), finishedAt: null, lastErrorCode: null, createdAt: new Date(), updatedAt: new Date() },
    setWhere: sql`${jobs.state} in ('succeeded', 'failed')` });
}
const PARSER_LOCK = [740301, 1] as const;
const SCRATCH_LOCK_CLASS = 740305;

async function processAsset(assetId: string, token: string) {
  const storage = getMediaStorage();
  const scratchKey = `${assetId}:${token}`;
  const reserved = await getDatabaseClient().reserve();
  let parserLocked = false;
  let scratchLocked = false;
  const releaseParserLocks = async () => {
    if (scratchLocked) {
      scratchLocked = false;
      await reserved`select pg_advisory_unlock(${SCRATCH_LOCK_CLASS}, hashtext(${scratchKey}))`.catch(() => {});
    }
    if (parserLocked) {
      parserLocked = false;
      await reserved`select pg_advisory_unlock(${PARSER_LOCK[0]}, ${PARSER_LOCK[1]})`.catch(() => {});
    }
  };
  try {
    // Acquire advisory locks AFTER MEDIA_BACKUP_LOCK (lockMediaOwner) to match
    // backup.ts's lock order (740303 -> 740301 -> 740305) and prevent deadlocks.
    const claimed = await getDatabase().transaction(async tx => {
      const [snapshot] = await tx.select().from(mediaStorage).where(eq(mediaStorage.assetId, assetId));
      if (!snapshot || snapshot.token !== token) return null;
      const owner = await lockMediaOwner(tx, snapshot.ownerId, true);
      const [row] = await tx.select().from(mediaStorage).where(eq(mediaStorage.assetId, assetId)).for("update");
      if (!row || row.token !== token || row.state !== "queued") return null;
      if (!owner || owner.deletedAt || owner.suspendedAt || !owner.emailVerified || row.expiresAt.getTime() < Date.now()) {
        await tx.update(mediaStorage).set({ state: "deleting" }).where(eq(mediaStorage.assetId, assetId));
        await enqueueMediaDeletion(tx, row);
        return null;
      }
      const [locked] = await reserved<{ acquired: boolean }[]>`select pg_try_advisory_lock(${PARSER_LOCK[0]}, ${PARSER_LOCK[1]}) as acquired`;
      if (!locked?.acquired) throw new MediaError(429, "MEDIA_PARSER_BUSY", "Media processing is busy. Try again shortly.");
      parserLocked = true;
      const [scratch] = await reserved<{ acquired: boolean }[]>`select pg_try_advisory_lock(${SCRATCH_LOCK_CLASS}, hashtext(${scratchKey})) as acquired`;
      if (!scratch?.acquired) throw new MediaError(429, "MEDIA_PARSER_BUSY", "Media processing is busy. Try again shortly.");
      scratchLocked = true;
      await tx.update(media).set({ state: "processing" }).where(eq(media.id, assetId));
      return { ownerId: snapshot.ownerId, kind: row.kind as "image" | "audio" };
    });
    if (!claimed) return;

    const keys = objectKeys(assetId, token);
    let parsed;
    let obsoleteDisplayBytes = 0;
    let validationRejected = false;
    try {
      await deleteAssetScratch(assetId, token);
      const quarantine = await storage.get("private", keys.quarantine, inputLimit(claimed.kind));
      parsed = await validateMedia(quarantine, claimed.kind, { assetId, token });
      // Keep derivative keys strictly immutable across retries and encoder
      // deployments (never DELETE a key a retry may commit). If a prior attempt
      // already wrote a valid WebP at an immutable key, verify and adopt it.
      if (claimed.kind === "image" && await storage.exists("private", keys.original)) {
        const existingOriginal = await storage.get("private", keys.original, IMAGE_BYTES);
        if (!existingOriginal.equals(parsed.original)) {
          const dims = await inspectStoredWebp(existingOriginal, { assetId, token });
          const keepShared = parsed.sharedVariants && existingOriginal.length <= DISPLAY_BYTES;
          parsed = {
            ...parsed,
            original: existingOriginal,
            width: dims.width,
            height: dims.height,
            display: keepShared ? existingOriginal : parsed.display,
            ...(keepShared
              ? { displayWidth: dims.width, displayHeight: dims.height, sharedVariants: true as const }
              : { sharedVariants: undefined }),
          };
        }
      }
      if (claimed.kind === "image" && !parsed.sharedVariants && await storage.exists("private", keys.display)) {
        const existingDisplay = await storage.get("private", keys.display, DISPLAY_BYTES);
        if (!existingDisplay.equals(parsed.display)) {
          const dims = await inspectStoredWebp(existingDisplay, { assetId, token });
          parsed = { ...parsed, display: existingDisplay, displayWidth: dims.width, displayHeight: dims.height };
        }
      }
      if (claimed.kind === "image" && parsed.sharedVariants && await storage.exists("private", keys.display)) {
        // Keep an obsolete separate display.webp covered in privateBytes until
        // trimQuarantine/reconcileAsset deletes it after the ready commit.
        obsoleteDisplayBytes = (await storage.get("private", keys.display, DISPLAY_BYTES)).length;
      }
    } catch (error) {
      if (!(error instanceof MediaError) || error.status !== 422) throw error;
      validationRejected = true;
    } finally {
      // Release parser & scratch locks before acquiring MEDIA_BACKUP_LOCK in
      // Tx 2 so a concurrent snapshot cannot deadlock waiting on PARSER_LOCK.
      await releaseParserLocks();
    }

    if (validationRejected) {
      await getDatabase().transaction(async tx => {
        await lockMediaOwner(tx, claimed.ownerId, true);
        const [row] = await tx.select().from(mediaStorage).where(eq(mediaStorage.assetId, assetId)).for("update");
        if (!row || row.token !== token || row.state !== "queued") return;
        await tx.update(media).set({ state: "rejected" }).where(eq(media.id, assetId));
        await tx.update(mediaStorage).set({ state: "deleting", updatedAt: new Date() }).where(eq(mediaStorage.assetId, assetId));
        await enqueueMediaDeletion(tx, row);
      });
      return;
    }

    if (!parsed) return;
    const readyCommitted = await getDatabase().transaction(async tx => {
      const owner = await lockMediaOwner(tx, claimed.ownerId, true);
      const [row] = await tx.select().from(mediaStorage).where(eq(mediaStorage.assetId, assetId)).for("update");
      if (!row || row.token !== token || row.state !== "queued") return false;
      if (!owner || owner.deletedAt || owner.suspendedAt || !owner.emailVerified || row.expiresAt.getTime() < Date.now()) {
        await tx.update(mediaStorage).set({ state: "deleting" }).where(eq(mediaStorage.assetId, assetId));
        await enqueueMediaDeletion(tx, row);
        return false;
      }
      await cleanAssetTemporaries(storage, row);
      const original = { area: "private" as const, key: row.kind === "image" ? keys.original : keys.audio, bytes: parsed.original.length,
        contentType: parsed.contentType, ...(parsed.width ? { width: parsed.width, height: parsed.height } : {}), ...(parsed.durationMs ? { durationMs: parsed.durationMs } : {}) };
      const display = row.kind === "image" && !parsed.sharedVariants
        ? { area: "private" as const, key: keys.display, bytes: parsed.display.length, contentType: parsed.contentType, width: parsed.displayWidth, height: parsed.displayHeight }
        : original;
      const privateBytes = row.receivedBytes + privateDerivativeBytes(original, display) + obsoleteDisplayBytes;
      const charge = privateBytes + display.bytes;
      if (charge > row.chargedBytes) throw invalidMedia();
      await storage.put("private", original.key, parsed.original, original.contentType);
      if (display.key !== original.key) await storage.put("private", display.key, parsed.display, display.contentType);
      await tx.update(mediaStorage).set({ original, display, state: "ready", chargedBytes: charge, privateBytes, publicBudgetBytes: display.bytes, updatedAt: new Date() }).where(eq(mediaStorage.assetId, assetId));
      await tx.update(media).set({ state: "ready", objectKey: original.key, actualBytes: original.bytes, contentType: original.contentType, width: parsed.width ?? null, height: parsed.height ?? null, durationMs: parsed.durationMs ?? null }).where(eq(media.id, assetId));
      return true;
    });
    if (readyCommitted) {
      // Best-effort quarantine/obsolete-display trim; reconcileAsset recovers on failure.
      await getDatabase().transaction(async tx => {
        await lockMediaOwner(tx, claimed.ownerId, true);
        const [row] = await tx.select().from(mediaStorage).where(eq(mediaStorage.assetId, assetId)).for("update");
        if (row && row.token === token && row.state === "ready") await trimReadyAsset(tx, storage, row);
      }).catch(() => {});
    }
  } finally {
    await releaseParserLocks();
    reserved.release();
  }
}
async function reconcileAsset(assetId: string, token: string, mode: "reconcileAsset" | "expire" | "trim") {
  const storage = getMediaStorage();
  if (mode !== "trim") getMediaPurge(storage);
  await getDatabase().transaction(async tx => {
    const [snapshot] = await tx.select().from(mediaStorage).where(eq(mediaStorage.assetId, assetId));
    if (!snapshot || snapshot.token !== token) return;
    const owner = await lockMediaOwner(tx, snapshot.ownerId, true);
    const [row] = await tx.select().from(mediaStorage).where(eq(mediaStorage.assetId, assetId)).for("update");
    if (!row || row.token !== token) return;
    if (mode === "trim" && row.state !== "ready") return;
    const abandoned = ["uploading", "queued"].includes(row.state) && row.expiresAt.getTime() <= Date.now();
    if (mode !== "trim" && (!owner || row.state === "deleting" || row.state === "rejected" || abandoned)) {
      // DB reference constraints remain the final guard against accidental removal.
      if (await retainedMedia(tx, assetId)) return;
      await tx.update(mediaStorage).set({ state: "deleting", updatedAt: new Date() }).where(eq(mediaStorage.assetId, assetId));
      await enqueueMediaDeletion(tx, row); return;
    }
    if (mode === "expire" || row.state !== "ready") return;
    // Includes final-object-exists retries and live publications: interrupted
    // locator temporaries must disappear before a peak reservation is released.
    if (storage instanceof LocalMediaStorage) await cleanAssetTemporaries(storage, row);
    await trimReadyAsset(tx, storage, row);
    if (mode === "trim") return;
    if (row.revokingKey) { await enqueuePublicPurge(tx, row, row.revokingKey); return; }
    const [live] = await tx.select({ live: activePublication(mediaStorage.assetId) }).from(mediaStorage).where(eq(mediaStorage.assetId, assetId));
    if (live.live) return;
    // HEAD discovers a provisional object even when its creating SQL transaction
    // rolled back. The owner lock excludes another copy/publication during this.
    if (await storage.exists("public", row.publicKey)) {
      await tx.update(mediaStorage).set({ revokingKey: row.publicKey, publicKey: publicObjectKey(assetId, token, row.kind), publicGeneration: row.publicGeneration + 1, updatedAt: new Date() }).where(eq(mediaStorage.assetId, assetId));
      await enqueuePublicPurge(tx, row, row.publicKey);
    }
  });
}
/** Worker supplies the persisted payload and marks success only after resolution. */
export async function processMediaJob(payload: unknown): Promise<void> {
  const data = mediaJobPayload.parse(payload);
  if (data.action === "process") return processAsset(data.assetId, data.token);
  if (data.action === "expire" || data.action === "reconcileAsset" || data.action === "trim") {
    return reconcileAsset(data.assetId, data.token, data.action);
  }
  if (data.action === "reconcile") {
    const rows = await getDatabase().select({ id: mediaStorage.assetId, token: mediaStorage.token }).from(mediaStorage).where(eq(mediaStorage.ownerId, data.ownerId));
    // Exactly one job per asset per reconciliation job; duplicate execution safe.
    await enqueueAssets(rows, data.eventId ?? new Date().toISOString().slice(0, 16));
    return;
  }
  if (data.action === "sweep") {
    const rows = await getDatabase().select({ id: mediaStorage.assetId, token: mediaStorage.token }).from(mediaStorage)
      .where(data.cursor ? gt(mediaStorage.assetId, data.cursor) : undefined).orderBy(mediaStorage.assetId).limit(100);
    await enqueueAssets(rows, data.sweepId, true);
    if (rows.length === 100) {
      const cursor = rows[rows.length - 1].id;
      await getDatabase().insert(jobs).values({ kind: "media", maxAttempts: 20, idempotencyKey: `media:sweep:${data.sweepId}:${cursor}`,
        payload: { ...data, cursor } }).onConflictDoNothing();
    }
  }
}
/** Removal captures immutable locators in a ledger without owner FKs. */
export async function processMediaDeletionJob(payload: unknown): Promise<void> {
  const data = mediaDeletionJobPayload.parse(payload), storage = getMediaStorage(), purge = getMediaPurge(storage);
  await getDatabase().transaction(async tx => {
    const [snapshot] = await tx.select().from(mediaStorage).where(eq(mediaStorage.assetId, data.assetId));
    if (!snapshot || snapshot.token !== data.token) return;
    await lockMediaOwner(tx, snapshot.ownerId, true);
    const [row] = await tx.select().from(mediaStorage).where(eq(mediaStorage.assetId, data.assetId)).for("update");
    if (!row || row.token !== data.token || row.state !== "deleting") return;
    if (await retainedMedia(tx, row.assetId)) throw new MediaError(409, "MEDIA_RETAINED", "Media is retained by a profile revision.");
    // Wait/retry if a parser worker still owns scratch files for this asset+token
    // so the ledger charge is never released while parser scratch exists.
    const [scratchFree] = await tx.execute<{ acquired: boolean }>(sql`select pg_try_advisory_xact_lock(${SCRATCH_LOCK_CLASS}, hashtext(${`${row.assetId}:${row.token}`})) as acquired`);
    if (!scratchFree?.acquired) throw new MediaError(429, "MEDIA_PARSER_BUSY", "Media processing is busy. Try again shortly.");
    // If a purge fails, leave the ledger/charge intact and retry these idempotent
    // deletes. A ledger is never forgotten before invalidation succeeds.
    await storage.delete("public", row.publicKey);
    if (row.revokingKey && row.revokingKey !== row.publicKey) await storage.delete("public", row.revokingKey);
    const purgeKeys = [...new Set([row.publicKey, row.revokingKey].filter((key): key is string => Boolean(key)))];
    await purge.purge(purgeKeys.map(key => storage.publicUrl(key)));
    for (const key of Object.values(objectKeys(row.assetId, row.token))) await storage.delete("private", key);
    await deleteAssetScratch(row.assetId, row.token);
    // Old rotated public keys have their own durable cache_purge jobs.
    await tx.delete(mediaStorage).where(and(eq(mediaStorage.assetId, row.assetId), eq(mediaStorage.token, row.token)));
    // Keep rejected status for user feedback; physical removal doesn't erase it.
    await tx.update(media).set({ state: "deleted", deletedAt: new Date() }).where(and(eq(media.id, row.assetId), sql`${media.state} <> 'rejected'`));
    await pruneMediaFeedback(tx, row.ownerId);
  });
}
export async function processCachePurgeJob(payload: unknown): Promise<void> {
  const data = cachePurgeJobPayload.parse(payload), storage = getMediaStorage(), purge = getMediaPurge(storage);
  // Validate the complete locator even after the asset/owner has been deleted.
  if (!data.key.startsWith(`v1/${data.assetId}/${data.token}/public-`)) throw invalidMedia();
  await getDatabase().transaction(async tx => {
    const [snapshot] = await tx.select().from(mediaStorage).where(eq(mediaStorage.assetId, data.assetId));
    if (snapshot) {
      await lockMediaOwner(tx, snapshot.ownerId, true);
      const [row] = await tx.select({ key: mediaStorage.publicKey, live: activePublication(mediaStorage.assetId) }).from(mediaStorage).where(eq(mediaStorage.assetId, data.assetId)).for("update");
      if (row?.key === data.key && row.live) return;
    }
    await storage.delete("public", data.key);
    await purge.purge([storage.publicUrl(data.key)]);
    await tx.update(mediaStorage).set({ revokingKey: null, updatedAt: new Date() }).where(and(eq(mediaStorage.assetId, data.assetId), eq(mediaStorage.token, data.token), eq(mediaStorage.revokingKey, data.key)));
  });
}
/** Call at least once per minute from the central worker scheduler, including
 * after crashes. A fresh sweep ID also repairs failed/missed older job attempts. */
export async function enqueueMediaSweep(sweepId: string): Promise<void> {
  z.string().uuid().parse(sweepId);
  await getDatabase().transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(740301, 2)`);
    const [outstanding] = await tx.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.kind, "media"),
      sql`${jobs.payload}->>'action' = 'sweep'`, sql`${jobs.state} in ('pending', 'running')`)).limit(1);
    if (outstanding) return;
    const payload = { version: 1, action: "sweep", sweepId };
    await tx.insert(jobs).values({ kind: "media", maxAttempts: 20, idempotencyKey: "media:sweep:periodic", payload })
      .onConflictDoUpdate({ target: jobs.idempotencyKey,
        set: { state: "pending", attempts: 0, availableAt: new Date(), finishedAt: null, lastErrorCode: null, createdAt: new Date(), updatedAt: new Date(), payload },
        setWhere: sql`${jobs.state} in ('succeeded', 'failed')` });
  });
}
