import { describe, expect, it } from "vitest";
import { defaultProfileDocument, profileDocumentSchema } from "@/domain/profile";
import { maxProfileEmbeds, resolveProfileEmbed } from "@/domain/profile-embeds";

const lastFm = { id: "9bcefb7c-f0df-4ed5-a8f6-d93f77cb6d61", title: "Recently played", url: "https://www.last.fm/user/Petra1999" };
const spotify = { id: "fb21f232-b964-447c-b873-35d844735e0d", title: "Favourite track", url: "https://open.spotify.com/embed/track/7GhIk7Il098yCjg4BQjzvb?si=share-id" };

describe("profile embeds", () => {
  it("preserves ordered embeds while accepting profiles saved before embeds existed", () => {
    expect(profileDocumentSchema.parse(defaultProfileDocument).embeds).toBeUndefined();
    const document = { ...defaultProfileDocument, embeds: [lastFm, spotify] };
    expect(profileDocumentSchema.parse(document).embeds).toEqual(document.embeds);
  });

  it("builds frame and outbound URLs from supported resource identifiers", () => {
    expect(resolveProfileEmbed(lastFm.url)).toMatchObject({
      src: "https://petracoding.github.io/neocities/widgets/lastfm?username=Petra1999",
      href: lastFm.url,
    });
    expect(resolveProfileEmbed(spotify.url)).toMatchObject({
      src: "https://open.spotify.com/embed/track/7GhIk7Il098yCjg4BQjzvb",
      href: "https://open.spotify.com/track/7GhIk7Il098yCjg4BQjzvb",
    });
  });

  it("resolves localized URLs to the same validated provider sources", () => {
    const localizedLastFm = "https://www.last.fm/es/user/Petra1999";
    const localizedSpotify = "https://open.spotify.com/intl-de/track/7GhIk7Il098yCjg4BQjzvb?si=share-id";
    expect(resolveProfileEmbed(localizedLastFm)).toEqual(resolveProfileEmbed(lastFm.url));
    expect(resolveProfileEmbed(localizedSpotify)).toEqual(resolveProfileEmbed(spotify.url));
  });

  it.each([
    "<iframe src=\"https://www.last.fm/user/Petra1999\"></iframe>",
    "javascript:alert(1)",
    "http://www.last.fm/user/Petra1999",
    "https://app.may-be.gay/editor",
    "https://www.last.fm.example.com/user/Petra1999",
    "https://www.last.fm:444/user/Petra1999",
    "https://anyone@www.last.fm/user/Petra1999",
    "https://www.last.fm/user/Petra1999\n",
    "https://www.last.fm/user/%2FPetra1999",
    "https://www.last.fm/es%2fuser%2fPetra1999",
    "https://petracoding.github.io/neocities/widgets/everything",
    "https://open.spotify.com/redirect?uri=7GhIk7Il098yCjg4BQjzvb",
    "https://open.spotify.com/intl-de/redirect?uri=7GhIk7Il098yCjg4BQjzvb",
  ])("rejects unsupported input %j", url => {
    expect(profileDocumentSchema.safeParse({ ...defaultProfileDocument, embeds: [{ ...lastFm, url }] }).success).toBe(false);
  });

  it("rejects raw markup fields, case-equivalent IDs and oversized lists", () => {
    for (const embeds of [
      [{ ...lastFm, srcDoc: "<p>Custom markup</p>" }],
      [lastFm, { ...spotify, id: lastFm.id.toUpperCase() }],
      Array.from({ length: maxProfileEmbeds + 1 }, () => ({ ...lastFm, id: crypto.randomUUID() })),
    ]) {
      expect(profileDocumentSchema.safeParse({ ...defaultProfileDocument, embeds }).success).toBe(false);
    }
  });
});
