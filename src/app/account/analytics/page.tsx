import { headers } from "next/headers";
import { readAnalytics } from "@/server/operations/analytics";
import { AccessHelp } from "@/components/operations/access";
import styles from "@/components/operations/operations.module.css";
export const dynamic = "force-dynamic";
export const metadata = { title: "Your analytics", robots: { index: false, follow: false } };
export default async function AnalyticsPage() {
  let data;
  try { data = await readAnalytics(await headers()); } catch (error) { return <AccessHelp error={error} />; }
  return <main className={styles.shell}><nav className={styles.nav}><a href="/account">Account</a><a href="/editor">Editor</a></nav><h1>Last 30 days</h1><p>{data.limitations}</p><div className={styles.grid}><p className={styles.card}><strong>{data.days.reduce((n, d) => n + d.views, 0)}</strong> page views</p><p className={styles.card}><strong>{data.days.reduce((n, d) => n + d.clicks, 0)}</strong> link clicks</p></div><div className={styles.table}><table><caption>Daily aggregate events, UTC</caption><thead><tr><th scope="col">Day</th><th scope="col">Views</th><th scope="col">Clicks</th></tr></thead><tbody>{data.days.map(day => <tr key={day.day}><th scope="row">{day.day}</th><td>{day.views}</td><td>{day.clicks}</td></tr>)}</tbody></table></div><details><summary>Per-link daily counts</summary><div className={styles.table}><table><caption>Stable link IDs, including links changed or removed since the event</caption><thead><tr><th scope="col">Day</th><th scope="col">Link ID</th><th scope="col">Clicks</th></tr></thead><tbody>{data.links.map(l => <tr key={`${l.day}-${l.linkId}`}><td>{l.day}</td><td>{l.linkId}</td><td>{l.clicks}</td></tr>)}</tbody></table></div></details></main>;
}
