import styles from "./editor.module.css";

type IconName = "browserControls" | "closeIcon" | "contrastIcon" | "desktopIcon" | "externalIcon" | "eyeIcon" | "musicIcon" | "phoneIcon" | "presetCheck";

export function EditorIcon({ name }: { name: IconName }) {
  return <span aria-hidden="true" className={`${styles.icon} ${styles[name]}`} />;
}
