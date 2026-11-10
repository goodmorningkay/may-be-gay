import { describe, expect, it } from "vitest";

import {
  createExampleProfile,
  defaultProfileDocument,
  getPublicDocument,
  profileDocumentSchema,
} from "@/domain/profile";

describe("profile document v1", () => {
  it("provides complete valid defaults with indexing off", () => {
    expect(profileDocumentSchema.parse(defaultProfileDocument)).toEqual(defaultProfileDocument);
    expect(defaultProfileDocument.schemaVersion).toBe(1);
    expect(defaultProfileDocument.allowIndexing).toBe(false);
    expect(defaultProfileDocument.links).toEqual([]);
  });

  it("returns independent, explicitly fictional demo documents", () => {
    const first = createExampleProfile();
    const second = createExampleProfile();
    expect(profileDocumentSchema.parse(first)).toEqual(first);
    expect(first.bio).toMatch(/fictional/i);
    expect(first.pageTitle).toMatch(/fictional/i);
    expect(first.allowIndexing).toBe(false);
    expect(first.links.every((link) => /^https:\/\/example\.(com|org|net)\//.test(link.url))).toBe(true);
    first.links[0].label = "Changed";
    first.theme.preset = "midnight";
    expect(second.links[0].label).not.toBe("Changed");
    expect(second.theme.preset).toBe("forest");
  });

  it.each([
    ["displayName", 1, 80],
    ["pronouns", 0, 50],
    ["bio", 0, 500],
    ["pageTitle", 0, 100],
    ["pageDescription", 0, 200],
  ] as const)("enforces %s length boundaries without truncation", (field, minimum, maximum) => {
    for (const length of [minimum, maximum]) {
      const input = { ...createExampleProfile(), [field]: "x".repeat(length) };
      expect(profileDocumentSchema.parse(input)[field]).toBe(input[field]);
    }
    expect(profileDocumentSchema.safeParse({ ...createExampleProfile(), [field]: "x".repeat(maximum + 1) }).success).toBe(false);
    if (minimum > 0) {
      expect(profileDocumentSchema.safeParse({ ...createExampleProfile(), [field]: "" }).success).toBe(false);
    }
  });

  it("preserves authored whitespace, case, line breaks and link order", () => {
    const input = createExampleProfile();
    input.displayName = "  Alex Example  ";
    input.bio = "First line\n\nSecond line  ";
    input.links[0].label = " My work ";
    input.links[0].url = "HTTPS://EXAMPLE.COM/work?text=a%20b#Section";
    expect(profileDocumentSchema.parse(input)).toEqual(input);
  });

  it.each([0, 2, "1", null])("rejects unsupported version %j", (schemaVersion) => {
    expect(profileDocumentSchema.safeParse({ ...createExampleProfile(), schemaVersion }).success).toBe(false);
  });

  it("requires every field rather than applying implicit defaults", () => {
    for (const field of Object.keys(defaultProfileDocument)) {
      const input: Record<string, unknown> = { ...defaultProfileDocument };
      delete input[field];
      expect(profileDocumentSchema.safeParse(input).success, field).toBe(false);
    }
  });

  it.each([null, undefined, [], "profile", 1, true])("rejects non-document input %j", (input) => {
    expect(profileDocumentSchema.safeParse(input).success).toBe(false);
  });

  it.each(["html", "css", "javascript", "avatarUrl", "backgroundImage", "music", "embeds", "ownerId"])(
    "rejects unknown document field %s instead of dropping it",
    (field) => {
      expect(profileDocumentSchema.safeParse({ ...createExampleProfile(), [field]: "untrusted" }).success).toBe(false);
    },
  );

  it("rejects unknown nested fields and wrong field types", () => {
    const profile = createExampleProfile();
    for (const theme of [{ ...profile.theme, css: "body{}" }, { ...profile.theme, preset: 1 }]) {
      expect(profileDocumentSchema.safeParse({ ...profile, theme }).success).toBe(false);
    }
    for (const link of [
      { ...profile.links[0], onClick: "alert(1)" },
      { ...profile.links[0], visible: "true" },
      { ...profile.links[0], label: 123 },
      { ...profile.links[0], url: null },
    ]) {
      expect(profileDocumentSchema.safeParse({ ...profile, links: [link] }).success).toBe(false);
    }
    expect(profileDocumentSchema.safeParse({ ...profile, allowIndexing: "false" }).success).toBe(false);
  });
});

describe("links and public projection", () => {
  it("allows zero through thirty links, but never silently drops a 31st", () => {
    const profile = createExampleProfile();
    const links = Array.from({ length: 31 }, (_, index) => ({
      ...profile.links[0],
      id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    }));
    expect(profileDocumentSchema.safeParse({ ...profile, links: [] }).success).toBe(true);
    expect(profileDocumentSchema.parse({ ...profile, links: links.slice(0, 30) }).links).toHaveLength(30);
    expect(profileDocumentSchema.safeParse({ ...profile, links }).success).toBe(false);
  });

  it("requires UUIDs and unique IDs, including hidden links and mixed case", () => {
    const profile = createExampleProfile();
    const first = profile.links[0];
    for (const id of ["", "not-a-uuid", "../../x"]) {
      expect(profileDocumentSchema.safeParse({ ...profile, links: [{ ...first, id }] }).success).toBe(false);
    }
    for (const id of [first.id, first.id.toUpperCase()]) {
      const duplicate = { ...first, id, visible: false };
      const result = profileDocumentSchema.safeParse({ ...profile, links: [first, duplicate] });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path.join(".") === "links.1.id")).toBe(true);
      }
    }
  });

  it("enforces link label bounds", () => {
    const profile = createExampleProfile();
    for (const length of [1, 100]) {
      profile.links[0].label = "x".repeat(length);
      expect(profileDocumentSchema.safeParse(profile).success).toBe(true);
    }
    for (const length of [0, 101]) {
      profile.links[0].label = "x".repeat(length);
      expect(profileDocumentSchema.safeParse(profile).success).toBe(false);
    }
  });

  it("removes hidden entries entirely from serializable output, preserving visible order", () => {
    const input = createExampleProfile();
    input.links[1] = { ...input.links[1], visible: false, url: "https://example.org/private-secret", label: "Hidden label" };
    const before = JSON.stringify(input);
    const output = getPublicDocument(input);
    expect(output.links.map((link) => link.id)).toEqual([input.links[0].id, input.links[2].id]);
    expect(JSON.stringify(output)).not.toContain("private-secret");
    expect(JSON.stringify(output)).not.toContain("Hidden label");
    expect(JSON.stringify(output)).not.toContain(input.links[1].id);
    expect(JSON.stringify(input)).toBe(before);
    expect(profileDocumentSchema.parse(output)).toEqual(output);
    output.links[0].label = "Changed";
    output.theme.preset = "ocean";
    expect(input.links[0].label).not.toBe("Changed");
    expect(input.theme.preset).toBe("forest");
  });

  it("validates the complete persisted snapshot before filtering hidden links", () => {
    const profile = createExampleProfile();
    profile.links[0] = { ...profile.links[0], visible: false, url: "javascript:alert(1)" };
    expect(() => getPublicDocument(profile)).toThrow();
    expect(() => getPublicDocument({ ...createExampleProfile(), privateData: "unknown" })).toThrow();
  });
});
