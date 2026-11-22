import { cache } from "react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { Homepage } from "@/components/homepage/homepage";
import { ProfileView } from "@/components/profile-view";
import { getSiteDomain, resolveHost } from "@/domain/hosts";
import { readClaimUsername, withClaimUsername } from "@/domain/username-intent";
import { isUsernameClaimed } from "@/server/accounts";
import { appOrigin } from "@/server/http";
import { getPublishedProfile } from "@/server/profiles";
import { PublicAnalytics } from "@/components/operations/public-analytics";
import { reportUrl } from "@/domain/operations";

export const dynamic = "force-dynamic";

// React cache only deduplicates within this request. There is no shared HTML,
// cross-user or revision cache; a publish/suspension is visible on the next read.
const readPage = cache(async () => {
  const domain = getSiteDomain();
  const host = resolveHost((await headers()).get("host"), domain);
  if (host.kind === "invalid" || host.kind === "media") notFound();
  const profile = host.kind === "profile" ? await getPublishedProfile(host.username) : null;
  if (host.kind === "profile" && !profile) notFound();
  return { domain, host, profile };
});

export async function generateMetadata(): Promise<Metadata> {
  const { domain, host, profile } = await readPage();
  if (!profile) return { title: host.kind === "app" ? "Your editor" : "A link-in-bio page you can make yours" };
  const title = profile.document.pageTitle || profile.document.displayName;
  const description = profile.document.pageDescription || profile.document.bio;
  const url = `https://${profile.username}.${domain}`;
  return {
    title: { absolute: title }, description,
    alternates: { canonical: url },
    robots: { index: profile.document.allowIndexing, follow: profile.document.allowIndexing },
    openGraph: { title, description, url, type: "profile", siteName: "may-be.gay" },
  };
}

export default async function Home({ searchParams }: { searchParams: Promise<{ username?: string | string[] }> }) {
  const { domain, host, profile } = await readPage();
  if (profile) return <>
    <ProfileView document={profile.document} username={profile.username} siteDomain={domain} media={profile.media} supportHref={reportUrl(profile.username, {}, domain)} />
    <PublicAnalytics username={profile.username} domain={domain} />
  </>;
  if (host.kind === "app") redirect("/editor");
  const { username: requestedUsername } = await searchParams;
  const username = readClaimUsername(requestedUsername);
  const origin = appOrigin();
  if (username) {
    if (await isUsernameClaimed(username)) {
      return <Homepage appOrigin={origin} domain={domain} takenUsername={username} />;
    }
    redirect(`${origin}${withClaimUsername("/sign-up", username)}`);
  }
  const rejectedUsername = requestedUsername === undefined ? undefined
    : typeof requestedUsername === "string" ? requestedUsername.slice(0, 30) : "";
  return <Homepage appOrigin={origin} domain={domain} rejectedUsername={rejectedUsername} />;
}
