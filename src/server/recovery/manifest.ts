import { z } from "zod";
import { MAX_PRIVATE_MEDIA_OBJECTS } from "../../domain/media";
export const MAX_ARCHIVE_FILES = MAX_PRIVATE_MEDIA_OBJECTS + 1;
export const MANIFEST_MAX = 8 * 1024 ** 2;
export const objectSchema = z.object({ area: z.literal("private"), key: z.string().regex(/^v1\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/[a-z0-9.-]+$/).refine(s => !s.includes("..")), bytes: z.number().int().positive().max(10 * 1024 ** 2), contentType: z.enum(["image/webp", "audio/mpeg"]) }).strict();
const fileSchema = z.object({ name: z.string().regex(/^file-\d{1,6}\.enc$/), bytes: z.number().int().nonnegative().max(16 * 1024 ** 3), sha256: z.string().regex(/^[0-9a-f]{64}$/), object: objectSchema.optional() }).strict();
export const manifestSchema = z.object({
  version: z.literal(1), id: z.string().regex(/^(snapshot|journal)-\d{13}-[a-f0-9-]{36}$/), kind: z.enum(["snapshot", "journal"]), createdAt: z.iso.datetime(),
  databaseVersion: z.number().int().min(170000), recoverySequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  eventCount: z.number().int().nonnegative().max(1000000), files: z.array(fileSchema).min(1).max(MAX_ARCHIVE_FILES),
  metadata: z.object({ roleNames: z.array(z.string().max(128)).max(100), siteDomain: z.enum(["may-be.gay", "may-be.localhost"]), mediaStorage: z.enum(["local", "s3"]), mediaPublicOrigin: z.string().url().max(256), sourceMedia: z.string().regex(/^[a-f0-9]{64}$/), sourceDatabase: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
}).strict().superRefine((m, c) => {
  if (m.files.reduce((total, f) => total + f.bytes, 0) > 64 * 1024 ** 3) c.addIssue({ code: "custom", message: "Archive size limit" });
  if (new Set(m.files.map(f => f.name)).size !== m.files.length || m.files[0].object || (m.kind === "journal" && m.files.length !== 1) || m.files.slice(1).some(f => !f.object || f.bytes !== f.object.bytes) || new Set(m.files.slice(1).map(f => f.object!.key)).size !== m.files.length - 1) c.addIssue({ code: "custom", message: "Invalid file inventory" });
});
export type Manifest = z.infer<typeof manifestSchema>;
