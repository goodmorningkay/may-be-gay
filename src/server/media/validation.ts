import "server-only";
import { mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cancelSupervised, spawnSupervised } from "../subprocess/supervised";
import { z } from "zod";
import { invalidMedia, MediaError } from "./errors";
import { inputLimit, PARSER_TIMEOUT_MS, UPLOAD_TIMEOUT_MS, type MediaKind } from "./limits";

type ScratchLocator = { assetId: string; token: string };
function scratchPrefix(locator?: ScratchLocator) { return locator ? `may-be-media-${locator.assetId}-${locator.token}-` : "may-be-media-"; }
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
/** Stale scratch files from killed processes, never active parser/upload dirs. */
export async function sweepMediaScratch(): Promise<void> {
  for (const name of await readdir(os.tmpdir())) {
    if (!/^may-be-media-[a-zA-Z0-9-]+$/.test(name)) continue;
    const dir = path.join(os.tmpdir(), name);
    const info = await stat(dir).catch(() => null);
    if (info?.isDirectory() && info.mtimeMs < Date.now() - 15 * 60000) await rm(dir, { recursive: true, force: true });
  }
}
const resultSchema = z.object({ contentType: z.enum(["image/webp", "audio/mpeg"]), width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
  displayWidth: z.number().int().positive().optional(), displayHeight: z.number().int().positive().optional(), durationMs: z.number().int().positive().max(180000).optional() }).strict();
export async function runBoundedProcess(command: string, args: string[], timeoutMs = PARSER_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawnSupervised>;
    try {
      if (process.env.NODE_ENV === "production" && !process.env.NATIVE_PARSER_LOCK_FILE) throw new Error("NATIVE_PARSER_LOCK_REQUIRED");
      child = spawnSupervised("/usr/bin/prlimit", ["--as=2147483648", "--cpu=12", "--fsize=10485760", "--nofile=64", "--core=0", "--", command, ...args], timeoutMs, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { NODE_ENV: process.env.NODE_ENV ?? "production", PATH: "/usr/bin:/bin", HOME: os.tmpdir(), TMPDIR: os.tmpdir(), OMP_NUM_THREADS: "1", MALLOC_ARENA_MAX: "2", VIPS_CONCURRENCY: "1", UV_THREADPOOL_SIZE: "1" },
      }, process.env.NATIVE_PARSER_LOCK_FILE || path.join(os.tmpdir(), `may-be-parser-${process.getuid!()}.lock`));
    } catch { reject(new MediaError(503, "MEDIA_PARSER_UNAVAILABLE", "Media validation is unavailable.")); return; }
    let output = "", bytes = 0, unavailable = false;
    for (const stream of [child.stdout!, child.stderr!]) stream.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 16384) cancelSupervised(child);
      if (stream === child.stdout && bytes <= 16384) output += chunk.toString("utf8");
    });
    child.on("error", () => { unavailable = true; });
    child.on("close", (code) => {
      if (bytes > 16384) reject(invalidMedia());
      else if (unavailable || code === 78 || code === 125 || code === 126 || code === 127) reject(new MediaError(503, "MEDIA_PARSER_UNAVAILABLE", "Media validation is unavailable."));
      else if (code === 124) reject(new MediaError(422, "MEDIA_PROCESSING_LIMIT", "Media validation exceeded its processing limit."));
      else if (code !== 0) reject(invalidMedia());
      else resolve(output);
    });
  });
}
// Caller MUST hold pg_try_advisory_xact_lock(740301, 1) for the whole invocation.
// This low-level function is exported for isolated parser tests only.
export async function validateMedia(data: Buffer, kind: MediaKind, locator?: ScratchLocator) {
  if (!data.length || data.length > inputLimit(kind)) throw invalidMedia();
  const dir = await mkdtemp(path.join(os.tmpdir(), scratchPrefix(locator)));
  try {
    const input = path.join(dir, "input"), original = path.join(dir, "validated"), display = path.join(dir, "display");
    await writeFile(input, data, { mode: 0o600, flag: "wx" });
    const result = resultSchema.parse(JSON.parse(await runBoundedProcess(process.execPath, ["--jitless", "--max-old-space-size=128", "--max-semi-space-size=8", path.join(process.cwd(), "src/server/media/parser.cjs"), kind, input, original, display])));
    const full = await readFile(original), small = kind === "image" ? await readFile(display) : full;
    if (!full.length || full.length > inputLimit(kind) || (kind === "image" && small.length > 1024 ** 2)) throw invalidMedia();
    return { ...result, original: full, display: small };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function deleteAssetScratch(assetId: string, token: string): Promise<void> {
  const prefix = scratchPrefix({ assetId, token });
  for (const name of await readdir(os.tmpdir())) if (name.startsWith(prefix) && /^may-be-media-[a-zA-Z0-9-]+$/.test(name)) {
    await rm(path.join(os.tmpdir(), name), { recursive: true, force: true });
  }
}
