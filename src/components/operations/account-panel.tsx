"use client";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { downloadBlob } from "../download-blob";
import chrome from "../site-chrome.module.css";
import styles from "./operations.module.css";
export function AccountPanel({ accountId }: { accountId: string }) {
  const [renderedAccountId] = useState(accountId);
  const [confirmation, setConfirmation] = useState(""), [message, setMessage] = useState(""), [busy, setBusy] = useState(false), [deleted, setDeleted] = useState(false);
  const [action, setAction] = useState<"download" | "delete">("download");
  async function download(event: FormEvent) {
    event.preventDefault(); setAction("download"); setBusy(true); setMessage("");
    try {
      // Native form navigation can send Origin:null under no-referrer. A real
      // same-origin fetch retains the exact-Origin protection and reports API
      // failures here instead of replacing the account screen with JSON.
      const response = await fetch("/api/account/export", { method: "POST", headers: { "x-account-id": renderedAccountId }, cache: "no-store", credentials: "same-origin", redirect: "error", referrerPolicy: "same-origin" });
      if (!response.ok) { const body = await response.json(); throw new Error(body.error?.message ?? "Unable to download your archive."); }
      if (!response.headers.get("content-type")?.startsWith("application/x-tar")) throw new Error("Unable to download your archive.");
      const archive = await response.blob();
      downloadBlob(archive, "may-be-account.tar");
      setMessage("Archive prepared. Keep the downloaded copy private.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to download your archive."); }
    finally { setBusy(false); }
  }
  async function remove(event: FormEvent) {
    event.preventDefault(); setAction("delete"); setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/account/delete", { method: "POST", headers: { "content-type": "application/json", "x-account-id": renderedAccountId }, body: JSON.stringify({ confirmation }) }); const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "Unable to delete account.");
      setDeleted(true); setMessage(body.message);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to delete account."); } finally { setBusy(false); }
  }
  return <>
    <section className={`${chrome.card} ${styles.accountCard}`} aria-labelledby="archive-title">
      <div className={styles.archiveRow}>
        <div>
          <h2 className={chrome.subheading} id="archive-title">Download your account</h2>
          <p className={chrome.muted}>Export your profile, private draft, retained revisions and available validated media.</p>
          <Link href="/account/security#confirm-password">Confirm your password</Link>
        </div>
        <form action="/api/account/form-help" method="post" onSubmit={download}>
          <button className={chrome.primary} disabled={busy || deleted}>Download account archive (.tar)</button>
        </form>
      </div>
      <noscript>Enable JavaScript to request the private account download.</noscript>
      <p className={`${chrome.muted} ${styles.cardDivider}`}>Keep the archive private. You can download up to two per hour. Exports over 1 GiB need support.</p>
    </section>
    <section className={`${chrome.card} ${styles.accountCard} ${styles.danger}`} aria-labelledby="deletion-title">
      <h2 className={chrome.subheading} id="deletion-title">Delete your account</h2>
      <p>Your page is removed immediately and all sessions are signed out. Your username stays reserved.</p>
      <p className={chrome.muted}>Private records and media are queued for removal within 24 hours when workers and storage are healthy. Cached copies and backups can take longer to expire.</p>
      <Link href="/account/security#confirm-password">Confirm your password</Link>
      <p className={chrome.muted}>Download your archive first if you need a copy.</p>
      <form className={`${styles.inlineForm} ${styles.cardDivider}`} action="/api/account/form-help" method="post" onSubmit={remove}>
        <label className={chrome.field}><span>Type DELETE MY ACCOUNT</span>
          <input className={chrome.control} value={confirmation} onChange={e => setConfirmation(e.target.value)} autoComplete="off" maxLength={32} required disabled={deleted} />
        </label>
        <button className={confirmation === "DELETE MY ACCOUNT" ? styles.dangerButton : chrome.button}
          disabled={busy || deleted || confirmation !== "DELETE MY ACCOUNT"}>Delete my account</button>
      </form>
    </section>
    <p role="status" className={message || busy ? chrome.notice : styles.emptyStatus}>
      {busy ? action === "download" ? "Preparing your archive…" : "Requesting deletion…" : message}
    </p>
  </>;
}
