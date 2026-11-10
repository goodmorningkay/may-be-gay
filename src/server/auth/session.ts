import "server-only";
import { and, eq, isNull, gt } from "drizzle-orm";
import { createAccountAuth } from "./config";
import { assertUnambiguousAuthCookies } from "./cookies";
import { getDatabase } from "../db";
import { user, session, twoFactor } from "../db/schema";
import { sessionAssurance } from "../db/schema-accounts";
import { AppError, appOrigin, assertAppHost, assertMutationOrigin } from "../http";
import { rateLimit } from "../rate-limit";
import { checkAccountIdentity, requireAccountIdentity } from "../account-identity";

export type SessionPrincipal = { userId: string; sessionId: string; email: string; emailVerified: boolean; role: "user" | "admin"; authenticatedAt: Date };
export const RECENT_AUTH_MS = 10 * 60 * 1000;
async function sessionBoundary<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) {
    // SSR callers rethrow outages to Next's logger. Neither SQL parameters nor
    // library APIError causes may cross this boundary, even as hidden fields.
    if (error instanceof AppError) throw new AppError(error.status, error.code, error.message);
    throw new AppError(503, "AUTH_UNAVAILABLE", "Authentication is temporarily unavailable. Please try again.");
  }
}
export async function getSession(headers: Headers): Promise<SessionPrincipal | null> {
  return sessionBoundary(async () => {
    assertAppHost(headers);
    assertUnambiguousAuthCookies(headers);
    if (headers.has("origin") && headers.get("origin") !== appOrigin()) throw new AppError(403, "ORIGIN_REJECTED", "Request origin rejected.");
    await rateLimit("auth:session-read", 1000, 60);
    // Read-only, fixed-query library API with no redirect parameters. Its explicit
    // host/origin/persistent limit above also covers internal server-page reads.
    const found = await createAccountAuth().api.getSession({ headers, query: { disableCookieCache: true } });
    if (!found) return null;
    const [record] = await getDatabase().select({ userId: user.id, sessionId: session.id, email: user.email, emailVerified: user.emailVerified, role: user.role, createdAt: session.createdAt, reauthenticatedAt: sessionAssurance.reauthenticatedAt })
      .from(session).innerJoin(user, eq(session.userId, user.id)).leftJoin(sessionAssurance, eq(sessionAssurance.sessionId, session.id))
      .where(and(eq(session.id, found.session.id), gt(session.expiresAt, new Date()), isNull(user.suspendedAt), isNull(user.deletedAt)));
    if (!record) return null;
    return { userId: record.userId, sessionId: record.sessionId, email: record.email, emailVerified: record.emailVerified, role: record.role === "admin" ? "admin" : "user", authenticatedAt: record.reauthenticatedAt ?? record.createdAt };
  });
}
export async function requireUser(input: Request | Headers, options: { recent?: boolean; allowUnverified?: boolean } = {}): Promise<SessionPrincipal> {
  return sessionBoundary(async () => {
    const headers = input instanceof Headers ? input : input.headers;
    assertAppHost(headers);
    if (!(input instanceof Headers) && !["GET", "HEAD", "OPTIONS"].includes(input.method)) assertMutationOrigin(input);
    const principal = await getSession(headers);
    if (!principal) throw new AppError(401, "SIGN_IN_REQUIRED", "Please sign in.");
    if (headers.has("x-account-id")) checkAccountIdentity(principal.userId, requireAccountIdentity(headers));
    if (!principal.emailVerified && !options.allowUnverified) throw new AppError(403, "VERIFICATION_REQUIRED", "Verify your email first.");
    if (options.recent && Date.now() - principal.authenticatedAt.getTime() > RECENT_AUTH_MS) throw new AppError(403, "REAUTHENTICATION_REQUIRED", "Confirm your password first.");
    return principal;
  });
}
export async function requireAdmin(input: Request | Headers): Promise<SessionPrincipal> {
  return sessionBoundary(async () => {
    const principal = await requireUser(input, { recent: true });
    const [proof] = await getDatabase().select({ at: sessionAssurance.secondFactorAt }).from(sessionAssurance)
      .innerJoin(twoFactor, eq(twoFactor.userId, principal.userId))
      .innerJoin(user, eq(user.id, twoFactor.userId))
      .where(and(eq(sessionAssurance.sessionId, principal.sessionId), eq(twoFactor.verified, true), eq(user.twoFactorEnabled, true), eq(user.role, "admin"), eq(user.emailVerified, true), isNull(user.suspendedAt), isNull(user.deletedAt)));
    if (principal.role !== "admin" || !proof?.at || Date.now() - proof.at.getTime() > RECENT_AUTH_MS) throw new AppError(403, "ADMIN_2FA_REQUIRED", "Administrator access requires a recent second-factor challenge.");
    return principal;
  });
}
