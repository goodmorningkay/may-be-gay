import * as React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PublicMediaMap } from "@/domain/media";
import { ProfileView } from "@/components/profile-view";
import { createExampleProfile } from "@/domain/profile";

const avatarId = "c87aa6c9-c504-4bf1-a8a1-00fde9bb5f01";
const bgId = "715f4a7f-31fe-417f-a437-a617b490a832";
const musicId = "735f4a7f-31fe-417f-a437-a617b490a832";
function fixture() {
  const document = createExampleProfile();
  Object.assign(document, { avatarAssetId: avatarId, backgroundAssetId: bgId, music: { assetId: musicId, attribution: '<b>Example Music</b> · CC BY' }, contact: { email: "public@example.com" } });
  document.links[0].icon = "github";
  return document;
}
const media = {
  [avatarId]: { url: "https://media.example.com/avatar.webp", contentType: "image/webp" },
  [bgId]: { url: "https://media.example.com/background.webp", contentType: "image/webp" },
  [musicId]: { url: "https://media.example.com/music.mp3", contentType: "audio/mpeg" },
};
const render = (document = fixture(), assets: PublicMediaMap = media) => renderToStaticMarkup(<ProfileView document={document} media={assets} username="example" siteDomain="may-be.gay" />);

describe("owned media renderer", () => {
  it("renders images and explicit public contact from resolver values", () => {
    const html = render();
    expect(html).toContain('src="https://media.example.com/avatar.webp"');
    expect(html).toContain('src="https://media.example.com/background.webp"');
    expect(html).toContain('alt="" aria-hidden="true"');
    expect(html).toContain('href="mailto:public@example.com"');
    expect(html).toContain('data-icon="github"');
  });
  it("leaves ordinary links working without loading media or running JS", () => {
    const html = render();
    expect(html).toMatch(/<audio\b[^>]*controls=""[^>]*preload="none"/);
    expect(html).not.toMatch(/autoplay|<script\b|onclick=/i);
    expect(html).toContain('href="https://example.com/work"');
    expect(html).toContain("Rights / attribution: &lt;b&gt;Example Music&lt;/b&gt;");
    // Native controls are the no-JS fallback; custom controls appear on hydration.
    expect(html).toContain('aria-label="Play music"');
    expect(html).toContain('type="range"');
    expect(html).toContain("Volume");
  });
  it("uses owner-authorized same-origin URLs in private preview", () => {
    expect(render(fixture(), { ...media, [musicId]: { contentType: "audio/mpeg", url: `/api/media/${musicId}/content` } })).toContain(`src="/api/media/${musicId}/content"`);
  });
  it("omits unresolved assets and rejects active URLs or mismatched types", () => {
    const html = render(fixture(), {});
    expect(html).not.toMatch(/<(img|audio)\b/);
    for (const url of ["javascript:alert(1)", "data:text/html,evil", "//evil.example/a", "/api/media/../../secret"]) {
      expect(render(fixture(), { [avatarId]: { contentType: "image/webp", url } })).not.toContain("<img");
    }
    expect(render(fixture(), { [avatarId]: { contentType: "audio/mpeg", url: media[musicId].url } })).not.toContain("<img");
  });
  it("only emits validated CSS values, and legacy snapshots have no inline styles", () => {
    expect(render(createExampleProfile(), {})).not.toContain("style=");
    const document = fixture();
    document.theme = { ...document.theme, colors: { ink: "#112233" }, button: "pill", spacing: "compact", overlay: "dark",
      background: { kind: "gradient", from: "#ffffff", to: "#eeeeee", direction: "diagonal" } };
    const html = render(document);
    expect(html).toContain("--ink:#112233");
    expect(html).toContain("linear-gradient(135deg, #ffffff, #eeeeee)");
    expect(html).toContain('data-button="pill"');
    expect(html).toContain('data-spacing="compact"');
  });
  it("only starts playback from the play action and provides focus and contrast support", () => {
    const source = readFileSync(new URL("../../src/components/music-player.tsx", import.meta.url), "utf8");
    expect(source.match(/\.play\(/g)).toHaveLength(1);
    expect(source).toMatch(/async function toggle\(\)[\s\S]*await audio.current.play/);
    expect(source).not.toMatch(/useEffect|autoPlay/);
    const css = readFileSync(new URL("../../src/components/music-player.module.css", import.meta.url), "utf8");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("forced-colors");
  });
});
