import "server-only";

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { defaultProfileDocument, getProfileAssetIds, profileDocumentSchema, type ProfileDocument } from "@/domain/profile";
import type { PublicMediaMap } from "@/domain/media";
import type { SessionPrincipal } from "@/server/auth/session";
import { getDatabase } from "@/server/db";
import type { Transaction } from "@/server/db/types";
import { draftMedia, media, profileDrafts, profileRevisions, profiles, revisionMedia, user, usernameClaims } from "@/server/db/schema";
import { AppError } from "@/server/http";
import { assertOwnedReadyMedia, enqueueMediaReconciliation, getPrivateMedia, publishOwnedMedia } from "@/server/media/service";

export const expectedVersionSchema = z.object({ expectedVersion: z.number().int().min(1).max(2147483646) }).strict();
export const saveProfileSchema = expectedVersionSchema.extend({ document: profileDocumentSchema }).strict();
export const unpublishProfileSchema = z.object({}).strict();

/** A tab retains the profile it loaded even if another tab switches accounts.
 * This precondition never grants access: mutations still resolve the owner from
 * the authenticated principal and compare the ID inside the owner/profile lock. */
export function requireEditorIdentity(request: Request): string {
  const parsed = z.string().uuid().safeParse(request.headers.get("x-editor-profile"));
  if (!parsed.success) throw new AppError(400, "EDITOR_IDENTITY_REQUIRED", "Reload the editor before changing this profile. Your input remains in this tab.");
  return parsed.data.toLowerCase();
}
function checkEditorIdentity(profile: LockedProfile, expectedProfileId: string) {
  if (profile.id !== expectedProfileId) throw new AppError(409, "ACCOUNT_CHANGED", "Sign in to the account that opened this editor before retrying. Your input has not been saved to the other account.");
}

export type ProfileEditorState = {
  profileId: string;
  username: string;
  editVersion: number;
  document: ProfileDocument;
  publishedRevisionId: string | null;
  revisions: { id: string; revisionNumber: number; createdAt: string }[];
};

type LockedProfile = { id: string; currentRevisionId: string | null; publicationNumber: number };

// Every operation takes locks in the same order: owner, profile, draft, assets.
// This also serializes account suspension/deletion against a publication commit.
async function lockProfile(tx: Transaction, principal: SessionPrincipal): Promise<LockedProfile> {
  const [owner] = await tx.select({ id: user.id, verified: user.emailVerified, suspendedAt: user.suspendedAt, deletedAt: user.deletedAt })
    .from(user).where(eq(user.id, principal.userId)).for("update");
  if (!owner || owner.suspendedAt || owner.deletedAt || !owner.verified) {
    throw new AppError(403, "ACCOUNT_UNAVAILABLE", "A verified, active account is required.");
  }
  const [profile] = await tx.select({ id: profiles.id, currentRevisionId: profiles.currentRevisionId,
    publicationNumber: profiles.publicationNumber,
    suspendedAt: profiles.suspendedAt, deletedAt: profiles.deletedAt })
    .from(profiles).where(eq(profiles.ownerId, principal.userId)).for("update");
  if (!profile) throw new AppError(404, "PROFILE_NOT_FOUND", "Claim your username before editing a profile.");
  if (profile.suspendedAt || profile.deletedAt) throw new AppError(403, "PROFILE_UNAVAILABLE", "This profile is unavailable for editing.");
  return profile;
}

// Tables without an owner column are independently constrained through profiles.
function ownedProfile(ownerId: string) {
  return sql`exists (select 1 from ${profiles} where ${profiles.id} = ${profileDrafts.profileId} and ${profiles.ownerId} = ${ownerId})`;
}
function ownedRevision(ownerId: string) {
  return sql`exists (select 1 from ${profiles} where ${profiles.id} = ${profileRevisions.profileId} and ${profiles.ownerId} = ${ownerId})`;
}

