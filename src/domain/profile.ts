import { z } from "zod";

/** Validate navigation targets without rewriting them or contacting the host. */
export const linkUrlSchema = z.string().max(2048).refine(
  (value) => {
    // WHATWG URL parsing can discard controls/whitespace and interpret slashes.
    // Reject those inputs before parsing rather than silently repairing them.
    if (/[\s\u0000-\u001f\u007f-\u009f\\]/u.test(value)) return false;

    const authority = /^https?:\/\/([^/?#]+)/i.exec(value)?.[1];
    if (!authority || authority.includes("@")) return false;

    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        url.hostname.length > 0 &&
        url.username === "" &&
        url.password === ""
      );
    } catch {
      return false;
    }
  },
  "Use a complete HTTP or HTTPS URL without credentials, whitespace, controls or backslashes.",
);

export const socialLinkIcons = [
  "website",
  "github",
  "instagram",
  "mastodon",
  "bluesky",
  "twitter",
  "x",
  "youtube",
  "twitch",
  "linkedin",
  "spotify",
] as const;

const linkSchema = z
  .object({
    id: z.string().uuid(),
    label: z.string().min(1).max(100),
    url: linkUrlSchema,
    visible: z.boolean(),
    icon: z.enum(socialLinkIcons).optional(),
  })
  .strict();

export const hexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i, "Use a six-digit hex colour.");

export const profileDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    displayName: z.string().min(1).max(80),
    pronouns: z.string().max(50),
    bio: z.string().max(500),
    // Public contact is deliberately separate from the account's login email.
    contact: z.object({
      email: z.string().max(254).email().refine((value) => !/[\s\u0000-\u001f\u007f-\u009f?&#%]/u.test(value)),
    }).strict().nullable().optional(),
    avatarAssetId: z.string().uuid().nullable().optional(),
    backgroundAssetId: z.string().uuid().nullable().optional(),
    music: z.object({
      assetId: z.string().uuid(),
      attribution: z.string().min(1).max(300).refine((value) => value.trim().length > 0, "Supply music rights / attribution."),
    }).strict().nullable().optional(),
    clickToEnter: z.boolean().optional(),
    links: z.array(linkSchema).max(30),
    theme: z
      .object({
        preset: z.enum(["paper", "midnight", "blush", "forest", "sunset", "ocean"]),
        layout: z.enum(["stack", "split"]),
        font: z.enum(["sans", "serif", "mono"]),
        colors: z.object({
          background: hexColorSchema.optional(),
          surface: hexColorSchema.optional(),
          ink: hexColorSchema.optional(),
          accent: hexColorSchema.optional(),
        }).strict().optional(),
        button: z.enum(["preset", "square", "rounded", "pill"]).optional(),
        background: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("solid"), color: hexColorSchema }).strict(),
          z.object({ kind: z.literal("gradient"), from: hexColorSchema, to: hexColorSchema,
            direction: z.enum(["down", "right", "diagonal"]) }).strict(),
        ]).optional(),
        overlay: z.enum(["none", "light", "dark"]).optional(),
        spacing: z.enum(["compact", "comfortable", "airy"]).optional(),
      })
      .strict(),
    pageTitle: z.string().max(100),
    pageDescription: z.string().max(200),
    allowIndexing: z.boolean(),
  })
  .strict()
  .superRefine((document, context) => {
    const ids = new Set<string>();
    document.links.forEach((link, index) => {
      // UUID hex is case-insensitive; changing case must not evade uniqueness.
      const id = link.id.toLowerCase();
      if (ids.has(id)) {
        context.addIssue({
          code: "custom",
          path: ["links", index, "id"],
          message: "Each link must have a unique ID.",
        });
      }
      ids.add(id);
    });
  });

export type ProfileDocument = z.infer<typeof profileDocumentSchema>;

/** Validate the entire stored snapshot before selecting its public links. */
export function getPublicDocument(value: unknown): ProfileDocument {
  const document = profileDocumentSchema.parse(value);
  return { ...document, links: document.links.filter((link) => link.visible) };
}

