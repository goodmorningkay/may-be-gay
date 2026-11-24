import "server-only";
import { getSiteDomain } from "@/domain/hosts";
import { serviceState } from "@/server/service-state";
import { apiError, apiJson } from "@/server/http";

/** /api/media bypasses Next's cloning proxy so POST reaches its byte-limited
 * spool before EOF. Repeat the entire admission/response boundary here. */
export async function mediaIngress(request: Request, handle: () => Promise<Response>): Promise<Response> {
  const domain = getSiteDomain(), host = request.headers.get("host")?.toLowerCase();
  let response: Response;
  try {
    if ((host !== `app.${domain}` && host !== `app.${domain}:443`) || new URL(request.url).pathname !== "/api/media") {
      response = apiJson({ error: { code: "NOT_FOUND", message: "Page not found." } }, 404);
    } else if (!["GET", "HEAD", "POST"].includes(request.method)) {
      response = apiJson({ error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." } }, 405);
      response.headers.set("Allow", "GET, HEAD, POST");
    } else if (await serviceState() !== "open") {
      response = apiJson({ error: { code: "SERVICE_UNAVAILABLE", message: "This service is temporarily unavailable." } }, 503);
      response.headers.set("Retry-After", "60");
    } else response = await handle();
  } catch (error) { response = apiError(error); }
  const headers: Record<string, string> = {
    "Content-Security-Policy": "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()", "X-Robots-Tag": "noindex, nofollow",
    "Cache-Control": "private, no-store, max-age=0", "CDN-Cache-Control": "no-store", "Cloudflare-CDN-Cache-Control": "no-store",
  };
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}
