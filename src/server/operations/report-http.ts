import "server-only";
import { z } from "zod";
import { AppError, apiJson, readJson } from "@/server/http";
/** Native form fallback, with the same byte cap as JSON. Never put private
 * details in a query string or redirect. Duplicate and unknown fields fail shut. */
export async function readReportBody(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return readJson(request, z.unknown(), 4096);
  const reader = request.body?.getReader(); if (!reader) throw new AppError(400, "INVALID_BODY", "Invalid form.");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 4096) { await reader.cancel(); throw new AppError(413, "BODY_TOO_LARGE", "Form too large."); } chunks.push(part.value); }
  } finally { reader.releaseLock(); }
  const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8")), data: Record<string, string> = {}, seen = new Set<string>();
  for (const [key, value] of params) {
    if (!["username", "reason", "details", "contact", "linkId", "mediaId", "website", "target"].includes(key) || seen.has(key)) throw new AppError(400, "INVALID_BODY", "Invalid form.");
    seen.add(key);
    if ((key === "linkId" || key === "mediaId") && !value) continue;
    data[key] = value;
  }
  if (data.target !== undefined) {
    if (seen.has("linkId") || seen.has("mediaId")) throw new AppError(400, "INVALID_BODY", "Choose one report target.");
    const target = data.target;
    delete data.target;
    if (target) {
      const parsed = z.string().regex(/^(link|media):[0-9a-f-]+$/i).safeParse(target);
      const [kind, id] = target.split(":");
      if (!parsed.success || !z.uuid().safeParse(id).success) throw new AppError(400, "INVALID_BODY", "Invalid report target.");
      data[kind === "link" ? "linkId" : "mediaId"] = id;
    }
  }
  return data;
}
export function reportResponse(request: Request, accepted: boolean) {
  const message = accepted ? "Submission received. If the target is available, it will enter the review queue. This does not confirm a policy violation or guarantee a response." : "Unable to accept a report right now. Check the form and try again later.";
  if (request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Report submission</title><main><h1>Report submission</h1><p>${message}</p><p><a href="/support">Return to support</a></p></main></html>`, { status: accepted ? 202 : 400, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" } });
  return accepted ? apiJson({ message }, 202) : apiJson({ error: { code: "REPORT_UNAVAILABLE", message } }, 400);
}
