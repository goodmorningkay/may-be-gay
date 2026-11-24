"use client";

import "@/components/validation-runtime";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { reportReasons } from "@/domain/operations";
import type { ReportTarget } from "@/server/operations/reports";
import { SiteFooter, SiteHeader } from "../site-chrome";
import chrome from "../site-chrome.module.css";
import styles from "./operations.module.css";
import onboarding from "../auth/onboarding.module.css";

type Props = {
  domain: string; username: string; targets: ReportTarget[]; target: string;
  supportEmail?: string; appealsEmail?: string;
};
const usernamePattern = "[a-z0-9][a-z0-9\\-]{1,28}[a-z0-9]";

export function SupportWorkspace({ domain, username, targets, target, supportEmail, appealsEmail }: Props) {
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [received, setReceived] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const body = Object.fromEntries(new FormData(event.currentTarget));
    const [kind, id] = String(body.target ?? "").split(":");
    delete body.target;
    if (id) body[kind === "link" ? "linkId" : "mediaId"] = id;
    setBusy(true);
    setProblem("");
    try {
      const response = await fetch("/api/reports", {
        method: "POST", credentials: "omit", headers: { "content-type": "application/json" },
        body: JSON.stringify(body), referrerPolicy: "no-referrer",
      });
      if (response.status === 202) setReceived(true);
      else setProblem("Check the form and try again later.");
    } catch {
      setProblem("Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const sidebar = <aside className={chrome.stack}>
    <section className={`${chrome.card} ${styles.accountCard}`}>
      <h2 className={styles.smallHeading}>Report privacy</h2>
      <p className={chrome.muted}>Contact and report details are removed after 30 days. Report records are removed after 90 days.</p>
      <Link href="/rules">Read the content rules</Link>
    </section>
    <section className={styles.accountCard}>
      <h2 className={styles.labelHeading}>Support contact</h2>
      {supportEmail ? <p><a href={`mailto:${supportEmail}`}>{supportEmail}</a></p> : <p className={chrome.muted}>A monitored support email is pending.</p>}
      {appealsEmail && <p>Appeals · <a href={`mailto:${appealsEmail}`}>{appealsEmail}</a></p>}
    </section>
  </aside>;

  return <div className={chrome.page}><div className={chrome.container}>
    <SiteHeader />
    <main>
      <div className={chrome.pageTitle}><h1 className={chrome.heading}>Support and reporting</h1>
        {!received && <p className={chrome.muted}>Report a public profile, a published link or uploaded media.</p>}
      </div>
      <div className={`${styles.supportLayout} ${received ? styles.received : ""}`}>
        <div className={chrome.stack}>
          {received ? <section className={`${chrome.card} ${chrome.stack}`} role="status">
            <h2 className={chrome.subheading}>Submission received</h2>
            <p className={chrome.muted}>If the target is still public, the report can enter the review queue.</p>
            <Link href="/support" onClick={() => setReceived(false)}>Return to support</Link>
          </section> : <>
            <section className={`${chrome.card} ${styles.accountCard}`}>
              <h2 className={styles.smallHeading}>Find a public profile</h2>
              <p className={chrome.muted}>Load a profile to choose a published link or media.</p>
              <form action="/support" method="get" className={styles.inlineForm}>
                <div className={chrome.field}><label htmlFor="find-profile">Profile username</label>
                  <span className={`${chrome.control} ${onboarding.usernameControl} ${styles.supportUsername}`}>
                    <input id="find-profile" name="username" defaultValue={username} minLength={3} maxLength={30} pattern={usernamePattern}
                      required autoComplete="off" autoCapitalize="none" spellCheck={false} /><span aria-hidden="true">.{domain}</span>
                  </span>
                </div>
                <button className={chrome.button}>Load report choices</button>
              </form>
            </section>
            <form action="/api/reports" method="post" onSubmit={submit} className={`${chrome.card} ${chrome.stack}`}>
              <div>
                <h2 className={chrome.subheading}>File a report</h2>
                {username && <p className={`${chrome.muted} ${chrome.mono} ${styles.range}`}>{username}.{domain}</p>}
              </div>
              {username ? <input type="hidden" name="username" value={username} /> :
                <label className={chrome.field}><span>Report username</span><input className={chrome.control} name="username" minLength={3}
                  maxLength={30} pattern={usernamePattern} required autoComplete="off" autoCapitalize="none" spellCheck={false} /></label>}
              <div className={styles.reportSelects}>
                <div className={chrome.field}><label htmlFor="report-target">Report target</label>
                  <select id="report-target" className={chrome.control} name="target" defaultValue={target}>
                    <option value="">Whole profile</option>
                    {targets.map(option => <option key={`${option.value}:${option.label}`} value={option.value}>{option.label}</option>)}
                  </select>
                </div>
                <div className={chrome.field}><label htmlFor="report-reason">Reason</label>
                  <select id="report-reason" className={chrome.control} name="reason">{reportReasons.map(reason => <option key={reason} value={reason}>{reason[0].toUpperCase() + reason.slice(1).replaceAll("-", " ")}</option>)}</select>
                </div>
              </div>
              <div className={chrome.field}><label htmlFor="report-details">Report details (optional)</label>
                <textarea id="report-details" className={chrome.control} name="details" rows={3} maxLength={2000} aria-describedby="report-privacy-note" />
                <small className={chrome.muted} id="report-privacy-note">Reports are private. Leave out passwords and sensitive personal details.</small>
              </div>
              <label className={chrome.field}><span>Private reply email (optional)</span><input className={chrome.control} type="email" name="contact" maxLength={254} autoComplete="email" /></label>
              <div className={styles.honey} aria-hidden="true"><label>Leave this empty<input name="website" tabIndex={-1} autoComplete="off" /></label></div>
              {problem && <div className={`${chrome.notice} ${styles.accountCard}`} role="status"><strong>Unable to submit report</strong><p className={chrome.muted}>{problem}</p></div>}
              <div><button className={chrome.primary} disabled={busy}>{busy ? "Submitting…" : "Submit report"}</button></div>
            </form>
          </>}
        </div>
        {sidebar}
      </div>
    </main>
    <SiteFooter />
  </div></div>;
}
