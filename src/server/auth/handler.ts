import "server-only";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { createAccountAuth, createAccountAuthInTransaction } from "./config";
import { requireUser, requireAdmin, type SessionPrincipal } from "./session";
import { assertUnambiguousAuthCookies } from "./cookies";
import { handleFactorRequest } from "./factors";
import { getDatabase } from "../db";
import { user, account, twoFactor } from "../db/schema";
import { sessionAssurance } from "../db/schema-accounts";
import { lockSignupAdmission, consumeInvite, normalizeEmail } from "../invites";
import { AppError, apiError, apiJson, appOrigin, assertAppHost, assertLocalRedirect, assertMutationOrigin, readJson } from "../http";
import { authRequestLimit } from "../rate-limit";

const postPaths = new Set(["/sign-up/email", "/sign-in/email", "/sign-out", "/send-verification-email", "/request-password-reset", "/reset-password", "/change-password", "/two-factor/enable", "/two-factor/disable", "/two-factor/verify-totp", "/two-factor/verify-backup-code", "/two-factor/generate-backup-codes", "/two-factor/get-totp-uri"]);
const privatePaths = new Set(["/change-password", "/two-factor/enable", "/two-factor/disable", "/two-factor/generate-backup-codes", "/two-factor/get-totp-uri"]);
const publicGeneric = new Set(["/sign-up/email", "/send-verification-email", "/request-password-reset"]);
function checkRedirects(input: Record<string, unknown>) {
  for (const [key, value] of Object.entries(input)) if (/callbackurl|redirectto|errorcallbackurl|newusercallbackurl/i.test(key)) assertLocalRedirect(value);
}
export async function handleAuth(request: Request): Promise<Response> {
  try {
    assertAppHost(request.headers);
    assertUnambiguousAuthCookies(request.headers);
    // TLS may terminate at the local reverse proxy. Host/Origin above are the
    // boundary; never let Next's internal request URL select the library origin.
    const incoming = new URL(request.url);
    const url = new URL(incoming.pathname + incoming.search, appOrigin());
    if (url.search.length > 8192) throw new AppError(400, "INVALID_REQUEST", "Invalid request.");
    const path = url.pathname.slice("/api/auth".length);
    const resetCallback = /^\/reset-password\/[A-Za-z0-9_-]{1,128}$/.test(path);
    if (request.method === "POST" ? !postPaths.has(path) : request.method !== "GET" || !(path === "/get-session" || path === "/verify-email" || resetCallback)) throw new AppError(404, "NOT_FOUND", "Not found.");
    if (request.method === "POST") assertMutationOrigin(request);
    else if (request.headers.has("origin") && request.headers.get("origin") !== appOrigin()) throw new AppError(403, "ORIGIN_REJECTED", "Request origin rejected.");
    checkRedirects(Object.fromEntries(url.searchParams));
    // Security controls retain the rendered account. Sign-in challenges have
    // no rendered account/session and continue to use the library challenge.
    let principal: SessionPrincipal | undefined;
    if (request.headers.has("x-account-id")) {
      principal = await requireUser(request, privatePaths.has(path) ? { recent: true } : { allowUnverified: true });
    }
    const body = request.method === "POST" ? await readJson(request, z.record(z.string(), z.unknown()), 16384) : undefined;
    if (body) checkRedirects(body);
    if (body && typeof body.email === "string") { try { body.email = normalizeEmail(body.email); } catch { throw new AppError(400, "AUTH_FAILED", "Unable to complete authentication."); } }
    await authRequestLimit(resetCallback ? "/reset-password/callback" : path, typeof body?.email === "string" ? body.email : undefined);
    if (privatePaths.has(path)) {
      principal ??= await requireUser(request, { recent: true });
      if (path === "/two-factor/disable" && principal.role === "admin") throw new AppError(403, "ADMIN_2FA_REQUIRED", "Administrators must keep two-factor authentication enabled.");
      if (principal.role === "admin" && ["/two-factor/get-totp-uri", "/two-factor/generate-backup-codes"].includes(path)) {
        const [enrollment] = await getDatabase().select({ enabled: user.twoFactorEnabled, verified: twoFactor.verified })
          .from(user).leftJoin(twoFactor, eq(twoFactor.userId, user.id)).where(eq(user.id, principal.userId));
        // Initial password-protected enrollment remains available. Once enrolled,
        // the password alone cannot reveal or replace the existing second factor.
        if (enrollment?.enabled || enrollment?.verified) await requireAdmin(principal);
      }
    }
    // Never accept remembered-device bypasses or backup-code verification without session creation.
    if (body && (body.trustDevice === true || body.disableSession === true || (path === "/two-factor/enable" && body.method && body.method !== "totp"))) throw new AppError(400, "AUTH_FAILED", "Unable to complete authentication.");
    const forwarded = new Headers(request.headers);
    // Better Auth must not derive identity/rate keys/base URLs from spoofed proxy headers.
    for (const name of ["x-forwarded-for", "x-real-ip", "cf-connecting-ip", "forwarded", "x-forwarded-host", "x-forwarded-proto"]) forwarded.delete(name);
    forwarded.delete("content-length");
    const authRequest = (data = body) => new Request(url, { method: request.method, headers: forwarded, ...(data ? { body: JSON.stringify(data) } : {}) });
    let response: Response;
    if (path === "/sign-up/email") {
      const signup = z.object({ email: z.email(), password: z.string().min(12).max(128), name: z.string().trim().min(1).max(100),
        inviteToken: z.string().max(128).optional(), callbackURL: z.string().optional() }).safeParse(body);
      if (!signup.success) throw new AppError(400, "REGISTRATION_UNAVAILABLE", "Unable to create an account with these details.");
      response = await getDatabase().transaction(async tx => {
        const { email, name, password, inviteToken, callbackURL } = signup.data;
        const invite = await lockSignupAdmission(tx, email, inviteToken);
        const admission = { email, created: false };
        const auth = createAccountAuthInTransaction(tx, admission);
        const result = await auth.handler(authRequest({ email, name, password, callbackURL }));
        if (!result.ok || !admission.created) throw new AppError(400, "REGISTRATION_UNAVAILABLE", "Unable to create an account with these details.");
        const [created] = await tx.select({ id: user.id }).from(user).innerJoin(account, and(eq(account.userId, user.id), eq(account.providerId, "credential")))
          .where(and(eq(user.email, email), eq(user.emailVerified, false), isNull(user.deletedAt)));
        if (!created) throw new Error("Signup did not create credential owner");
        if (invite) await consumeInvite(tx, invite.id, created.id);
        // A commit error still rejects this function; no response/cookie escapes before commit.
        return result;
      });
    } else if (path.startsWith("/two-factor/")) response = await handleFactorRequest(path, authRequest());
    else response = await createAccountAuth().handler(authRequest());
    const location = response.headers.get("location");
    if (location) assertLocalRedirect(location);
    if (!response.ok && !location) throw new AppError(response.status === 429 ? 429 : 400, "AUTH_FAILED", "Unable to complete authentication. Check your details or request a new link.");
    const headers = new Headers(response.headers); headers.set("cache-control", "no-store"); headers.set("referrer-policy", "no-referrer");
    if (response.ok && publicGeneric.has(path)) {
      headers.set("content-type", "application/json");
      return new Response(JSON.stringify({ status: true, message: "If eligible, check your email for the next step." }), { status: path === "/sign-up/email" ? 202 : 200, headers });
    }
    // Session/credential bearer tokens stay in HttpOnly cookies, not JSON.
    if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
      const data = await response.json();
      if (data && typeof data === "object") delete data.token;
      if (data?.session) delete data.session.token;
      return new Response(JSON.stringify(data), { status: response.status, headers });
    }
    return new Response(response.body, { status: response.status, headers });
  } catch (error) { return apiError(error); }
}
/** This server-only library endpoint has no public handler. Mirror all HTTP boundary checks explicitly. */
export async function reauthenticate(request: Request): Promise<Response> {
  try {
    const principal = await requireUser(request);
    const body = await readJson(request, z.object({ password: z.string().min(1).max(128) }).strict());
    await authRequestLimit("reauthenticate", principal.email);
    const result = await createAccountAuth().api.verifyPassword({ headers: request.headers, body });
    if (!result.status) throw new AppError(400, "AUTH_FAILED", "Unable to confirm password.");
    await getDatabase().insert(sessionAssurance).values({ sessionId: principal.sessionId, reauthenticatedAt: new Date() }).onConflictDoUpdate({ target: sessionAssurance.sessionId, set: { reauthenticatedAt: new Date() } });
    return apiJson({ status: true });
  } catch (error) { return apiError(error instanceof AppError ? error : new AppError(400, "AUTH_FAILED", "Unable to confirm password.")); }
}
