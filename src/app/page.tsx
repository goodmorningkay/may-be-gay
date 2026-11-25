import type { Metadata, Viewport } from "next";
import { notFound, redirect } from "next/navigation";
import { Homepage } from "@/components/homepage/homepage";
import { ProfileView } from "@/components/profile-view";
import { readClaimUsername, withClaimUsername } from "@/domain/username-intent";
import { isUsernameClaimed } from "@/server/accounts";
import { appOrigin } from "@/server/http";
import { readSitePage } from "@/server/site-page";
import { PublicAnalytics } from "@/components/operations/public-analytics";
import { reportUrl } from "@/domain/operations";

export const dynamic = "force-dynamic";

async function readPage() {
  const page = await readSitePage();
  const { host, profile } = page;
  if (host.kind === "invalid" || host.kind === "media" || (host.kind === "profile" && !profile)) notFound();
  return page;
}

export async function generateViewport(): Promise<Viewport> {
  const { profile } = await readSitePage();
  return profile ? { viewportFit: "cover" } : {};
}

export async function generateMetadata(): Promise<Metadata> {
  const { domain, profile } = await readPage();
  if (!profile) return { title: "A link-in-bio page you can make yours" };
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
    <ProfileView document={profile.document} username={profile.username} siteDomain={domain} media={profile.media} supportHref={reportUrl(profile.username, {}, domain)} fullViewport />
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
