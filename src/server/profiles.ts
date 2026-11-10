import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { getPublicDocument, type ProfileDocument } from "@/domain/profile";
import { isValidUsername } from "@/domain/hosts";
import { getDatabase } from "@/server/db";
import { profiles, profileRevisions, user, usernameClaims } from "@/server/db/schema";

export type PublishedProfile = {
  id: string;
  username: string;
  revisionId: string;
  document: ProfileDocument;
};

/** Public only: no session access, draft joins, wildcard projections, or shared cache. */
export async function getPublishedProfile(username: string): Promise<PublishedProfile | null> {
  if (!isValidUsername(username)) return null;

  // An unconfigured `next dev` serves the landing page and profile 404s. Production
  // and tests fail explicitly; neither a broken DB nor missing config creates demos.
  if (process.env.NODE_ENV === "development" && !process.env.DATABASE_URL) return null;

  const [published] = await getDatabase().select({
    id: profiles.id,
    username: usernameClaims.username,
    revisionId: profileRevisions.id,
    document: profileRevisions.document,
  }).from(usernameClaims)
    .innerJoin(user, eq(usernameClaims.ownerId, user.id))
    .innerJoin(profiles, eq(profiles.ownerId, user.id))
    .innerJoin(profileRevisions, and(
      eq(profileRevisions.id, profiles.currentRevisionId),
      eq(profileRevisions.profileId, profiles.id),
    ))
    .where(and(
      eq(usernameClaims.username, username),
      isNull(usernameClaims.retiredAt),
      isNull(user.suspendedAt),
      eq(user.emailVerified, true),
      isNull(user.deletedAt),
      isNull(profiles.suspendedAt),
      isNull(profiles.deletedAt),
      eq(profileRevisions.schemaVersion, 1),
    )).limit(1);

  if (!published) return null;
  try {
    return { ...published, document: getPublicDocument(published.document) };
  } catch {
    // Malformed/unsupported stored snapshots must never reach a public renderer.
    return null;
  }
}
