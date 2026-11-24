import type { ReactNode } from "react";
import Link from "next/link";
import brand from "./brand.module.css";
import styles from "./site-chrome.module.css";

const policies = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/rules", label: "Rules" },
];

export function SiteHeader({ home = "/", children }: { home?: string; children?: ReactNode }) {
  return <header className={styles.header}>
    <Link href={home} prefetch={false} className={brand.wordmark}>
      <span className={brand.brandMark} aria-hidden="true" />may-be.gay
    </Link>
    {children}
  </header>;
}

export function SiteFooter({ home = "" }: { home?: string }) {
  return <footer className={styles.footer}>
    <span>© may-be.gay</span>
    <nav aria-label="Legal">{policies.map(({ href, label }) => <Link key={href} href={home + href}>{label}</Link>)}</nav>
  </footer>;
}

export function SectionLinks({ items, current, label }: {
  items: readonly { href: string; label: string }[]; current: string; label: string;
}) {
  return <nav className={styles.sideNav} aria-label={label}>
    {items.map(item => <Link key={item.href} href={item.href} prefetch={false} aria-current={item.href === current ? "page" : undefined}>{item.label}</Link>)}
  </nav>;
}
