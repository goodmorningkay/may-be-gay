import { headers } from "next/headers";
import { requireUser } from "@/server/auth/session";
import { AccountPanel } from "@/components/operations/account-panel";
import { AccountShell } from "@/components/operations/account-shell";
import { AccessHelp } from "@/components/operations/access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your account", robots: { index: false, follow: false } };

export default async function AccountPage() {
  let principal;
  try { principal = await requireUser(await headers()); }
  catch (error) { return <AccessHelp error={error} />; }

  return <AccountShell title="Your account" section="/account" email={principal.email} admin={principal.role === "admin"}>
    <AccountPanel key={principal.userId} accountId={principal.userId} />
  </AccountShell>;
}
