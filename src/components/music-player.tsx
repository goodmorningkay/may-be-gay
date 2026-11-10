"use client";

import * as React from "react";
import styles from "./music-player.module.css";

type MusicPlayerProps = { url: string; attribution: string };
const subscribe = () => () => {};

/** Native controls remain usable without hydration; no playback occurs on mount. */
export function MusicPlayer({ url, attribution }: MusicPlayerProps) {
  const audio = React.useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = React.useState(false);
  const [error, setError] = React.useState("");
  const [volume, setVolume] = React.useState(1);
  const hydrated = React.useSyncExternalStore(subscribe, () => true, () => false);
  const attributionId = React.useId();

  async function toggle() {
    if (!audio.current) return;
    setError("");
    if (audio.current.paused) {
      try { await audio.current.play(); }
      catch { setError("The track could not play. Try again using the audio controls."); }
    } else audio.current.pause();
  }

  return <section className={styles.player} aria-label="Profile music">
    <p className={styles.title}>Music</p>
    <audio ref={audio} src={url} controls preload="none" aria-label="Profile music player" aria-describedby={attributionId}
      onVolumeChange={() => { if (audio.current) setVolume(audio.current.volume); }}
      onEmptied={() => setPlaying(false)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
      onError={() => { setPlaying(false); setError("The track is unavailable."); }} />
    <div className={styles.controls} hidden={!hydrated}>
      <button type="button" onClick={toggle} aria-label={playing ? "Pause music" : "Play music"}>{playing ? "Pause" : "Play"}</button>
      <label>Volume <input type="range" min="0" max="1" step="0.05" value={volume}
        onChange={(event) => { const next = Number(event.target.value); setVolume(next); if (audio.current) audio.current.volume = next; }} /></label>
    </div>
    <p id={attributionId} className={styles.attribution}>Rights / attribution: {attribution}</p>
    <p role="status" className={styles.status}>{error}</p>
  </section>;
}
