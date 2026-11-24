import type { ReactNode } from "react";
import { SiteHeader } from "@/components/site-chrome";
import styles from "@/components/site-chrome.module.css";
import { getSiteDomain } from "@/domain/hosts";

export const dynamic = "force-dynamic";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return <div className={styles.page}><div className={styles.container}>
    <SiteHeader home={`https://${getSiteDomain()}`} />
    <main>{children}</main>
  </div></div>;
}
