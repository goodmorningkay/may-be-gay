import { useEffect, useRef, useState } from "react";
import { reorderLink, type FieldErrors } from "@/domain/editor";
import { socialLinkIcons, type ProfileDocument } from "@/domain/profile";
import { EditorIcon } from "./editor-icon";
import { Field } from "./fields";
import styles from "./editor.module.css";

type Props = { document: ProfileDocument; errors: FieldErrors; onChange: (value: ProfileDocument) => void };
export type LinkEdit = { id: string; field?: "label" | "url" | "icon" };

export function AboutFields({ document: d, errors, onChange }: Props) {
  return <section className={styles.section} aria-labelledby="identity-title">
    <h2 id="identity-title">About you</h2>
    <div className={styles.twoColumns}>
      <Field name="displayName" label="Display name" errors={errors}>{props => <input {...props} value={d.displayName} maxLength={80} required autoComplete="off" onChange={e => onChange({ ...d, displayName: e.target.value })} />}</Field>
      <Field name="pronouns" label="Pronouns" errors={errors}>{props => <input {...props} value={d.pronouns} maxLength={50} autoComplete="off" onChange={e => onChange({ ...d, pronouns: e.target.value })} />}</Field>
    </div>
    <Field name="bio" label="Bio" errors={errors}>{props => <textarea {...props} value={d.bio} rows={2} maxLength={500} onChange={e => onChange({ ...d, bio: e.target.value })} />}</Field>
    <Field name="contact.email" label="Public contact email" hint="Shown on your published page." errors={errors}>
      {props => <input {...props} type="email" value={d.contact?.email ?? ""} maxLength={254} autoComplete="off" onChange={e => onChange({ ...d, contact: e.target.value ? { email: e.target.value } : null })} />}
    </Field>
  </section>;
}

const socialIcons = socialLinkIcons;

export function LinkFields({ document: d, errors, onChange, edit, onEdit }: Props & { edit: LinkEdit | null; onEdit: (edit: LinkEdit | null) => void }) {
  const [announcement, setAnnouncement] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const index = d.links.findIndex(link => link.id === edit?.id);
  const link = d.links[index];
  const editing = Boolean(link);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (!editing) {
      if (node.open) node.close();
      return;
    }
    if (!node.open) node.showModal();
    const field = edit?.field ?? "label";
    node.querySelector<HTMLElement>(`[id$=".${field}"]`)?.focus();
  }, [edit, editing]);

  function updateLink(patch: Partial<ProfileDocument["links"][number]>) {
    onChange({ ...d, links: d.links.map(value => value.id === link.id ? { ...value, ...patch } : value) });
  }

  function move(direction: -1 | 1) {
    onChange(reorderLink(d, link.id, direction));
    setAnnouncement(`Link moved to position ${index + direction + 1}.`);
    dialog.current?.querySelector("input")?.focus();
  }

  function add() {
    const id = crypto.randomUUID();
    onChange({ ...d, links: [...d.links, { id, label: "", url: "", visible: true }] });
    onEdit({ id });
  }

  function remove() {
    if (!window.confirm(`Delete ${link.label || `link ${index + 1}`} from your draft?`)) return;
    onChange({ ...d, links: d.links.filter(value => value.id !== link.id) });
    onEdit(null);
    setAnnouncement("Link removed from draft.");
    requestAnimationFrame(() => addButton.current?.focus());
  }

  return <section className={styles.section} aria-labelledby="links-title">
    <h2 id="links-title">Links</h2>
    {d.links.length ? <ol className={styles.linkList}>{d.links.map((value, position) =>
      <li key={value.id}>
        <button type="button" className={styles.linkRow} aria-haspopup="dialog" onClick={() => onEdit({ id: value.id })}>
          <span className={styles.linkSummary}>
            <strong>{value.label || `Link ${position + 1}`}</strong>
            <span>{value.url || "Add a URL"}</span>
          </span>
          {!value.visible && <span className={styles.rowMeta}>Hidden</span>}
        </button>
      </li>
    )}</ol> : <p className={styles.hint}>No links yet.</p>}
    <div className={styles.sectionHeading}>
      <span className={styles.rowMeta}>{d.links.length} / 30 links</span>
      <button ref={addButton} type="button" disabled={d.links.length >= 30} onClick={add}>Add link</button>
    </div>
    <p role="status" className={styles.srOnly}>{announcement}</p>
    <dialog ref={dialog} className={`${styles.dialog} ${styles.linkDialog}`} aria-labelledby="link-dialog-title"
      onCancel={() => onEdit(null)}>
      <div className={styles.sectionHeading}>
        <h2 id="link-dialog-title">Edit link</h2>
        <button type="button" className={styles.iconButton} aria-label="Close link editor" onClick={() => onEdit(null)}><EditorIcon name="closeIcon" /></button>
      </div>
      {link && <>
        <Field name={`links.${index}.label`} label="Label" errors={errors}>{props => <input {...props} value={link.label} maxLength={100} required onChange={e => updateLink({ label: e.target.value })} />}</Field>
        <Field name={`links.${index}.url`} label="URL" errors={errors}>{props => <input {...props} type="url" inputMode="url" autoCapitalize="none" spellCheck={false} value={link.url} maxLength={2048} required onChange={e => updateLink({ url: e.target.value })} />}</Field>
        <Field name={`links.${index}.icon`} label="Social icon" errors={errors}>{props => <select {...props} value={link.icon ?? ""} onChange={e => {
          const icon = socialIcons.find(value => value === e.target.value);
          if (icon) updateLink({ icon });
          else {
            const { icon: _icon, ...rest } = link;
            void _icon;
            onChange({ ...d, links: d.links.map(value => value.id === link.id ? rest : value) });
          }
        }}><option value="">No icon</option>{socialIcons.map(icon => <option key={icon} value={icon}>{icon[0].toUpperCase() + icon.slice(1)}</option>)}</select>}</Field>
        <label className={styles.checkRow}>Show on public page<input className={styles.visibilityCheck} type="checkbox" checked={link.visible} onChange={e => updateLink({ visible: e.target.checked })} /></label>
        <div className={styles.sectionHeading}>
          <div className={styles.inlineActions}>
            <button type="button" disabled={index === 0} onClick={() => move(-1)}>Move up</button>
            <button type="button" disabled={index === d.links.length - 1} onClick={() => move(1)}>Move down</button>
          </div>
          <button type="button" className={styles.dangerText} onClick={remove}>Delete link</button>
        </div>
      </>}
    </dialog>
  </section>;
}

export function DiscoveryFields({ document: d, errors, onChange }: Props) {
  return <section className={styles.section} aria-labelledby="discovery-title">
    <h2 id="discovery-title">Page details &amp; discovery</h2>
    <Field name="pageTitle" label="Page title" errors={errors}>{props => <input {...props} value={d.pageTitle} maxLength={100} onChange={e => onChange({ ...d, pageTitle: e.target.value })} />}</Field>
    <Field name="pageDescription" label="Sharing description" errors={errors}>{props => <textarea {...props} value={d.pageDescription} rows={2} maxLength={200} onChange={e => onChange({ ...d, pageDescription: e.target.value })} />}</Field>
    <label className={styles.checkRow}>Allow search engines to index this page
      <input id="field-allowIndexing" className={styles.switch} type="checkbox" role="switch" checked={d.allowIndexing} onChange={e => onChange({ ...d, allowIndexing: e.target.checked })} />
    </label>
  </section>;
}
