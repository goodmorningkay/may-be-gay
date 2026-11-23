import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ProfileView } from "@/components/profile-view";
import { createExampleProfile, defaultProfileDocument, type ProfileDocument } from "@/domain/profile";

function render(document = createExampleProfile(), username = "example", siteDomain = "may-be.gay") {
  return renderToStaticMarkup(<ProfileView document={document} username={username} siteDomain={siteDomain} />);
}

describe("public profile renderer", () => {
  it("renders a heading and ordered native links that work without JavaScript", () => {
    const profile = createExampleProfile();
    const html = render(profile);
    expect(html).toMatch(/<main\b/);
    expect(html).toMatch(/<h1\b[^>]*>Alex Example<\/h1>/);
    expect(html).toMatch(/<nav\b[^>]*aria-label="Profile links"/);
    expect(html).toContain("<ul");
    expect(html.match(/<li>/g)).toHaveLength(profile.links.length);
    let position = -1;
    for (const link of profile.links) {
      const next = html.indexOf(`href="${link.url}"`);
      expect(next).toBeGreaterThan(position);
      position = next;
    }
    expect(html).toContain('aria-hidden="true">→');
    expect(html).not.toMatch(/<(button|script)\b|onclick=|tabindex=|target=|role="button"/i);
  });

  it("escapes authored markup, including display names, pronouns, bios, labels and username", () => {
    const profile = createExampleProfile();
    profile.displayName = '<img src=x onerror="alert(1)">';
    profile.pronouns = "<b>they & them</b>";
    profile.bio = '<script>alert("bio")</script>\nA & B';
    profile.links[0].label = "<svg/onload=alert(1)> & friends";
    const html = render(profile, '<script>alert("username")</script>');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(html).toContain("&lt;b&gt;they &amp; them&lt;/b&gt;");
    expect(html).toContain('&lt;script&gt;alert(&quot;bio&quot;)&lt;/script&gt;');
    expect(html).toContain("&lt;svg/onload=alert(1)&gt; &amp; friends");
    expect(html).toContain('@&lt;script&gt;alert(&quot;username&quot;)&lt;/script&gt;');
    expect(html).not.toMatch(/<(img|script|svg)\b/i);
  });

  it("escapes URL attribute characters while retaining the actual destination", () => {
    const profile = createExampleProfile();
    profile.links[0].url = 'https://example.com/?a=1&text="hello"';
    expect(render(profile)).toContain('href="https://example.com/?a=1&amp;text=&quot;hello&quot;"');
  });

  it("never includes hidden destinations, labels or IDs in HTML", () => {
    const profile = createExampleProfile();
    profile.links[0] = { ...profile.links[0], visible: false, url: "https://example.com/secret", label: "Private destination" };
    const html = render(profile);
    expect(html).not.toContain("/secret");
    expect(html).not.toContain("Private destination");
    expect(html).not.toContain(profile.links[0].id);
    expect(html.match(/<li>/g)).toHaveLength(2);
  });

  it("renders escaped embed titles and fallback links below the profile links before loading a frame", () => {
    const profile = createExampleProfile();
    profile.embeds = [{ id: "9bcefb7c-f0df-4ed5-a8f6-d93f77cb6d61", title: "<b>Recent tracks</b>", url: "https://www.last.fm/user/Petra1999" }];
    const html = render(profile);
    expect(html.indexOf('aria-label="Profile embeds"')).toBeGreaterThan(html.indexOf('aria-label="Profile links"'));
    expect(html).toContain("&lt;b&gt;Recent tracks&lt;/b&gt;");
    expect(html).toContain('href="https://www.last.fm/user/Petra1999"');
    expect(html).not.toContain("<iframe");
  });

  it("rejects invalid runtime data even if a caller bypasses TypeScript", () => {
    const profile = createExampleProfile();
    expect(() => render({ ...profile, html: "<script>" } as ProfileDocument)).toThrow();
    profile.links[0].url = "javascript:alert(1)";
    profile.links[0].visible = false;
    expect(() => render(profile)).toThrow();
  });

  it("has a useful empty state and retains platform/support access without links", () => {
    const html = render(defaultProfileDocument);
    expect(html).toContain("No public links yet.");
    expect(html).not.toContain("<nav");
    expect(html).toContain('<a href="https://may-be.gay">may-be.gay</a>');
    expect(html).toMatch(/href="https:\/\/may-be\.gay\/support"[^>]*>Report this page or get support<\/a>/);
  });

  it("derives platform links from the caller's apex domain, never the username", () => {
    const html = render(createExampleProfile(), "someone", "may-be.test:3443");
    expect(html).toContain('href="https://may-be.test:3443"');
    expect(html).toContain('href="https://may-be.test:3443/support"');
    expect(html).toContain("@someone");
    expect(html).not.toContain('href="https://someone.');
  });

  it.each([
    "javascript:alert(1)", "https://may-be.gay", "may-be.gay@evil.example", "may-be.gay/evil",
    "may-be.gay?redirect=evil", "may-be.gay#fragment", "may-be.gay\\evil", "may-be.gay\n",
    'may-be.gay\" onmouseover=\"alert(1)',
  ])("rejects origin-changing platform input %j", (siteDomain) => {
    expect(() => render(createExampleProfile(), "example", siteDomain)).toThrow();
  });

  it("never fetches destinations or introduces media, embeds, inline styles or scripts", () => {
    const fetch = vi.fn(() => { throw new Error("Renderer must not fetch destinations"); });
    vi.stubGlobal("fetch", fetch);
    try {
      const html = render();
      expect(fetch).not.toHaveBeenCalled();
      expect(html).not.toMatch(/<(script|iframe|img|audio|video|object|embed|style)\b|style=|autoplay|preload=/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("renders all six presets, both layouts and all three font choices", () => {
    const presets = ["paper", "midnight", "blush", "forest", "sunset", "ocean"] as const;
    const layouts = ["stack", "split"] as const;
    const fonts = ["sans", "serif", "mono"] as const;
    for (const preset of presets) {
      for (const layout of layouts) {
        for (const font of fonts) {
          const profile = createExampleProfile();
          profile.theme = { preset, layout, font };
          const html = render(profile);
          expect(html).toContain(`data-preset="${preset}"`);
          expect(html).toContain(`data-layout="${layout}"`);
          expect(html).toContain(`data-font="${font}"`);
          expect(html).toContain('href="https://example.com/work"');
          expect(html).toContain('href="https://may-be.gay/support"');
        }
      }
    }
  });
});
