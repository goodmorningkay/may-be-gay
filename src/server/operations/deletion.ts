import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { deleteAccountSchema } from "@/domain/operations";
import { requireUser, type SessionPrincipal } from "@/server/auth/session";
import { getDatabase } from "@/server/db";
import { invites, jobs, profiles, reports, user, verification } from "@/server/db/schema";
import { mediaStorage } from "@/server/db/schema-media";
import { bootstrapInvites } from "@/server/db/schema-accounts";
import { enqueueMediaDeletion } from "@/server/media/service";
import { AppError } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { assertPrincipal, audit, lockOwner, operationsLock } from "./core";
import { journal, markAccountDeleted } from "./recovery";
import { checkAccountIdentity, requireAccountIdentity } from "@/server/account-identity";
export async function deleteAccount(input: Request | { principal: SessionPrincipal; expectedAccountId: string }, raw: unknown, alreadyParsed = false) {
  if (!alreadyParsed) deleteAccountSchema.parse(raw);
  const p = input instanceof Request ? await requireUser(input, { recent: true }) : await requireUser(input.principal, { recent: true });
  const expectedAccountId = input instanceof Request ? requireAccountIdentity(input) : input.expectedAccountId;
  await rateLimit(`operations:delete:${p.userId}`, 3, 3600);
  await getDatabase().transaction(async tx => {
    await operationsLock(tx);
    const owner = await lockOwner(tx, p.userId);
    await assertPrincipal(tx, p);
    checkAccountIdentity(p.userId, expectedAccountId);
    if (owner.role === "admin") throw new AppError(409, "ADMIN_SAFETY_WORKFLOW_REQUIRED", "An administrator must use the operator handover workflow before deleting their account.");
    await markAccountDeleted(tx, p.userId);
    await journal(tx, { action: "delete-account", ownerId: p.userId });
    await audit(tx, p.userId, "account.delete-request", p.userId);
  });
  return { accepted: true, message: "Your account is unavailable and sessions are revoked. Private records and media are queued for removal within 24 hours when workers and storage are healthy. Cleanup and CDN invalidation are still pending; backups expire on their retention schedule." };
}
const accountDeletionPayloadSchema = z.object({ version: z.literal(1), ownerId: z.string().min(1).max(128) }).strict();
/** Dispatcher owns leases/retries. Resolves after records are removed and all
 * storage deletion jobs are durably queued, not after provider/CDN completion. */
export async function processAccountDeletionJob(payload: unknown): Promise<void> {
  const data = accountDeletionPayloadSchema.parse(payload);
  await getDatabase().transaction(async tx => {
    await operationsLock(tx);
    const owner = await lockOwner(tx, data.ownerId);
    if (owner && !owner.deletedAt) throw new Error("ACCOUNT_DELETION_NOT_REQUESTED");
    // Delete live pointer before cascading immutable history/reference deletion.
    await tx.update(profiles).set({ currentRevisionId: null }).where(eq(profiles.ownerId, data.ownerId));
    await tx.delete(profiles).where(eq(profiles.ownerId, data.ownerId));
    const assets = await tx.select().from(mediaStorage).where(eq(mediaStorage.ownerId, data.ownerId)).orderBy(mediaStorage.assetId).limit(1001).for("update");
    if (assets.length > 1000) throw new Error("ACCOUNT_MEDIA_BOUND_EXCEEDED");
    for (const row of assets) {
      await tx.update(mediaStorage).set({ state: "deleting", updatedAt: new Date() }).where(eq(mediaStorage.assetId, row.assetId));
      await enqueueMediaDeletion(tx, row);
    }
    if (owner) {
      // Cancel obsolete private mail/processing jobs. Preserve reconciliation,
      // deletion and cache-purge jobs, which may outlive this owner.
      await tx.update(jobs).set({ payload: {}, state: "succeeded", finishedAt: new Date(), lockedAt: null, lockedBy: null, lastErrorCode: null, updatedAt: new Date() })
        .where(and(eq(jobs.kind, "email"), sql`(${jobs.ownerId} = ${owner.id} OR ${jobs.payload}->>'to' = ${owner.email})`));
      // Better Auth recovery values encode the owner; removing the credential
      // rows and these verification records prevents resurrection by old links.
      await tx.delete(verification).where(sql`${verification.identifier} = ${owner.email} OR ${verification.identifier} = ${owner.id} OR ${verification.value} = ${owner.id}`);
      await tx.update(reports).set({ reporterEmail: null }).where(sql`lower(btrim(${reports.reporterEmail})) = ${owner.email}`);
      await tx.delete(bootstrapInvites).where(sql`${bootstrapInvites.tokenHash} in (select ${invites.tokenHash} from ${invites} where ${invites.email} = ${owner.email})`);
      await tx.delete(invites).where(eq(invites.email, owner.email));
      // Tombstone trigger retires username instead of freeing it. Auth records,
      // sessions, assurance and quota rows cascade; the storage ledger does not.
      await tx.delete(user).where(eq(user.id, owner.id));
    }
  });
}
