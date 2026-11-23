import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { runBoundedProcess, validateMedia, validateStoredWebp, withUploadFile } from "@/server/media/validation";
import { DISPLAY_BYTES, IMAGE_BYTES, type MediaKind } from "@/server/media/limits";
import { gifFixture } from "./gif-fixture";

const readUpload = (body: ReadableStream<Uint8Array>, kind: MediaKind, timeoutMs?: number) => withUploadFile(body,kind,file=>readFile(file),undefined,timeoutMs);
const stream = (chunks: Uint8Array[]) => new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });

async function grayscaleGif(width: number, height: number, delay: number[], shade: (x: number, y: number, frame: number) => number) {
  const pixels = Buffer.alloc(width * height * delay.length * 3);
  let offset = 0;
  for (let frame = 0; frame < delay.length; frame++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        pixels.fill(shade(x, y, frame), offset, offset + 3);
        offset += 3;
      }
    }
  }
  return sharp(pixels, { raw: { width, height: height * delay.length, pageHeight: height, channels: 3 } })
    .gif({ delay, dither: 0, interPaletteMaxError: 0 }).toBuffer();
}

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
    await expect(validateStoredWebp(result.display)).resolves.toBeUndefined();
  });
  it("preserves GIF frames, timing and loop count in bounded WebP variants", async () => {
    const input = await gifFixture(1500, 240, 2, 3);
    const result = await validateMedia(input, "image");
    expect(result).toMatchObject({ contentType: "image/webp", width: 1500, height: 240, displayWidth: 1280, displayHeight: 205 });
    expect(result.display.length).toBeLessThan(input.length);
    expect(result.display.length).toBeLessThanOrEqual(DISPLAY_BYTES);
    for (const variant of [result.original, result.display]) {
      const image = sharp(variant, { animated: true });
      const metadata = await image.metadata();
      expect(metadata).toMatchObject({ format: "webp", pages: 2, delay: [300, 500], loop: 3 });
      const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
      const next = metadata.width * metadata.pageHeight! * info.channels;
      expect(data[0]).toBeGreaterThan(200);
      expect(data[next + 2]).toBeGreaterThan(200);
      await expect(validateStoredWebp(variant)).resolves.toBeUndefined();
      await expect(validateMedia(variant, "image")).rejects.toMatchObject({ code: "MEDIA_INVALID" });
    }
    await expect(validateStoredWebp(result.display.subarray(0, -1))).rejects.toMatchObject({ code: "MEDIA_INVALID" });
    await expect(validateStoredWebp(input)).rejects.toMatchObject({ code: "MEDIA_INVALID" });
  }, 15_000);
  it("keeps subtle palette changes in both animated WebPs", async () => {
    const side = 200, frameBytes = side * side * 3;
    const pixels = Buffer.concat([Buffer.alloc(frameBytes, 0x60), Buffer.alloc(frameBytes, 0x64)]);
    const input = await sharp(pixels, { raw: { width: side, height: side * 2, pageHeight: side, channels: 3 } })
      .gif({ delay: [300, 500], interPaletteMaxError: 0 }).toBuffer();
    const result = await validateMedia(input, "image");
    for (const variant of [result.original, result.display]) {
      const image = sharp(variant, { animated: true });
      expect(await image.metadata()).toMatchObject({ pages: 2, delay: [300, 500] });
      expect((await image.removeAlpha().raw().toBuffer()).equals(pixels)).toBe(true);
    }
  });
  it.each([64, 1500])("preserves long GIF frame delays at %i pixels wide", async width => {
    const input = await gifFixture(width, 240, 2, 3);
    // The GIF control extension stores centiseconds in a 16-bit field.
    const control = input.indexOf(Buffer.from([0x21, 0xf9, 0x04]));
    expect(control).toBeGreaterThanOrEqual(0);
    input.writeUInt16LE(7000, control + 4);
    const result = await validateMedia(input, "image");
    expect(result.displayWidth).toBe(Math.min(width, 1280));
    for (const variant of [result.original, result.display]) {
      expect(await sharp(variant).metadata()).toMatchObject({ pages: 2, delay: [70000, 500], loop: 3 });
    }
  });
  it("uses the full animation when a smaller encode erases the motion", async () => {
    const width = 1500, height = 100, frameBytes = width * height * 3;
    const pixels = Buffer.alloc(frameBytes * 2, 0x60);
    const changedPixel = frameBytes + (40 * width + 105) * 3;
    pixels.fill(0x61, changedPixel, changedPixel + 3);
    const input = await sharp(pixels, { raw: { width, height: height * 2, pageHeight: height, channels: 3 } })
      .gif({ delay: [300, 500], interPaletteMaxError: 0, dither: 0 }).toBuffer();
    const result = await validateMedia(input, "image");
    expect(await sharp(result.display).metadata()).toMatchObject({ pages: 2, delay: [300, 500] });
    expect(result.displayWidth).toBe(width);
    expect(result.display.equals(result.original)).toBe(true);
    expect(result.display.length).toBeLessThanOrEqual(DISPLAY_BYTES);
  });
  it("resamples each GIF frame without bleeding into the adjacent frame", async () => {
    const width = 2560, height = 256, delay = [300, 500];
    const input = await grayscaleGif(width, height, delay, (x, y, frame) => {
      if (y === 0) return 0;
      if (y === height - 1) return 255;
      if (frame === 0) return 96;
      return x % 2 === 0 ? 95 : 97;
    });
    const result = await validateMedia(input, "image");
    expect(result).toMatchObject({ displayWidth: 1280, displayHeight: 128 });
    const output = sharp(result.display, { animated: true });
    expect(await output.metadata()).toMatchObject({ pages: 2, delay });
    const source = await sharp(input, { animated: true }).removeAlpha().raw().toBuffer();
    const resized = await output.removeAlpha().raw().toBuffer();
    const sourceFrameBytes = width * height * 3, displayFrameBytes = resized.length / delay.length;
    for (let frame = 0; frame < delay.length; frame++) {
      const sourceFrame = source.subarray(frame * sourceFrameBytes, (frame + 1) * sourceFrameBytes);
      const expected = await sharp(sourceFrame, { raw: { width, height, channels: 3 } }).resize(1280, 128).raw().toBuffer();
      const displayFrame = resized.subarray(frame * displayFrameBytes, (frame + 1) * displayFrameBytes);
      expect(displayFrame.equals(expected)).toBe(true);
    }
  });
  it("keeps a compact full animation when resizing inflates the display file", async () => {
    const width = 1281, height = 720, delay = [300, 500, 300];
    const input = await grayscaleGif(width, height, delay, (x, y, frame) => {
      const square = Math.floor((x + frame) / 4) + Math.floor(y / 4);
      return square % 2 === 0 ? 45 : 210;
    });
    const result = await validateMedia(input, "image");
    expect(result).toMatchObject({ displayWidth: width, displayHeight: height });
    expect(result.display.equals(result.original)).toBe(true);
    expect(result.display.length).toBeLessThan(input.length);
    expect(await sharp(result.display).metadata()).toMatchObject({ pages: 3, delay });
  });
  it("uses the smaller animation for both variants when the wider encode loses frames", async () => {
    const delay = [300, 500];
    const input = await grayscaleGif(8192, 192, delay, (x, _y, frame) => {
      if (frame === 0) return 96;
      return x % 2 === 0 ? 95 : 97;
    });
    const result = await validateMedia(input, "image");
    expect(result).toMatchObject({ width: 1280, height: 30, displayWidth: 1280, displayHeight: 30 });
    expect(result.display.equals(result.original)).toBe(true);
    expect(await sharp(result.display).metadata()).toMatchObject({ pages: 2, delay });
  });
  it("compresses a long, striped animation without sacrificing frames or resolution", async () => {
    const width = 640, height = 480, frames = 50;
    const pixels = Buffer.alloc(width * height * frames * 3);
    for (let row = 0; row < height * frames; row++) {
      const offset = Math.floor(row / height);
      for (let x = 0; x < width; x++) pixels[(row * width + x) * 3 + (x + offset) % 3] = 255;
    }
    const input = await sharp(pixels, { raw: { width, height: height * frames, pageHeight: height, channels: 3 } })
      .gif({ delay: 50 }).toBuffer();
    const result = await validateMedia(input, "image");
    for (const variant of [result.original, result.display]) {
      expect(variant.length).toBeLessThan(input.length);
      expect(await sharp(variant, { animated: true }).metadata()).toMatchObject({ pages: frames, width, pageHeight: height });
    }
  }, 15_000);
  it("resizes a dense animation again when the first display encode exceeds the byte budget", async () => {
    const side = 1000, pixels = Buffer.alloc(side * side * 2 * 3);
    let seed = 29;
    for (let i = 0; i < pixels.length; i += 3) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      pixels[i] = (seed >>> 30) * 85;
      pixels[i + 1] = ((seed >>> 26) & 3) * 85;
      pixels[i + 2] = ((seed >>> 22) & 3) * 85;
    }
    const input = await sharp(pixels, { raw: { width: side, height: side * 2, pageHeight: side, channels: 3 } })
      .gif({ delay: [300, 500] }).toBuffer();
    const result = await validateMedia(input, "image");
    expect(result).toMatchObject({ width: side, height: side });
    expect(result.displayWidth).toBeLessThan(side);
    expect(result.displayHeight).toBe(result.displayWidth);
    expect(result.display.length).toBeLessThanOrEqual(DISPLAY_BYTES);
    expect(await sharp(result.display, { animated: true }).metadata()).toMatchObject({ pages: 2, delay: [300, 500] });
  }, 15_000);
  it("rejects GIF truncation, trailing data and excessive frames or total decoded pixels", async () => {
    const gif = await gifFixture(32, 20);
    const bigCanvas = Buffer.from(gif);
    bigCanvas.writeUInt16LE(4096, 6);
    bigCanvas.writeUInt16LE(4096, 8);
    // 9 million pixels per frame is allowed. Two such frames exceed the total budget.
    const largeAnimation = Buffer.from(gif);
    largeAnimation.writeUInt16LE(3000, 6);
    largeAnimation.writeUInt16LE(3000, 8);
    for (const invalid of [gif.subarray(0, -1), Buffer.concat([gif, Buffer.from([0x3b])]), bigCanvas, largeAnimation, await gifFixture(2, 2, 121)]) {
      await expect(validateMedia(invalid, "image")).rejects.toMatchObject({ code: "MEDIA_INVALID" });
    }
  }, 15_000);
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
      const makeId3v24 = (payloadBytes: number) => {
        const header = Buffer.alloc(10);
        header.write("ID3", 0, "ascii");
        header[3] = 4; header[4] = 0; header[5] = 0;
        header[6] = (payloadBytes >> 21) & 0x7f; header[7] = (payloadBytes >> 14) & 0x7f;
        header[8] = (payloadBytes >> 7) & 0x7f; header[9] = payloadBytes & 0x7f;
        return Buffer.concat([header, Buffer.alloc(payloadBytes), track]);
      };
      const withLargeCoverArt = await validateMedia(makeId3v24(512 * 1024), "audio");
      expect(withLargeCoverArt.contentType).toBe("audio/mpeg");
      expect(withLargeCoverArt.original.equals(track)).toBe(true);
      await expect(validateMedia(makeId3v24(5 * 1024 * 1024), "audio")).rejects.toMatchObject({ code: "MEDIA_INVALID" });
      await expect(validateMedia(Buffer.concat(Array.from({length:1000},()=>track)), "audio")).rejects.toMatchObject({ code: "MEDIA_INVALID" });
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
});
