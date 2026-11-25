import { z } from "./zod";
import { contrastRatio } from "./profile-colors";

export const maxProfileEmbeds = 6;
export const maxEmbedUrlLength = 2048;

const lastFmWidget = "https://lastfm-embed.vercel.app/api/currently-playing";
const spotifyPlayer = "https://open.spotify.com/embed/";
const minimumTextContrast = 4.5;

export const profileEmbedFrameSources = [lastFmWidget, spotifyPlayer];

type EmbedColors = { surface: string; ink: string };

export function resolveProfileEmbed(url: string, colors?: EmbedColors) {
  const lastFm = /^https:\/\/(?:www\.)?last\.fm\/(?:[a-z]{2}\/)?user\/([a-z][a-z0-9_-]{1,14})\/?$/i.exec(url);
  if (lastFm) {
    const username = lastFm[1];
    const params = new URLSearchParams({ user: username, showTitle: "false" });
    let textColor: string | undefined;
    if (colors) {
      const { surface, ink } = colors;
      textColor = ink;
      if (contrastRatio(ink, surface) < minimumTextContrast) {
        textColor = contrastRatio("#000000", surface) > contrastRatio("#ffffff", surface) ? "#000000" : "#ffffff";
      }
      params.set("bgColor", surface);
      params.set("textColor", textColor);
      // Snoozeds uses urlColor for track metadata and the Now Playing label.
      params.set("urlColor", textColor);
      // Snoozeds keys its HTML cache by username and theme name, without the color overrides.
      params.set("theme", `may-be-gay-${surface.slice(1).toLowerCase()}-${textColor.slice(1).toLowerCase()}`);
    }
    return {
      provider: "Last.fm" as const,
      src: `${lastFmWidget}?${params}`,
      href: `https://www.last.fm/user/${username}`,
      height: 176,
      textColor,
    };
  }

  const spotify = /^https:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(?:embed\/)?(track|album|playlist)\/([a-zA-Z0-9]{22})\/?(?:\?[a-zA-Z0-9_=&%:-]*)?$/.exec(url);
  if (spotify) {
    const [, kind, id] = spotify;
    return {
      provider: "Spotify" as const,
      src: `${spotifyPlayer}${kind}/${id}`,
      href: `https://open.spotify.com/${kind}/${id}`,
      height: kind === "track" ? 152 : 352,
    };
  }
}

export const profileEmbedSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1, "Enter an embed title.").max(100).refine(value => value.trim().length > 0, "Enter an embed title."),
  url: z.string().max(maxEmbedUrlLength).refine(
    value => Boolean(resolveProfileEmbed(value)),
    "Enter a Last.fm profile URL or a Spotify track, album, or playlist URL.",
  ),
}).strict();

export type ProfileEmbed = z.infer<typeof profileEmbedSchema>;
