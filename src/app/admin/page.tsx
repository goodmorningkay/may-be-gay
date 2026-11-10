import { headers } from "next/headers";
import { requireAdmin } from "@/server/auth/session";
import { readAdmin } from "@/server/operations/admin";
import { launchReadiness } from "@/server/operations/policy";
import { AccessHelp } from "@/components/operations/access";
import { AdminPanel } from "@/components/operations/admin-panel";
import styles from "@/components/operations/operations.module.css";
export const dynamic = "force-dynamic";
export const metadata = { title: "Administration", robots: { index: false, follow: false } };
export default async function AdminPage() {
  let initial;
  try { const h = await headers(); await requireAdmin(h); initial = await readAdmin(h, "reports", new URL("https://app.invalid/?state=open")); }
  catch (error) { return <AccessHelp error={error} />; }
  const readiness = launchReadiness();
  return <main className={styles.shell}><nav className={styles.nav}><a href="/account">Account</a><a href="/account/security">Security</a><a href="/editor">Editor</a></nav><h1>Administration</h1><p>Review reports, manage invitations and keep the service within its limits.</p>{!readiness.ready && <p className={styles.notice}>Launch decisions are incomplete: {readiness.missing.join(", ")}. Local reporting and account tools are available.</p>}<AdminPanel initial={JSON.parse(JSON.stringify(initial))} /></main>;
}