async function readDraft(tx: Transaction, ownerId: string, profileId: string) {
  const [draft] = await tx.select({ editVersion: profileDrafts.editVersion, document: profileDrafts.document })
    .from(profileDrafts).where(and(eq(profileDrafts.profileId, profileId), ownedProfile(ownerId))).for("update");
  if (draft) return draft;
  // The owner/profile lock makes lazy creation safe for pre-editor accounts.
  const [initialized] = await tx.insert(profileDrafts).select(tx.select({
    profileId: profiles.id,
    editVersion: sql<number>`1`.as("edit_version"),
    schemaVersion: sql<number>`1`.as("schema_version"),
    document: sql<unknown>`${JSON.stringify(defaultProfileDocument)}::jsonb`.as("document"),
    updatedAt: sql<Date>`statement_timestamp()`.as("updated_at"),
  }).from(profiles).where(and(eq(profiles.id, profileId), eq(profiles.ownerId, ownerId))))
    .returning({ editVersion: profileDrafts.editVersion, document: profileDrafts.document });
  if (!initialized) throw new AppError(404, "PROFILE_NOT_FOUND", "This profile was not found.");
  return initialized;
}

function parseDocument(value: unknown): ProfileDocument {
  const parsed = profileDocumentSchema.safeParse(value);
  if (!parsed.success) throw new AppError(422, "INVALID_PROFILE", "The profile document is invalid. Check the profile fields and link destinations.");
  return parsed.data;
}
function checkVersion(actual: number, expected: number) {
  if (actual !== expected) throw new AppError(409, "EDIT_VERSION_CONFLICT",
    `This profile changed in another tab (current editVersion ${actual}). Reload GET /api/profile and reconcile your changes before retrying.`);
  if (actual >= 2147483647) throw new AppError(409, "EDIT_VERSION_EXHAUSTED", "This profile needs maintenance before another edit can be saved.");
}

async function state(tx: Transaction, ownerId: string, profile: LockedProfile): Promise<ProfileEditorState> {
  const draft = await readDraft(tx, ownerId, profile.id);
  const [claim] = await tx.select({ username: usernameClaims.username }).from(usernameClaims)
    .where(and(eq(usernameClaims.ownerId, ownerId), isNull(usernameClaims.retiredAt))).limit(1);
  if (!claim) throw new AppError(404, "USERNAME_NOT_FOUND", "Claim your username before editing a profile.");
  const revisions = await tx.select({ id: profileRevisions.id, revisionNumber: profileRevisions.revisionNumber, createdAt: profileRevisions.createdAt })
    .from(profileRevisions).where(and(eq(profileRevisions.profileId, profile.id), ownedRevision(ownerId)))
    .orderBy(desc(profileRevisions.revisionNumber)).limit(5);
  return { profileId: profile.id, username: claim.username, editVersion: draft.editVersion,
    document: parseDocument(draft.document), publishedRevisionId: profile.currentRevisionId,
    revisions: revisions.map((revision) => ({ ...revision, createdAt: revision.createdAt.toISOString() })) };
}

async function validateAssets(tx: Transaction, ownerId: string, document: ProfileDocument) {
  const ids = getProfileAssetIds(document);
  await assertOwnedReadyMedia(tx, ownerId, ids);
  if (!ids.length) return ids;
  const assets = await tx.select({ id: media.id, kind: media.kind }).from(media)
    .where(and(eq(media.ownerId, ownerId), inArray(media.id, ids), eq(media.state, "ready"), isNull(media.deletedAt))).for("update");
  const kinds = new Map(assets.map((asset) => [asset.id, asset.kind]));
  for (const id of [document.avatarAssetId, document.backgroundAssetId]) {
    if (id && kinds.get(id.toLowerCase()) !== "image") throw new AppError(422, "INVALID_PROFILE_MEDIA", "Avatar and background must use your ready image assets.");
  }
  if (document.music && kinds.get(document.music.assetId.toLowerCase()) !== "audio") {
    throw new AppError(422, "INVALID_PROFILE_MEDIA", "Choose a track marked ready in your media library.");
  }
  return ids;
}

