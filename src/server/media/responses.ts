import type { MediaObject } from "@/server/db/schema-media";
/** Bounded in-memory files support single byte ranges for explicit MP3 seeking. */
export function mediaResponse(body: Buffer, object: MediaObject, request: Request): Response {
  const headers = new Headers({ "content-type": object.contentType, "x-content-type-options": "nosniff", "cache-control": "private, no-store",
    "content-security-policy": "default-src 'none'; sandbox", "accept-ranges": "bytes", "content-disposition": "inline", "cross-origin-resource-policy": "cross-origin" });
  const range = request.headers.get("range");
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start = 0, end = body.length - 1;
    if (match && (match[1] || match[2])) {
      if (!match[1]) start = Math.max(0, body.length - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    }
    if (!match || !(match[1] || match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= body.length) {
      headers.set("content-range", `bytes */${body.length}`); return new Response(null, { status: 416, headers });
    }
    headers.set("content-range", `bytes ${start}-${end}/${body.length}`);
    headers.set("content-length", String(end - start + 1));
    return new Response(new Uint8Array(body.subarray(start, end + 1)), { status: 206, headers });
  }
  headers.set("content-length", String(body.length));
  return new Response(new Uint8Array(body), { headers });
}
