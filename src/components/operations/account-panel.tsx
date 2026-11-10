"use client";
import { useState, type FormEvent } from "react";
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
      const url = URL.createObjectURL(archive), anchor = document.createElement("a");
      anchor.href = url; anchor.download = "may-be-account.tar"; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
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
  return <><section className={styles.card}><h2>Download your account</h2><p>Includes your profile, private draft, retained revisions and available validated media. Keep the download private. Confirm your password first; exports are limited to two per hour.</p><form method="post" onSubmit={download}><button disabled={busy || deleted}>Download account archive (.tar)</button></form><noscript>Enable JavaScript to request the private account download.</noscript><p className={styles.muted}>If a file is removed or your access expires during download, the archive may be incomplete. Retry a fresh download. Large exports over 1 GiB need support assistance.</p></section>
    <section className={`${styles.card} ${styles.danger}`}><h2>Delete your account</h2><p>This immediately removes your page and signs out every session. Private records and media are queued for removal within 24 hours when workers and storage are healthy. CDN cleanup and backup expiry may take longer. Your username remains reserved.</p><p><a href="/account/security">Confirm your password</a> before continuing. Download your archive first if you need a copy.</p><form method="post" onSubmit={remove}><label>Type DELETE MY ACCOUNT<input value={confirmation} onChange={e => setConfirmation(e.target.value)} autoComplete="off" maxLength={32} required disabled={deleted} /></label><button disabled={busy || deleted || confirmation !== "DELETE MY ACCOUNT"}>Delete my account</button></form></section><p role="status" className={message ? styles.notice : ""}>{busy ? action === "download" ? "Preparing your archive…" : "Requesting deletion…" : message}</p></>;
}
