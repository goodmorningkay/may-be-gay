import { useState } from "react";
import { reorderLink, type FieldErrors } from "@/domain/editor";
import type { ProfileDocument } from "@/domain/profile";
import { Field } from "./fields";
import styles from "./editor.module.css";

type Props = { document: ProfileDocument; errors: FieldErrors; onChange: (value: ProfileDocument) => void };
export function ContentFields({ document: d, errors, onChange }: Props) {
  const [announcement, setAnnouncement] = useState("");
  function updateLink(id: string, patch: Partial<ProfileDocument["links"][number]>) { onChange({ ...d, links: d.links.map(link => link.id === id ? { ...link, ...patch } : link) }); }
  return <>
    <section id="identity" className={styles.section} aria-labelledby="identity-title"><h2 id="identity-title">Make yourself at home.</h2>
      <p className={styles.sectionIntro}>Only the information you choose here appears on your page.</p>
      <Field name="displayName" label="Display name" errors={errors}>{props => <input {...props} value={d.displayName} maxLength={80} required autoComplete="off" onChange={e => onChange({ ...d, displayName: e.target.value })} />}</Field>
      <Field name="pronouns" label="Pronouns (optional)" errors={errors}>{props => <input {...props} value={d.pronouns} maxLength={50} autoComplete="off" onChange={e => onChange({ ...d, pronouns: e.target.value })} />}</Field>
      <Field name="bio" label="Bio" hint={`${d.bio.length}/500 characters`} errors={errors}>{props => <textarea {...props} value={d.bio} rows={4} maxLength={500} onChange={e => onChange({ ...d, bio: e.target.value })} />}</Field>
      <Field name="contact.email" label="Public contact email (optional)" hint="This address will be public. It is separate from your private login email. Clear it to remove it." errors={errors}>
        {props => <input {...props} type="email" value={d.contact?.email ?? ""} maxLength={254} autoComplete="off" onChange={e => onChange({ ...d, contact: e.target.value ? { email: e.target.value } : null })} />}</Field>
    </section>
    <section id="links" className={styles.section} aria-labelledby="links-title"><div className={styles.sectionHeading}><h2 id="links-title">Your links</h2><span>{d.links.length} / 30</span></div>
      <p className={styles.sectionIntro}>Use complete http:// or https:// addresses. Hidden links stay in your draft and count toward the limit.</p>
      <ol className={styles.linkList}>{d.links.map((link, index) => <li key={link.id} className={styles.linkCard}>
        <div className={styles.sectionHeading}><h3>Link {index + 1}{!link.visible ? " · Hidden" : ""}</h3><div className={styles.inlineActions}>
          <button type="button" disabled={index === 0} aria-label={`Move link ${index + 1} up`} onClick={() => { onChange(reorderLink(d, link.id, -1)); setAnnouncement(`Link moved to position ${index}.`); requestAnimationFrame(() => window.document.getElementById(`field-links.${index - 1}.label`)?.focus()); }}>↑ Up</button>
          <button type="button" disabled={index === d.links.length - 1} aria-label={`Move link ${index + 1} down`} onClick={() => { onChange(reorderLink(d, link.id, 1)); setAnnouncement(`Link moved to position ${index + 2}.`); requestAnimationFrame(() => window.document.getElementById(`field-links.${index + 1}.label`)?.focus()); }}>↓ Down</button>
        </div></div>
        <Field name={`links.${index}.label`} label={`Link ${index + 1} label`} errors={errors}>{props => <input {...props} value={link.label} maxLength={100} required onChange={e => updateLink(link.id, { label: e.target.value })} />}</Field>
        <Field name={`links.${index}.url`} label={`Link ${index + 1} URL`} errors={errors}>{props => <input {...props} type="url" inputMode="url" autoCapitalize="none" spellCheck={false} value={link.url} maxLength={2048} required onChange={e => updateLink(link.id, { url: e.target.value })} />}</Field>
        <Field name={`links.${index}.icon`} label={`Link ${index + 1} social icon`} errors={errors}>{props => <select {...props} value={link.icon ?? ""} onChange={e => {
          if (!e.target.value) { const { icon: _icon, ...rest } = link; void _icon; onChange({ ...d, links: d.links.map(value => value.id === link.id ? rest : value) }); }
          else updateLink(link.id, { icon: e.target.value as typeof link.icon });
        }}><option value="">No icon</option>{["website", "github", "instagram", "mastodon", "bluesky", "youtube", "twitch", "linkedin", "spotify"].map(icon => <option key={icon} value={icon}>{icon[0].toUpperCase() + icon.slice(1)}</option>)}</select>}</Field>
        <div className={styles.sectionHeading}><label className={styles.check}><input type="checkbox" checked={link.visible} onChange={e => updateLink(link.id, { visible: e.target.checked })} /> Show on public page</label>
          <button type="button" className={styles.dangerText} onClick={() => { if (window.confirm(`Delete link ${index + 1}${link.label ? ` (${link.label})` : ""}? This removes it from the draft. Published history stays available.`)) { onChange({ ...d, links: d.links.filter(value => value.id !== link.id) }); setAnnouncement("Link removed from draft."); } }}>Delete link {index + 1}</button></div>
      </li>)}</ol>
      {d.links.length === 0 ? <p>No links yet. Add a place you want to share.</p> : null}
      <button type="button" disabled={d.links.length >= 30} onClick={() => {
        onChange({ ...d, links: [...d.links, { id: crypto.randomUUID(), label: "", url: "", visible: true }] });
        setAnnouncement("Link added. Enter its label and complete URL to save.");
        requestAnimationFrame(() => window.document.getElementById(`field-links.${d.links.length}.label`)?.focus());
      }}>Add a link</button><p role="status" className={styles.hint}>{announcement}</p>
    </section>
  </>;
}

export function DiscoveryFields({ document: d, errors, onChange }: Props) {
  return <section id="discovery" className={styles.section} aria-labelledby="discovery-title"><h2 id="discovery-title">Page details & discovery</h2>
      <Field name="pageTitle" label="Page title" hint="Used for the browser title and share metadata. Leave empty to use the display name." errors={errors}>{props => <input {...props} value={d.pageTitle} maxLength={100} onChange={e => onChange({ ...d, pageTitle: e.target.value })} />}</Field>
      <Field name="pageDescription" label="Page description" hint={`${d.pageDescription.length}/200 characters for share metadata`} errors={errors}>{props => <textarea {...props} value={d.pageDescription} rows={3} maxLength={200} onChange={e => onChange({ ...d, pageDescription: e.target.value })} />}</Field>
      <label className={styles.check}><input type="checkbox" checked={d.allowIndexing} onChange={e => onChange({ ...d, allowIndexing: e.target.checked })} /> Allow search engines to index my published page</label>
      <p className={styles.hint}>Indexing is off unless you opt in. Published pages are accessible to anyone with the address either way. Search engines may take time to reflect changes.</p>
    </section>;
}
