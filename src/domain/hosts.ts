/** Keep this list in sync with the database's username_reserved_check. */
export const reservedUsernames = new Set([
  "www", "app", "api", "auth", "admin", "media", "cdn", "assets", "mail",
  "support", "abuse", "status", "staging", "localhost", "static", "dev", "test",
  "beta", "www2", "email", "smtp", "imap", "pop", "ftp", "sftp", "ssh", "ns1",
  "ns2", "dns", "webmail", "autoconfig", "autodiscover", "mta-sts", "account",
  "accounts", "login", "logout", "signup", "register", "settings", "help",
  "privacy", "terms", "legal", "security", "billing", "dashboard", "editor", "preview",
]);

export type SiteDomain = "may-be.gay" | "may-be.localhost";
export type ResolvedHost =
  | { kind: "apex" }
  | { kind: "app" }
  | { kind: "media" }
  | { kind: "profile"; username: string }
  | { kind: "invalid" };

export function getSiteDomain(value = process.env.SITE_DOMAIN): SiteDomain {
  const domain = value ?? "may-be.gay";
  if (domain !== "may-be.gay" && domain !== "may-be.localhost") {
    throw new Error("SITE_DOMAIN must be may-be.gay or may-be.localhost.");
  }
  return domain;
}

export function isValidUsername(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(value)
    && !value.startsWith("xn--") && !reservedUsernames.has(value);
}

/** Only Host selects a tenant. Forwarded headers are never an authority here. */
export function resolveHost(host: string | null, domain: SiteDomain): ResolvedHost {
  if (!host || host.length > 260 || /[^a-zA-Z0-9.:-]/.test(host)) return { kind: "invalid" };
  const match = /^([a-zA-Z0-9.-]+)(?::([1-9][0-9]{0,4}))?$/.exec(host);
  if (!match) return { kind: "invalid" };
  const [, rawName, port] = match;
  if (port && (Number(port) > 65535 || (domain === "may-be.gay" && port !== "443"))) {
    return { kind: "invalid" };
  }
  const name = rawName.toLowerCase();
  if (name === domain) return { kind: "apex" };
  if (name === `app.${domain}`) return { kind: "app" };
  if (name === `media.${domain}`) return { kind: "media" };
  const suffix = `.${domain}`;
  if (!name.endsWith(suffix)) return { kind: "invalid" };
  const username = name.slice(0, -suffix.length);
  return isValidUsername(username) ? { kind: "profile", username } : { kind: "invalid" };
}

export function isAllowedPath(host: ResolvedHost, pathname: string): boolean {
  return allowedMethods(host, pathname).length > 0;
}

const readMethods = ["GET", "HEAD"] as const;
const appPages = new Set(["/editor", "/preview", "/account", "/account/security", "/account/analytics", "/admin",
  "/sign-in", "/sign-up", "/verify-email", "/forgot-password", "/reset-password", "/two-factor"]);
const authPosts = new Set(["sign-up/email", "sign-in/email", "sign-out", "send-verification-email", "request-password-reset", "reset-password", "change-password",
  "two-factor/enable", "two-factor/disable", "two-factor/verify-totp", "two-factor/verify-backup-code", "two-factor/generate-backup-codes", "two-factor/get-totp-uri"]);
const uuid = "[0-9a-fA-F-]{36}";

/** Route/method admission is separate from the handlers' ownership and Origin
 * checks. Public APIs have their own exact host; no wildcard API prefix exists. */
export function allowedMethods(host: ResolvedHost, pathname: string): readonly string[] {
  if (host.kind === "invalid") return [];
  if (host.kind === "media") return pathname.startsWith("/media/") ? readMethods : [];
  if (pathname.startsWith("/_next/static/")) return readMethods;
  if (pathname === "/" || pathname === "/robots.txt") return readMethods;
  if (host.kind === "apex") {
    if (["/examples", "/support", "/privacy", "/terms", "/rules"].includes(pathname)) return readMethods;
    return pathname === "/api/reports" ? ["POST"] : [];
  }
  if (host.kind === "profile") return pathname === "/api/metrics" ? ["POST"] : [];
  if (appPages.has(pathname) || pathname === "/api/health" || pathname === "/api/account/analytics") return readMethods;
  if (pathname === "/api/profile") return ["GET", "HEAD", "PUT"];
  if (["/api/profile/publish", "/api/profile/unpublish", "/api/account/username", "/api/account/reauthenticate", "/api/account/export", "/api/account/delete", "/api/account/form-help", "/api/admin/actions"].includes(pathname)
    || new RegExp(`^/api/profile/revisions/${uuid}/restore$`).test(pathname)) return ["POST"];
  if (pathname === "/api/account/session") return ["GET", "HEAD", "DELETE"];
  if (pathname === "/api/media") return ["GET", "HEAD", "POST"];
  if (new RegExp(`^/api/media/${uuid}$`).test(pathname)) return ["DELETE"];
  if (new RegExp(`^/api/media/${uuid}/content$`).test(pathname)) return readMethods;
  if (/^\/api\/admin\/(reports|accounts|invites|settings|audit)$/.test(pathname)) return readMethods;
  if (pathname.startsWith("/api/auth/")) {
    const action = pathname.slice("/api/auth/".length);
    if (authPosts.has(action)) return ["POST"];
    if (["get-session", "verify-email"].includes(action) || /^reset-password\/[A-Za-z0-9_-]{1,512}$/.test(action)) return readMethods;
  }
  return [];
}
