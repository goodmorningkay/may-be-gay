import { z } from "zod";

export const maxProfileEmbeds = 6;
export const maxEmbedUrlLength = 2048;

const lastFmWidget = "https://petracoding.github.io/neocities/widgets/lastfm";
const spotifyPlayer = "https://open.spotify.com/embed/";

export const profileEmbedFrameSources = [lastFmWidget, spotifyPlayer];

export function resolveProfileEmbed(url: string) {
  const lastFm = /^https:\/\/(?:www\.)?last\.fm\/(?:[a-z]{2}\/)?user\/([a-z][a-z0-9_-]{1,14})\/?$/i.exec(url);
  if (lastFm) {
    const username = lastFm[1];
    return {
      provider: "Last.fm" as const,
      src: `${lastFmWidget}?username=${username}`,
      href: `https://www.last.fm/user/${username}`,
      height: 96,
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
