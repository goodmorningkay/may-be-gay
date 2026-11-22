"use client";

import { useEffect, useId, useRef, useState } from "react";
import styles from "./username-taken-dialog.module.css";

export function UsernameTakenDialog({
  username,
  siteDomain,
  signInHref,
  focusInputId,
  dismissLabel = "Choose another username",
  onDismiss,
}: {
  username: string;
  siteDomain: string;
  signInHref?: string;
  focusInputId?: string;
  dismissLabel?: string;
  onDismiss?: () => void;
}) {
  const [open, setOpen] = useState(true);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const address = `${username}.${siteDomain}`;

  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    if (open) {
      if (!node.open && typeof node.showModal === "function") node.showModal();
    } else if (node.open) {
      node.close();
    }
  }, [open]);

  function dismiss() {
    setOpen(false);
    onDismiss?.();
    if (focusInputId) {
      requestAnimationFrame(() => {
        const input = document.getElementById(focusInputId);
        if (input instanceof HTMLInputElement) {
          input.focus();
          input.select();
        }
      });
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={event => {
        event.preventDefault();
        dismiss();
      }}
      onClick={event => {
        if (event.target === dialogRef.current) dismiss();
      }}
    >
      <div className={styles.content}>
        <span className={styles.badge}>Username unavailable</span>
        <h2 id={titleId} className={styles.title}>Username already taken</h2>
        <p id={descriptionId} className={styles.body}>
          <strong className={styles.address}>{address}</strong> is already claimed. Please choose a different username.
        </p>
        <div className={styles.actions}>
          <button type="button" className={styles.primary} onClick={dismiss}>
            {dismissLabel}
          </button>
          {signInHref && (
            <a href={signInHref} className={styles.secondary}>
              Sign in instead
            </a>
          )}
        </div>
      </div>
    </dialog>
  );
}
