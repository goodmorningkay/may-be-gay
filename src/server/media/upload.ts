import "server-only";
import { mkdtemp, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { invalidMedia, MediaError } from "./errors";
import { inputLimit, UPLOAD_TIMEOUT_MS, type MediaKind } from "./limits";

export type ScratchLocator = { assetId: string; token: string };
export function scratchPrefix(locator?: ScratchLocator) { return locator ? `may-be-media-${locator.assetId}-${locator.token}-` : "may-be-media-"; }

export async function withUploadFile<T>(body: ReadableStream<Uint8Array> | null, kind: MediaKind, consume: (file: string, bytes: number) => Promise<T>, locator?: ScratchLocator, timeoutMs = UPLOAD_TIMEOUT_MS): Promise<T> {
  if (!body) throw invalidMedia();
  const dir = await mkdtemp(path.join(os.tmpdir(), scratchPrefix(locator)));
  const file = path.join(dir, "upload"), reader = body.getReader();
  const handle = await open(file, "wx", 0o600);
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new MediaError(408, "MEDIA_UPLOAD_TIMEOUT", "Upload timed out.")), timeoutMs); });
  try {
    for (;;) {
      const result = await Promise.race([reader.read(), deadline]);
      if (result.done) break;
      size += result.value.byteLength;
      if (size > inputLimit(kind)) throw new MediaError(413, "MEDIA_TOO_LARGE", "The upload exceeds the media byte limit.");
      await handle.writeFile(result.value);
    }
    if (!size) throw invalidMedia();
    await handle.close();
    return await consume(file, size);
  } finally {
    clearTimeout(timer); void reader.cancel().catch(() => {}); reader.releaseLock();
    await handle.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}
