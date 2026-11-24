"use client";
import styles from "@/components/editor/editor.module.css";
export default function EditorError({ reset }: { reset: () => void }) {
  return <main className={styles.entry}><h1>The editor could not open</h1><p>No account details are shown. Try opening the editor again.</p><button type="button" onClick={reset}>Try again</button></main>;
}
