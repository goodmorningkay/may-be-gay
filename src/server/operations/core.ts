import "server-only";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { RECENT_AUTH_MS, type SessionPrincipal } from "@/server/auth/session";
import { user, session, twoFactor, auditEvents } from "@/server/db/schema";
import { sessionAssurance } from "@/server/db/schema-accounts";
import type { Transaction } from "@/server/db/types";
import { AppError, apiError, apiJson } from "@/server/http";
import { ZodError } from "zod";

export async function operationsLock(tx: Transaction) {
  // Serialize privileged/journal transactions before acquiring owning users.
  // The journal sequence consequently also represents commit order.
  await tx.execute(sql`select pg_advisory_xact_lock(740302, 1)`);
}
export async function lockOwner(tx: Transaction, id: string) {
  const [row] = await tx.select().from(user).where(eq(user.id, id)).for("update");
  return row;
}
export async function assertPrincipal(tx: Transaction, p: SessionPrincipal, admin = false) {
  const [owner] = await tx.select({ id: user.id, role: user.role, twoFactorEnabled: user.twoFactorEnabled })
    .from(user).innerJoin(session, eq(session.userId, user.id))
    .where(and(eq(user.id, p.userId), eq(session.id, p.sessionId), gt(session.expiresAt, new Date()), eq(user.emailVerified, true), isNull(user.suspendedAt), isNull(user.deletedAt)));
  const [proof] = await tx.select().from(sessionAssurance).where(eq(sessionAssurance.sessionId, p.sessionId));
  const cutoff = Date.now() - RECENT_AUTH_MS;
  // Sensitive operations require actual password confirmation in the assurance table.
  if (!owner || !proof?.reauthenticatedAt || proof.reauthenticatedAt.getTime() < cutoff) throw new AppError(403, "REAUTHENTICATION_REQUIRED", "Confirm your password in account security, then try again.");
  if (admin) {
    const [factor] = await tx.select({ id: twoFactor.id }).from(twoFactor).where(and(eq(twoFactor.userId, p.userId), eq(twoFactor.verified, true)));
    if (owner.role !== "admin" || !owner.twoFactorEnabled || !factor || !proof.secondFactorAt || proof.secondFactorAt.getTime() < cutoff) throw new AppError(403, "ADMIN_2FA_REQUIRED", "Complete a recent second-factor challenge in account security.");
  }
}
export async function audit(tx: Transaction, actorId: string | null, action: string, subjectUserId?: string, metadata: Record<string, unknown> = {}, reportId?: string) {
  await tx.insert(auditEvents).values({ actorId, action, subjectUserId, metadata, reportId });
}
export function operationsError(error: unknown) {
  if (error instanceof ZodError) return apiJson({ error: { code: "INVALID_INPUT", message: "Check the submitted fields and pagination limits." } }, 400);
  if (error instanceof AppError && [401, 403].includes(error.status)) return apiJson({ error: { code: error.code, message: error.message }, links: { signIn: "/sign-in", security: "/account/security" } }, error.status);
  return apiError(error);
}
export function pagination(url: URL) {
  const raw = url.searchParams.get("offset") ?? "0";
  const limit = url.searchParams.get("limit") ?? "25";
  if (!/^\d{1,6}$/.test(raw) || !/^\d{1,2}$/.test(limit) || Number(raw) > 10000 || Number(limit) < 1 || Number(limit) > 50) throw new AppError(400, "INVALID_PAGE", "Use a limit from 1 to 50 and an offset up to 10000.");
  return { offset: Number(raw), limit: Number(limit) };
}
