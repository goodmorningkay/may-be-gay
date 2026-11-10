import { headers } from "next/headers";
import { requireUser } from "@/server/auth/session";
import { AccountPanel } from "@/components/operations/account-panel";
import { AccessHelp } from "@/components/operations/access";
import styles from "@/components/operations/operations.module.css";
export const dynamic = "force-dynamic";
export const metadata = { title: "Your account", robots: { index: false, follow: false } };
export default async function AccountPage() {
  let p;
  try { p = await requireUser(await headers()); } catch (error) { return <AccessHelp error={error} />; }
  return <main className={styles.shell}><nav className={styles.nav}><a href="/editor">Edit profile</a><a href="/account/security">Password, two-factor and sessions</a><a href="/account/analytics">Analytics</a>{p.role === "admin" && <a href="/admin">Administration</a>}</nav><h1>Your account</h1><p>Signed in as {p.email}.</p><AccountPanel key={p.userId} accountId={p.userId} /></main>;
}