export const defaultProfileDocument: ProfileDocument = profileDocumentSchema.parse({
  schemaVersion: 1,
  displayName: "Your name",
  pronouns: "",
  bio: "A little about you, and the places you’d like to share.",
  links: [],
  theme: { preset: "paper", layout: "stack", font: "sans" },
  pageTitle: "Your name",
  pageDescription: "",
  allowIndexing: false,
});

/** A fresh, explicitly fictional sample; example domains do not claim a user. */
export function createExampleProfile(): ProfileDocument {
  return profileDocumentSchema.parse({
    schemaVersion: 1,
    displayName: "Alex Example",
    pronouns: "they / them",
    bio: "A fictional profile for a person who makes things, collects small discoveries, and likes a good walk. This is a demonstration, not a real account.",
    links: [
      {
        id: "9bcefb7c-f0df-4ed5-a8f6-d93f77cb6d61",
        label: "Things I make",
        url: "https://example.com/work",
        visible: true,
      },
      {
        id: "fb21f232-b964-447c-b873-35d844735e0d",
        label: "Notes & small discoveries",
        url: "https://example.org/journal",
        visible: true,
      },
      {
        id: "884c11c6-38b7-44d6-a433-870725106439",
        label: "Say hello",
        url: "https://example.net/hello",
        visible: true,
      },
    ],
    theme: { preset: "forest", layout: "stack", font: "serif" },
    pageTitle: "Alex Example · Fictional demo",
    pageDescription: "A fictional example of a may-be.gay profile. No real account is represented.",
    allowIndexing: false,
  });
}

/** Canonical UUID keys match PostgreSQL UUID spelling and media resolver maps. */
export function getProfileAssetIds(document: ProfileDocument): string[] {
  const parsed = profileDocumentSchema.parse(document);
  return [...new Set([parsed.avatarAssetId, parsed.backgroundAssetId, parsed.music?.assetId]
    .filter((id): id is string => Boolean(id)).map((id) => id.toLowerCase()))];
}

export const profilePalettes = {
  paper: { background: "#f5f1e7", surface: "#fffdf7", ink: "#252923", muted: "#626258", border: "#8e8b7b", accent: "#39523e", focus: "#255ca2" },
  midnight: { background: "#171b24", surface: "#232a38", ink: "#f2eee5", muted: "#bac1d0", border: "#6d7a91", accent: "#cad8ff", focus: "#a7c6ff" },
  blush: { background: "#f7e9eb", surface: "#fff8f7", ink: "#482632", muted: "#79505a", border: "#a37483", accent: "#91425c", focus: "#662a65" },
  forest: { background: "#e9eee7", surface: "#f7faf3", ink: "#203d2f", muted: "#4b6656", border: "#758d78", accent: "#2f6143", focus: "#205d9b" },
  sunset: { background: "#f9e4ce", surface: "#fff3e5", ink: "#4c2e25", muted: "#7d4f40", border: "#a87651", accent: "#a34420", focus: "#704017" },
  ocean: { background: "#e7f0f4", surface: "#f5fbff", ink: "#193c50", muted: "#486475", border: "#6e8e9f", accent: "#1c617f", focus: "#164a9f" },
} as const;

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

export function getThemeColors(theme: ProfileDocument["theme"]) {
  const base = profilePalettes[theme.preset];
  return { ...base, ...theme.colors,
    ...(theme.colors?.ink ? { muted: theme.colors.ink } : {}),
    ...(theme.colors?.accent ? { border: theme.colors.accent } : {}),
    ...(theme.background?.kind === "solid" ? { background: theme.background.color } : {}),
  };
}

/** Feedback is advisory; uploaded imagery cannot have a guaranteed contrast ratio. */
export function getThemeContrast(theme: ProfileDocument["theme"]) {
  const colors = getThemeColors(theme);
  const backgrounds = theme.background?.kind === "gradient"
    ? [theme.background.from, theme.background.to, colors.surface] : [colors.background, colors.surface];
  return {
    text: Math.min(...backgrounds.flatMap((bg) => [colors.ink, colors.muted, colors.accent].map((fg) => contrastRatio(fg, bg)))),
    boundaries: Math.min(...backgrounds.flatMap((bg) => [colors.border, colors.focus].map((fg) => contrastRatio(fg, bg)))),
    get readable() { return this.text >= 4.5; },
  };
}
