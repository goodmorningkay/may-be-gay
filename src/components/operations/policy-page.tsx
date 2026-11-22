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
  const { values } = policyConfiguration();

  return <div className={chrome.page}><div className={chrome.container}>
    <SiteHeader><Link href="/support">Support</Link></SiteHeader>
    <main className={`${chrome.sidebarLayout} ${styles.policyLayout}`}>
      <SectionLinks items={sections} current={`/${kind}`} label="Policies" />
      <article className={styles.policyText}>
        <h1 className={chrome.heading}>{kind === "privacy" ? "Privacy" : kind === "terms" ? "Terms" : "Rules"}</h1>
        {kind === "privacy" && <>
          {values.privacy && <p>{values.privacy}</p>}
          <section><h2>What is public</h2><p>Published profile fields, links, and media are public. Your login email and authentication details stay private.</p></section>
          <section><h2>Profile analytics</h2><p>We keep 30 days of approximate daily profile views and link clicks. The counts do not measure unique people. Analytics do not store persistent visitor IDs, cookies, IP addresses, user agents, or referrers.</p></section>
          <section><h2>Reports and service records</h2><p>Private report contact and details are removed after 30 days, report records after 90 days, and redacted moderation audit records after 180 days. Minimal recovery records help prevent removed content from returning after a restore. Operational logs are kept briefly for reliability and troubleshooting, and encrypted backups expire automatically on a rolling schedule.</p></section>
          <section><h2>Account export and deletion</h2><p>You can export your account data or request deletion from your account. Requesting deletion ends account access immediately and queues private cleanup. Backup expiry and provider cache cleanup are separate. Copies downloaded by other people cannot be recalled.</p></section>
        </>}
        {kind === "terms" && <>
          <section><h2>Publishing your page</h2><p>{values.terms ?? "By creating an account or publishing a page on may-be.gay, you agree to follow these terms and our site rules. You are responsible for the content, links, and media you publish and for keeping your account credentials secure."}</p>
            <p>Publishing makes your chosen profile content public. The service is provided as is without guarantees of uptime or permanent storage, so keep a copy of anything important. We may suspend accounts, hide profiles, or remove content that breaks our rules or applicable law.</p></section>
          <section><h2>Media rights and takedown</h2><p>{values.mediaRights ?? "You keep ownership of the content you upload and grant may-be.gay permission to host, process, and display it as part of your profile. Only upload images, audio, and other media you have the right to share."}</p>
            <p>If you believe content on the site infringes your rights or breaks our rules, report it through <Link href="/support">support</Link> and we will review and remove it where appropriate.</p></section>
        </>}
        {kind === "rules" && <>
          <section><h2>Content rules</h2><p>{values.contentRules ?? "Keep things light, respectful, and legal. Do not use your page for harassment, impersonation, scams, malware, phishing, or other malicious links, and do not post illegal content."}</p></section>
          <section><h2>Media</h2><p>{values.mediaRights ?? "No NSFW media, including nudity, sexually explicit imagery, or graphic violence. Only upload images, audio, and other media you have permission to use."}</p></section>
          <section><h2>Reporting</h2><p>Report a published profile, visible link, or exposed media through <Link href="/support">support</Link>. Submissions are private and enter an administrator review queue when the target is available.</p></section>
        </>}
      </article>
    </main>
    <SiteFooter />
  </div></div>;
}
