import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { allowedMethods, getSiteDomain, resolveHost } from "@/domain/hosts";
import { getPublishedProfile } from "@/server/profiles";
import { serviceState } from "@/server/service-state";

export async function proxy(request: NextRequest) {
  const domain = getSiteDomain();
  const host = resolveHost(request.headers.get("host"), domain);
  const nonce = randomBytes(18).toString("base64");
  const development = process.env.NODE_ENV === "development";
  // Public assets use the one configured media origin, never an authored URL.
  const mediaOrigin = `https://media.${domain}`;
  // The homepage's username form redirects from the apex to invite signup.
  const signupTarget = host.kind === "apex" && request.nextUrl.pathname === "/" ? ` https://app.${domain}/sign-up` : "";
  const csp = [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' ${mediaOrigin}`,
    `media-src 'self' ${mediaOrigin}`,
    "font-src 'self'",
    ...(host.kind === "app" ? ["frame-src 'self'"] : []),
    `connect-src 'self'${development ? " ws: wss:" : ""}`,
    "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'", `form-action 'self'${signupTarget}`,
    ...(domain === "may-be.gay" && !development ? ["upgrade-insecure-requests"] : []),
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  for (const header of ["forwarded", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port", "x-forwarded-for", "x-real-ip", "cf-connecting-ip", "x-nonce"]) {
    requestHeaders.delete(header);
  }
  // Anonymous published pages cannot depend on a visitor's editor session.
  if (host.kind !== "app") requestHeaders.delete("cookie");
  requestHeaders.set("content-security-policy", csp);
  requestHeaders.set("x-nonce", nonce);

  let response: NextResponse;
  const methods = allowedMethods(host, request.nextUrl.pathname);
  if (methods.length === 0) {
    response = new NextResponse("Page not found.", { status: 404 });
  } else if (!methods.includes(request.method)) {
    response = new NextResponse("Method not allowed.", { status: 405, headers: { Allow: methods.join(", ") } });
  } else if (!request.nextUrl.pathname.startsWith("/_next/static/") && await serviceState() !== "open") {
    response = new NextResponse("This service is temporarily unavailable.", { status: 503, headers: { "Retry-After": "60" } });
  } else {
    response = NextResponse.next({ request: { headers: requestHeaders } });
    if (host.kind === "profile" && ["/", "/robots.txt"].includes(request.nextUrl.pathname)) {
      // Flight can start streaming before a page's notFound() executes, making
      // an unknown profile look like HTTP 200. Resolve public availability
      // before handing any HTML/RSC request to the renderer. The page still
      // performs its own public-only read; no document is passed in headers.
      try {
        if (!await getPublishedProfile(host.username)) {
          if (request.nextUrl.pathname === "/") {
            const unavailable = request.nextUrl.clone();
            unavailable.pathname = "/profile-unavailable";
            unavailable.search = "";
            response = NextResponse.rewrite(unavailable, { status: 404, request: { headers: requestHeaders } });
          } else {
            response = new NextResponse("Page not found.", { status: 404 });
          }
        }
      } catch {
        console.error("Published profile lookup failed at the request boundary.");
        response = new NextResponse("This page is temporarily unavailable.", { status: 503 });
      }
    }
  }

  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("X-Content-Type-Options", "nosniff");
  // Native same-origin reporting must preserve its Origin header. Cross-origin
  // navigations still send no referrer under this support-page-only policy.
  response.headers.set("Referrer-Policy", host.kind === "apex" && request.nextUrl.pathname === "/support" ? "same-origin" : "no-referrer");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (host.kind === "app" || host.kind === "media") response.headers.set("X-Robots-Tag", "noindex, nofollow");
  if (!request.nextUrl.pathname.startsWith("/_next/static/") || response.status !== 200) {
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    response.headers.set("CDN-Cache-Control", "no-store");
    response.headers.set("Cloudflare-CDN-Cache-Control", "no-store");
  }
  return response;
}

// The exact media collection route owns its host/method/maintenance/security
// boundary. Excluding it here avoids Next's eager body clone/finalize (10 MiB
// by default); raising that cap would still buffer uploads before admission.
// Descendants and encoded spellings still pass through the proxy. Next's
// trailing-slash redirect runs before matching; the route also rejects aliases.
export const config = { matcher: "/((?!api/media/?$).*)" };
