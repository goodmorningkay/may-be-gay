import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../../src/components/profile-view.module.css", import.meta.url), "utf8");
const palettes = new Map(
  [...css.matchAll(/\.profile\[data-preset="([^"]+)"\]\s*\{([^}]+)\}/g)].map(([, preset, body]) => [
    preset,
    Object.fromEntries([...body.matchAll(/--([a-z]+):\s*(#[a-f0-9]{6})/gi)].map(([, key, value]) => [key, value])),
  ]),
);

function luminance(hex: string): number {
  const [red, green, blue] = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function contrast(first: string, second: string): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("preset accessibility contracts", () => {
  it.each(["paper", "midnight", "blush", "forest", "sunset", "ocean"])(
    "%s has complete CSS, readable text, visible boundaries and a contrasting focus indicator",
    (preset) => {
      const palette = palettes.get(preset);
      expect(palette).toBeDefined();
      if (!palette) throw new Error(`Missing preset: ${preset}`);
      for (const background of ["background", "surface"]) {
        for (const foreground of ["ink", "muted", "accent"]) {
          expect(contrast(palette[foreground], palette[background]), `${preset}: ${foreground}/${background}`).toBeGreaterThanOrEqual(4.5);
        }
        for (const foreground of ["focus", "border"]) {
          expect(contrast(palette[foreground], palette[background]), `${preset}: ${foreground}/${background}`).toBeGreaterThanOrEqual(3);
        }
      }
    },
  );

  it("keeps platform footer links aligned with the footer text color instead of accent", () => {
    expect(css).toMatch(/\.footer\s*\{[^}]*color:\s*var\(--muted\)/);
    expect(css).toMatch(/\.footer a\s*\{[^}]*color:\s*inherit/);
  });

  it("includes keyboard focus and disables hover motion for reduced-motion visitors", () => {
    expect(css).toMatch(/a:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--focus\)/);
    const reducedMotion = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reducedMotion).toMatch(/\.link\s*\{[^}]*transition:\s*none/);
    expect(reducedMotion).toMatch(/\.link:hover\s*\{[^}]*transform:\s*none/);
    expect(css).not.toMatch(/@import|@font-face|url\(/i);
  });
});
