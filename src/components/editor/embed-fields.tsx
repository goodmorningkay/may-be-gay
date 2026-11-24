import { useRef } from "react";
import type { FieldErrors } from "@/domain/editor";
import type { ProfileDocument } from "@/domain/profile";
import { maxEmbedUrlLength, maxProfileEmbeds, type ProfileEmbed } from "@/domain/profile-embeds";
import { Field } from "./fields";
import styles from "./editor.module.css";

export function EmbedFields({ document: draft, errors, onChange }: {
  document: ProfileDocument;
  errors: FieldErrors;
  onChange: (value: ProfileDocument) => void;
}) {
  const embeds = draft.embeds ?? [];
  const addButton = useRef<HTMLButtonElement>(null);
  const update = (next: ProfileEmbed[]) => onChange({ ...draft, embeds: next });

  function focusTitle(index: number) {
    requestAnimationFrame(() => {
      const title = document.getElementById(`field-embeds.${index}.title`);
      (title ?? addButton.current)?.focus();
    });
  }

  function add() {
    update([...embeds, { id: crypto.randomUUID(), title: "", url: "" }]);
    focusTitle(embeds.length);
  }

  function change(index: number, patch: Partial<Pick<ProfileEmbed, "title" | "url">>) {
    update(embeds.map((embed, position) => position === index ? { ...embed, ...patch } : embed));
  }

  function move(index: number, target: number) {
    const next = [...embeds];
    [next[index], next[target]] = [next[target], next[index]];
    update(next);
    focusTitle(target);
  }

  function remove(index: number) {
    update(embeds.filter((_, position) => position !== index));
    focusTitle(Math.min(index, embeds.length - 2));
  }

  return <section className={styles.section} aria-labelledby="embeds-title">
    <h2 id="embeds-title">Embeds</h2>
    <p className={styles.hint}>Use a Last.fm profile URL or a Spotify track, album, or playlist URL.</p>
    {embeds.map((embed, index) => <fieldset className={styles.embedFields} key={embed.id}>
      <legend>Embed {index + 1}</legend>
      <Field name={`embeds.${index}.title`} label="Title" errors={errors}>
        {props => <input {...props} value={embed.title} maxLength={100} required onChange={e => change(index, { title: e.target.value })} />}
      </Field>
      <Field name={`embeds.${index}.url`} label="Embed URL" errors={errors}>
        {props => <input {...props} type="url" value={embed.url} maxLength={maxEmbedUrlLength} required
          autoCapitalize="none" spellCheck={false} onChange={e => change(index, { url: e.target.value })} />}
      </Field>
      <div className={styles.sectionHeading}>
        <div className={styles.inlineActions}>
          <button type="button" disabled={index === 0} onClick={() => move(index, index - 1)}>Move up</button>
          <button type="button" disabled={index === embeds.length - 1} onClick={() => move(index, index + 1)}>Move down</button>
        </div>
        <button type="button" className={styles.dangerText} onClick={() => remove(index)}>Remove embed</button>
      </div>
    </fieldset>)}
    <div className={styles.sectionFooter}>
      <button ref={addButton} type="button" disabled={embeds.length >= maxProfileEmbeds} onClick={add}>Add embed</button>
      {embeds.length >= maxProfileEmbeds && <span className={styles.rowMeta}>Up to {maxProfileEmbeds} embeds per profile</span>}
    </div>
  </section>;
}
