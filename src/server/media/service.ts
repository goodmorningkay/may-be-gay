import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { PublicMedia, PublicMediaMap } from "@/domain/media";
import { MAX_PRIVATE_MEDIA_OBJECTS } from "@/domain/media";
import { getDatabase } from "@/server/db";
import type { Transaction } from "@/server/db/types";
import { lockMediaForBackupConsistency } from "@/server/db/maintenance-lock";
import { draftMedia, jobs, media, revisionMedia, user } from "@/server/db/schema";
import { accountQuotas, DEFAULT_ACCOUNT_MEDIA_LIMIT_BYTES, DEFAULT_TOTAL_MEDIA_LIMIT_BYTES, serviceSettings } from "@/server/db/schema-settings";
import { mediaStorage, type MediaObject } from "@/server/db/schema-media";
import { capacity, invalidMedia, MediaError, storageFailure } from "./errors";
import { MAX_ASSETS, MAX_REJECTION_FEEDBACK, RESERVATION_MS, reservationBytes, privateObjectSlots, type MediaKind } from "./limits";
import { cleanAssetTemporaries, getMediaStorage, objectKeys, publicObjectKey } from "./storage";
import { getMediaPurge } from "./purge";
import { withUploadFile } from "./validation";
import { checkMediaEditor } from "./identity";

