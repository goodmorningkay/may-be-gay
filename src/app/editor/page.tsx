import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSession, requireUser } from "@/server/auth/session";
import { AppError, assertAppHost } from "@/server/http";
import { getSiteDomain } from "@/domain/hosts";
import { readClaimUsername, withClaimUsername } from "@/domain/username-intent";
import { EditorEntry } from "@/components/editor/editor-entry";
import styles from "@/components/editor/editor.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Edit your page", robots: { index: false, follow: false } };

export default async function EditorPage({ searchParams }: { searchParams: Promise<{ username?: string | string[] }> }) {
  const requestHeaders = await headers();
  const username = readClaimUsername((await searchParams).username);
  const signInPath = withClaimUsername("/sign-in?returnTo=%2Feditor", username);
  let principal;
  try {
    assertAppHost(requestHeaders);
    if (!await getSession(requestHeaders)) redirect(signInPath);
    principal = await requireUser(requestHeaders);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    if (error.status === 401) redirect(signInPath);
    return <main className={styles.entry}><h1>Your private editor</h1>
      <p>{error.code === "VERIFICATION_REQUIRED" ? "Verify your email before claiming a username or editing a page." : "The editor is unavailable for this account or address."}</p>
      {error.code === "VERIFICATION_REQUIRED" ? <a href="/verify-email">Email verification</a> : <p>Try again from the account application. If access remains unavailable, use the support page.</p>}
      <p><a href={`https://${getSiteDomain()}/support`}>Support</a></p></main>;
  }
  // No account email or authentication name is serialized into the editor.
  return <EditorEntry key={username} accountId={principal.userId} siteDomain={getSiteDomain()} initialUsername={username} />;
}
