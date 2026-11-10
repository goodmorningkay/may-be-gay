"use client";
import { useState, type FormEvent } from "react";
import styles from "./operations.module.css";
type Row = Record<string, string | number | boolean | null>;
type Data = { rows?: Row[]; page?: { offset: number; limit: number }; settings?: { registrationMode: string; uploadsPaused: boolean; accountLimit: number; totalMediaLimitBytes: number } };
const sections = ["reports", "accounts", "invites", "settings", "audit"] as const;
export function AdminPanel({ initial }: { initial: Data }) {
  const [section, setSection] = useState<string>("reports"), [data, setData] = useState(initial), [offset, setOffset] = useState(0), [query, setQuery] = useState(""), [state, setState] = useState("open");
  const [message, setMessage] = useState(""), [busy, setBusy] = useState(false), [secret, setSecret] = useState<string | null>(null), [detail, setDetail] = useState<Row | null>(null);
  async function load(next = section, start = offset, search = query, filter = state) {
    setBusy(true); setMessage(""); setDetail(null);
    try {
      const params = new URLSearchParams({ offset: String(start), limit: "25" });
      if (next === "accounts") params.set("q", search);
      if (next === "reports" && filter) params.set("state", filter);
      const response = await fetch(`/api/admin/${next}?${params}`, { cache: "no-store" }); const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "Unable to load records.");
      setData(body); setSection(next); setOffset(start);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to load records."); }
    finally { setBusy(false); }
  }
  async function action(input: Record<string, unknown>) {
    setBusy(true); setMessage(""); setSecret(null);
    try {
      const response = await fetch("/api/admin/actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }); const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "Action failed.");
      await load();
      if (body.invite?.token) setSecret(`${location.origin}/sign-up#invite=${encodeURIComponent(body.invite.token)}`);
      setMessage("Change saved.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Action failed."); }
    finally { setBusy(false); }
  }
  async function inspect(id: string) {
    setBusy(true);
    try { const res = await fetch(`/api/admin/reports?id=${encodeURIComponent(id)}`, { cache: "no-store" }); const body = await res.json(); if (!res.ok) throw new Error(body.error?.message); setDetail(body.rows?.[0] ?? null); }
    catch { setMessage("Unable to load report. Confirm your password and second factor if access expired."); } finally { setBusy(false); }
  }
  function form(event: FormEvent<HTMLFormElement>, build: (f: FormData) => Record<string, unknown>) { event.preventDefault(); void action(build(new FormData(event.currentTarget))); }
  return <><nav className={styles.tabs} aria-label="Administration sections">{sections.map(s => <button key={s} disabled={busy} aria-pressed={s === section} onClick={() => { setSecret(null); void load(s, 0); }}>{s[0].toUpperCase() + s.slice(1)}</button>)}</nav>
    <div role="status" aria-live="polite">{busy ? "Working…" : message}</div><p className={styles.muted}>Access expired? <a href="/account/security">Confirm your password and second factor</a>.</p>
    {secret && <section className={styles.card}><h2>Invitation ready</h2><p>This recipient-bound link is shown once. Share it deliberately with its intended recipient.</p><code className={styles.secret}>{secret}</code><div className={styles.actions}><button onClick={() => void navigator.clipboard.writeText(secret).then(() => setMessage("Invitation copied."), () => setMessage("Copy is unavailable. Select the link to copy manually."))}>Copy invitation</button><button onClick={() => setSecret(null)}>Hide link</button></div></section>}
    {section === "accounts" && <form className={styles.actions} onSubmit={e => { e.preventDefault(); void load("accounts", 0); }}><label>Find email or username<input value={query} maxLength={100} onChange={e => setQuery(e.target.value)} /></label><button disabled={busy}>Search</button></form>}
    {section === "reports" && <label>Queue<select aria-label="Queue" value={state} disabled={busy} onChange={e => { setState(e.target.value); void load("reports", 0, query, e.target.value); }}>{["open", "reviewing", "resolved", "dismissed"].map(v => <option key={v}>{v}</option>)}</select></label>}
    {detail && <section className={styles.card}><h2>Report details</h2><p>{String(detail.username)} · {String(detail.reason)}</p><p>{detail.details || "No additional details."}</p><p>Private reply address: {detail.reporterEmail || "Not supplied"}</p>{detail.linkId && <p>Link: {detail.linkId}</p>}{detail.mediaId && <p>Media: {detail.mediaId}</p>}<p>Find this username in Accounts to inspect availability or remove reported media.</p></section>}
    {section === "settings" && data.settings && <form className={styles.card} onSubmit={e => form(e, f => ({ action: "settings", registrationMode: f.get("registrationMode"), uploadsPaused: f.get("uploadsPaused") === "on", accountLimit: Number(f.get("accountLimit")), totalMediaLimitBytes: Number(f.get("totalMediaLimitBytes")) }))} key={JSON.stringify(data.settings)}><h2>Service limits</h2><label>Registration<select name="registrationMode" defaultValue={data.settings.registrationMode === "closed" ? "closed" : "invite"}><option value="closed">Closed</option><option value="invite">Invitation required</option></select></label><label><span><input type="checkbox" name="uploadsPaused" defaultChecked={data.settings.uploadsPaused} />Pause new uploads</span></label><label>Account limit (maximum 50)<input type="number" name="accountLimit" min={1} max={50} defaultValue={data.settings.accountLimit} required /></label><label>Total storage limit in bytes<input type="number" name="totalMediaLimitBytes" min={0} max={1024 ** 4} defaultValue={data.settings.totalMediaLimitBytes} required /></label><button disabled={busy}>Save service limits</button></form>}
    {section === "invites" && <form className={styles.card} onSubmit={e => form(e, f => ({ action: "invite", email: f.get("email"), expiresInHours: Number(f.get("hours")) }))}><h2>Issue invitation</h2><label>Recipient email<input name="email" type="email" maxLength={254} required autoComplete="off" /></label><label>Valid for hours<input name="hours" type="number" min={1} max={168} defaultValue={72} required /></label><button disabled={busy}>Create recipient-bound link</button><p className={styles.muted}>This action creates a link; it sends no email.</p></form>}
    <div className={styles.grid}>{data.rows?.map(row => <article className={styles.card} key={String(row.id)}>
      {section === "reports" ? <><h2>{row.username}</h2><p>{row.reason} · {row.state}</p><p>{row.assignedTo ? `Assigned: ${row.assignedTo}` : "Unassigned"}</p><p>{String(row.createdAt)}</p><div className={styles.actions}><button disabled={busy} onClick={() => void inspect(String(row.id))}>Read details</button><button disabled={busy} onClick={() => void action({ action: "report", id: row.id, state: "reviewing", assign: "me" })}>Assign to me</button><button disabled={busy} onClick={() => void action({ action: "report", id: row.id, state: row.state, assign: "none" })}>Unassign</button><button disabled={busy} onClick={() => void action({ action: "report", id: row.id, state: "resolved" })}>Resolve</button><button disabled={busy} onClick={() => void action({ action: "report", id: row.id, state: "dismissed" })}>Dismiss</button></div></> :
      section === "accounts" ? <><h2>{row.username || "No username"}</h2><p>{row.email}</p><p>{row.deletedAt ? "Deletion pending" : row.suspendedAt ? "Account suspended" : "Account active"} · {row.publishedRevisionId ? "Published" : "Unpublished"}{row.profileSuspendedAt ? " · Profile suspended" : ""}</p><p>{row.role} · {row.verified ? "Verified" : "Unverified"}</p><div className={styles.actions}><button disabled={busy || !!row.deletedAt || row.role === "admin"} onClick={() => void action({ action: "suspend", userId: row.id, scope: "account", suspended: !row.suspendedAt })}>{row.suspendedAt ? "Reinstate account" : "Suspend account"}</button>{row.profileId && <button disabled={busy || !!row.deletedAt || row.role === "admin"} onClick={() => void action({ action: "suspend", userId: row.id, scope: "profile", suspended: !row.profileSuspendedAt })}>{row.profileSuspendedAt ? "Reinstate profile" : "Suspend profile"}</button>}</div><form onSubmit={e => form(e, f => ({ action: "quota", userId: row.id, bytes: Number(f.get("bytes")) }))}><label>Storage quota in bytes<input name="bytes" type="number" min={0} max={1024 ** 4} defaultValue={Number(row.quotaBytes ?? 100 * 1024 ** 2)} required /></label><button disabled={busy || !!row.deletedAt}>Set quota</button></form><form onSubmit={e => form(e, f => ({ action: "remove-media", userId: row.id, mediaId: f.get("mediaId") }))}><label>Reported asset ID<input name="mediaId" required pattern={"[a-fA-F0-9\\-]{36}"} maxLength={36} /></label><label><span><input type="checkbox" required />Remove asset and affected publication/history</span></label><button disabled={busy || !!row.deletedAt}>Remove media</button></form></> :
      section === "invites" ? <><h2>{row.email}</h2><p>{row.redeemedAt ? "Used" : row.revokedAt ? "Revoked" : "Unredeemed"} · Expires {String(row.expiresAt)}</p><button disabled={busy || !!row.redeemedAt || !!row.revokedAt} onClick={() => void action({ action: "revoke-invite", id: row.id })}>Revoke</button></> : <><h2>{row.action}</h2><p>Actor: {row.actorId || "Removed account"}</p><p>Subject: {row.subjectUserId || "Service"}</p><p>{String(row.createdAt)}</p></>}
    </article>)}</div>
    {data.rows && <><p>{data.rows.length === 0 ? "No records in this view." : `Showing ${offset + 1}–${offset + data.rows.length}`}</p><div className={styles.actions}><button disabled={busy || offset === 0} onClick={() => void load(section, Math.max(0, offset - 25))}>Previous</button><button disabled={busy || data.rows.length < 25 || offset >= 9975} onClick={() => void load(section, offset + 25)}>Next</button></div></>}
  </>;
}
