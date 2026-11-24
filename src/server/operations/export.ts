import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { Readable } from "node:stream";
import { profileDocumentSchema } from "@/domain/profile";
import { getDatabase } from "@/server/db";
import { media, profileDrafts, profileRevisions, profiles, usernameClaims } from "@/server/db/schema";
import { mediaStorage } from "@/server/db/schema-media";
import { requireUser } from "@/server/auth/session";
import { getMediaStorage, objectKeys } from "@/server/media/storage";
import { AppError } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { assertPrincipal, lockOwner } from "./core";
import { checkAccountIdentity, requireAccountIdentity } from "@/server/account-identity";

export function tarHeader(path: string, size: number) {
  if (!/^[a-zA-Z0-9/_.-]{1,99}$/.test(path) || path.startsWith("/") || path.split("/").some(s => s === ".." || s === ".") || !Number.isSafeInteger(size) || size < 0 || size > 1024 ** 3) throw new Error("EXPORT_PATH_OR_SIZE_INVALID");
  const b = Buffer.alloc(512);
  b.write(path, 0, 100, "ascii");
  const octal = (value: number, offset: number, length: number) => b.write(value.toString(8).padStart(length - 1, "0") + "\0", offset, length, "ascii");
  octal(0o600, 100, 8); octal(0, 108, 8); octal(0, 116, 8); octal(size, 124, 12); octal(0, 136, 12);
  b.fill(32, 148, 156); b[156] = 48; b.write("ustar\0", 257, "ascii"); b.write("00", 263, "ascii");
  const sum = b.reduce((n, v) => n + v, 0);
  b.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return b;
}
async function* entry(path: string, body: Buffer) {
  yield tarHeader(path, body.length);
  for (let offset = 0; offset < body.length; offset += 65536) yield body.subarray(offset, offset + 65536);
  if (body.length % 512) yield Buffer.alloc(512 - body.length % 512);
}
export async function exportAccount(request: Request): Promise<Response> {
  const p = await requireUser(request, { recent: true });
  const expectedAccountId = requireAccountIdentity(request);
  // The download request submits no fields. Reject even undeclared/chunked
  // bodies instead of accepting owner IDs, paths or unbounded ignored input.
  const reader = request.body?.getReader();
  if (reader) {
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        if (part.value.byteLength) { await reader.cancel(); throw new AppError(400, "EMPTY_EXPORT_BODY_REQUIRED", "Submit the account download form without additional fields."); }
      }
    } finally { reader.releaseLock(); }
  }
  await rateLimit(`operations:export:${p.userId}`, 2, 3600);
  await rateLimit("operations:export:global", 10, 3600);
  const snapshot = await getDatabase().transaction(async tx => {
    await lockOwner(tx, p.userId); await assertPrincipal(tx, p);
    checkAccountIdentity(p.userId, expectedAccountId);
    const [claim] = await tx.select({ username: usernameClaims.username }).from(usernameClaims).where(eq(usernameClaims.ownerId, p.userId));
    const [profile] = await tx.select({ id: profiles.id, currentRevisionId: profiles.currentRevisionId }).from(profiles).where(eq(profiles.ownerId, p.userId)).for("share");
    const [draft] = profile ? await tx.select({ editVersion: profileDrafts.editVersion, document: profileDrafts.document }).from(profileDrafts).where(eq(profileDrafts.profileId, profile.id)) : [];
    const revisions = profile ? await tx.select({ id: profileRevisions.id, number: profileRevisions.revisionNumber, document: profileRevisions.document, createdAt: profileRevisions.createdAt }).from(profileRevisions).where(eq(profileRevisions.profileId, profile.id)).limit(6) : [];
    if (revisions.length > 5) throw new AppError(409, "EXPORT_HISTORY_BOUND", "Profile history needs maintenance before export.");
    const rows = await tx.select({ id: media.id, kind: media.kind, original: mediaStorage.original, display: mediaStorage.display, token: mediaStorage.token })
      .from(media).innerJoin(mediaStorage, eq(media.id, mediaStorage.assetId)).where(and(eq(media.ownerId, p.userId), eq(mediaStorage.ownerId, p.userId), eq(media.state, "ready"), eq(mediaStorage.state, "ready"), isNull(media.deletedAt))).orderBy(media.id).limit(1001);
    if (rows.length > 1000 || rows.reduce((n, r) => n + (r.original?.bytes ?? 0) + (r.kind === "image" ? r.display?.bytes ?? 0 : 0), 0) > 1024 ** 3) throw new AppError(413, "EXPORT_TOO_LARGE", "Contact support to arrange an export larger than 1 GiB.");
    return { manifest: { formatVersion: 1, exportedAt: new Date().toISOString(), account: { email: p.email, username: claim?.username ?? null }, profile, draft: draft ? { ...draft, document: profileDocumentSchema.parse(draft.document) } : null, revisions: revisions.map(r => ({ ...r, document: profileDocumentSchema.parse(r.document) })), media: rows.map(r => ({ id: r.id, kind: r.kind, originalPath: r.original ? `media/${r.id}/original.${r.kind === "image" ? "webp" : "mp3"}` : null, displayPath: r.kind === "image" && r.display ? `media/${r.id}/display.webp` : null })), consistency: "Profile snapshot at export start. Each file is checked again for ownership and availability. Concurrent removal or interrupted download aborts the archive; retry a new export." }, rows };
  });
  const started = Date.now();
  const check = () => { if (request.signal.aborted || Date.now() - started > 300000) throw new Error("EXPORT_ABORTED"); };
  async function* archive() {
    check();
    const manifest = Buffer.from(JSON.stringify(snapshot.manifest, null, 2));
    if (manifest.length > 1024 ** 2) throw new Error("EXPORT_MANIFEST_BOUND");
    yield* entry("account.json", manifest);
    for (const row of snapshot.rows) {
      for (const variant of ["original", "display"] as const) {
        if (variant === "display" && row.kind !== "image") continue;
        const object = row[variant]; if (!object) continue;
        check();
        const body = await getDatabase().transaction(async tx => {
          await lockOwner(tx, p.userId); await assertPrincipal(tx, p);
          const [valid] = await tx.select({ id: media.id }).from(media).innerJoin(mediaStorage, eq(mediaStorage.assetId, media.id)).where(and(eq(media.id, row.id), eq(media.ownerId, p.userId), eq(mediaStorage.ownerId, p.userId), eq(mediaStorage.token, row.token), eq(media.state, "ready"), eq(mediaStorage.state, "ready"), isNull(media.deletedAt)));
          if (!valid || object.bytes < 1 || object.bytes > 10 * 1024 ** 2) throw new Error("EXPORT_MEDIA_UNAVAILABLE");
          const keys = objectKeys(row.id, row.token);
          const sharedDisplay = row.kind === "image" && variant === "display"
            && object.key === keys.original && row.original?.key === keys.original && row.original.bytes === object.bytes;
          const expected = row.kind === "audio" ? keys.audio : variant === "original" || sharedDisplay ? keys.original : keys.display;
          if (object.key !== expected) throw new Error("EXPORT_MEDIA_LOCATOR_INVALID");
          const body = await getMediaStorage().get("private", expected, object.bytes);
          if (body.length !== object.bytes) throw new Error("EXPORT_MEDIA_UNAVAILABLE");
          return body;
        });
        check(); yield* entry(`media/${row.id}/${variant}.${row.kind === "image" ? "webp" : "mp3"}`, body);
      }
    }
    check(); yield Buffer.alloc(1024);
  }
  const stream = Readable.from(archive(), { objectMode: false, highWaterMark: 65536 });
  const onAbort = () => stream.destroy(new Error("EXPORT_ABORTED"));
  const timeout = setTimeout(onAbort, 300000);
  timeout.unref();
  request.signal.addEventListener("abort", onAbort, { once: true });
  stream.once("close", () => { clearTimeout(timeout); request.signal.removeEventListener("abort", onAbort); });
  return new Response(Readable.toWeb(stream, { strategy: { highWaterMark: 65536, size: chunk => chunk.byteLength } }) as ReadableStream<Uint8Array>, { headers: { "content-type": "application/x-tar", "content-disposition": 'attachment; filename="may-be-account.tar"', "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
}
