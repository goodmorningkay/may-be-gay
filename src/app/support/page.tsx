import Link from "next/link";
import { getReportTargets } from "@/server/operations/reports";
import { isValidUsername } from "@/domain/hosts";
import { policyConfiguration } from "@/server/operations/policy";
import { requireApexPage } from "@/server/operations/pages";
import { ReportForm } from "@/components/operations/report-form";
import styles from "@/components/operations/operations.module.css";
export const dynamic = "force-dynamic";
export default async function SupportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireApexPage(); const q = await searchParams, config = policyConfiguration();
  const username = typeof q.username === "string" && isValidUsername(q.username) ? q.username : "";
  const targets = username ? await getReportTargets(username) : [];
  const requested = typeof q.linkId === "string" ? `link:${q.linkId.toLowerCase()}` : typeof q.mediaId === "string" ? `media:${q.mediaId.toLowerCase()}` : "";
  const target = targets.some(t => t.value === requested) ? requested : "";
  return <main className={styles.shell}><nav className={styles.nav}><Link href="/">may-be.gay</Link><a href="/rules">Rules</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav><h1>Support and reporting</h1>{config.values.supportEmail && config.supportMonitored ? <p>Support: <a href={`mailto:${config.values.supportEmail}`}>{config.values.supportEmail}</a>. {config.values.appealsEmail && <>Appeals: <a href={`mailto:${config.values.appealsEmail}`}>{config.values.appealsEmail}</a>.</>}</p> : <p className={styles.notice}>A monitored operator/support contact is pending configuration. Local reports are saved for an administrator to review; response times and email replies are not yet promised.</p>}<form action="/support" method="get" className={styles.card}><label>Find a public profile<input name="username" defaultValue={username} minLength={3} maxLength={30} required autoComplete="off" /></label><button>Load report choices</button></form><ReportForm key={username} username={username} targets={targets} target={target} /><p>Reporter contact is private and removed after 30 days. Report records are removed after 90 days. Reporting does not send an email automatically.</p></main>;
}
