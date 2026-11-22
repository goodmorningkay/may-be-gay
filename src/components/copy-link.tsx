"use client";

import * as React from "react";
import styles from "./profile-view.module.css";

type CopyLinkProps = {
  id: string;
  label: string;
  value: string;
  icon?: React.ReactNode;
};

async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to legacy execCommand fallback when Clipboard API is unavailable or denied.
    }
  }
  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

export function CopyLink({ id, label, value, icon }: CopyLinkProps) {
  const [status, setStatus] = React.useState<"idle" | "copied" | "failed">("idle");
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function handleCopy() {
    if (timer.current) clearTimeout(timer.current);
    const ok = await copyText(value);
    setStatus(ok ? "copied" : "failed");
    timer.current = setTimeout(() => setStatus("idle"), 2000);
  }

  return (
    <button
      type="button"
      className={styles.link}
      data-profile-link={id}
      data-copy-link="true"
      data-copied={status === "copied" ? "true" : undefined}
      onClick={() => void handleCopy()}
      aria-label={`Copy ${label}: ${value}`}
    >
      {icon}
      <span className={styles.linkText}>
        <span className={styles.linkLabel}>{label}</span>
        <span className={styles.linkHost}>{value}</span>
      </span>
      <span className={styles.copyAction} aria-hidden="true">
        {status === "copied" ? (
          <span className={styles.copyBadge}>Copied</span>
        ) : status === "failed" ? (
          <span className={styles.copyBadge}>Copy failed</span>
        ) : (
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" focusable="false">
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </span>
      <span role="status" className={styles.srOnly}>
        {status === "copied" ? `Copied ${value} to clipboard.` : status === "failed" ? "Could not copy to clipboard." : ""}
      </span>
    </button>
  );
}
