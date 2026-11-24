"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { resolveProfileEmbed } from "@/domain/profile-embeds";
import styles from "./profile-view.module.css";

const subscribe = () => () => {};
const previewRefreshDelay = 800;

export function ProfileEmbed({ title, source, deferAutoLoad }: {
  title: string;
  source: NonNullable<ReturnType<typeof resolveProfileEmbed>>;
  deferAutoLoad: boolean;
}) {
  const { src } = source;
  const isLastFm = source.provider === "Last.fm";
  const [frameSrc, setFrameSrc] = useState<string | null>(isLastFm && !deferAutoLoad ? src : null);
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  const loaded = frameSrc !== null;
  const action = loaded ? "Hide embed" : "Load Spotify embed";
  const frameClass = isLastFm ? `${styles.embedFrame} ${styles.lastFmFrame}` : styles.embedFrame;

  useEffect(() => {
    if (!isLastFm || frameSrc === src) return;
    // Wait for the editor’s URL or palette to settle before contacting Snoozeds.
    const timer = setTimeout(() => setFrameSrc(src), previewRefreshDelay);
    return () => clearTimeout(timer);
  }, [frameSrc, isLastFm, src]);

  return <li className={styles.embed}>
    <h2>{title}</h2>
    <div className={styles.embedActions}>
      {!isLastFm && hydrated && <button type="button" aria-expanded={loaded} aria-label={`${action}: ${title}`} onClick={() => setFrameSrc(loaded ? null : src)}>{action}</button>}
      <a href={source.href} target="_blank" rel="noopener noreferrer" style={isLastFm ? { color: source.textColor } : undefined}>Open on {source.provider}</a>
    </div>
    {/* Spotify needs its origin for playback, and Snoozeds needs its origin to poll the currently-playing endpoint. */}
    {loaded && <iframe className={frameClass} src={frameSrc} title={`${title} (${source.provider})`} height={source.height} loading={isLastFm ? "lazy" : undefined}
      sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" />}
  </li>;
}
