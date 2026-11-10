import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ProfileView } from "@/components/profile-view";
import { getSiteDomain, resolveHost } from "@/domain/hosts";
import { createExampleProfile, profileDocumentSchema } from "@/domain/profile";
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
  return <>
    <section className={styles.sampleBar} aria-label="Sample page settings">
      <Link href="/" prefetch={false}>← Back to may-be.gay</Link>
      <p><strong>A fictional sample.</strong> Try a few looks. This is a public demonstration, with no account or draft attached.</p>
      <form className={styles.controls} action="/examples" method="get">
        <label>Look<select name="preset" defaultValue={example.theme.preset}>
          {profileDocumentSchema.shape.theme.shape.preset.options.map(value => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}
        </select></label>
        <label>Layout<select name="layout" defaultValue={example.theme.layout}><option value="stack">Stacked</option><option value="split">Side by side</option></select></label>
        <label>Type<select name="font" defaultValue={example.theme.font}><option value="sans">Sans serif</option><option value="serif">Serif</option><option value="mono">Monospace</option></select></label>
        <button type="submit">Try this look</button>
      </form>
    </section>
    <ProfileView document={example} username="example" siteDomain={domain} />
  </>;
}
