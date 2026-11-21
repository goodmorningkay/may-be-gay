"use client";

import * as React from "react";
import styles from "./music-player.module.css";

type MusicPlayerProps = { url: string; attribution: string; durationMs?: number };
const subscribe = () => () => {};
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export function MusicPlayer({ url, attribution, durationMs }: MusicPlayerProps) {
  const audio = React.useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = React.useState(false);
  const [error, setError] = React.useState("");
  const [volume, setVolume] = React.useState(1);
  const [muted, setMuted] = React.useState(false);
  const [duration, setDuration] = React.useState((durationMs ?? 0) / 1000);
  const [position, setPosition] = React.useState(0);
  const [canSeek, setCanSeek] = React.useState(false);
  const hydrated = React.useSyncExternalStore(subscribe, () => true, () => false);
  const attributionId = React.useId();

  async function toggle() {
    if (!audio.current) return;
    setError("");
    if (audio.current.paused) {
      try { await audio.current.play(); }
      catch { setError("The track could not play. Try again."); }
    } else audio.current.pause();
  }

  return <section className={styles.player} aria-label="Profile music" data-enhanced={hydrated || undefined}>
    <audio ref={audio} src={url} controls preload="none" aria-label="Profile music player" aria-describedby={attributionId}
      onDurationChange={({ currentTarget }) => { if (Number.isFinite(currentTarget.duration)) setDuration(currentTarget.duration); }}
      onLoadedMetadata={() => setCanSeek(true)}
      onTimeUpdate={({ currentTarget }) => setPosition(currentTarget.currentTime)}
      onVolumeChange={({ currentTarget }) => { setVolume(currentTarget.volume); setMuted(currentTarget.muted); }}
      onEmptied={() => { setPlaying(false); setPosition(0); setCanSeek(false); }}
      onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
      onError={() => { setPlaying(false); setError("The track is unavailable."); }} />
    <div className={styles.controls} hidden={!hydrated}>
      <div className={styles.titleRow}>
        <button type="button" className={styles.play} onClick={toggle} data-playing={playing || undefined} aria-label={playing ? "Pause music" : "Play music"} />
        <div><strong>Music</strong><span>{playing ? "Playing" : "Play music"}</span></div>
      </div>
      <div className={styles.timeline}>
        <span>{clock(position)} / {duration ? clock(duration) : "–:––"}</span>
        <input type="range" aria-label="Playback position" min="0" max={duration || 1} step="0.1"
          value={Math.min(position, duration)} disabled={!duration || !canSeek}
          onChange={event => { if (audio.current) { audio.current.currentTime = Number(event.target.value); setPosition(audio.current.currentTime); } }} />
        <button type="button" className={styles.volume} aria-pressed={muted} aria-label={muted ? "Unmute" : "Mute"}
          onClick={() => { if (audio.current) audio.current.muted = !audio.current.muted; }} />
        <input className={styles.volumeSlider} type="range" aria-label="Volume" min="0" max="1" step="0.05" value={muted ? 0 : volume}
          onChange={event => { if (audio.current) { audio.current.muted = false; audio.current.volume = Number(event.target.value); } }} />
      </div>
    </div>
    <p id={attributionId} className={styles.attribution}>Rights / attribution: {attribution}</p>
    <p role="status" className={styles.status}>{error}</p>
  </section>;
}
