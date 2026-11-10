import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ProfileView } from "@/components/profile-view";
import { getSiteDomain } from "@/domain/hosts";
import { getSession, requireUser } from "@/server/auth/session";
import { assertAppHost } from "@/server/http";
import { getProfilePreview } from "@/server/profile-editor";
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
    <aside className={styles.notice} aria-label="Private preview">
      <strong>Private draft preview</strong> · Version {profile.editVersion}. Publishing is a separate action. <a href="/editor">Return to editor</a>
    </aside>
    <ProfileView document={profile.document} username={profile.username} siteDomain={getSiteDomain()} media={profile.media} />
  </>;
}
