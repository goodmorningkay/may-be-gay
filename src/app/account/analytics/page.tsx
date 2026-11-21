import { headers } from "next/headers";
import { readAnalytics } from "@/server/operations/analytics";
import { readAccountPresentation } from "@/server/accounts";
import { requireUser } from "@/server/auth/session";
import { AccessHelp } from "@/components/operations/access";
import { AccountShell } from "@/components/operations/account-shell";
import chrome from "@/components/site-chrome.module.css";
import styles from "@/components/operations/operations.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your analytics", robots: { index: false, follow: false } };

const date = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const year = new Intl.DateTimeFormat("en-GB", { year: "numeric", timeZone: "UTC" });
const number = new Intl.NumberFormat("en-GB");

function DailyChart({ days }: { days: Awaited<ReturnType<typeof readAnalytics>>["days"] }) {
  const largest = Math.max(2, ...days.flatMap(day => [day.views, day.clicks]));
  const half = Math.ceil(largest / 2);
  const max = half * 2;
  const labels = [days[0], days[Math.floor(days.length / 2)], days[days.length - 1]];

  return <section className={`${chrome.card} ${styles.chart}`}>
    <h3 className={chrome.subheading}>Daily activity</h3>
    <div className={styles.chartLegend}><span>Page views</span><span>Link clicks</span></div>
    <div className={styles.chartArea} role="img" aria-label="Daily page views and link clicks over the last 30 days. Exact counts are in the table below.">
      <div className={styles.chartAxis} aria-hidden="true"><span>{number.format(max)}</span><span>{number.format(half)}</span><span>0</span></div>
      <div className={styles.chartBars} aria-hidden="true">{days.map(day => <div className={styles.chartDay} key={day.day} title={`${day.day} · ${day.views} views · ${day.clicks} clicks`}>
        <span style={{ height: `${day.views / max * 100}%` }} /><span style={{ height: `${day.clicks / max * 100}%` }} />
      </div>)}</div>
      <div className={styles.chartDates} aria-hidden="true">{labels.map(day => <span key={day.day}>{date.format(new Date(day.day))}</span>)}</div>
    </div>
  </section>;
}

export default async function AnalyticsPage() {
  const h = await headers();
  let principal, data, presentation;
  try {
    principal = await requireUser(h);
    [data, presentation] = await Promise.all([readAnalytics(h), readAccountPresentation(principal.userId)]);
  } catch (error) {
    return <AccessHelp error={error} />;
  }

  const views = data.days.reduce((sum, day) => sum + day.views, 0);
  const clicks = data.days.reduce((sum, day) => sum + day.clicks, 0);
  const start = new Date(data.days[0].day), end = new Date(data.days[data.days.length - 1].day);
  const range = year.format(start) === year.format(end)
    ? `${date.format(start)}–${date.format(end)} ${year.format(end)}`
    : `${date.format(start)} ${year.format(start)}–${date.format(end)} ${year.format(end)}`;

  return <AccountShell title="Analytics" section="/account/analytics" username={presentation.username} admin={principal.role === "admin"}>
    <div><h2 className={chrome.subheading}>Last 30 days</h2><p className={`${styles.range} ${chrome.mono} ${chrome.muted}`}>{range} · UTC</p></div>
    <div className={styles.totals}>{[{ count: views, label: "Page views" }, { count: clicks, label: "Link clicks" }].map(({ count, label }) =>
      <div className={chrome.card} key={label}><span>{label}</span><strong>{number.format(count)}</strong><small>Approximate</small></div>
    )}</div>
    <p className={chrome.muted}>{data.limitations}</p>
    {views || clicks ? <>
      <DailyChart days={data.days} />
      <section className={`${chrome.card} ${chrome.stack}`}>
        <h3 className={chrome.subheading}>Daily counts</h3><p className={chrome.muted}>Approximate events by day, UTC.</p>
        <div className={styles.table} tabIndex={0} role="region" aria-label="Daily counts">
          <table><thead><tr><th scope="col">Day</th><th scope="col">Views</th><th scope="col">Clicks</th></tr></thead>
            <tbody>{[...data.days].reverse().map(day => <tr key={day.day}><th scope="row">{day.day}</th><td>{number.format(day.views)}</td><td>{number.format(day.clicks)}</td></tr>)}</tbody>
          </table>
        </div>
        <p className={chrome.muted}>Scroll to see all 30 days.</p>
      </section>
      <details className={`${chrome.card} ${styles.linkCounts}`}><summary>Per-link daily counts</summary>
        <p className={chrome.muted}>Stable IDs include links that have since changed or been removed.</p>
        {data.links.length ? <div className={styles.table} tabIndex={0} role="region" aria-label="Per-link daily counts">
          <table><thead><tr><th scope="col">Day</th><th scope="col">Link ID</th><th scope="col">Clicks</th></tr></thead>
            <tbody>{[...data.links].reverse().map(link => <tr key={`${link.day}-${link.linkId}`}><th scope="row">{link.day}</th><td>{link.linkId}</td><td>{number.format(link.clicks)}</td></tr>)}</tbody>
          </table>
        </div> : <p className={chrome.muted}>No link clicks recorded.</p>}
      </details>
    </> : <section className={`${chrome.card} ${chrome.stack}`}>
      <h3 className={chrome.subheading}>No activity recorded</h3>
      <p className={chrome.muted}>Page views and link clicks will appear here as activity is recorded on your published page.</p>
    </section>}
  </AccountShell>;
}
