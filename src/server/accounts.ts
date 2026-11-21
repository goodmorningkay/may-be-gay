import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { isValidUsername } from "@/domain/hosts";
import { defaultProfileDocument } from "@/domain/profile";
import { getDatabase } from "./db";
import { user, usernameClaims, profiles, profileDrafts, session, twoFactor } from "./db/schema";
import { requireUser } from "./auth/session";
import { AppError } from "./http";

export async function claimUsername(input: Request | Headers, username: string) {
  const principal = await requireUser(input);
  if (!isValidUsername(username)) throw new AppError(400, "INVALID_USERNAME", "Choose a valid, available username.");
  try {
    return await getDatabase().transaction(async tx => {
      const [owner] = await tx.select({ id: user.id }).from(user).where(and(eq(user.id, principal.userId), eq(user.emailVerified, true), isNull(user.suspendedAt), isNull(user.deletedAt))).for("update");
      if (!owner) throw new AppError(403, "ACCOUNT_UNAVAILABLE", "Account unavailable.");
      if ((await tx.select().from(usernameClaims).where(eq(usernameClaims.ownerId, owner.id))).length) throw new AppError(409, "USERNAME_FIXED", "Your username is already fixed.");
      await tx.insert(usernameClaims).values({ username, ownerId: owner.id });
      const [profile] = await tx.insert(profiles).values({ ownerId: owner.id }).returning({ id: profiles.id });
      await tx.insert(profileDrafts).values({ profileId: profile.id, document: defaultProfileDocument });
      return { username, profileId: profile.id };
    });
  } catch (error) {
    if ((error as { cause?: { code?: string }; code?: string }).cause?.code === "23505" || (error as { code?: string }).code === "23505") throw new AppError(409, "USERNAME_UNAVAILABLE", "Choose an available username.");
    throw error;
  }
}
export async function listAccountSessions(input: Request | Headers) {
  const p = await requireUser(input);
  const rows = await getDatabase().select({ id: session.id, createdAt: session.createdAt, expiresAt: session.expiresAt }).from(session).where(eq(session.userId, p.userId));
  return rows.map(row => ({ ...row, current: row.id === p.sessionId }));
}
export async function revokeAccountSessions(input: Request | Headers, sessionId?: string) {
  const p = await requireUser(input, { recent: true });
  await getDatabase().delete(session).where(and(eq(session.userId, p.userId), sessionId ? eq(session.id, sessionId) : undefined));
}

/** Only the signed-in owner's display state is passed to the account screens. */
export async function readAccountPresentation(ownerId: string) {
  const [row] = await getDatabase().select({
    username: usernameClaims.username,
    enabled: user.twoFactorEnabled,
    enrollmentId: twoFactor.id,
  }).from(user)
    .leftJoin(usernameClaims, and(eq(usernameClaims.ownerId, user.id), isNull(usernameClaims.retiredAt)))
    .leftJoin(twoFactor, eq(twoFactor.userId, user.id))
    .where(eq(user.id, ownerId));
  const authenticator: "enabled" | "pending" | "off" = row?.enabled ? "enabled" : row?.enrollmentId ? "pending" : "off";
  return { username: row?.username ?? undefined, authenticator };
}
