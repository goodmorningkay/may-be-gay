import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth/session";
import { listAccountSessions } from "@/server/accounts";
import { AppError } from "@/server/http";
import { SecurityPanel } from "@/components/auth/security-panel";
import styles from "../../(auth)/auth.module.css";
export const dynamic = "force-dynamic";
export default async function SecurityPage() {
  const h = await headers();
  let p;
  try {
    p = await requireUser(h);
  } catch (error) {
    if (error instanceof AppError && error.status === 401) redirect("/sign-in");
    throw error;
  }
  const sessions = await listAccountSessions(h);
  return <main className={styles.account}><SecurityPanel accountId={p.userId} email={p.email} initialSessions={sessions.map(s => ({ ...s, createdAt: s.createdAt.toISOString(), expiresAt: s.expiresAt.toISOString() }))} /></main>;
}
