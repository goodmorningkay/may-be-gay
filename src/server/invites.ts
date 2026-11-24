import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { defaultRegistrationMode } from "@/domain/registration";
import { getDatabase } from "./db";
import type { Transaction } from "./db/types";
import { invites, user } from "./db/schema";
import { serviceSettings } from "./db/schema-settings";
import { bootstrapInvites } from "./db/schema-accounts";
import { AppError, appOrigin } from "./http";
import { enqueueMail } from "./mail";

export const normalizeEmail = (email: string) => z.email().max(254).parse(email.trim().toLowerCase());
export const hashInviteToken = (token: string) => createHash("sha256").update(token).digest("hex");
const unavailable = () => new AppError(400, "REGISTRATION_UNAVAILABLE", "Unable to create an account with these details.");
/** Server-only administrative service: caller must requireAdmin, or be the private operator CLI. */
export async function issueInvite(input: { email: string; createdBy?: string; expiresInHours?: number; sendEmail?: boolean; bootstrap?: boolean }) {
  const email = normalizeEmail(input.email);
  const hours = input.expiresInHours ?? 72;
  if (!Number.isFinite(hours) || hours < 1 || hours > 168) throw new AppError(400, "INVALID_EXPIRY", "Use an expiry between one hour and seven days.");
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashInviteToken(token);
  return getDatabase().transaction(async tx => {
    const [invite] = await tx.insert(invites).values({ email, tokenHash, createdBy: input.createdBy, expiresAt: new Date(Date.now() + hours * 3600000) }).returning({ id: invites.id, email: invites.email, expiresAt: invites.expiresAt });
    if (input.bootstrap) await tx.insert(bootstrapInvites).values({ tokenHash });
    if (input.sendEmail) await enqueueMail({ template: "invite", to: email, url: `${appOrigin()}/sign-up#invite=${token}` }, undefined, tx);
    return { ...invite, token }; // Returned once; never available from list.
  });
}
export async function listInvites(limit = 100) {
  return getDatabase().select({ id: invites.id, email: invites.email, expiresAt: invites.expiresAt, revokedAt: invites.revokedAt, redeemedAt: invites.redeemedAt, createdAt: invites.createdAt }).from(invites).orderBy(sql`${invites.createdAt} DESC`).limit(Math.min(Math.max(limit, 1), 100));
}
export async function revokeInvite(id: string) {
  if (!z.uuid().safeParse(id).success) throw new AppError(400, "INVALID_INVITE", "Invalid invitation.");
  // Conditional update serializes with the signup row lock.
  await getDatabase().update(invites).set({ revokedAt: new Date() }).where(and(eq(invites.id, id), isNull(invites.redeemedAt), isNull(invites.revokedAt)));
}
export async function readRegistrationMode() {
  const [settings] = await getDatabase().select({ mode: serviceSettings.registrationMode }).from(serviceSettings).where(eq(serviceSettings.id, true));
  return settings?.mode ?? defaultRegistrationMode;
}

/** Hold the settings lock through account creation and any invite redemption. */
export async function lockSignupAdmission(tx: Transaction, email: string, inviteToken?: string) {
  await tx.insert(serviceSettings).values({ id: true }).onConflictDoNothing();
  const [settings] = await tx.select().from(serviceSettings).where(eq(serviceSettings.id, true)).for("update");
  if (settings.registrationMode === "closed") throw unavailable();

  if (settings.accountLimit !== null) {
    const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(user);
    if (count.n >= settings.accountLimit) throw unavailable();
  }
  if (settings.registrationMode === "public" && inviteToken === undefined) return;
  if (!inviteToken || !/^[a-zA-Z0-9_-]{43}$/.test(inviteToken)) throw unavailable();
  const [invite] = await tx.select({ id: invites.id }).from(invites).where(and(eq(invites.tokenHash, hashInviteToken(inviteToken)), eq(invites.email, email), isNull(invites.revokedAt), isNull(invites.redeemedAt), gt(invites.expiresAt, new Date()))).for("update");
  if (!invite) throw unavailable();
  return invite;
}
export async function consumeInvite(tx: Transaction, inviteId: string, userId: string) {
  const [redeemed] = await tx.update(invites).set({ redeemedAt: new Date(), redeemedBy: userId }).where(and(eq(invites.id, inviteId), isNull(invites.redeemedAt), isNull(invites.revokedAt), gt(invites.expiresAt, new Date()))).returning({ tokenHash: invites.tokenHash });
  if (!redeemed) throw unavailable();
  const [bootstrap] = await tx.update(bootstrapInvites).set({ designatedUserId: userId }).where(and(eq(bootstrapInvites.tokenHash, redeemed.tokenHash), isNull(bootstrapInvites.designatedUserId))).returning();
  if (bootstrap) await tx.update(user).set({ role: "admin" }).where(eq(user.id, userId));
}
