import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getSiteDomain, resolveHost } from "@/domain/hosts";
import styles from "../site.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Support & reporting" };

export default async function Support() {
  if (resolveHost((await headers()).get("host"), getSiteDomain()).kind !== "apex") notFound();
  return <main className={styles.page}>
    <Link className={styles.wordmark} href="/" prefetch={false}>may-be.gay</Link>
    <div className={styles.content}>
      <h1>Support & reporting</h1>
      <p>This service is still in development and is not accepting accounts.</p>
      <p>Before the beta opens, this page will provide a monitored support contact, a way to report pages, links and media, and information about appeals.</p>
      <p>No report has been submitted from this page. Reporting and support are not open yet.</p>
      <Link href="/" prefetch={false}>Back to the introduction</Link>
    </div>
  </main>;
}
