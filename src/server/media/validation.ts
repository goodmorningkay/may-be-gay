import "server-only";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runBoundedCommand } from "../subprocess/bounded";
import { z } from "zod";
import { invalidMedia, MediaError } from "./errors";
import { DISPLAY_BYTES, IMAGE_BYTES, inputLimit, PARSER_TIMEOUT_MS, type MediaKind } from "./limits";
import { scratchPrefix, withUploadFile, type ScratchLocator } from "./upload";

export { withUploadFile };
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
  displayWidth: z.number().int().positive().optional(), displayHeight: z.number().int().positive().optional(), durationMs: z.number().int().positive().max(180000).optional(),
  sharedVariants: z.literal(true).optional() }).strict();
export async function runBoundedProcess(command: string, args: string[], timeoutMs = PARSER_TIMEOUT_MS): Promise<string> {
  const result = await runBoundedCommand("/usr/bin/prlimit", ["--as=2147483648", "--cpu=12", "--fsize=10485760", "--nofile=64", "--core=0", "--", command, ...args], {
    timeoutMs,
    env: { NODE_ENV: process.env.NODE_ENV ?? "production", PATH: "/usr/bin:/bin", HOME: os.tmpdir(), TMPDIR: os.tmpdir(), OMP_NUM_THREADS: "1", MALLOC_ARENA_MAX: "2", VIPS_CONCURRENCY: "1", UV_THREADPOOL_SIZE: "1" },
    captureStdout: true,
    captureStderr: true,
    maxOutputBytes: 16384,
  });
  if (result.outputExceeded) throw invalidMedia();
  if (result.unavailable || result.code === 78 || result.code === 125 || result.code === 126 || result.code === 127) {
    throw new MediaError(503, "MEDIA_PARSER_UNAVAILABLE", "Media validation is unavailable.");
  }
  if (result.timedOut || result.code === 124) {
    throw new MediaError(422, "MEDIA_PROCESSING_LIMIT", "Media validation exceeded its processing limit.");
  }
  if (result.code !== 0) throw invalidMedia();
  return result.stdout;
}
// Callers hold the parser advisory lock for the whole invocation outside isolated tests.
async function withParserInput<T>(data: Buffer, maxBytes: number, locator: ScratchLocator | undefined, consume: (input: string, dir: string) => Promise<T>) {
  if (!data.length || data.length > maxBytes) throw invalidMedia();
  const dir = await mkdtemp(path.join(os.tmpdir(), scratchPrefix(locator)));
  try {
    const input = path.join(dir, "input");
    await writeFile(input, data, { mode: 0o600, flag: "wx" });
    return await consume(input, dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

function runParser(...args: string[]) {
  return runBoundedProcess(process.execPath, ["--jitless", "--max-old-space-size=128", "--max-semi-space-size=8", path.join(process.cwd(), "src/server/media/parser.cjs"), ...args]);
}

export async function validateMedia(data: Buffer, kind: MediaKind | "mp3", locator?: ScratchLocator) {
  const byteLimit = inputLimit(kind === "image" ? "image" : "audio");
  return withParserInput(data, byteLimit, locator, async (input, dir) => {
    const original = path.join(dir, "validated"), display = path.join(dir, "display");
    const result = resultSchema.parse(JSON.parse(await runParser(kind, input, original, display)));
    const full = await readFile(original), small = kind === "image" && !result.sharedVariants ? await readFile(display) : full;
    if (!full.length || full.length > byteLimit || (kind === "image" && (!small.length || small.length > DISPLAY_BYTES))) throw invalidMedia();
    return { ...result, original: full, display: small };
  });
}

const storedWebpSchema = z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict();

/** Validate a stored WebP derivative and return its decoded frame dimensions. */
export async function inspectStoredWebp(data: Buffer, locator?: ScratchLocator): Promise<{ width: number; height: number }> {
  const result = await withParserInput(data, IMAGE_BYTES, locator, input => runParser("stored-webp", input));
  try { return storedWebpSchema.parse(JSON.parse(result)); }
  catch { throw invalidMedia(); }
}

/** Recovery validation for WebP derivatives already produced by the parser. */
export async function validateStoredWebp(data: Buffer, locator?: ScratchLocator): Promise<void> {
  await inspectStoredWebp(data, locator);
}

export async function deleteAssetScratch(assetId: string, token: string): Promise<void> {
  const prefix = scratchPrefix({ assetId, token });
  for (const name of await readdir(os.tmpdir())) if (name.startsWith(prefix) && /^may-be-media-[a-zA-Z0-9-]+$/.test(name)) {
    await rm(path.join(os.tmpdir(), name), { recursive: true, force: true });
  }
}
