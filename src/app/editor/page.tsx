import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSession, requireUser } from "@/server/auth/session";
import { AppError, assertAppHost } from "@/server/http";
import { getSiteDomain } from "@/domain/hosts";
import { EditorEntry } from "@/components/editor/editor-entry";
import styles from "@/components/editor/editor.module.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const metadata: Metadata = { title: "Edit your page", robots: { index: false, follow: false } };

export default async function EditorPage() {
  const requestHeaders = await headers();
  let principal;
  try {
    assertAppHost(requestHeaders);
    if (!await getSession(requestHeaders)) redirect("/sign-in?returnTo=%2Feditor");
    principal = await requireUser(requestHeaders);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    if (error.status === 401) redirect("/sign-in?returnTo=%2Feditor");
    return <main className={styles.entry}><h1>Your private editor</h1>
      <p>{error.code === "VERIFICATION_REQUIRED" ? "Verify your email before claiming a username or editing a page." : "The editor is unavailable for this account or address."}</p>
      {error.code === "VERIFICATION_REQUIRED" ? <a href="/verify-email">Email verification</a> : <p>Try again from the account application. If access remains unavailable, use the support page.</p>}
      <p><a href={`https://${getSiteDomain()}/support`}>Support</a></p></main>;
  }
  // No account email or authentication name is serialized into the editor.
  return <EditorEntry accountId={principal.userId} siteDomain={getSiteDomain()} />;
}
