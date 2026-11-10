"use client";
import "@/components/validation-runtime";
import { useState, type FormEvent } from "react";
import { reportReasons } from "@/domain/operations";
import styles from "./operations.module.css";
import type { ReportTarget } from "@/server/operations/reports";
export function ReportForm({ username = "", targets = [], target = "" }: { username?: string; targets?: ReportTarget[]; target?: string }) {
  const [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const f = new FormData(event.currentTarget); setBusy(true); setMessage("");
    try {
      const body = Object.fromEntries(f); const selected = String(body.target ?? ""); delete body.target;
      if (selected) { const [kind, id] = selected.split(":"); body[kind === "link" ? "linkId" : "mediaId"] = id; }
      const res = await fetch("/api/reports", { method: "POST", credentials: "omit", headers: { "content-type": "application/json" }, body: JSON.stringify(body), referrerPolicy: "no-referrer" }); const result = await res.json();
      setMessage(result.message ?? result.error?.message ?? "Try again later.");
    } catch { setMessage("Unable to submit right now. Try again later."); } finally { setBusy(false); }
  }
  return <form action="/api/reports" method="post" onSubmit={submit} className={styles.card}><h2>Report a public profile, link or media</h2><p>Reports are private. Include only what is needed to explain the problem. Do not include passwords or highly sensitive personal information.</p><label>Profile username<input name="username" defaultValue={username} readOnly={!!username} minLength={3} maxLength={30} pattern={"[a-z0-9][a-z0-9\\-]{1,28}[a-z0-9]"} required autoComplete="off" /></label><label>Reason<select name="reason">{reportReasons.map(r => <option key={r} value={r}>{r.replaceAll("-", " ")}</option>)}</select></label><label>What should we review?<textarea name="details" maxLength={2000} /></label><label>Report target<select aria-label="Report target" name="target" defaultValue={target}><option value="">Whole profile</option>{targets.map(t => <option key={`${t.value}:${t.label}`} value={t.value}>{t.label}</option>)}</select></label><p>Load a profile above to choose one of its published links, avatar, background or music.</p><label>Private reply email (optional)<input type="email" name="contact" maxLength={254} autoComplete="email" /></label><div className={styles.honey} aria-hidden="true"><label>Leave this empty<input name="website" tabIndex={-1} autoComplete="off" /></label></div><button disabled={busy}>Submit report</button><p role="status">{busy ? "Submitting…" : message}</p><noscript>You can submit this form without JavaScript. The next page confirms receipt without showing your private details.</noscript></form>;
}
