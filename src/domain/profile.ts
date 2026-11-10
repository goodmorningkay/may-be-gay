import { z } from "zod";

/** Validate navigation targets without rewriting them or contacting the host. */
const linkUrlSchema = z.string().max(2048).refine(
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

const linkSchema = z
  .object({
    id: z.string().uuid(),
    label: z.string().min(1).max(100),
    url: linkUrlSchema,
    visible: z.boolean(),
  })
  .strict();

export const profileDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    displayName: z.string().min(1).max(80),
    pronouns: z.string().max(50),
    bio: z.string().max(500),
    links: z.array(linkSchema).max(30),
    theme: z
      .object({
        preset: z.enum(["paper", "midnight", "blush", "forest", "sunset", "ocean"]),
        layout: z.enum(["stack", "split"]),
        font: z.enum(["sans", "serif", "mono"]),
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
