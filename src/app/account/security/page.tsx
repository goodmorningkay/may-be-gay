import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth/session";
import { listAccountSessions, readAccountPresentation } from "@/server/accounts";
import { AppError } from "@/server/http";
import { SecurityPanel } from "@/components/auth/security-panel";
import { AccountShell } from "@/components/operations/account-shell";
import { AccessHelp } from "@/components/operations/access";

export const dynamic = "force-dynamic";

export default async function SecurityPage() {
  const h = await headers();
  let principal, sessions, presentation;
  try {
    principal = await requireUser(h);
    [sessions, presentation] = await Promise.all([listAccountSessions(principal), readAccountPresentation(principal.userId)]);
  } catch (error) {
    if (error instanceof AppError && error.status === 401) redirect("/sign-in");
    return <AccessHelp error={error} />;
  }

  return <AccountShell title="Account security" section="/account/security" email={principal.email} admin={principal.role === "admin"}>
    <SecurityPanel key={principal.userId} accountId={principal.userId} email={principal.email} initial={presentation}
      initialSessions={sessions.map(row => ({ id: row.id, createdAt: row.createdAt.toISOString(), current: row.current }))} />
  </AccountShell>;
}
