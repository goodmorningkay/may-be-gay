import { z } from "zod";

export const hexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i, "Use a six-digit hex colour.");

export function relativeLuminance(color: string): number {
  hexColorSchema.parse(color);
  const [r, g, b] = [1, 3, 5].map((offset) => {
    const c = parseInt(color.slice(offset, offset + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

export function contrastRatio(first: string, second: string): number {
  const a = relativeLuminance(first), b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
