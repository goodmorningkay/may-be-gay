import "server-only";
import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { createAccountAuthInTransaction } from "./config";
import { getDatabase } from "../db";
import { session, twoFactor, user } from "../db/schema";
import { sessionAssurance } from "../db/schema-accounts";
import { AppError } from "../http";

const proofPaths = new Set(["/two-factor/verify-totp", "/two-factor/verify-backup-code"]);
const attemptRejections = new Set(["INVALID_CODE", "INVALID_BACKUP_CODE", "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE", "ACCOUNT_TEMPORARILY_LOCKED"]);
function cookieHeaders(original: Headers, response: Response) {
  const headers = new Headers(original);
  const cookies = new Map((headers.get("cookie") ?? "").split(";").filter(Boolean).map(v => { const i = v.indexOf("="); return [v.slice(0, i).trim(), v.slice(i + 1)] as const; }));
  for (const cookie of response.headers.getSetCookie()) { const part = cookie.split(";", 1)[0]; const i = part.indexOf("="); cookies.set(part.slice(0, i), part.slice(i + 1)); }
  headers.set("cookie", [...cookies].map(([k, v]) => `${k}=${v}`).join("; "));
  return headers;
}

/** Called only after the HTTP facade's identity, cookie, origin and rate checks. */
export async function handleFactorRequest(path: string, request: Request): Promise<Response> {
  return getDatabase().transaction(async tx => {
    // Both direct plugin adapter calls and internalAdapter hooks must use this
    // connection. Merely enabling adapter transactions does not wrap endpoints.
    const auth = createAccountAuthInTransaction(tx);
    const response = await auth.handler(request);
    if (!response.ok) {
      const error = z.object({ code: z.string() }).safeParse(await response.clone().json());
      if (proofPaths.has(path) && response.status >= 400 && response.status < 500 && error.success && attemptRejections.has(error.data.code)) {
        // Expected verification failures consumed/rearmed the challenge and
        // incremented account lockout counters. Commit that abuse accounting.
        return response;
      }
      // INVALID_TWO_FACTOR_COOKIE can also follow a correct proof, after code
      // consumption/reset, when final challenge consumption fails. Roll it back.
      throw new AppError(response.status === 429 ? 429 : 400, "AUTH_FAILED", "Unable to complete authentication.");
    }
    if (proofPaths.has(path)) {
      const verified = z.object({ user: z.object({ id: z.string().min(1) }) }).safeParse(await response.clone().json());
      // Initial TOTP confirmation returns the old token, but sets a new cookie.
      // Resolve the recipient from merged cookies and compare the proven user.
      const recipient = await auth.api.getSession({ headers: cookieHeaders(request.headers, response), query: { disableCookieCache: true } });
      if (!recipient || !verified.success || verified.data.user.id !== recipient.user.id) throw new AppError(401, "AUTH_FAILED", "Please sign in again.");
      const [live] = await tx.select({ id: session.id }).from(session)
        .innerJoin(user, eq(user.id, session.userId)).innerJoin(twoFactor, eq(twoFactor.userId, user.id))
        .where(and(eq(session.id, recipient.session.id), eq(user.id, verified.data.user.id), gt(session.expiresAt, new Date()), eq(user.emailVerified, true), isNull(user.suspendedAt), isNull(user.deletedAt), eq(user.twoFactorEnabled, true), eq(twoFactor.verified, true)));
      if (!live) throw new AppError(401, "AUTH_FAILED", "Please sign in again.");
      const secondFactorAt = new Date();
      await tx.insert(sessionAssurance).values({ sessionId: live.id, secondFactorAt }).onConflictDoUpdate({ target: sessionAssurance.sessionId, set: { secondFactorAt } });
    }
    // Handler response and replacement cookies remain private until commit;
    // a failed proof/assurance write rolls back factor state and session changes.
    return response;
  });
}
