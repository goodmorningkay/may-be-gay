import type { ReactNode } from "react";
import Link from "next/link";
import { getSiteDomain } from "@/domain/hosts";
import { SectionLinks, SiteHeader } from "../site-chrome";
import chrome from "../site-chrome.module.css";
import styles from "./operations.module.css";

const sections = [
  { href: "/account", label: "Account" },
  { href: "/account/security", label: "Security" },
  { href: "/account/analytics", label: "Analytics" },
];

export function AccountShell({ title, section, email, username, admin, children }: {
  title: string; section: string; email?: string; username?: string; admin?: boolean; children: ReactNode;
}) {
  const domain = getSiteDomain();
  return <div className={chrome.page}><div className={chrome.container}>
    <SiteHeader home={`https://${domain}`}><Link href="/editor" className={chrome.button}>Edit profile</Link></SiteHeader>
    <main>
      <div className={chrome.pageTitle}>
        <h1 className={chrome.heading}>{title}</h1>
        {email && <p className={chrome.muted}>Signed in as <span className={chrome.mono}>{email}</span></p>}
        {username && <p className={`${chrome.muted} ${chrome.mono}`}>{username}.{domain}</p>}
      </div>
      <div className={chrome.sidebarLayout}>
        <div className={styles.accountNav}>
          <SectionLinks label="Account sections" current={section} items={admin ? [...sections, { href: "/admin", label: "Administration" }] : sections} />
        </div>
        <div className={chrome.stack}>{children}</div>
      </div>
    </main>
  </div></div>;
}
