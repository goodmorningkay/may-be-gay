import Link from "next/link";
import { policyConfiguration } from "@/server/operations/policy";
import { requireApexPage } from "@/server/operations/pages";
import { SectionLinks, SiteFooter, SiteHeader } from "../site-chrome";
import chrome from "../site-chrome.module.css";
import styles from "./operations.module.css";

const sections = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/rules", label: "Rules" },
];

export async function PolicyPage({ kind }: { kind: "privacy" | "terms" | "rules" }) {
  await requireApexPage();
  const config = policyConfiguration();
  const values = config.values;
  const contact = config.supportMonitored && values.supportEmail;

  return <div className={chrome.page}><div className={chrome.container}>
    <SiteHeader><Link href="/support">Support</Link></SiteHeader>
    <main className={`${chrome.sidebarLayout} ${styles.policyLayout}`}>
      <SectionLinks items={sections} current={`/${kind}`} label="Policies" />
      <article className={styles.policyText}>
        <h1 className={chrome.heading}>{kind === "privacy" ? "Privacy" : kind === "terms" ? "Terms" : "Content and audience rules"}</h1>
        {!config.ready && <div className={`${chrome.notice} ${styles.accountCard}`}>
          <strong>Development draft</strong>
          <p className={chrome.muted}>Final policy wording and operator details are pending. This page describes current service behavior.</p>
        </div>}
        {kind === "privacy" && <>
          {values.privacy && <p>{values.privacy}</p>}
          <section><h2>What is public</h2><p>Published profile fields and media are public. Your login email and authentication details stay private.</p></section>
          <section><h2>Profile analytics</h2><p>We keep 30 days of approximate daily profile views and link clicks. The counts do not measure unique people. Analytics do not store persistent visitor IDs, cookies, IP addresses, user agents or referrers.</p></section>
          <section><h2>Reports and service records</h2><p>Private report contact and details are removed after 30 days, report records after 90 days and redacted moderation audit records after 180 days. Minimal recovery records help prevent removed content from returning after a restore. Retention for operational logs and backups is pending.</p></section>
          <section><h2>Account export and deletion</h2><p>You can export your account data or request deletion from your account. Requesting deletion ends account access immediately and queues private cleanup. Backup expiry and provider cache cleanup are separate. Copies downloaded by other people cannot be recalled.</p></section>
        </>}
        {kind === "terms" && <>
          <section><h2>Publishing your page</h2><p>{values.terms ?? "Service terms, operator responsibilities and the appeals process are pending approval."}</p>
            <p>Publishing makes your chosen profile content public. Keep a copy of important content. Account availability and moderation decisions can affect your page and retained media.</p></section>
          <section><h2>Media rights and takedown</h2><p>{values.mediaRights ?? "Media rights, music permissions and a monitored takedown process are pending operator decisions."}</p></section>
        </>}
        {kind === "rules" && <>
          <section><h2>Content rules</h2><p>{values.contentRules ?? "Proposed review categories include harassment, impersonation, malicious links, scams and copyright complaints. Final content rules, including permitted age-sensitive content, are pending operator review."}</p></section>
          <section><h2>Media and reporting</h2><p>{values.mediaRights ?? "Upload only media you have permission to use. The final rights and takedown procedure is pending."}</p>
            <p>Report a published profile, visible link or exposed media through <Link href="/support">support</Link>. Submissions are private and enter an administrator review queue when the target is available.</p></section>
        </>}
        <section className={`${chrome.card} ${styles.operator}`}>
          <h2>Operator and audience</h2>
          <dl>
            <div><dt>Operator identity</dt><dd>{kind === "privacy" ? "Kay" : (values.operator ?? "Pending")}</dd></div>
            <div><dt>Jurisdiction</dt><dd>{values.jurisdiction ?? "Pending"}</dd></div>
            <div><dt>Audience and minimum age</dt><dd>{values.audience ?? "Pending"}</dd></div>
            <div><dt>Monitored support contact</dt><dd>{contact ? <a href={`mailto:${contact}`}>{contact}</a> : "Pending"}</dd></div>
          </dl>
        </section>
      </article>
    </main>
    <SiteFooter />
  </div></div>;
}
