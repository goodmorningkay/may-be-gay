import "server-only";
import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { getDatabase, getDatabaseClient } from "@/server/db";
import { jobs, media } from "@/server/db/schema";
import { mediaStorage } from "@/server/db/schema-media";
import { inputLimit, RESERVATION_MS } from "./limits";
import { invalidMedia, MediaError } from "./errors";
import { cleanAssetTemporaries, getMediaStorage, objectKeys, publicObjectKey } from "./storage";
import { getMediaPurge } from "./purge";
import { deleteAssetScratch, sweepMediaScratch, validateMedia } from "./validation";
import { activePublication, assetIdSchema, enqueueMediaDeletion, enqueuePublicPurge, lockMediaOwner, pruneMediaFeedback, retainedMedia } from "./service";

const locator = { version: z.literal(1), assetId: assetIdSchema, token: z.string().uuid() };
export const mediaJobPayload = z.discriminatedUnion("action", [
  z.object({ ...locator, action: z.enum(["process", "expire", "reconcileAsset", "trim"]), periodic: z.literal(true).optional() }).strict(),
  z.object({ version: z.literal(1), action: z.literal("reconcile"), ownerId: z.string().min(1).max(200), eventId: z.string().regex(/^[0-9]+$/).optional() }).strict(),
  z.object({ version: z.literal(1), action: z.literal("sweep"), cursor: assetIdSchema.optional(), sweepId: z.string().uuid() }).strict(),
]);
export const mediaDeletionJobPayload = z.object(locator).strict();
export const cachePurgeJobPayload = z.object({ ...locator, key: z.string().min(1).max(240) }).strict();

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
async function processAsset(assetId: string, token: string) {
  const storage = getMediaStorage();
  const reserved = await getDatabaseClient().reserve();
  let parserLocked = false;
  try {
    // Session advisory lock on a reserved connection releases on crash or unlock,
    // and shares the same namespace as pg_advisory_xact_lock(740301, 1).
    const [locked] = await reserved<{ acquired: boolean }[]>`select pg_try_advisory_lock(740301, 1) as acquired`;
    if (!locked?.acquired) throw new MediaError(429, "MEDIA_PARSER_BUSY", "Media processing is busy. Try again shortly.");
    parserLocked = true;

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
      await tx.update(media).set({ state: "processing" }).where(eq(media.id, assetId));
      return { ownerId: snapshot.ownerId, kind: row.kind as "image" | "audio" };
    });
    if (!claimed) return;

    await deleteAssetScratch(assetId, token);
    const keys = objectKeys(assetId, token);
    let parsed;
    try {
      const quarantine = await storage.get("private", keys.quarantine, inputLimit(claimed.kind));
      parsed = await validateMedia(quarantine, claimed.kind, { assetId, token });
    } catch (error) {
      if (!(error instanceof MediaError) || error.status !== 422) throw error;
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

    await getDatabase().transaction(async tx => {
      const owner = await lockMediaOwner(tx, claimed.ownerId, true);
      const [row] = await tx.select().from(mediaStorage).where(eq(mediaStorage.assetId, assetId)).for("update");
      if (!row || row.token !== token || row.state !== "queued") return;
      if (!owner || owner.deletedAt || owner.suspendedAt || !owner.emailVerified || row.expiresAt.getTime() < Date.now()) {
        await tx.update(mediaStorage).set({ state: "deleting" }).where(eq(mediaStorage.assetId, assetId));
        await enqueueMediaDeletion(tx, row);
        return;
      }
      await cleanAssetTemporaries(storage, row);
      const original = { area: "private" as const, key: row.kind === "image" ? keys.original : keys.audio, bytes: parsed.original.length,
        contentType: parsed.contentType, ...(parsed.width ? { width: parsed.width, height: parsed.height } : {}), ...(parsed.durationMs ? { durationMs: parsed.durationMs } : {}) };
      const display = row.kind === "image" ? { area: "private" as const, key: keys.display, bytes: parsed.display.length, contentType: parsed.contentType, width: parsed.displayWidth, height: parsed.displayHeight } : original;
      const privateBytes = row.receivedBytes + original.bytes + (row.kind === "image" ? display.bytes : 0);
      const charge = privateBytes + display.bytes;
      if (charge > row.chargedBytes) throw invalidMedia();
      await storage.put("private", original.key, parsed.original, original.contentType);
      if (row.kind === "image") await storage.put("private", display.key, parsed.display, display.contentType);
      await tx.update(mediaStorage).set({ original, display, state: "ready", chargedBytes: charge, privateBytes, publicBudgetBytes: display.bytes, updatedAt: new Date() }).where(eq(mediaStorage.assetId, assetId));
      await tx.update(media).set({ state: "ready", objectKey: original.key, actualBytes: original.bytes, contentType: original.contentType, width: parsed.width ?? null, height: parsed.height ?? null, durationMs: parsed.durationMs ?? null }).where(eq(media.id, assetId));
      await tx.insert(jobs).values({ kind: "media", idempotencyKey: `media:trim:${assetId}`, maxAttempts: 20, payload: { version: 1, action: "trim", assetId, token } }).onConflictDoNothing();
    });
  } finally {
    if (parserLocked) await reserved`select pg_advisory_unlock(740301, 1)`.catch(() => {});
    reserved.release();
  }
}
async function reconcileAsset(assetId: string, token: string, expireOnly = false) {
  const storage = getMediaStorage(); getMediaPurge(storage);
  await getDatabase().transaction(async tx => {
    const [snapshot] = await tx.select().from(mediaStorage).where(eq(mediaStorage.assetId, assetId));
    if (!snapshot || snapshot.token !== token) return;
    const owner = await lockMediaOwner(tx, snapshot.ownerId, true);
    const [row] = await tx.select().from(mediaStorage).where(eq(mediaStorage.assetId, assetId)).for("update");
    if (!row || row.token !== token) return;
    const abandoned = ["uploading", "queued"].includes(row.state) && row.expiresAt.getTime() <= Date.now();
    if (!owner || row.state === "deleting" || row.state === "rejected" || abandoned) {
      // DB reference constraints remain the final guard against accidental removal.
      if (await retainedMedia(tx, assetId)) return;
      await tx.update(mediaStorage).set({ state: "deleting", updatedAt: new Date() }).where(eq(mediaStorage.assetId, assetId));
      await enqueueMediaDeletion(tx, row); return;
    }
    if (expireOnly || row.state !== "ready") return;
    // Includes final-object-exists retries and live publications: interrupted
    // locator temporaries must disappear before a peak reservation is released.
    await cleanAssetTemporaries(storage, row);
    await storage.delete("private", objectKeys(assetId, token).quarantine);
    if (row.original && row.display) {
      const bytes = row.original.bytes + (row.kind === "image" ? row.display.bytes : 0);
      await tx.update(mediaStorage).set({ privateBytes: bytes, chargedBytes: bytes + row.publicBudgetBytes }).where(eq(mediaStorage.assetId, assetId));
    }
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
async function trimQuarantine(assetId: string, token: string) {
  await getDatabase().transaction(async tx => {
    const [snapshot] = await tx.select().from(mediaStorage).where(eq(mediaStorage.assetId, assetId));
    if (!snapshot || snapshot.token !== token) return;
    await lockMediaOwner(tx, snapshot.ownerId, true);
    const [row] = await tx.select().from(mediaStorage).where(eq(mediaStorage.assetId, assetId)).for("update");
    if (!row || row.state !== "ready" || !row.original || !row.display) return;
    const storage = getMediaStorage();
    await cleanAssetTemporaries(storage, row);
    await storage.delete("private", objectKeys(assetId, token).quarantine);
    const bytes = row.original.bytes + (row.kind === "image" ? row.display.bytes : 0);
    await tx.update(mediaStorage).set({ privateBytes: bytes, chargedBytes: bytes + row.publicBudgetBytes, updatedAt: new Date() }).where(eq(mediaStorage.assetId, assetId));
  });
}
/** Worker supplies the persisted payload and marks success only after resolution. */
export async function processMediaJob(payload: unknown): Promise<void> {
  const data = mediaJobPayload.parse(payload);
  if (data.action === "process") return processAsset(data.assetId, data.token);
  if (data.action === "trim") return trimQuarantine(data.assetId, data.token);
  if (data.action === "expire") return reconcileAsset(data.assetId, data.token, true);
  if (data.action === "reconcileAsset") return reconcileAsset(data.assetId, data.token);
  if (data.action === "reconcile") {
    const rows = await getDatabase().select({ id: mediaStorage.assetId, token: mediaStorage.token }).from(mediaStorage).where(eq(mediaStorage.ownerId, data.ownerId));
    // Exactly one job per asset per reconciliation job; duplicate execution safe.
    await enqueueAssets(rows, data.eventId ?? new Date().toISOString().slice(0, 16));
    return;
  }
  if (data.action === "sweep") {
    await sweepMediaScratch();
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
    // If a purge fails, leave the ledger/charge intact and retry these idempotent
    // deletes. A ledger is never forgotten before invalidation succeeds.
    await storage.delete("public", row.publicKey);
    await purge.purge([storage.publicUrl(row.publicKey)]);
    if (row.revokingKey) { await storage.delete("public", row.revokingKey); await purge.purge([storage.publicUrl(row.revokingKey)]); }
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
export const mediaReservationLifetimeMs = RESERVATION_MS;
