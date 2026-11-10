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
  const suffix = `.${domain}`;
  if (!name.endsWith(suffix)) return { kind: "invalid" };
  const username = name.slice(0, -suffix.length);
  return isValidUsername(username) ? { kind: "profile", username } : { kind: "invalid" };
}

export function isAllowedPath(host: ResolvedHost, pathname: string): boolean {
  if (host.kind === "invalid") return false;
  if (pathname.startsWith("/_next/static/")) return true;
  if (pathname === "/" || pathname === "/robots.txt") return true;
  if (host.kind === "apex") return pathname === "/examples" || pathname === "/support";
  return host.kind === "app" && pathname === "/api/health";
}
