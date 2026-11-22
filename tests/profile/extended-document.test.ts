import { describe, expect, it } from "vitest";
import { contrastRatio, createExampleProfile, defaultProfileDocument, getProfileAssetIds, getPublicDocument, getThemeColors, getThemeContrast, profileDocumentSchema } from "@/domain/profile";

const image = "c87aa6c9-c504-4bf1-a8a1-00fde9bb5f01";
const audio = "735f4a7f-31fe-417f-a437-a617b490a832";

describe("additive v1 document contract", () => {
  it("reads legacy snapshots without adding fields or changing their appearance", () => {
    const legacy = createExampleProfile();
    expect(profileDocumentSchema.parse(legacy)).toEqual(legacy);
    expect(Object.keys(profileDocumentSchema.parse(legacy).theme)).toEqual(["preset", "layout", "font"]);
    expect(getProfileAssetIds(legacy)).toEqual([]);
  });
  it("deduplicates canonical owned asset IDs and does not mutate authored content", () => {
    const doc = { ...defaultProfileDocument, avatarAssetId: image.toUpperCase(), backgroundAssetId: image, music: { assetId: audio, attribution: "Music by Example, used with permission" } };
    expect(getProfileAssetIds(doc)).toEqual([image, audio]);
    expect(doc.avatarAssetId).toBe(image.toUpperCase());
    expect(getProfileAssetIds({ ...defaultProfileDocument, avatarAssetId: null, backgroundAssetId: null, music: null })).toEqual([]);
  });
  it("keeps deliberate public contact separate and supports safe icon selections", () => {
    const doc = createExampleProfile();
    doc.contact = { email: "public@example.com" };
    doc.links[0].icon = "github";
    doc.links[1].icon = "twitter";
    doc.links[2].icon = "x";
    expect(getPublicDocument(doc).contact?.email).toBe("public@example.com");
    expect(getPublicDocument(doc).links.map((link) => link.icon)).toEqual(["github", "twitter", "x"]);
    for (const email of ["bad", "person@example.com?subject=evil", "a\nb@example.com", "x%0a@example.com"]) {
      expect(profileDocumentSchema.safeParse({ ...doc, contact: { email } }).success).toBe(false);
    }
    expect(profileDocumentSchema.safeParse({ ...doc, links: [{ ...doc.links[0], icon: "<svg/onload=evil()>" }] }).success).toBe(false);
  });
  it("allows Discord links to store a username instead of a URL while rejecting blank or control-character handles", () => {
    const doc = createExampleProfile();
    for (const handle of ["alex_dev", "@alex.example", "Alex#1234", "a".repeat(100)]) {
      const parsed = profileDocumentSchema.safeParse({
        ...doc,
        links: [{ ...doc.links[0], icon: "discord", label: "Discord", url: handle }],
      });
      expect(parsed.success, handle).toBe(true);
      if (parsed.success) expect(parsed.data.links[0].url).toBe(handle);
    }
    for (const bad of ["", "   ", "alex\nname", "alex\u0000name", "a".repeat(101)]) {
      const parsed = profileDocumentSchema.safeParse({
        ...doc,
        links: [{ ...doc.links[0], icon: "discord", label: "Discord", url: bad }],
      });
      expect(parsed.success, JSON.stringify(bad)).toBe(false);
      if (!parsed.success) expect(parsed.error.issues[0]?.path.join(".")).toBe("links.0.url");
    }
    // Non-Discord icons still require a complete HTTP/HTTPS URL.
    expect(profileDocumentSchema.safeParse({
      ...doc,
      links: [{ ...doc.links[0], icon: "github", label: "GitHub", url: "alex_dev" }],
    }).success).toBe(false);
  });
  it.each([
    { avatarAssetId: "https://evil.example/avatar.png" },
    { backgroundAssetId: "data:image/png,evil" },
    { music: { assetId: audio, attribution: " " } },
    { music: { assetId: audio, attribution: "x", autoplay: true } },
    { contact: { email: "public@example.com", phone: "123" } },
  ])("rejects unowned-reference syntax and unexpected settings %j", (fields) => {
    expect(profileDocumentSchema.safeParse({ ...defaultProfileDocument, ...fields }).success).toBe(false);
  });
  it("accepts controlled appearance options, rejects active CSS and arbitrary values", () => {
    const theme = { ...defaultProfileDocument.theme, colors: { background: "#010203", surface: "#ffffff", ink: "#123456", accent: "#aabbcc" },
      button: "pill", background: { kind: "gradient", from: "#010203", to: "#aabbcc", direction: "diagonal" }, overlay: "dark", spacing: "airy" };
    expect(profileDocumentSchema.safeParse({ ...defaultProfileDocument, theme }).success).toBe(true);
    for (const field of [
      { colors: { ink: "red; background:url(https://evil.example)" } }, { colors: { custom: "#ffffff" } },
      { background: { kind: "gradient", from: "#fff", to: "#ffffff", direction: "diagonal" } },
      { overlay: 0.5 }, { spacing: "100px" }, { button: "url(evil)" }, { font: "https://evil.example/font" },
    ]) expect(profileDocumentSchema.safeParse({ ...defaultProfileDocument, theme: { ...theme, ...field } }).success).toBe(false);
  });
  it("provides contrast feedback for presets and custom colors", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBe(21);
    expect(contrastRatio("#ffffff", "#ffffff")).toBe(1);
    expect(getThemeContrast(defaultProfileDocument.theme).readable).toBe(true);
    expect(getThemeContrast({ ...defaultProfileDocument.theme, colors: { ink: "#fffdf7" } }).readable).toBe(false);
    expect(getThemeColors({ ...defaultProfileDocument.theme, colors: { ink: "#111111" } }).muted).toBe("#111111");
    expect(getThemeColors({ ...defaultProfileDocument.theme, colors: { accent: "#333333" } }).border).toBe("#333333");
    expect(getThemeColors({ ...defaultProfileDocument.theme, preset: "midnight", colors: { ink: "#ffffff" } }).border).toBe("#6d7a91");
    expect(() => contrastRatio("url(evil)", "#ffffff")).toThrow();
  });
});