async function replaceDraft(tx: Transaction, ownerId: string, profileId: string, version: number, document: ProfileDocument, ids: string[]) {
  const changed = await tx.update(profileDrafts).set({ editVersion: version + 1, document, schemaVersion: 1, updatedAt: new Date() })
    .where(and(eq(profileDrafts.profileId, profileId), eq(profileDrafts.editVersion, version), ownedProfile(ownerId)))
    .returning({ id: profileDrafts.profileId });
  if (!changed.length) throw new AppError(409, "EDIT_VERSION_CONFLICT", "Reload GET /api/profile and reconcile your changes before retrying.");
  await tx.delete(draftMedia).where(and(eq(draftMedia.profileId, profileId), eq(draftMedia.ownerId, ownerId)));
  if (ids.length) await tx.insert(draftMedia).values(ids.map((mediaId) => ({ profileId, ownerId, mediaId })));
}

export async function getProfileEditor(principal: SessionPrincipal): Promise<ProfileEditorState> {
  return getDatabase().transaction(async (tx) => state(tx, principal.userId, await lockProfile(tx, principal)));
}

export async function saveProfile(principal: SessionPrincipal, input: z.infer<typeof saveProfileSchema>, expectedProfileId: string): Promise<ProfileEditorState> {
  const parsed = saveProfileSchema.safeParse(input);
  if (!parsed.success) throw new AppError(422, "INVALID_PROFILE", "Supply expectedVersion and a valid complete profile document.");
  return getDatabase().transaction(async (tx) => {
    const profile = await lockProfile(tx, principal);
    checkEditorIdentity(profile, expectedProfileId);
    const draft = await readDraft(tx, principal.userId, profile.id);
    checkVersion(draft.editVersion, parsed.data.expectedVersion);
    const ids = await validateAssets(tx, principal.userId, parsed.data.document);
    await replaceDraft(tx, principal.userId, profile.id, draft.editVersion, parsed.data.document, ids);
    await enqueueMediaReconciliation(tx, principal.userId);
    return state(tx, principal.userId, profile);
  });
}

async function publish(principal: SessionPrincipal, expectedVersion: number, expectedProfileId: string, restoreId?: string): Promise<ProfileEditorState> {
  const input = expectedVersionSchema.safeParse({ expectedVersion });
  if (!input.success) throw new AppError(422, "INVALID_VERSION", "Supply a positive expectedVersion from GET /api/profile.");
  if (restoreId !== undefined && !z.string().uuid().safeParse(restoreId).success) throw new AppError(404, "REVISION_NOT_FOUND", "This retained revision was not found.");
  let preparedMedia = false;
  try {
    return await getDatabase().transaction(async (tx) => {
      const profile = await lockProfile(tx, principal);
      checkEditorIdentity(profile, expectedProfileId);
      const draft = await readDraft(tx, principal.userId, profile.id);
      checkVersion(draft.editVersion, expectedVersion);
      const revisionNumber = profile.publicationNumber + 1;
      if (revisionNumber > 2147483647) throw new AppError(409, "REVISION_NUMBER_EXHAUSTED", "This profile needs maintenance before publishing.");
      let value = draft.document;
      if (restoreId) {
        const [revision] = await tx.select({ document: profileRevisions.document }).from(profileRevisions)
          .where(and(eq(profileRevisions.id, restoreId), eq(profileRevisions.profileId, profile.id), ownedRevision(principal.userId))).limit(1);
        if (!revision) throw new AppError(404, "REVISION_NOT_FOUND", "This retained revision was not found.");
        value = revision.document;
      }
      const document = parseDocument(value);
      const ids = await validateAssets(tx, principal.userId, document);
      // Set before the call: partial storage promotion can happen before a rejection.
      preparedMedia = ids.length > 0;
      const prepared = await publishOwnedMedia(tx, principal.userId, ids);
      if (ids.some((id) => !prepared[id])) {
        throw new AppError(503, "MEDIA_PROMOTION_FAILED", "Media could not be prepared. The previous published page is unchanged; retry publishing later.");
      }
      // Transaction rollback restores the counter on failure. Removing retained
      // revisions through moderation never lowers the durable high-water mark.
      await tx.update(profiles).set({ publicationNumber: revisionNumber })
        .where(and(eq(profiles.id, profile.id), eq(profiles.ownerId, principal.userId)));
      const [revision] = await tx.insert(profileRevisions).select(tx.select({
        id: sql<string>`gen_random_uuid()`.as("id"),
        profileId: profiles.id,
        revisionNumber: sql<number>`${revisionNumber}::integer`.as("revision_number"),
        schemaVersion: sql<number>`1`.as("schema_version"),
        document: sql<unknown>`${JSON.stringify(document)}::jsonb`.as("document"),
        createdAt: sql<Date>`statement_timestamp()`.as("created_at"),
      }).from(profiles).where(and(eq(profiles.id, profile.id), eq(profiles.ownerId, principal.userId))))
        .returning({ id: profileRevisions.id });
      if (!revision) throw new AppError(404, "PROFILE_NOT_FOUND", "This profile was not found.");
      if (ids.length) await tx.insert(revisionMedia).values(ids.map((mediaId) => ({ revisionId: revision.id, profileId: profile.id, ownerId: principal.userId, mediaId })));
      await replaceDraft(tx, principal.userId, profile.id, draft.editVersion, document, ids);
      await tx.update(profiles).set({ currentRevisionId: revision.id, updatedAt: new Date() })
        .where(and(eq(profiles.id, profile.id), eq(profiles.ownerId, principal.userId)));
      const obsolete = await tx.select({ id: profileRevisions.id }).from(profileRevisions)
        .where(and(eq(profileRevisions.profileId, profile.id), ownedRevision(principal.userId)))
        .orderBy(desc(profileRevisions.revisionNumber)).offset(5);
      if (obsolete.length) await tx.delete(profileRevisions).where(and(eq(profileRevisions.profileId, profile.id), ownedRevision(principal.userId), inArray(profileRevisions.id, obsolete.map((row) => row.id))));
      await enqueueMediaReconciliation(tx, principal.userId);
      return state(tx, principal.userId, { ...profile, currentRevisionId: revision.id });
    });
  } catch (error) {
    if (preparedMedia) {
      // Separate transaction survives rollback. The media adapter must additionally
      // sweep provisional objects if the DB is unavailable here (see feature docs).
      try {
        await getDatabase().transaction(async (tx) => {
          await tx.select({ id: user.id }).from(user).where(eq(user.id, principal.userId)).for("update");
          await enqueueMediaReconciliation(tx, principal.userId);
        });
      } catch { /* preserve the original failure; durable media preparation/sweep owns recovery */ }
    }
    throw error;
  }
}

