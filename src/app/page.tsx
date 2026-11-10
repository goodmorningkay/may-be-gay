import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { ProfileView } from "@/components/profile-view";
import { getSiteDomain, resolveHost } from "@/domain/hosts";
import { getPublishedProfile } from "@/server/profiles";
import styles from "./site.module.css";

export const dynamic = "force-dynamic";

// React cache only deduplicates within this request. There is no shared HTML,
// cross-user or revision cache; a publish/suspension is visible on the next read.
const readPage = cache(async () => {
  const domain = getSiteDomain();
  const host = resolveHost((await headers()).get("host"), domain);
  if (host.kind === "invalid") notFound();
  const profile = host.kind === "profile" ? await getPublishedProfile(host.username) : null;
  if (host.kind === "profile" && !profile) notFound();
  return { domain, host, profile };
});

export async function generateMetadata(): Promise<Metadata> {
  const { domain, host, profile } = await readPage();
  if (!profile) return { title: host.kind === "app" ? "Your space is taking shape" : "A little space to be yourself" };
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

export default async function Home() {
  const { domain, host, profile } = await readPage();
  if (profile) return <ProfileView document={profile.document} username={profile.username} siteDomain={domain} />;
  if (host.kind === "app") return (
    <main className={styles.page}>
      <a className={styles.wordmark} href={`https://${domain}`}>may-be.gay</a>
      <div className={styles.intro}>
        <p className={styles.eyebrow}>A space in the making</p>
        <h1>Your page starts here.<br />Soon.</h1>
        <p>We’re getting ready for a small, invite-only beta. Account creation and the editor aren’t open yet.</p>
        <a className={styles.button} href={`https://${domain}/examples`}>Explore a sample page <span aria-hidden="true">↗</span></a>
      </div>
    </main>
  );
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.wordmark} href="/" prefetch={false}>may-be.gay</Link>
        <a href="/support">Support & reporting</a>
      </header>
      <div className={styles.hero}>
        <section className={styles.intro}>
          <p className={styles.eyebrow}>A little space on the internet</p>
          <h1>All your places.<br />A page that’s you.</h1>
          <p>Your work, your interests, your favourite corners of the web. A home for your links, with room for a little personality.</p>
          <a className={styles.button} href="/examples">Find your look <span aria-hidden="true">↗</span></a>
          <p className={styles.note}>In development · preparing for an invite-only beta</p>
        </section>
        <aside className={styles.postcard} aria-label="An example of your future address">
          <span>A place to call your own</span>
          <p>you<span>.may-be.gay</span></p>
          <span>A few links. A lot of you.</span>
        </aside>
      </div>
      <section className={styles.details} aria-label="What we're making">
        <div><h2>Make yourself at home</h2><p>Six starting looks, two layouts, and space to share what matters to you.</p></div>
        <div><h2>Your pace, your page</h2><p>The editor will let you keep a private draft and choose when to publish.</p></div>
        <div><h2>A small beginning</h2><p>We’re building towards a free service, starting with a small invited group.</p></div>
      </section>
      <footer className={styles.footer}><span>may-be.gay</span><a href={`https://app.${domain}`}>About the upcoming beta <span aria-hidden="true">↗</span></a></footer>
    </main>
  );
}
