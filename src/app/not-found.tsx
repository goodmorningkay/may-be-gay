import { headers } from "next/headers";
import Link from "next/link";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";
import chrome from "@/components/site-chrome.module.css";
import { getSiteDomain } from "@/domain/hosts";
import styles from "./site.module.css";

export default async function NotFound() {
  // Resolve the public home at request time, including on missing profile hosts.
  await headers();
  const home = `https://${getSiteDomain()}`;
  return <div className={chrome.page}><div className={`${chrome.container} ${styles.missingPage}`}>
    <SiteHeader home={home}><Link href={`${home}/support`}>Support</Link></SiteHeader>
    <main className={styles.missing}>
      <span className={chrome.mono}>404</span>
      <h1 className={chrome.heading}>There’s no page here.</h1>
      <p>This address may not exist, or its owner may not have published a page.</p>
      <Link href={home} className={chrome.primary}>Go to may-be.gay</Link>
    </main>
    <SiteFooter home={home} />
  </div></div>;
}
