"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { resolveProfileEmbed } from "@/domain/profile-embeds";
import styles from "./profile-view.module.css";

const subscribe = () => () => {};
const paletteRefreshDelay = 800;

export function ProfileEmbed({ title, source }: {
  title: string;
  source: NonNullable<ReturnType<typeof resolveProfileEmbed>>;
}) {
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  const { src } = source;
  const loaded = frameSrc !== null;
  const loadAction = source.provider === "Last.fm" ? "Load Last.fm embed via Snoozeds" : "Load Spotify embed";
  const action = loaded ? "Hide embed" : loadAction;
  const frameClass = source.provider === "Last.fm" ? `${styles.embedFrame} ${styles.lastFmFrame}` : styles.embedFrame;

  useEffect(() => {
    if (frameSrc === null || frameSrc === src) return;
    // A drag in the editor’s color picker can emit enough changes to hit Snoozeds’ rate limit.
    const timer = setTimeout(() => setFrameSrc(current => current === frameSrc ? src : current), paletteRefreshDelay);
    return () => clearTimeout(timer);
  }, [frameSrc, src]);

  return <li className={styles.embed}>
    <h2>{title}</h2>
    <div className={styles.embedActions}>
      {hydrated && <button type="button" aria-expanded={loaded} aria-label={`${action}: ${title}`} onClick={() => setFrameSrc(loaded ? null : src)}>{action}</button>}
      <a href={source.href} target="_blank" rel="noopener noreferrer">Open on {source.provider}</a>
    </div>
    {/* Spotify needs its origin for playback, and Snoozeds needs its origin to poll the currently-playing endpoint. */}
    {loaded && <iframe className={frameClass} src={frameSrc} title={`${title} (${source.provider})`} height={source.height}
      sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" />}
  </li>;
}
