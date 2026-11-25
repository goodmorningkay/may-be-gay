import { z } from "@/domain/zod";
import { EditorRequestError, type EditorTransport } from "@/domain/editor";
import { profileDocumentSchema } from "@/domain/profile";
import { MAX_MEDIA_LIBRARY_ENTRIES } from "@/domain/media";

const editorStateSchema = z.object({
  profileId: z.string().uuid(), username: z.string().min(3).max(30), editVersion: z.number().int().positive(),
  document: profileDocumentSchema, publishedRevisionId: z.string().uuid().nullable(),
  revisions: z.array(z.object({ id: z.string().uuid(), revisionNumber: z.number().int().positive(), createdAt: z.string().datetime() })).max(5),
});
export const mediaListSchema = z.object({
  assets: z.array(z.object({ id: z.string().uuid(), kind: z.enum(["image", "audio"]),
    state: z.enum(["quarantined", "processing", "ready", "rejected", "deleted"]), contentType: z.string().nullable(),
    bytes: z.number().nonnegative().nullable(), width: z.number().nullable(), height: z.number().nullable(), durationMs: z.number().nullable(), createdAt: z.string() })).max(MAX_MEDIA_LIBRARY_ENTRIES),
  usage: z.object({ chargedBytes: z.number().nonnegative(), privateBytes: z.number().nonnegative(), publicReservedBytes: z.number().nonnegative() }),
  quota: z.object({ limitBytes: z.number().nonnegative(), uploadsPaused: z.boolean(), globalCapacityAvailable: z.boolean() }),
});
export type MediaList = z.infer<typeof mediaListSchema>;
export type MediaAsset = MediaList["assets"][number];

/** Render only bounded, redacted API errors; never stringify an unexpected response. */
export async function requestJson(path: string, options: RequestInit = {}): Promise<unknown> {
  let response: Response;
  try { response = await fetch(path, { ...options, cache: "no-store", credentials: "same-origin", redirect: "error" }); }
  catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new EditorRequestError(0, "NETWORK_UNAVAILABLE", "Connection unavailable. Your input remains in this tab.");
  }
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    const error = z.object({ error: z.object({ code: z.string().regex(/^[A-Z0-9_]{1,80}$/), message: z.string().max(500) }) }).safeParse(value);
    throw new EditorRequestError(response.status, error.success ? error.data.error.code : "REQUEST_FAILED",
      response.status === 401 ? "Your session expired. Sign in in a new tab, then retry here to keep your input." : error.success ? error.data.error.message : "Unable to complete the request. Your input is retained.");
  }
  return value;
}
export function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new EditorRequestError(502, "INVALID_RESPONSE", "The server returned an unexpected response. Your input is retained.");
  return result.data;
}
const jsonBody = (body: unknown, profileId: string): RequestInit => ({ headers: { "content-type": "application/json", "x-editor-profile": profileId }, body: JSON.stringify(body) });
export const editorTransport: EditorTransport = {
  async read() { return checked(editorStateSchema, await requestJson("/api/profile")); },
  async save(expectedVersion, document, profileId) {
    return checked(editorStateSchema, await requestJson("/api/profile", { method: "PUT", ...jsonBody({ expectedVersion, document }, profileId) }));
  },
  async action(action, expectedVersion, profileId) {
    const path = typeof action === "object" ? `/api/profile/revisions/${encodeURIComponent(action.restore)}/restore` : `/api/profile/${action}`;
    return checked(editorStateSchema, await requestJson(path, { method: "POST", ...jsonBody(action === "unpublish" ? {} : { expectedVersion }, profileId) }));
  },
};
