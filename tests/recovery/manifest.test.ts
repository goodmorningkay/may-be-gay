import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_PRIVATE_MEDIA_OBJECTS } from "../../src/domain/media";
import { MAX_ARCHIVE_FILES, MANIFEST_MAX, manifestSchema } from "../../src/server/recovery/manifest";
import { manifest } from "./manifest-fixture";
describe("admission-compatible archive inventory", () => {
  it("accepts every admitted private object plus the DB and rejects one extra tiny descriptor", () => {
    const m = manifest(), owner = randomUUID(), asset = randomUUID();
    for (let n = 0; n < MAX_PRIVATE_MEDIA_OBJECTS; n++) m.files.push({ name: `file-${n + 1}.enc`, bytes: 1, sha256: "c".repeat(64), object: { area: "private", key: `v1/${owner}/${asset}/${n}.webp`, bytes: 1, contentType: "image/webp" } });
    expect(MAX_ARCHIVE_FILES).toBe(MAX_PRIVATE_MEDIA_OBJECTS + 1);
    expect(manifestSchema.safeParse(m).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(m))).toBeLessThan(MANIFEST_MAX);
    m.files.push({ ...m.files[1], name: `file-${MAX_ARCHIVE_FILES}.enc`, object: { ...m.files[1].object!, key: `v1/${owner}/${asset}/extra.webp` } });
    expect(manifestSchema.safeParse(m).success).toBe(false);
  });
});
