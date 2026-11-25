import "server-only";
import { z } from "zod";
import { AppError, apiJson, readBoundedBody, readJson } from "@/server/http";
/** Native form fallback, with the same byte cap as JSON. Never put private
 * details in a query string or redirect. Duplicate and unknown fields fail shut. */
export async function readReportBody(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return readJson(request, z.unknown(), 4096);
  const raw = await readBoundedBody(request, 4096, "Form too large.", "Invalid form.");
  const params = new URLSearchParams(raw.toString("utf8")), data: Record<string, string> = {}, seen = new Set<string>();
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
  if (request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
    const title = accepted ? "Submission received" : "Unable to submit report";
    const detail = accepted ? "If the target is still public, the report can enter the review queue." : "Check the form and try again later.";
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Report submission · may-be.gay</title>
      <style>html{color-scheme:dark;background:#121212;color:#fafafa;font:1rem/1.5 system-ui,sans-serif}body{margin:0 auto;padding:20px;max-width:70rem}header{padding:14px 0;border-bottom:1px solid #333;font-weight:700}main{max-width:36rem;margin:3rem auto;background:#191919;border:1px solid #4c4c4c;border-radius:16px;padding:24px}h1{margin:0;font-size:1.75rem}p{color:#b8b8b8}a{color:inherit}a:focus-visible{outline:3px solid currentColor;outline-offset:3px}</style>
      <header><a href="/">may-be.gay</a></header><main><h1>${title}</h1><p>${detail}</p><a href="/support">Return to support</a></main></html>`;
    return new Response(html, { status: accepted ? 202 : 400, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" } });
  }
  return accepted ? apiJson({ message }, 202) : apiJson({ error: { code: "REPORT_UNAVAILABLE", message } }, 400);
}
