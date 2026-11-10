import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getSiteDomain, isAllowedPath, resolveHost } from "@/domain/hosts";
import { getPublishedProfile } from "@/server/profiles";

export async function proxy(request: NextRequest) {
  const domain = getSiteDomain();
  const host = resolveHost(request.headers.get("host"), domain);
  const nonce = randomBytes(18).toString("base64");
  const development = process.env.NODE_ENV === "development";
  const csp = [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self'",
    "font-src 'self'",
    `connect-src 'self'${development ? " ws: wss:" : ""}`,
    "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'", "form-action 'self'",
    ...(domain === "may-be.gay" && !development ? ["upgrade-insecure-requests"] : []),
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  for (const header of ["forwarded", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port", "x-nonce"]) {
    requestHeaders.delete(header);
  }
  // Anonymous published pages cannot depend on a visitor's editor session.
  if (host.kind !== "app") requestHeaders.delete("cookie");
  requestHeaders.set("content-security-policy", csp);
  requestHeaders.set("x-nonce", nonce);

  let response: NextResponse;
  if (!isAllowedPath(host, request.nextUrl.pathname)) {
    response = new NextResponse("Page not found.", { status: 404 });
  } else if (!["GET", "HEAD"].includes(request.method)) {
    // No mutation route is implemented in this milestone. Future routes must
    // enforce exact Origin, CSRF, authentication and ownership before enabling.
    response = new NextResponse("Method not allowed.", { status: 405, headers: { Allow: "GET, HEAD" } });
  } else {
    response = NextResponse.next({ request: { headers: requestHeaders } });
    if (host.kind === "profile" && !request.nextUrl.pathname.startsWith("/_next/static/")) {
      // Flight can start streaming before a page's notFound() executes, making
      // an unknown profile look like HTTP 200. Resolve public availability
      // before handing any HTML/RSC request to the renderer. The page still
      // performs its own public-only read; no document is passed in headers.
      try {
        if (!await getPublishedProfile(host.username)) {
          response = new NextResponse("Page not found.", { status: 404 });
        }
      } catch {
        console.error("Published profile lookup failed at the request boundary.");
        response = new NextResponse("This page is temporarily unavailable.", { status: 503 });
      }
    }
  }

  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (!request.nextUrl.pathname.startsWith("/_next/static/") || response.status !== 200) {
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    response.headers.set("CDN-Cache-Control", "no-store");
    response.headers.set("Cloudflare-CDN-Cache-Control", "no-store");
  }
  return response;
}

// Include prefetch/RSC requests and error paths: hostname policy is not optional.
export const config = { matcher: "/:path*" };
