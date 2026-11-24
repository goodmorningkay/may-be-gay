import { headers } from "next/headers";
import Link from "next/link";
import { requireAdmin } from "@/server/auth/session";
import { readAdmin } from "@/server/operations/admin";
import { launchReadiness } from "@/server/operations/policy";
import { AccessHelp } from "@/components/operations/access";
import { AdminPanel } from "@/components/operations/admin-panel";
import { SiteHeader } from "@/components/site-chrome";
import chrome from "@/components/site-chrome.module.css";
import { getSiteDomain } from "@/domain/hosts";

export const dynamic = "force-dynamic";
export const metadata = { title: "Administration", robots: { index: false, follow: false } };

export default async function AdminPage() {
  let initial;
  try {
    const h = await headers();
    await requireAdmin(h);
    initial = await readAdmin(h, "reports", new URL("https://app.invalid/?state=open"));
  } catch (error) {
    return <AccessHelp error={error} />;
  }

  const readiness = launchReadiness();
  return <div className={chrome.page}><div className={chrome.container}>
    <SiteHeader home={`https://${getSiteDomain()}`}><nav aria-label="Account">
      <Link href="/account">Account</Link><Link href="/account/security">Security</Link><Link href="/editor">Editor</Link>
    </nav></SiteHeader>
    <main>
      <div className={chrome.pageTitle}>
        <h1 className={chrome.heading}>Administration</h1>
        {!readiness.ready && <p><strong>Launch decisions pending</strong>{" "}
          <span className={chrome.muted}>Operator details, policies and monitored support are still pending.</span></p>}
      </div>
      <AdminPanel initial={JSON.parse(JSON.stringify(initial))} />
    </main>
  </div></div>;
}
