import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { runBoundedProcess, validateMedia, withUploadFile } from "@/server/media/validation";
import { IMAGE_BYTES, type MediaKind } from "@/server/media/limits";

const readUpload = (body: ReadableStream<Uint8Array>, kind: MediaKind, timeoutMs?: number) => withUploadFile(body,kind,file=>readFile(file),undefined,timeoutMs);
const stream = (chunks: Uint8Array[]) => new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });
describe("media byte and parser bounds", () => {
  it("counts received bytes without trusting MIME or declared size", async () => {
    await expect(readUpload(stream([Buffer.alloc(IMAGE_BYTES), Buffer.from([1])]), "image")).rejects.toMatchObject({ code: "MEDIA_TOO_LARGE", status: 413 });
    await expect(readUpload(stream([]), "image")).rejects.toMatchObject({ code: "MEDIA_INVALID" });
    expect(await readUpload(stream([Buffer.from([1]), Buffer.from([2])]), "image")).toEqual(Buffer.from([1,2]));
  });
  it("streams received bytes into a private temporary file and removes it after consumption", async () => {
    let file = "";
    expect(await withUploadFile(stream([Buffer.from("ab"), Buffer.from("cd")]), "image", async (name, bytes) => {
      file = name; expect(bytes).toBe(4); expect(await readFile(name)).toEqual(Buffer.from("abcd")); return "consumed";
    })).toBe("consumed");
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(withUploadFile(stream([Buffer.alloc(IMAGE_BYTES),Buffer.from([0])]), "image",async()=>{throw new Error("must not run");})).rejects.toMatchObject({ code: "MEDIA_TOO_LARGE" });
  });
  it("times out a stalled stream without awaiting cancellation", async () => {
    await expect(readUpload(new ReadableStream({ cancel: () => new Promise(() => {}) }), "image", 20)).rejects.toMatchObject({ code: "MEDIA_UPLOAD_TIMEOUT" });
  });
  it.each(["jpeg", "png", "webp"] as const)("decodes %s and makes metadata-free bounded WebP variants", async format => {
    const input = await sharp({ create: { width: 48, height: 24, channels: 3, background: "red" } }).toFormat(format).withMetadata({ exif: { IFD0: { Artist: "PRIVATE ARTIST" } } }).toBuffer();
    const result = await validateMedia(input, "image");
    expect(result).toMatchObject({ contentType: "image/webp", width: 48, height: 24 });
    const metadata = await sharp(result.original).metadata();
    expect(metadata.exif).toBeUndefined(); expect(metadata.icc).toBeUndefined(); expect(metadata.format).toBe("webp");
    expect(result.original.includes(Buffer.from("PRIVATE ARTIST"))).toBe(false);
    expect(result.display.length).toBeLessThan(1024 ** 2);
  });
  it.each(["<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", "<!doctype html><img src=x onerror=alert(1)>", "%PDF-1.7", "GIF89a"])("rejects active/unsupported or spoofed data %s", async data => {
    await expect(validateMedia(Buffer.from(data), "image")).rejects.toMatchObject({ code: "MEDIA_INVALID" });
  });
  it("rejects truncated images, animated WebP/APNG and oversized dimensions", async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: "blue" } }).png().toBuffer();
    await expect(validateMedia(png.subarray(0, png.length - 4), "image")).rejects.toMatchObject({ code: "MEDIA_INVALID" });
    const actl = Buffer.alloc(20); actl.writeUInt32BE(8); actl.write("acTL",4);
    await expect(validateMedia(Buffer.concat([png.subarray(0,33), actl, png.subarray(33)]), "image")).rejects.toMatchObject({ code: "MEDIA_INVALID" });
    const animated = Buffer.alloc(30); animated.write("RIFF"); animated.writeUInt32LE(22,4); animated.write("WEBP",8); animated.write("VP8X",12); animated.writeUInt32LE(10,16); animated[20] = 2;
    await expect(validateMedia(animated,"image")).rejects.toMatchObject({ code: "MEDIA_INVALID" });
    const big = await sharp({ create: { width: 4001, height: 4000, channels: 3, background: "white" } }).png().toBuffer();
    await expect(validateMedia(big, "image")).rejects.toMatchObject({ code: "MEDIA_INVALID" });
  });
  it("enforces process wall time and output bounds", async () => {
    await expect(runBoundedProcess(process.execPath,["--jitless", "-e","setInterval(()=>{},1000)"],100)).rejects.toMatchObject({ code: "MEDIA_PROCESSING_LIMIT" });
    await expect(runBoundedProcess(process.execPath,["--jitless", "-e","process.stdout.write('x'.repeat(20000))"])).rejects.toMatchObject({ code: "MEDIA_INVALID" });
  });
  it("inspects MP3 frames and fully decodes audio, stripping ID3 tags", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(),"media-fixture-"));
    try {
      const file = path.join(dir,"tone.mp3");
      execFileSync("/usr/bin/ffmpeg",["-v","error","-f","lavfi","-i","sine=frequency=440:duration=0.2","-metadata","title=PRIVATE TITLE","-c:a","libmp3lame","-b:a","64k",file]);
      const input = await readFile(file), result = await validateMedia(input,"audio");
      expect(result.contentType).toBe("audio/mpeg"); expect(result.durationMs).toBeGreaterThan(150);
      expect(result.original.subarray(0,3).toString()).not.toBe("ID3"); expect(result.original.includes(Buffer.from("PRIVATE TITLE"))).toBe(false);
      await expect(validateMedia(input,"image")).rejects.toMatchObject({ code: "MEDIA_INVALID" });
      await expect(validateMedia(Buffer.concat([input, Buffer.from("<script>active tail</script>")]),"audio")).rejects.toMatchObject({ code: "MEDIA_INVALID" });
      await expect(validateMedia(input.subarray(0,input.length-3),"audio")).rejects.toMatchObject({ code: "MEDIA_INVALID" });
      const track = result.original;
      await expect(validateMedia(Buffer.concat(Array.from({length:1000},()=>track)), "audio")).rejects.toMatchObject({ code: "MEDIA_INVALID" });
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
});
