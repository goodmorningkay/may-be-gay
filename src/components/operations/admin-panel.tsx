"use client";

import { useState, type FormEvent } from "react";
import type { RegistrationMode } from "@/domain/registration";
import chrome from "../site-chrome.module.css";
import styles from "./operations.module.css";

type Row = Record<string, string | number | boolean | null>;
type Data = {
  rows?: Row[];
  settings?: { registrationMode: RegistrationMode; uploadsPaused: boolean; accountLimit: number; totalMediaLimitBytes: number };
};
const sections = { reports: "Reports", accounts: "Accounts", invites: "Invites", settings: "Settings", audit: "Audit" } as const;
type Section = keyof typeof sections;
const queues = ["open", "reviewing", "resolved", "dismissed"];
const time = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
const formatTime = (value: Row[string]) => time.format(new Date(String(value)));
const display = (value: Row[string]) => {
  const text = String(value ?? "").replaceAll("-", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
};

export function AdminPanel({ initial }: { initial: Data }) {
  const [section, setSection] = useState<Section>("reports");
  const [data, setData] = useState(initial);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState("");
  const [queue, setQueue] = useState("open");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<{ url: string; email?: string } | null>(null);
  const [detail, setDetail] = useState<Row | null>(null);

  async function read(next: Section, start: number, filter = queue) {
    const params = new URLSearchParams({ offset: String(start), limit: "25" });
    if (next === "accounts") params.set("q", query);
    if (next === "reports") params.set("state", filter);
    const response = await fetch(`/api/admin/${next}?${params}`, { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message ?? "Unable to load records.");
    setData(body);
    setSection(next);
    setOffset(start);
    setDetail(null);
  }

  async function run(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try { await task(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Unable to complete the action."); }
    finally { setBusy(false); }
  }

  function load(next = section, start = offset, filter = queue) {
    void run(async () => {
      if (next !== section) setInvite(null);
      await read(next, start, filter);
      if (next === "reports") setQueue(filter);
    });
  }

  function action(input: Record<string, unknown>) {
    void run(async () => {
      setInvite(null);
      const response = await fetch("/api/admin/actions", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "Action failed.");
      if (body.invite?.token) {
        setInvite({ url: `${location.origin}/sign-up#invite=${encodeURIComponent(body.invite.token)}`, email: String(input.email ?? "") });
      }
      try { await read(section, offset); }
      catch { setMessage("Change saved. Refresh the list to see it."); return; }
      if (!body.invite?.token) setMessage("Change saved.");
    });
  }

  function inspect(id: string) {
    void run(async () => {
      const res = await fetch(`/api/admin/reports?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error?.message ?? "Unable to load report.");
      setDetail(body.rows?.[0] ?? null);
    });
  }

  function form(event: FormEvent<HTMLFormElement>, build: (fields: FormData) => Record<string, unknown>) {
    event.preventDefault();
    action(build(new FormData(event.currentTarget)));
  }

  const rows = data.rows ?? [];
  const selected = detail ?? (section === "reports" ? rows[0] : undefined);
  const pager = data.rows && <div className={styles.pager}>
    <span className={chrome.muted}>{rows.length ? `Showing ${offset + 1}–${offset + rows.length}` : "No records in this view."}</span>
    <div className={chrome.actions}>
      <button className={chrome.button} disabled={busy || offset === 0} onClick={() => load(section, Math.max(0, offset - 25))}>Previous</button>
      <button className={chrome.button} disabled={busy || rows.length < 25 || offset >= 9975} onClick={() => load(section, offset + 25)}>Next</button>
    </div>
  </div>;

  return <div className={chrome.sidebarLayout}>
    <nav className={chrome.sideNav} aria-label="Administration sections">{(Object.keys(sections) as Section[]).map(name =>
      <button key={name} disabled={busy} aria-pressed={name === section} onClick={() => load(name, 0)}>{sections[name]}</button>
    )}</nav>
    <div className={chrome.stack}>
      <div role="status" className={message || busy ? chrome.notice : styles.emptyStatus}>{busy ? "Working…" : message}</div>
      <div className={styles.row}>
        <h2 className={chrome.subheading}>{section === "invites" ? "Invitations" : sections[section]}</h2>
        {section === "reports" && <div className={chrome.field}><label htmlFor="report-queue">Queue</label><select id="report-queue" className={chrome.control} value={queue} disabled={busy} onChange={e => load("reports", 0, e.target.value)}>
          {queues.map(value => <option key={value} value={value}>{display(value)}</option>)}
        </select></div>}
      </div>
      {section === "reports" && <div className={chrome.split}>
        <div className={chrome.stack}>
          {rows.map(row => <article className={`${styles.record} ${selected?.id === row.id ? styles.selected : ""}`} key={String(row.id)}>
            <div className={styles.recordText}><h3 className={chrome.mono}>{row.username}</h3>
              <p>{display(row.reason)} · {display(row.state)}</p>
              <p className={chrome.muted}>{row.assignedTo ? "Assigned" : "Unassigned"} · {formatTime(row.createdAt)} UTC</p>
            </div>
            {detail?.id !== row.id && <button className={chrome.button} disabled={busy} onClick={() => inspect(String(row.id))}>Read details</button>}
          </article>)}
          {pager}
        </div>
        {selected && <section className={`${chrome.card} ${chrome.stack}`} aria-labelledby="report-detail">
          <h3 className={chrome.subheading} id="report-detail">Report details</h3>
          <div className={styles.row}><span className={chrome.mono}>{selected.username}</span><span className={styles.badge}>{display(selected.state)}</span></div>
          <dl className={styles.reportDetail}>
            <dt>Reason</dt><dd>{display(selected.reason)}</dd>
            {detail && <>
              <dt>Reporter’s note</dt><dd>{detail.details || "No additional details."}</dd>
              {detail.linkId && <><dt>Reported link ID</dt><dd className={chrome.mono}>{detail.linkId}</dd></>}
              {detail.mediaId && <><dt>Reported media ID</dt><dd className={chrome.mono}>{detail.mediaId}</dd></>}
              <dt>Private reply address</dt><dd>{detail.reporterEmail || "Not supplied"}</dd>
            </>}
          </dl>
          <p className={chrome.muted}>To check profile availability or remove reported media, find this username in Accounts.</p>
          <div className={`${chrome.actions} ${styles.cardDivider}`}>
            <button className={chrome.primary} disabled={busy} onClick={() => action({ action: "report", id: selected.id, state: "reviewing", assign: "me" })}>Assign to me</button>
            <button className={chrome.button} disabled={busy} onClick={() => action({ action: "report", id: selected.id, state: selected.state, assign: "none" })}>Unassign</button>
            <button className={chrome.button} disabled={busy} onClick={() => action({ action: "report", id: selected.id, state: "resolved" })}>Resolve</button>
            <button className={chrome.button} disabled={busy} onClick={() => action({ action: "report", id: selected.id, state: "dismissed" })}>Dismiss</button>
          </div>
        </section>}
      </div>}
      {section === "invites" && <>
        {invite && <section className={`${chrome.card} ${chrome.stack}`} aria-labelledby="invitation-ready">
          <h3 className={styles.smallHeading} id="invitation-ready">Invitation ready</h3>
          <p className={chrome.muted}>This link is shown once. Copy it to share with {invite.email || "the recipient"}.</p>
          <code className={styles.secret}>{invite.url}</code>
          <div className={chrome.actions}>
            <button className={chrome.primary} onClick={() => {
              if (!navigator.clipboard) { setMessage("Select the link to copy it manually."); return; }
              void navigator.clipboard.writeText(invite.url).then(() => setMessage("Invitation copied."), () => setMessage("Select the link to copy it manually."));
            }}>Copy invitation</button>
            <button className={chrome.button} onClick={() => setInvite(null)}>Hide link</button>
          </div>
        </section>}
        <div className={styles.invitesLayout}>
          <form method="post" action="/api/account/form-help" className={`${chrome.card} ${chrome.stack}`} onSubmit={e => form(e, fields => ({ action: "invite", email: fields.get("email"), expiresInHours: Number(fields.get("hours")) }))}>
            <h3 className={styles.smallHeading}>Issue invitation</h3>
            <label className={chrome.field}><span>Recipient email</span><input className={chrome.control} name="email" type="email" maxLength={254} required autoComplete="off" /></label>
            <label className={chrome.field}><span>Valid for (hours)</span><input className={chrome.control} name="hours" type="number" min={1} max={168} defaultValue={72} required /><small className={chrome.muted}>1–168 hours</small></label>
            <div><button className={chrome.primary} disabled={busy}>Create invitation link</button></div>
            <p className={chrome.muted}>The recipient must use this email to sign up. Share the link with them directly.</p>
          </form>
          <div className={chrome.stack}>
            <h3 className={styles.smallHeading}>Existing invitations</h3>
            {rows.map(row => <article className={styles.record} key={String(row.id)}>
              <div className={styles.recordText}><h4 className={chrome.mono}>{row.email}</h4><p className={chrome.muted}>Expires {formatTime(row.expiresAt)} UTC</p></div>
              <div className={chrome.actions}>
                <span className={styles.badge}>{row.redeemedAt ? "Used" : row.revokedAt ? "Revoked" : "Unredeemed"}</span>
                {!row.redeemedAt && !row.revokedAt && <button className={chrome.button} disabled={busy} onClick={() => action({ action: "revoke-invite", id: row.id })}>Revoke</button>}
              </div>
            </article>)}
            {pager}
          </div>
        </div>
      </>}
      {section === "accounts" && <>
        <form method="post" action="/api/account/form-help" className={styles.inlineForm} onSubmit={event => { event.preventDefault(); load("accounts", 0); }}>
          <label className={chrome.field}><span>Find email or username</span><input className={chrome.control} value={query} maxLength={100} onChange={e => setQuery(e.target.value)} /></label>
          <button className={chrome.button} disabled={busy}>Search</button>
        </form>
        {rows.map(row => <article className={`${chrome.card} ${chrome.stack}`} key={String(row.id)}>
          <h3 className={styles.smallHeading}>{row.username || "No username"}</h3>
          <p>{row.email}</p>
          <p className={chrome.muted}>{row.deletedAt ? "Deletion pending" : row.suspendedAt ? "Account suspended" : "Account active"} · {row.publishedRevisionId ? "Published" : "Unpublished"}{row.profileSuspendedAt ? " · Profile suspended" : ""}</p>
          <p className={chrome.muted}>{display(row.role)} · {row.verified ? "Verified" : "Unverified"}</p>
          <div className={chrome.actions}>
            <button className={chrome.button} disabled={busy || !!row.deletedAt || row.role === "admin"} onClick={() => action({ action: "suspend", userId: row.id, scope: "account", suspended: !row.suspendedAt })}>{row.suspendedAt ? "Reinstate account" : "Suspend account"}</button>
            {row.profileId && <button className={chrome.button} disabled={busy || !!row.deletedAt || row.role === "admin"} onClick={() => action({ action: "suspend", userId: row.id, scope: "profile", suspended: !row.profileSuspendedAt })}>{row.profileSuspendedAt ? "Reinstate profile" : "Suspend profile"}</button>}
          </div>
          <form method="post" action="/api/account/form-help" className={styles.inlineForm} onSubmit={e => form(e, f => ({ action: "quota", userId: row.id, bytes: Number(f.get("bytes")) }))}>
            <label className={chrome.field}><span>Storage quota in bytes</span><input className={chrome.control} name="bytes" type="number" min={0} max={1024 ** 4} defaultValue={Number(row.quotaBytes ?? 100 * 1024 ** 2)} required /></label>
            <button className={chrome.button} disabled={busy || !!row.deletedAt}>Set quota</button>
          </form>
          <form method="post" action="/api/account/form-help" className={styles.securityForm} onSubmit={e => form(e, f => ({ action: "remove-media", userId: row.id, mediaId: f.get("mediaId") }))}>
            <label className={chrome.field}><span>Reported asset ID</span><input className={chrome.control} name="mediaId" required pattern={"[a-fA-F0-9\\-]{36}"} maxLength={36} /></label>
            <label><input type="checkbox" required /> Remove asset and affected publication history</label>
            <button className={styles.dangerButton} disabled={busy || !!row.deletedAt}>Remove media</button>
          </form>
        </article>)}
        {pager}
      </>}
      {section === "settings" && data.settings && <form method="post" action="/api/account/form-help" className={`${chrome.card} ${chrome.stack}`} key={JSON.stringify(data.settings)}
        onSubmit={e => form(e, f => ({ action: "settings", registrationMode: f.get("registrationMode"), uploadsPaused: f.get("uploadsPaused") === "on", accountLimit: Number(f.get("accountLimit")), totalMediaLimitBytes: Number(f.get("totalMediaLimitBytes")) }))}>
        <h3 className={styles.smallHeading}>Service limits</h3>
        <div className={chrome.field}><label htmlFor="registration-mode">Registration</label><select id="registration-mode" className={chrome.control} name="registrationMode" defaultValue={data.settings.registrationMode}><option value="closed">Closed</option><option value="invite">Invitation required</option><option value="public">Public</option></select></div>
        <label><input type="checkbox" name="uploadsPaused" defaultChecked={data.settings.uploadsPaused} /> Pause new uploads</label>
        <label className={chrome.field}><span>Account limit (maximum 50)</span><input className={chrome.control} type="number" name="accountLimit" min={1} max={50} defaultValue={data.settings.accountLimit} required /></label>
        <label className={chrome.field}><span>Total storage limit in bytes</span><input className={chrome.control} type="number" name="totalMediaLimitBytes" min={0} max={1024 ** 4} defaultValue={data.settings.totalMediaLimitBytes} required /></label>
        <div><button className={chrome.primary} disabled={busy}>Save service limits</button></div>
      </form>}
      {section === "audit" && <>
        {rows.map(row => <article className={`${chrome.card} ${styles.accountCard}`} key={String(row.id)}>
          <h3 className={styles.smallHeading}>{row.action}</h3><p>Actor · {row.actorId || "Removed account"}</p><p>Subject · {row.subjectUserId || "Service"}</p>
          <p className={chrome.muted}>{formatTime(row.createdAt)} UTC</p>
        </article>)}
        {pager}
      </>}
    </div>
  </div>;
}