export const assetIdSchema = z.string().uuid().transform(value => value.toLowerCase());
export type StorageRow = typeof mediaStorage.$inferSelect;
function ids(input: string[]): string[] {
  if (input.length > MAX_ASSETS || input.some(id => !assetIdSchema.safeParse(id).success)) throw invalidMedia();
  return [...new Set(input.map(id => id.toLowerCase()))].sort();
}
export async function lockMediaOwner(tx: Transaction, ownerId: string, allowInactive = false) {
  await lockMediaForBackupConsistency(tx);
  const [owner] = await tx.select().from(user).where(eq(user.id, ownerId)).for("update");
  if (!allowInactive && (!owner || owner.deletedAt || owner.suspendedAt || !owner.emailVerified)) throw new MediaError(403, "ACCOUNT_UNAVAILABLE", "An active verified account is required.");
  return owner;
}
export async function lockMediaCapacity(tx: Transaction, ownerId: string) {
  await tx.insert(serviceSettings).values({ id: true }).onConflictDoNothing();
  const [settings] = await tx.select().from(serviceSettings).where(eq(serviceSettings.id, true)).for("update");
  await tx.insert(accountQuotas).values({ userId: ownerId }).onConflictDoNothing();
  const [quota] = await tx.select().from(accountQuotas).where(eq(accountQuotas.userId, ownerId)).for("update");
  return { settings, quota };
}
export async function mediaUsage(tx: Transaction, ownerId: string) {
  const [totals] = await tx.select({
    total: sql<number>`coalesce(sum(${mediaStorage.chargedBytes}), 0)::float8`,
    owner: sql<number>`coalesce(sum(case when ${mediaStorage.ownerId} = ${ownerId} then ${mediaStorage.chargedBytes} else 0 end), 0)::float8`,
    private: sql<number>`coalesce(sum(case when ${mediaStorage.ownerId} = ${ownerId} then ${mediaStorage.privateBytes} else 0 end), 0)::float8`,
    publicReserved: sql<number>`coalesce(sum(case when ${mediaStorage.ownerId} = ${ownerId} then ${mediaStorage.publicBudgetBytes} else 0 end), 0)::float8`,
    count: sql<number>`count(case when ${mediaStorage.ownerId} = ${ownerId} then 1 end)::int`,
    privateObjects: sql<number>`coalesce(sum(case when ${mediaStorage.kind} = 'image' then 2 else 1 end), 0)::int`,
  }).from(mediaStorage);
  return totals;
}
async function enqueue(tx: Transaction, kind: "media" | "media_deletion" | "cache_purge", key: string, payload: Record<string, unknown>, availableAt = new Date()) {
  // Payloads intentionally have no owner FK. Hard account deletion cannot discard
  // the storage cleanup locator, and ON CONFLICT makes repeated enqueue safe.
  await tx.insert(jobs).values({ kind, idempotencyKey: key, payloadVersion: 1, payload, availableAt, maxAttempts: 20 }).onConflictDoNothing();
  if (availableAt.getTime() <= Date.now()) await tx.execute(sql`select pg_notify('may_be_jobs', '')`);
}
export async function enqueueMediaReconciliation(tx: Transaction, ownerId: string): Promise<void> {
  const [row] = await tx.execute<{ id: string }>(sql`select txid_current()::text as id`);
  await enqueue(tx, "media", `media:reconcile:${ownerId}:${row.id}`, { version: 1, action: "reconcile", ownerId, eventId: row.id });
}
export async function enqueueMediaDeletion(tx: Transaction, row: StorageRow) {
  await enqueue(tx, "media_deletion", `media:delete:${row.assetId}:${row.token}`, { version: 1, assetId: row.assetId, token: row.token });
}
export async function enqueuePublicPurge(tx: Transaction, row: StorageRow, key: string) {
  await enqueue(tx, "cache_purge", `media:purge:${key}`, { version: 1, assetId: row.assetId, token: row.token, key });
}
export async function uploadMedia(ownerId: string, kind: MediaKind, body: ReadableStream<Uint8Array> | null, expectedProfileId?: string) {
  const storage = getMediaStorage();
  // Validate revocation configuration before consuming capacity or bytes.
  getMediaPurge(storage);
  const row = await getDatabase().transaction(async tx => {
    await lockMediaOwner(tx, ownerId);
    await checkMediaEditor(tx, ownerId, expectedProfileId);
    const { settings, quota } = await lockMediaCapacity(tx, ownerId), usage = await mediaUsage(tx, ownerId);
    if (settings.uploadsPaused) throw new MediaError(503, "MEDIA_UPLOADS_PAUSED", "Media uploads are paused.");
    if (usage.privateObjects + privateObjectSlots(kind) > MAX_PRIVATE_MEDIA_OBJECTS) throw new MediaError(507, "MEDIA_OBJECT_CAPACITY", "The service media inventory is full. Remove unused assets or try again after cleanup finishes.");
    const charge = reservationBytes(kind);
    if (usage.owner + charge > quota.mediaLimitBytes || usage.total + charge > settings.totalMediaLimitBytes || usage.count >= MAX_ASSETS) throw capacity();
    const assetId = randomUUID(), token = randomUUID();
    const [ledger] = await tx.insert(mediaStorage).values({ assetId, ownerId, token, kind, chargedBytes: charge,
      publicKey: publicObjectKey(assetId, token, kind), expiresAt: new Date(Date.now() + RESERVATION_MS) }).returning();
    await tx.insert(media).values({ id: assetId, ownerId, kind, objectKey: objectKeys(assetId, token).quarantine });
    // A durable expiry check already exists if the uploader dies at any point.
    await enqueue(tx, "media", `media:expiry:${assetId}`, { version: 1, action: "expire", assetId, token }, ledger.expiresAt);
    return ledger;
  });
  try {
    await withUploadFile(body, kind, async (file, receivedBytes) => getDatabase().transaction(async tx => {
      await lockMediaOwner(tx, ownerId);
      await checkMediaEditor(tx, ownerId, expectedProfileId);
      const [current] = await tx.select().from(mediaStorage).where(eq(mediaStorage.assetId, row.assetId)).for("update");
      if (!current || current.token !== row.token || current.state !== "uploading" || current.expiresAt.getTime() < Date.now()) throw capacity("MEDIA_RESERVATION_EXPIRED");
      // Spooling holds no DB lock. Every storage mutation, including this bounded
      // PUT, holds owner + ledger locks through finalization so cleanup cannot
      // release the charge and then have an uploader recreate an orphan.
      await cleanAssetTemporaries(storage, current);
      await storage.putFile("private", objectKeys(row.assetId, row.token).quarantine, file, receivedBytes, "application/octet-stream");
      await tx.update(mediaStorage).set({ state: "queued", receivedBytes, updatedAt: new Date() }).where(eq(mediaStorage.assetId, row.assetId));
      await enqueue(tx, "media", `media:process:${row.assetId}`, { version: 1, action: "process", assetId: row.assetId, token: row.token });
    }), { assetId: row.assetId, token: row.token });
    return { id: row.assetId, kind, state: "quarantined" };
  } catch (error) {
    await getDatabase().transaction(async tx => {
      await lockMediaOwner(tx, ownerId, true);
      const [current] = await tx.select().from(mediaStorage).where(eq(mediaStorage.assetId, row.assetId)).for("update");
      if (current) {
        await tx.update(mediaStorage).set({ state: "deleting" }).where(eq(mediaStorage.assetId, row.assetId));
        await enqueueMediaDeletion(tx, current);
      }
    }).catch(() => {}); // Durable expiry + sweep recover if the database is down.
    throw error;
  }
}
export async function assertOwnedReadyMedia(tx: Transaction, ownerId: string, assetIds: string[]): Promise<void> {
  const selected = ids(assetIds);
  if (!selected.length) return;
  await lockMediaOwner(tx, ownerId);
  const rows = await tx.select({ id: media.id }).from(media).innerJoin(mediaStorage, eq(mediaStorage.assetId, media.id))
    .where(and(eq(media.ownerId, ownerId), eq(mediaStorage.ownerId, ownerId), inArray(media.id, selected), eq(media.state, "ready"), eq(mediaStorage.state, "ready"), isNull(media.deletedAt)))
    .orderBy(media.id).for("update");
  if (rows.length !== selected.length) throw new MediaError(422, "MEDIA_NOT_READY", "Use only your ready media assets.");
}
function descriptor(object: MediaObject, url: string): PublicMedia {
  return { url, contentType: object.contentType, ...(object.width ? { width: object.width } : {}), ...(object.height ? { height: object.height } : {}), ...(object.durationMs ? { durationMs: object.durationMs } : {}) };
}
export async function publishOwnedMedia(tx: Transaction, ownerId: string, assetIds: string[], signal?: AbortSignal): Promise<PublicMediaMap> {
  signal?.throwIfAborted();
  const selected = ids(assetIds);
  await assertOwnedReadyMedia(tx, ownerId, selected);
  if (!selected.length) return {};
  const storage = getMediaStorage(); getMediaPurge(storage);
  const rows = await tx.select().from(mediaStorage).where(and(eq(mediaStorage.ownerId, ownerId), inArray(mediaStorage.assetId, selected))).orderBy(mediaStorage.assetId).for("update");
  const result: PublicMediaMap = {};
  // Maximum three profile fields; bound storage time held in the caller's tx.
  if (rows.length > 3) throw invalidMedia();
  for (const row of rows) {
    signal?.throwIfAborted();
    if (row.revokingKey) throw new MediaError(503, "MEDIA_REVOCATION_PENDING", "Media cleanup is in progress. Try publishing again shortly.");
    if (!row.display || row.publicBudgetBytes < row.display.bytes) throw invalidMedia();
    await cleanAssetTemporaries(storage, row);
    const body = await storage.get("private", row.display.key, row.display.bytes);
    signal?.throwIfAborted();
    if (body.length !== row.display.bytes) throw storageFailure();
    await storage.put("public", row.publicKey, body, row.display.contentType);
    signal?.throwIfAborted();
    result[row.assetId] = descriptor(row.display, storage.publicUrl(row.publicKey));
  }
  // No second pool transaction here. Precommitted random keys and capacity slots
  // permit retries, and the sweep removes provisional copies after tx rollback.
  await enqueueMediaReconciliation(tx, ownerId);
  return result;
}
export function activePublication(assetId: typeof mediaStorage.assetId) {
  // Drizzle removes Column qualifiers in single-table SELECT projections,
  // including nested SQL fragments. Use explicit identifiers in this correlated
  // subquery so it works both as a selected boolean and a WHERE predicate.
  const outerId = sql`${mediaStorage}.${sql.identifier(assetId.name)}`;
  return sql<boolean>`exists (select 1 from "revision_media" as rm
    join "profiles" as p on p.id = rm.profile_id and p.current_revision_id = rm.revision_id
    join "user" as u on u.id = p.owner_id
    join "media" as m on m.id = rm.media_id and m.owner_id = p.owner_id
    where rm.media_id = ${outerId} and p.suspended_at is null and p.deleted_at is null
      and m.state = 'ready' and m.deleted_at is null
      and u.suspended_at is null and u.deleted_at is null and u.email_verified = true)`;
}
export async function getPublicMedia(assetIds: string[]): Promise<PublicMediaMap> {
  const selected = ids(assetIds); if (!selected.length) return {};
  const rows = await getDatabase().select({ ledger: mediaStorage }).from(mediaStorage).innerJoin(media, eq(media.id, mediaStorage.assetId))
    .where(and(inArray(mediaStorage.assetId, selected), eq(mediaStorage.state, "ready"), eq(media.state, "ready"), isNull(media.deletedAt), activePublication(mediaStorage.assetId)));
  if (!rows.length) return {};
  const storage = getMediaStorage(); const result: PublicMediaMap = {};
  for (const { ledger: row } of rows) if (row.display) result[row.assetId] = descriptor(row.display, storage.publicUrl(row.publicKey));
  return result;
}
export async function getPrivateMedia(ownerId: string, assetIds: string[]): Promise<PublicMediaMap> {
  const selected = ids(assetIds); if (!selected.length) return {};
  const rows = await getDatabase().select({ ledger: mediaStorage }).from(mediaStorage).innerJoin(media, eq(media.id, mediaStorage.assetId)).innerJoin(user, eq(user.id, media.ownerId))
    .where(and(eq(media.ownerId, ownerId), eq(mediaStorage.ownerId, ownerId), inArray(media.id, selected), eq(media.state, "ready"), eq(mediaStorage.state, "ready"), isNull(media.deletedAt), isNull(user.deletedAt), isNull(user.suspendedAt), eq(user.emailVerified, true)));
  const result: PublicMediaMap = {};
  for (const { ledger: row } of rows) if (row.display) result[row.assetId] = descriptor(row.display, `/api/media/${row.assetId}/content`);
  return result;
}
export async function retainedMedia(tx: Transaction, assetId: string) {
  const [draft] = await tx.select({ id: draftMedia.mediaId }).from(draftMedia).where(eq(draftMedia.mediaId, assetId)).limit(1);
  const [revision] = await tx.select({ id: revisionMedia.mediaId }).from(revisionMedia).where(eq(revisionMedia.mediaId, assetId)).limit(1);
  return !!(draft || revision);
}
export async function deleteOwnedMedia(ownerId: string, assetId: string, expectedProfileId?: string) {
  const selected = assetIdSchema.safeParse(assetId); if (!selected.success) throw new MediaError(404, "MEDIA_NOT_FOUND", "Media asset not found.");
  await getDatabase().transaction(async tx => {
    await lockMediaOwner(tx, ownerId);
    await checkMediaEditor(tx, ownerId, expectedProfileId);
    const [row] = await tx.select().from(mediaStorage).where(and(eq(mediaStorage.assetId, selected.data), eq(mediaStorage.ownerId, ownerId))).for("update");
    if (!row) throw new MediaError(404, "MEDIA_NOT_FOUND", "Media asset not found.");
    if (await retainedMedia(tx, row.assetId)) throw new MediaError(409, "MEDIA_RETAINED", "This asset is used by your draft or retained revisions.");
    await tx.update(media).set({ state: "deleted", deletedAt: new Date() }).where(and(eq(media.id, row.assetId), eq(media.ownerId, ownerId)));
    await tx.update(mediaStorage).set({ state: "deleting", updatedAt: new Date() }).where(eq(mediaStorage.assetId, row.assetId));
    await enqueueMediaDeletion(tx, row);
  });
}
/** Bound cleaned rejection history independently of the admitted inventory.
 * Called under the owner lock, including by cleanup when the editor is closed. */
