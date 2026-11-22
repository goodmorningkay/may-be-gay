/* eslint-disable @next/next/no-img-element -- Resolver URLs already point to validated media derivatives. */
import * as React from "react";

import type { PublicMedia, PublicMediaMap } from "@/domain/media";
import { getPublicDocument, getThemeColors, isCopyableLink, linkUrlSchema, type ProfileDocument } from "@/domain/profile";

import { ClickToEnter } from "./click-to-enter";
import { CopyLink } from "./copy-link";
import { MusicPlayer } from "./music-player";

import "./brand.module.css";
import styles from "./profile-view.module.css";
import icons from "./profile-icons.module.css";

type ProfileViewProps = {
  document: ProfileDocument;
  username: string;
  siteDomain: string;
  media?: PublicMediaMap;
  supportHref?: string;
};

function platformOrigin(siteDomain: string): string {
  // The caller owns hostname policy. This extra check prevents a path, userinfo
  // or scheme from changing where platform/support anchors navigate.
  if (!/^[a-z0-9.-]+(?::[0-9]+)?$/i.test(siteDomain)) {
    throw new Error("ProfileView requires a caller-validated apex domain.");
  }
  const origin = new URL(`https://${siteDomain}`);
  if (origin.host !== siteDomain.toLowerCase() || !origin.hostname) {
    throw new Error("ProfileView requires a caller-validated apex domain.");
  }
  return origin.origin;
}

function resolveMedia(media: PublicMediaMap, id: string | null | undefined, kind: "image" | "audio"): PublicMedia | undefined {
  if (!id) return;
  const asset = media[id.toLowerCase()];
  if (!asset || !(kind === "image" ? ["image/jpeg", "image/png", "image/webp"].includes(asset.contentType) : asset.contentType === "audio/mpeg")) return;
  // These URLs come only from server-owned resolvers. Reject active schemes even
  // when a caller bypasses the typed boundary; private URLs are same-origin.
  if (!/^\/api\/media\/[0-9a-f-]{36}\/content$/i.test(asset.url) && !linkUrlSchema.safeParse(asset.url).success) return;
  return asset;
}

