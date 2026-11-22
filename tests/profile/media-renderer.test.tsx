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
  document.links[1].icon = "twitter";
  document.links[2].icon = "x";
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
    expect(html).toContain('data-icon="twitter"');
    expect(html).toContain('data-icon="x"');
  });
  it("leaves ordinary links working without loading media or running JS", () => {
    const html = render();
    expect(html).toMatch(/<audio\b[^>]*controls=""[^>]*preload="none"/);
    expect(html).not.toMatch(/autoplay|<script\b|onclick=/i);
    expect(html).toContain('href="https://example.com/work"');
    expect(html.indexOf("<audio")).toBeGreaterThan(html.indexOf("</nav>"));
    expect(html).toContain("&lt;b&gt;Example Music&lt;/b&gt; · CC BY");
    expect(html).not.toContain("Rights / attribution:");
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
    document.theme = { ...document.theme, colors: { ink: "#112233", accent: "#333333" }, button: "pill", spacing: "compact", overlay: "dark",
      background: { kind: "gradient", from: "#ffffff", to: "#eeeeee", direction: "diagonal" } };
    const html = render(document);
    expect(html).toContain("--ink:#112233");
    expect(html).toContain("--accent:#333333");
    expect(html).toContain("--border:#333333");
    expect(html).toContain("linear-gradient(135deg, #ffffff, #eeeeee)");
    expect(html).toContain('data-button="pill"');
    expect(html).toContain('data-spacing="compact"');
  });
  it("defaults to 20% volume with guarded autoplay and provides focus and contrast support", () => {
    const source = readFileSync(new URL("../../src/components/music-player.tsx", import.meta.url), "utf8");
    expect(source).toContain("DEFAULT_VOLUME = 0.2");
    expect(source).toMatch(/el\.volume = DEFAULT_VOLUME/);
    expect(source).toMatch(/async function toggle\(\)[\s\S]*await audio.current.play/);
    expect(source).not.toMatch(/autoPlay/);
    const css = readFileSync(new URL("../../src/components/music-player.module.css", import.meta.url), "utf8");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("forced-colors");
  });
  it("renders a no-JS-safe click-to-enter overlay only when enabled and plays profile music on click", () => {
    expect(render()).not.toContain("Click to enter");
    const withMusic = { ...fixture(), clickToEnter: true };
    const htmlWithMusic = render(withMusic);
    expect(htmlWithMusic).toContain('role="dialog"');
    expect(htmlWithMusic).toContain('aria-modal="true"');
    expect(htmlWithMusic).toContain('hidden=""');
    expect(htmlWithMusic).toContain("Click to enter · plays music");
    expect(htmlWithMusic).toContain('data-profile-music="true"');

    const withoutMusic = { ...createExampleProfile(), clickToEnter: true };
    const htmlWithoutMusic = render(withoutMusic, {});
    expect(htmlWithoutMusic).toContain("Click to enter");
    expect(htmlWithoutMusic).not.toContain("plays music");

    const source = readFileSync(new URL("../../src/components/click-to-enter.tsx", import.meta.url), "utf8");
    expect(source).toContain('audio[data-profile-music]');
    expect(source).toContain("audio.play()");
    const css = readFileSync(new URL("../../src/components/click-to-enter.module.css", import.meta.url), "utf8");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("forced-colors");
  });
});
