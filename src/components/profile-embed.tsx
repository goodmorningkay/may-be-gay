"use client";

import { useState } from "react";
import type { resolveProfileEmbed } from "@/domain/profile-embeds";
import styles from "./profile-view.module.css";

export function ProfileEmbed({ title, source }: {
  title: string;
  source: NonNullable<ReturnType<typeof resolveProfileEmbed>>;
}) {
  const [loaded, setLoaded] = useState(false);
  const loadAction = source.provider === "Last.fm" ? "Load Last.fm embed via PetraPixel" : "Load Spotify embed";
  const action = loaded ? "Hide embed" : loadAction;

  return <li className={styles.embed}>
    <h2>{title}</h2>
    <div className={styles.embedActions}>
      <button type="button" aria-expanded={loaded} aria-label={`${action}: ${title}`} onClick={() => setLoaded(!loaded)}>{action}</button>
      <a href={source.href} target="_blank" rel="noopener noreferrer">Open on {source.provider}</a>
    </div>
    {/* Spotify needs its own origin for playback. The parent CSP only admits the external player URL. */}
    {loaded && <iframe className={styles.embedFrame} src={source.src} title={`${title} (${source.provider})`} height={source.height}
      sandbox={source.provider === "Spotify" ? "allow-scripts allow-same-origin" : "allow-scripts"} referrerPolicy="no-referrer" />}
  </li>;
}
