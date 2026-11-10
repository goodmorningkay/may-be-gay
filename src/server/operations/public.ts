import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { getSiteDomain, resolveHost } from "@/domain/hosts";
import { getProfileAssetIds, profileDocumentSchema } from "@/domain/profile";
import type { Transaction } from "@/server/db/types";
import { profiles, profileRevisions, user, usernameClaims } from "@/server/db/schema";
import { AppError } from "@/server/http";

export function assertPublicRequest(request: Request, kind: "apex" | "profile") {
  const domain = getSiteDomain(), host = request.headers.get("host"), resolved = resolveHost(host, domain);
  // Exact canonical HTTPS Origin is mandatory even if no cookies are involved.
  const expected = resolved.kind === "profile" ? `https://${resolved.username}.${domain}` : `https://${domain}`;
  if (resolved.kind !== kind || request.headers.get("origin") !== expected) throw new AppError(403, "REQUEST_REJECTED", "Unable to accept this request.");
  return resolved;
}
export async function currentPublic(tx: Transaction, username: string) {
  const [identity] = await tx.select({ ownerId: usernameClaims.ownerId }).from(usernameClaims).where(and(eq(usernameClaims.username, username), isNull(usernameClaims.retiredAt)));
  if (!identity?.ownerId) return null;
  // Owner -> profile lock order also serializes metrics/report insertion with
  // suspension/deletion/publication. No network request to submitted destinations.
  const [owner] = await tx.select({ id: user.id }).from(user).where(and(eq(user.id, identity.ownerId), eq(user.emailVerified, true), isNull(user.suspendedAt), isNull(user.deletedAt))).for("share");
  if (!owner) return null;
  const [profile] = await tx.select().from(profiles).where(and(eq(profiles.ownerId, owner.id), isNull(profiles.suspendedAt), isNull(profiles.deletedAt))).for("share");
  if (!profile?.currentRevisionId) return null;
  const [revision] = await tx.select({ document: profileRevisions.document }).from(profileRevisions).where(and(eq(profileRevisions.profileId, profile.id), eq(profileRevisions.id, profile.currentRevisionId)));
  const document = profileDocumentSchema.safeParse(revision?.document);
  return document.success ? { profileId: profile.id, document: document.data, assetIds: getProfileAssetIds(document.data) } : null;
}