export async function pruneMediaFeedback(tx: Transaction, ownerId: string) {
  const obsolete = await tx.select({ id: media.id }).from(media).where(and(eq(media.ownerId, ownerId), eq(media.state, "rejected"),
    sql`not exists (select 1 from ${mediaStorage} where ${mediaStorage.assetId} = ${media.id})`,
    sql`not exists (select 1 from ${draftMedia} where ${draftMedia.mediaId} = ${media.id})`,
    sql`not exists (select 1 from ${revisionMedia} where ${revisionMedia.mediaId} = ${media.id})`))
    .orderBy(desc(media.createdAt), desc(media.id)).offset(MAX_REJECTION_FEEDBACK);
  if (obsolete.length) await tx.delete(media).where(inArray(media.id, obsolete.map(row => row.id)));
}
export async function listOwnedMedia(ownerId: string, expectedProfileId?: string) {
  const result = await getDatabase().transaction(async tx => {
    const [owner] = await tx.select().from(user).where(eq(user.id, ownerId));
    if (!owner || owner.deletedAt || owner.suspendedAt || !owner.emailVerified) throw new MediaError(403, "ACCOUNT_UNAVAILABLE", "An active verified account is required.");
    await checkMediaEditor(tx, ownerId, expectedProfileId, false);
    const [settingsRow] = await tx.select().from(serviceSettings).where(eq(serviceSettings.id, true));
    const [quotaRow] = await tx.select().from(accountQuotas).where(eq(accountQuotas.userId, ownerId));
    const settings = settingsRow ?? { uploadsPaused: false, totalMediaLimitBytes: DEFAULT_TOTAL_MEDIA_LIMIT_BYTES };
    const quota = quotaRow ?? { mediaLimitBytes: DEFAULT_ACCOUNT_MEDIA_LIMIT_BYTES };
    const usage = await mediaUsage(tx, ownerId);
    const fields = { id: media.id, kind: media.kind, state: media.state, contentType: media.contentType, bytes: media.actualBytes,
      width: media.width, height: media.height, durationMs: media.durationMs, createdAt: media.createdAt };
    const usable = await tx.select(fields).from(media).innerJoin(mediaStorage, eq(mediaStorage.assetId, media.id))
      .where(and(eq(media.ownerId, ownerId), ne(media.state, "rejected"), isNull(media.deletedAt))).orderBy(media.createdAt, media.id);
    const feedback = await tx.select(fields).from(media).where(and(eq(media.ownerId, ownerId), eq(media.state, "rejected"), isNull(media.deletedAt)))
      .orderBy(desc(media.createdAt), desc(media.id)).limit(MAX_REJECTION_FEEDBACK + 1);
    const needsPrune = feedback.length > MAX_REJECTION_FEEDBACK;
    const assets = [...usable, ...(needsPrune ? feedback.slice(0, MAX_REJECTION_FEEDBACK) : feedback)];
    return {
      needsPrune,
      response: { assets, usage: { chargedBytes: usage.owner, privateBytes: usage.private, publicReservedBytes: usage.publicReserved },
        quota: { limitBytes: quota.mediaLimitBytes, uploadsPaused: settings.uploadsPaused, globalCapacityAvailable: usage.total < settings.totalMediaLimitBytes && usage.privateObjects < MAX_PRIVATE_MEDIA_OBJECTS } },
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
  if (result.needsPrune) {
    await getDatabase().transaction(async tx => {
      await lockMediaOwner(tx, ownerId, true);
      await pruneMediaFeedback(tx, ownerId);
    });
  }
  return result.response;
}
export async function readPrivateContent(ownerId: string, assetId: string) {
  if (!assetIdSchema.safeParse(assetId).success) throw new MediaError(404, "MEDIA_NOT_FOUND", "Media asset not found.");
  return getDatabase().transaction(async tx => {
    await lockMediaOwner(tx, ownerId);
    const [row] = await tx.select({ ledger: mediaStorage }).from(mediaStorage).innerJoin(media, eq(media.id, mediaStorage.assetId))
      .where(and(eq(mediaStorage.assetId, assetId.toLowerCase()), eq(media.ownerId, ownerId), eq(mediaStorage.ownerId, ownerId), eq(media.state, "ready"), eq(mediaStorage.state, "ready"), isNull(media.deletedAt)));
    if (!row?.ledger.display) throw new MediaError(404, "MEDIA_NOT_FOUND", "Media asset not found.");
    const object = row.ledger.display;
    const body = await getMediaStorage().get("private", object.key, object.bytes);
    if (body.length !== object.bytes) throw storageFailure();
    return { body, object };
  });
}
export async function readLocalPublicContent(key: string) {
  const storage = getMediaStorage();
  if (storage.kind !== "local") throw new MediaError(404, "MEDIA_NOT_FOUND", "Media asset not found.");
  const [row] = await getDatabase().select().from(mediaStorage).where(and(eq(mediaStorage.publicKey, key), eq(mediaStorage.state, "ready"), activePublication(mediaStorage.assetId)));
  if (!row?.display) throw new MediaError(404, "MEDIA_NOT_FOUND", "Media asset not found.");
  const body = await storage.get("public", key, row.display.bytes);
  if (body.length !== row.display.bytes) throw storageFailure();
  return { body, object: row.display };
}
