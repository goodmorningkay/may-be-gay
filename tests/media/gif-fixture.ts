import sharp from "sharp";

export async function gifFixture(width = 1500, height = 240, frames = 2, loop = 0) {
  const frameBytes = width * height * 3;
  const pixels = Buffer.alloc(frameBytes * frames);
  for (let frame = 0; frame < frames; frame++) {
    const channel = frame % 2 === 0 ? 0 : 2;
    for (let i = frame * frameBytes; i < (frame + 1) * frameBytes; i += 3) pixels[i + channel] = 255;
  }
  return sharp(pixels, { raw: { width, height: height * frames, pageHeight: height, channels: 3 } })
    .gif({ delay: [300, 500], loop }).toBuffer();
}