// Fixed inline paths; authored SVG/markup and external icon requests are forbidden.
const iconPaths: Record<Exclude<NonNullable<ProfileDocument["links"][number]["icon"]>, "website">, string> = {
  github: "M9 20c-5 1-5-3-7-3m14 5v-4c0-1-.3-2-1-2 4-.5 6-2 6-6 0-1-1-3-2-3 0-1 0-3-1-4-2 0-3 1-4 2h-4C8 4 7 3 5 3 4 4 4 6 4 7c-1 0-2 2-2 3 0 4 2 5.5 6 6-.7 0-1 1-1 2v4",
  instagram: "M7 3h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4Zm9 9a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm1-6h1",
  mastodon: "M5 17V7a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v7c0 3-3 4-7 4H8c0 2 3 3 6 2M8 13V8l4 4 4-4v5",
  bluesky: "M12 11C7 2 2 2 3 8c0 3 3 4 6 4-7 0-5 7-1 6l4-5 4 5c4 1 6-6-1-6 3 0 6-1 6-4 1-6-4-6-9 3Z",
  twitter: "M22 4s-.7 2.1-2 3.4c1.6 10-9.4 17.3-18 11.6 2.2.1 4.4-.6 6-2C3 15.5.5 9.6 3 5c2.2 2.6 5.6 4.1 9 4-.9-4.2 4-6.6 7-3.8 1.1 0 3-1.2 3-1.2Z",
  x: "M4 4l11.733 16h4.267L8.267 4H4Zm0 16l6.768-6.768m2.46-2.46L20 4",
  youtube: "M5 5h14a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Zm5 4v6l5-3-5-3Z",
  twitch: "M5 3h16v12l-5 5h-5l-4 3v-3H3V7l2-4Zm6 4v6m5-6v6",
  discord: "M8.5 17c0 1-1.356 3-1.832 3-1.429 0-2.698-1.667-3.333-3-.635-1.667-.476-5.833 1.428-11.5C6.151 4.485 7.545 4.16 9 4l1 2.5h4L15 4c1.455.16 2.849.485 4.237 1.5 1.904 5.667 2.063 9.833 1.428 11.5-.635 1.333-1.904 3-3.333 3-.476 0-1.832-2-1.832-3M7 16.5c3.5 1 6.5 1 10 0M9 12a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm6 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z",
  linkedin: "M5 9v11M5 4v1M10 20V9m0 4c0-5 9-5 9 0v7",
  spotify: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM6 9c4-2 8-2 12 0M7 12c3-2 7-2 10 0M8 15c2-1 5-1 8 0",
};
function SocialIcon({ name }: { name: NonNullable<ProfileDocument["links"][number]["icon"]> }) {
  return <span className={styles.socialIcon} aria-hidden="true" data-icon={name}>
    {name === "website" ? <span className={icons.website} /> :
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" focusable="false"><path d={iconPaths[name]} /></svg>}
  </span>;
}

/** Read-only, server-renderable public content. All authored text is escaped. */
export function ProfileView({
  document,
  username,
  siteDomain,
  media = {},
  supportHref,
}: ProfileViewProps): React.JSX.Element {
  const profile = getPublicDocument(document);
  const origin = platformOrigin(siteDomain);
  const support = new URL(supportHref ?? `${origin}/support`);
  if (support.origin !== origin || support.pathname !== "/support" || support.username || support.password) {
    throw new Error("Profile support must use the platform support page.");
  }
  const avatar = resolveMedia(media, profile.avatarAssetId, "image");
  const background = resolveMedia(media, profile.backgroundAssetId, "image");
  const music = resolveMedia(media, profile.music?.assetId, "audio");
  // Every interpolated value is a validated hex colour or a closed enum.
  // Omitting styles entirely preserves the original v1 preset rendering.
  const colors = profile.theme.colors || profile.theme.background ? getThemeColors(profile.theme) : undefined;
  const customStyle = colors ? Object.fromEntries(Object.entries(colors).map(([key, value]) => [`--${key}`, value])) : undefined;
  if (profile.theme.background?.kind === "gradient") {
    const gradient = profile.theme.background;
    Object.assign(customStyle!, { "--page-gradient": `linear-gradient(${({ down: "180deg", right: "90deg", diagonal: "135deg" })[gradient.direction]}, ${gradient.from}, ${gradient.to})` });
  }

  return (
    <main
      className={styles.profile}
      data-preset={profile.theme.preset}
      data-layout={profile.theme.layout}
      data-font={profile.theme.font}
      data-button={profile.theme.button}
      data-spacing={profile.theme.spacing}
      data-photo={background ? "true" : undefined}
      data-overlay={background ? profile.theme.overlay : undefined}
      style={customStyle as React.CSSProperties | undefined}
    >
      {background ? <img className={styles.background} src={background.url} alt="" aria-hidden="true" decoding="async" /> : null}
      <div className={styles.frame}>
        <div className={styles.content}>
          <header className={styles.identity}>
            {avatar ? <img className={styles.avatar} src={avatar.url} alt={`${profile.displayName}’s avatar`} width={128} height={128} decoding="async" /> : null}
            <p className={styles.address}>
              <span>@{username}</span>
              <span className={styles.domain}>{siteDomain}</span>
            </p>
            <h1 className={styles.name}>{profile.displayName}</h1>
            {profile.pronouns ? <p className={styles.pronouns}>{profile.pronouns}</p> : null}
            {profile.bio ? <p className={styles.bio}>{profile.bio}</p> : null}
            {profile.contact ? <p className={styles.contact}><a href={`mailto:${encodeURIComponent(profile.contact.email).replace(/%40/gi, "@")}`}>{profile.contact.email}</a></p> : null}
          </header>

          <div className={styles.destinations}>
            {profile.links.length > 0 ? (
              <nav aria-label="Profile links">
                <ul className={styles.links}>
                  {profile.links.map((link) => (
                    <li key={link.id}>
                      {isCopyableLink(link) ? (
                        <CopyLink
                          id={link.id}
                          label={link.label}
                          value={link.url}
                          icon={link.icon ? <SocialIcon name={link.icon} /> : null}
                        />
                      ) : (
                        <a className={styles.link} href={link.url} data-profile-link={link.id}>
                          {link.icon ? <SocialIcon name={link.icon} /> : null}
                          <span className={styles.linkText}>
                            <span className={styles.linkLabel}>{link.label}</span>
                            <span className={styles.linkHost}>{new URL(link.url).host}</span>
                          </span>
                          <span className={icons.arrow} aria-hidden="true">→</span>
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </nav>
            ) : (
              <p className={styles.empty}>No public links yet.</p>
            )}
            {music && profile.music && <MusicPlayer key={music.url} url={music.url} durationMs={music.durationMs} attribution={profile.music.attribution} deferPlay={Boolean(profile.clickToEnter)} />}
          </div>
        </div>

        <footer className={styles.footer}>
          <p className={styles.attribution}>
            A page on <a href={origin}>{siteDomain}</a>
          </p>
          <a href={support.href}>
            Report this page or get support
          </a>
        </footer>
      </div>
      {profile.clickToEnter ? <ClickToEnter displayName={profile.displayName} username={username} hasMusic={Boolean(music && profile.music)} /> : null}
    </main>
  );
}
