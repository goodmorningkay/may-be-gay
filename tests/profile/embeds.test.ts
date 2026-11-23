import { describe, expect, it } from "vitest";
import { defaultProfileDocument, getThemeColors, profileDocumentSchema } from "@/domain/profile";
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
      src: "https://lastfm-embed.vercel.app/api/currently-playing?user=Petra1999&showTitle=false",
      href: lastFm.url,
    });
    expect(resolveProfileEmbed(spotify.url)).toMatchObject({
      src: "https://open.spotify.com/embed/track/7GhIk7Il098yCjg4BQjzvb",
      href: "https://open.spotify.com/track/7GhIk7Il098yCjg4BQjzvb",
    });
  });

  it("sets the Last.fm palette and gives each palette its own provider cache key", () => {
    const theme = { ...defaultProfileDocument.theme, preset: "midnight" as const };
    const preset = new URL(resolveProfileEmbed(lastFm.url, getThemeColors(theme))!.src).searchParams;
    expect(Object.fromEntries(preset)).toMatchObject({ bgColor: "#232a38", textColor: "#f2eee5", urlColor: "#cad8ff" });

    const customColors = { surface: "#181026", ink: "#F6ECFF", accent: "#DAABFF" };
    const custom = new URL(resolveProfileEmbed(lastFm.url, getThemeColors({ ...theme, colors: customColors }))!.src).searchParams;
    expect(Object.fromEntries(custom)).toMatchObject({ bgColor: "#181026", textColor: "#F6ECFF", urlColor: "#DAABFF" });
    expect(custom.get("theme")).toBe("may-be-gay-181026-f6ecff-daabff");
    expect(custom.get("theme")).not.toBe(preset.get("theme"));
    expect(resolveProfileEmbed(spotify.url, customColors)).toEqual(resolveProfileEmbed(spotify.url));
  });

  it("resolves localized URLs to the same validated provider sources", () => {
    const localizedLastFm = "https://www.last.fm/es/user/Petra1999";
    const localizedSpotify = "https://open.spotify.com/intl-de/track/7GhIk7Il098yCjg4BQjzvb?si=share-id";
    expect(resolveProfileEmbed(localizedLastFm)).toEqual(resolveProfileEmbed(lastFm.url));
    expect(resolveProfileEmbed(localizedSpotify)).toEqual(resolveProfileEmbed(spotify.url));
  });

  it("accepts Spotify album links that highlight a track", () => {
    const albumUrl = "https://open.spotify.com/album/4lhjMs1eMIJdU2QAC6sYwv";
    const highlighted = `${albumUrl}?highlight=spotify:track:7GhIk7Il098yCjg4BQjzvb`;
    expect(resolveProfileEmbed(highlighted)).toMatchObject({
      src: "https://open.spotify.com/embed/album/4lhjMs1eMIJdU2QAC6sYwv",
      href: albumUrl,
    });
    expect(resolveProfileEmbed(highlighted)).toEqual(resolveProfileEmbed(albumUrl));
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
    "https://lastfm-embed.vercel.app/api/currently-playing?user=Petra1999",
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
