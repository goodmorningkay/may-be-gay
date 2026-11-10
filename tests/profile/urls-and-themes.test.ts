import { describe, expect, it } from "vitest";

import { createExampleProfile, profileDocumentSchema } from "@/domain/profile";

describe("navigation URL validation", () => {
  function parseUrl(url: unknown) {
    const profile = createExampleProfile();
    return profileDocumentSchema.safeParse({ ...profile, links: [{ ...profile.links[0], url }] });
  }

  it.each([
    "https://example.com",
    "http://example.org/path",
    "HTTPS://EXAMPLE.COM/CaseSensitive?query=a%20b&next=%2F#Section",
    "https://example.com:8443/path",
    "https://example.com/?text=%3Chello%3E",
    "https://example.com/path?email=a@example.org",
    "https://example.com/path/@name",
    "https://例え.jp/こんにちは",
    "http://[::1]:3000/path",
  ])("accepts and preserves %s", (url) => {
    const result = parseUrl(url);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.links[0].url).toBe(url);
  });

  it.each([
    "", "/relative", "//example.com", "example.com", "#fragment",
    "javascript:alert(1)", "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)",
    "file:///etc/passwd", "ftp://example.com/file", "mailto:a@example.com",
    "https:example.com", "https:/example.com", "https:///example.com", "https:////example.com",
    "https://", "https://?query", "https://#fragment", "https://example.com:99999/",
    "https://user@example.com", "https://user:pass@example.com",
    "https://:pass@example.com", "https://@example.com", "https://:@example.com",
    "https://user%40name@example.com",
    " https://example.com", "https://example.com ", "https://example.com/a b",
    "https://exa\tmple.com", "https://example.com/\npath", "https://example.com/\rpath",
    "https://example.com/\u0000", "https://example.com/\u001f", "https://example.com/\u007f",
    "https://example.com/\u0085", "https://example.com/\u009f",
    "https://example.com\\@evil.example", "https:\\example.com", "https://example.com/path\\file",
  ])("rejects unsafe or ambiguous URL %j", (url) => {
    expect(parseUrl(url).success).toBe(false);
  });

  it.each([false, null, 123, { url: "https://example.com" }])("does not coerce %j into a URL", (value) => {
    expect(parseUrl(value).success).toBe(false);
  });
});

describe("controlled appearance", () => {
  it.each(["paper", "midnight", "blush", "forest", "sunset", "ocean"])("accepts preset %s", (preset) => {
    const profile = createExampleProfile();
    expect(profileDocumentSchema.safeParse({ ...profile, theme: { ...profile.theme, preset } }).success).toBe(true);
  });

  it.each(["stack", "split"])("accepts layout %s", (layout) => {
    const profile = createExampleProfile();
    expect(profileDocumentSchema.safeParse({ ...profile, theme: { ...profile.theme, layout } }).success).toBe(true);
  });

  it.each(["sans", "serif", "mono"])("accepts system font option %s", (font) => {
    const profile = createExampleProfile();
    expect(profileDocumentSchema.safeParse({ ...profile, theme: { ...profile.theme, font } }).success).toBe(true);
  });

  it.each([
    { preset: "custom" }, { preset: "Paper" }, { preset: "url(https://example.com)" },
    { layout: "freeform" }, { layout: "" }, { font: "https://fonts.example.com/font.css" },
    { font: "Comic Sans MS" }, { css: "body{display:none}" }, { background: "#fff" },
  ])("rejects unrecognized or authored appearance %j", (theme) => {
    const profile = createExampleProfile();
    expect(profileDocumentSchema.safeParse({ ...profile, theme: { ...profile.theme, ...theme } }).success).toBe(false);
  });
});