export async function publishProfile(principal: SessionPrincipal, expectedVersion: number, expectedProfileId: string) {
  return publish(principal, expectedVersion, expectedProfileId);
}
export async function restoreProfileRevision(principal: SessionPrincipal, revisionId: string, expectedVersion: number, expectedProfileId: string) {
  return publish(principal, expectedVersion, expectedProfileId, revisionId);
}
export async function unpublishProfile(principal: SessionPrincipal, expectedProfileId: string): Promise<ProfileEditorState> {
  return getDatabase().transaction(async (tx) => {
    const profile = await lockProfile(tx, principal);
    checkEditorIdentity(profile, expectedProfileId);
    const draft = await readDraft(tx, principal.userId, profile.id);
    checkVersion(draft.editVersion, draft.editVersion);
    // Invalidate in-flight saves/publications even though the document is unchanged.
    await tx.update(profileDrafts).set({ editVersion: draft.editVersion + 1 })
      .where(and(eq(profileDrafts.profileId, profile.id), ownedProfile(principal.userId), eq(profileDrafts.editVersion, draft.editVersion)));
    await tx.update(profiles).set({ currentRevisionId: null, updatedAt: new Date() })
      .where(and(eq(profiles.id, profile.id), eq(profiles.ownerId, principal.userId)));
    await enqueueMediaReconciliation(tx, principal.userId);
    return state(tx, principal.userId, { ...profile, currentRevisionId: null });
  });
}

export async function getProfilePreview(principal: SessionPrincipal): Promise<ProfileEditorState & { media: PublicMediaMap }> {
  const result = await getProfileEditor(principal);
  // This resolver owns a separate DB connection and independently checks owner
  // authorization. Release the profile transaction first to avoid nested pool
  // exhaustion (and lock inversion if the resolver needs its own owner lock).
  const resolved = await getPrivateMedia(principal.userId, getProfileAssetIds(result.document));
  return { ...result, media: resolved };
}
