"use client";

import { useState, useSyncExternalStore } from "react";
import type { resolveProfileEmbed } from "@/domain/profile-embeds";
import styles from "./profile-view.module.css";

const subscribe = () => () => {};

export function ProfileEmbed({ title, source }: {
  title: string;
  source: NonNullable<ReturnType<typeof resolveProfileEmbed>>;
}) {
  const [loaded, setLoaded] = useState(false);
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  const loadAction = `Load ${source.provider} embed`;
  const action = loaded ? "Hide embed" : loadAction;
  const frameClass = source.provider === "Last.fm" ? `${styles.embedFrame} ${styles.lastFmFrame}` : styles.embedFrame;

  return <li className={styles.embed}>
    <h2>{title}</h2>
    <div className={styles.embedActions}>
      {hydrated && <button type="button" aria-expanded={loaded} aria-label={`${action}: ${title}`} onClick={() => setLoaded(!loaded)}>{action}</button>}
      <a href={source.href} target="_blank" rel="noopener noreferrer">Open on {source.provider}</a>
    </div>
    {/* Spotify needs its origin for playback, and Snoozeds needs its origin to poll the currently-playing endpoint. */}
    {loaded && <iframe className={frameClass} src={source.src} title={`${title} (${source.provider})`} height={source.height}
      sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" />}
  </li>;
}
