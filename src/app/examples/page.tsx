import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ProfileView } from "@/components/profile-view";
import { getSiteDomain, resolveHost } from "@/domain/hosts";
import { createExampleProfile, profileDocumentSchema } from "@/domain/profile";
import { SiteHeader } from "@/components/site-chrome";
import chrome from "@/components/site-chrome.module.css";
import styles from "../site.module.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Explore a sample page", robots: { index: false, follow: false } };

export default async function Examples({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const domain = getSiteDomain();
  if (resolveHost((await headers()).get("host"), domain).kind !== "apex") notFound();
  const params = await searchParams;
  const example = createExampleProfile();
  const theme = profileDocumentSchema.shape.theme.safeParse({
    preset: params.preset ?? example.theme.preset,
    layout: params.layout ?? example.theme.layout,
    font: params.font ?? example.theme.font,
  });
  if (!theme.success) notFound();
  example.theme = theme.data;
  example.bio = "I make things, collect small discoveries, and take the long way home.";
  return <>
    <div className={`${chrome.page} ${styles.sampleBar}`}><div className={chrome.container}>
      <SiteHeader><Link href="/" prefetch={false} className={chrome.button}>Back to home</Link></SiteHeader>
      <section className={styles.sampleSettings} aria-labelledby="sample-title">
        <div><h2 id="sample-title">Explore a sample page</h2><p>This profile is fictional.</p></div>
        <form className={styles.controls} action="/examples" method="get">
          <div className={chrome.field}><label htmlFor="sample-preset">Look</label><select id="sample-preset" className={chrome.control} name="preset" defaultValue={example.theme.preset}>
            {profileDocumentSchema.shape.theme.shape.preset.options.map(value => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}
          </select></div>
          <div className={chrome.field}><label htmlFor="sample-layout">Layout</label><select id="sample-layout" className={chrome.control} name="layout" defaultValue={example.theme.layout}><option value="stack">Stacked</option><option value="split">Side by side</option></select></div>
          <div className={chrome.field}><label htmlFor="sample-font">Type</label><select id="sample-font" className={chrome.control} name="font" defaultValue={example.theme.font}><option value="sans">Sans serif</option><option value="serif">Serif</option><option value="mono">Monospace</option></select></div>
          <button className={chrome.primary} type="submit">Try this look</button>
        </form>
      </section>
    </div></div>
    <ProfileView document={example} username="example" siteDomain={domain} />
  </>;
}
