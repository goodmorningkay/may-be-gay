import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ProfileView } from "@/components/profile-view";
import { getSiteDomain } from "@/domain/hosts";
import { getSession, requireUser } from "@/server/auth/session";
import { assertAppHost } from "@/server/http";
import { getProfilePreview } from "@/server/profile-editor";
import Link from "next/link";
import chrome from "@/components/site-chrome.module.css";
import styles from "./preview.module.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = { title: "Private draft preview", robots: { index: false, follow: false } };

export default async function Preview() {
  const requestHeaders = await headers();
  assertAppHost(requestHeaders);
  if (!await getSession(requestHeaders)) redirect("/sign-in?returnTo=%2Fpreview");
  const principal = await requireUser(requestHeaders);
  const profile = await getProfilePreview(principal);
  return <>
    <aside className={`${chrome.page} ${styles.notice}`} aria-label="Private preview">
      <div className={`${chrome.container} ${styles.banner}`}>
        <div className={styles.identity}>
          <span className={styles.lock} aria-hidden="true" />
          <div><strong>Private draft preview</strong><p>Saved version {profile.editVersion} · Only you can see this draft.</p></div>
        </div>
        <Link className={chrome.button} href="/editor">Return to editor</Link>
      </div>
    </aside>
    <ProfileView document={profile.document} username={profile.username} siteDomain={getSiteDomain()} media={profile.media} />
  </>;
}
