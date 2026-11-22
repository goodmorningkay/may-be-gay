"use client";

import * as React from "react";
import styles from "./click-to-enter.module.css";

type ClickToEnterProps = {
  displayName: string;
  username: string;
  hasMusic: boolean;
};

const subscribe = () => () => {};

export function ClickToEnter({ displayName, username, hasMusic }: ClickToEnterProps) {
  const [entered, setEntered] = React.useState(false);
  const hydrated = React.useSyncExternalStore(subscribe, () => true, () => false);

  if (entered) return null;

  function enter(event: React.MouseEvent<HTMLButtonElement>) {
    const root = event.currentTarget.closest("main") ?? event.currentTarget.ownerDocument;
    const audio = root.querySelector<HTMLAudioElement>("audio[data-profile-music]");
    if (audio) {
      const attempt = audio.play();
      if (attempt && typeof attempt.catch === "function") {
        attempt.catch(() => {});
      }
    }
    setEntered(true);
  }

  return (
    <div
      className={styles.gate}
      role="dialog"
      aria-modal="true"
      aria-label={`Enter ${displayName}’s page`}
      hidden={!hydrated}
    >
      <button type="button" className={styles.enter} onClick={enter}>
        <span className={styles.card}>
          <span className={styles.handle}>@{username}</span>
          <span className={styles.name}>{displayName}</span>
          <span className={styles.prompt}>
            {hasMusic ? "Click to enter · plays music" : "Click to enter"}
          </span>
        </span>
      </button>
    </div>
  );
}
