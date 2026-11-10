import "server-only";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { profileDocumentSchema, getProfileAssetIds } from "@/domain/profile";
import { withoutAsset } from "@/domain/operations";
import { getDatabase } from "@/server/db";
import type { Transaction } from "@/server/db/types";
import { draftMedia, jobs, media, profileDrafts, profileRevisions, profiles, revisionMedia, session, user } from "@/server/db/schema";
import { mediaStorage } from "@/server/db/schema-media";
import { recoveryEvents, recoveryReplay } from "@/server/db/schema-operations";
import { enqueueMediaDeletion, enqueueMediaReconciliation } from "@/server/media/service";
import { AppError } from "@/server/http";
import { lockOwner, operationsLock } from "./core";

const ownerId = z.string().min(1).max(128);
export const recoveryPayloadSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("delete-account"), ownerId }).strict(),
  z.object({ action: z.literal("account-suspension"), ownerId, suspended: z.boolean() }).strict(),
  z.object({ action: z.literal("profile-suspension"), ownerId, profileId: z.uuid(), suspended: z.boolean() }).strict(),
  z.object({ action: z.literal("remove-media"), ownerId, assetId: z.uuid() }).strict(),
]);
export type RecoveryPayload = z.infer<typeof recoveryPayloadSchema>;
export async function journal(tx: Transaction, payload: RecoveryPayload) {
  await tx.insert(recoveryEvents).values({ payload: recoveryPayloadSchema.parse(payload) });
}
export async function queueAccountDeletion(tx: Transaction, ownerId: string) {
  // No owner FK: this job must survive the hard deletion it performs.
  await tx.insert(jobs).values({ kind: "account_deletion", idempotencyKey: `operations:delete:${ownerId}`, maxAttempts: 20,
    payload: { version: 1, ownerId } }).onConflictDoNothing();
}
export async function markAccountDeleted(tx: Transaction, ownerId: string) {
  await tx.update(user).set({ deletedAt: sql`coalesce(${user.deletedAt}, now())`, updatedAt: new Date() }).where(eq(user.id, ownerId));
  await tx.delete(session).where(eq(session.userId, ownerId));
  await tx.update(profiles).set({ currentRevisionId: null, deletedAt: sql`coalesce(${profiles.deletedAt}, now())`, updatedAt: new Date() }).where(eq(profiles.ownerId, ownerId));
  await queueAccountDeletion(tx, ownerId);
  await enqueueMediaReconciliation(tx, ownerId);
}
export async function setSuspension(tx: Transaction, ownerId: string, scope: "account" | "profile", suspended: boolean, profileId?: string) {
  if (scope === "account") {
    await tx.update(user).set({ suspendedAt: suspended ? new Date() : null, updatedAt: new Date() }).where(and(eq(user.id, ownerId), sql`${user.deletedAt} is null`));
  } else {
    await tx.update(profiles).set({ suspendedAt: suspended ? new Date() : null, updatedAt: new Date() }).where(and(eq(profiles.ownerId, ownerId), profileId ? eq(profiles.id, profileId) : undefined, sql`${profiles.deletedAt} is null`));
  }
  // Reinstate leaves the page unpublished. Owners must deliberately republish.
  await tx.update(profiles).set({ currentRevisionId: null, updatedAt: new Date() }).where(eq(profiles.ownerId, ownerId));
  await tx.delete(session).where(eq(session.userId, ownerId));
  await enqueueMediaReconciliation(tx, ownerId);
}
/** Caller holds owning user, then profile; no immutable document is updated. */
export async function detachAndRemoveMedia(tx: Transaction, ownerId: string, assetId: string) {
  const [profile] = await tx.select().from(profiles).where(eq(profiles.ownerId, ownerId)).for("update");
  if (profile) {
    const [draft] = await tx.select().from(profileDrafts).where(eq(profileDrafts.profileId, profile.id)).for("update");
    // Read documents as well as references, so malformed/missing reference rows
    // cannot preserve a forbidden asset through a retained restore.
    const revisions = await tx.select().from(profileRevisions).where(eq(profileRevisions.profileId, profile.id)).orderBy(profileRevisions.id);
    const affected = revisions.filter(r => {
      const parsed = profileDocumentSchema.safeParse(r.document);
      return !parsed.success || getProfileAssetIds(parsed.data).some(id => id.toLowerCase() === assetId.toLowerCase());
    }).map(r => r.id);
    if (profile.currentRevisionId && affected.includes(profile.currentRevisionId)) await tx.update(profiles).set({ currentRevisionId: null, updatedAt: new Date() }).where(eq(profiles.id, profile.id));
    if (affected.length) await tx.delete(profileRevisions).where(and(eq(profileRevisions.profileId, profile.id), inArray(profileRevisions.id, affected)));
    if (draft) {
      const parsed = profileDocumentSchema.safeParse(draft.document);
      if (!parsed.success) throw new AppError(409, "DRAFT_REPAIR_REQUIRED", "Repair the invalid private draft before removing this asset.");
      if (draft.editVersion >= 2147483647) throw new AppError(409, "EDIT_VERSION_EXHAUSTED", "Draft maintenance is required.");
      await tx.update(profileDrafts).set({ document: withoutAsset(parsed.data, assetId), editVersion: draft.editVersion + 1, updatedAt: new Date() }).where(eq(profileDrafts.profileId, profile.id));
    }
    await tx.delete(draftMedia).where(and(eq(draftMedia.profileId, profile.id), eq(draftMedia.mediaId, assetId)));
    // A stale reference must not keep the deletion worker permanently blocked.
    await tx.delete(revisionMedia).where(and(eq(revisionMedia.ownerId, ownerId), eq(revisionMedia.mediaId, assetId)));
  }
  const [ledger] = await tx.select().from(mediaStorage).where(and(eq(mediaStorage.ownerId, ownerId), eq(mediaStorage.assetId, assetId))).for("update");
  await tx.update(media).set({ state: "deleted", deletedAt: new Date() }).where(and(eq(media.id, assetId), eq(media.ownerId, ownerId)));
  if (ledger) {
    await tx.update(mediaStorage).set({ state: "deleting", updatedAt: new Date() }).where(eq(mediaStorage.assetId, assetId));
    await enqueueMediaDeletion(tx, ledger);
  }
  await enqueueMediaReconciliation(tx, ownerId);
}
export const recoveryRecordSchema = z.object({ sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), version: z.literal(1), payload: recoveryPayloadSchema, createdAt: z.iso.datetime() }).strict();
/** Operator-only server API. Never expose this journal over public/admin HTTP. */
export async function readRecoveryEvents(afterSequence = 0, limit = 100) {
  z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(afterSequence);
  z.number().int().min(1).max(500).parse(limit);
  const rows = await getDatabase().select().from(recoveryEvents).where(gt(recoveryEvents.sequence, afterSequence)).orderBy(asc(recoveryEvents.sequence)).limit(limit);
  return rows.map(row => recoveryRecordSchema.parse({ ...row, createdAt: row.createdAt.toISOString() }));
}
export async function replayRecoveryEvents(input: unknown) {
  const records = z.array(recoveryRecordSchema).max(500).parse(input);
  for (let i = 1; i < records.length; i++) if (records[i].sequence <= records[i - 1].sequence) throw new Error("RECOVERY_ORDER_INVALID");
  return getDatabase().transaction(async tx => {
    await operationsLock(tx);
    await tx.insert(recoveryReplay).values({ id: true }).onConflictDoNothing();
    const [checkpoint] = await tx.select().from(recoveryReplay).where(eq(recoveryReplay.id, true)).for("update");
    let lastSequence = checkpoint.lastSequence;
    for (const event of records) {
      if (event.sequence <= lastSequence) continue;
      const [existing] = await tx.select().from(recoveryEvents).where(eq(recoveryEvents.sequence, event.sequence));
      const canonical = (value: RecoveryPayload) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
      if (existing && canonical(recoveryPayloadSchema.parse(existing.payload)) !== canonical(event.payload)) throw new Error("RECOVERY_HISTORY_CONFLICT");
      await tx.insert(recoveryEvents).values({ sequence: event.sequence, version: 1, payload: event.payload, createdAt: new Date(event.createdAt) }).onConflictDoNothing();
      const p = event.payload, owner = await lockOwner(tx, p.ownerId);
      if (p.action === "delete-account") await markAccountDeleted(tx, p.ownerId);
      else if (p.action === "remove-media") await detachAndRemoveMedia(tx, p.ownerId, p.assetId);
      else if (owner && !owner.deletedAt) await setSuspension(tx, p.ownerId, p.action === "account-suspension" ? "account" : "profile", p.suspended, p.action === "profile-suspension" ? p.profileId : undefined);
      // Missing owners are never recreated. Cleanup still uses the durable ledger.
      lastSequence = event.sequence;
    }
    await tx.update(recoveryReplay).set({ lastSequence, updatedAt: new Date() }).where(eq(recoveryReplay.id, true));
    // Imported events must not be reused by the next local append after restore.
    // Sequences are nontransactional; advancing on a later rollback only leaves
    // a harmless gap. Never lower the existing allocator.
    if (lastSequence) await tx.execute(sql`select setval(pg_get_serial_sequence('recovery_events','sequence'), greatest(${lastSequence}, (select last_value from recovery_events_sequence_seq)), true)`);
    return { lastSequence };
  });
}
