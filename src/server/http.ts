import "server-only";
import { z } from "zod";
import { getSiteDomain } from "@/domain/hosts";

export class AppError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function appOrigin() { return `https://app.${getSiteDomain()}`; }
export function assertAppHost(headers: Headers): void {
  const host = headers.get("host")?.toLowerCase();
  if (host !== new URL(appOrigin()).host && host !== `${new URL(appOrigin()).host}:443`) {
    throw new AppError(403, "APP_HOST_REQUIRED", "Use the account application.");
  }
}
export function assertMutationOrigin(request: Request): void {
  assertAppHost(request.headers);
  if (request.headers.get("origin") !== appOrigin()) throw new AppError(403, "ORIGIN_REJECTED", "Request origin rejected.");
}
export function assertLocalRedirect(value: unknown): void {
  if (typeof value !== "string" || value.length > 2048 || /[\\\u0000-\u0020\u007f]/.test(value)) throw new AppError(400, "REDIRECT_REJECTED", "Invalid redirect.");
  const url = new URL(value, appOrigin());
  if (url.origin !== appOrigin() || value.startsWith("//") || url.username || url.password) throw new AppError(400, "REDIRECT_REJECTED", "Invalid redirect.");
}
export async function readJson<T>(request: Request, schema: z.ZodType<T>, maxBytes = 16384): Promise<T> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new AppError(415, "JSON_REQUIRED", "Send JSON.");
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new AppError(413, "BODY_TOO_LARGE", "Request too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new AppError(400, "INVALID_BODY", "Invalid request.");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new AppError(413, "BODY_TOO_LARGE", "Request too large."); }
      chunks.push(value);
    }
    const parsed = schema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!parsed.success) throw new Error();
    return parsed.data;
  } catch (error) { if (error instanceof AppError) throw error; throw new AppError(400, "INVALID_BODY", "Invalid request."); }
  finally { reader.releaseLock(); }
}
export function apiJson(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}
export function apiError(error: unknown): Response {
  return error instanceof AppError ? apiJson({ error: { code: error.code, message: error.message } }, error.status)
    : apiJson({ error: { code: "REQUEST_FAILED", message: "Unable to complete request." } }, 500);
}
