import { applyPreset, type FieldErrors } from "@/domain/editor";
import { getThemeColors, getThemeContrast, hexColorSchema, profilePalettes, type ProfileDocument } from "@/domain/profile";
import { EditorIcon } from "./editor-icon";
import { Field } from "./fields";
import styles from "./editor.module.css";

type Theme = ProfileDocument["theme"];
export function AppearanceFields({ document: d, preview, errors, onChange }: { document: ProfileDocument; preview: ProfileDocument; errors: FieldErrors; onChange: (document: ProfileDocument) => void }) {
  const t = d.theme, colors = getThemeColors(preview.theme), contrast = getThemeContrast(preview.theme);
  function update(patch: Partial<Theme>) { onChange({ ...d, theme: { ...t, ...patch } }); }
  function color(name: string, label: string, value: string, change: (value: string) => void) {
    return <Field key={name} name={name} label={label} errors={errors}>{props => <div className={styles.colorInput}>
      <input type="color" aria-label={`Pick ${label.toLowerCase()}`} value={hexColorSchema.safeParse(value).success ? value : "#000000"} onChange={e => change(e.target.value)} />
      <input {...props} value={value} maxLength={7} spellCheck={false} onChange={e => change(e.target.value)} /></div>}</Field>;
  }
  return <section id="appearance" className={styles.section} aria-labelledby="appearance-title"><h2 id="appearance-title">Appearance</h2>
    <h3 className={styles.controlLabel}>Theme presets</h3>
    <div className={styles.presetGrid} role="group" aria-label="Appearance presets">{Object.keys(profilePalettes).map(preset => <button type="button" key={preset} aria-pressed={t.preset === preset}
      title="Resets custom colours, background treatment, overlay, button shape and spacing."
      onClick={() => onChange(applyPreset(d, preset as Theme["preset"]))}>
      <span className={styles.presetMarks}><span className={styles.swatches} data-preset={preset} aria-hidden="true" />
        {t.preset === preset && <EditorIcon name="presetCheck" />}</span>
      {preset[0].toUpperCase() + preset.slice(1)}</button>)}</div>
    <div className={`${styles.twoColumns} ${styles.sectionFooter}`}>
      <Field name="theme.layout" label="Layout" errors={errors}>{props => <select {...props} value={t.layout} onChange={e => update({ layout: e.target.value as Theme["layout"] })}><option value="stack">Stack</option><option value="split">Split</option></select>}</Field>
      <Field name="theme.font" label="Font" errors={errors}>{props => <select {...props} value={t.font} onChange={e => update({ font: e.target.value as Theme["font"] })}><option value="sans">Sans serif</option><option value="serif">Serif</option><option value="mono">Monospace</option></select>}</Field>
      <Field name="theme.button" label="Link button shape" errors={errors}>{props => <select {...props} value={t.button ?? "preset"} onChange={e => update({ button: e.target.value as Theme["button"] })}>{["preset", "square", "rounded", "pill"].map(option => <option key={option} value={option}>{option}</option>)}</select>}</Field>
      <Field name="theme.spacing" label="Spacing" errors={errors}>{props => <select {...props} value={t.spacing ?? "comfortable"} onChange={e => update({ spacing: e.target.value as Theme["spacing"] })}>{["compact", "comfortable", "airy"].map(option => <option key={option} value={option}>{option}</option>)}</select>}</Field>
    <Field name="theme.background.kind" label="Background treatment" errors={errors}>{props => <select {...props} value={t.background?.kind ?? "preset"} onChange={e => {
      if (e.target.value === "preset") { const { background: _background, ...theme } = t; void _background; onChange({ ...d, theme }); }
      else update({ background: e.target.value === "solid" ? { kind: "solid", color: colors.background } : { kind: "gradient", from: colors.background, to: colors.surface, direction: "down" } });
    }}><option value="preset">Custom base colour</option><option value="solid">Solid colour</option><option value="gradient">Gradient</option></select>}</Field>
    <Field name="theme.overlay" label="Image overlay" errors={errors}>{props => <select {...props} value={t.overlay ?? "none"} onChange={e => update({ overlay: e.target.value as Theme["overlay"] })}><option value="none">None</option><option value="light">Light</option><option value="dark">Dark</option></select>}</Field>
    </div>
    {t.background?.kind === "solid" ? color("theme.background.color", "Solid background", t.background.color, value => update({ background: { kind: "solid", color: value } })) : null}
    {t.background?.kind === "gradient" ? <>
      <div className={styles.twoColumns}>{color("theme.background.from", "Gradient start", t.background.from, value => { if (t.background?.kind === "gradient") update({ background: { ...t.background, from: value } }); })}
        {color("theme.background.to", "Gradient end", t.background.to, value => { if (t.background?.kind === "gradient") update({ background: { ...t.background, to: value } }); })}</div>
      <Field name="theme.background.direction" label="Gradient direction" errors={errors}>{props => <select {...props} value={t.background?.kind === "gradient" ? t.background.direction : "down"} onChange={e => { if (t.background?.kind === "gradient") update({ background: { ...t.background, direction: e.target.value as "down" | "right" | "diagonal" } }); }}><option value="down">Top to bottom</option><option value="right">Left to right</option><option value="diagonal">Diagonal</option></select>}</Field>
    </> : null}
    <div className={styles.sectionFooter}>
    <label className={styles.checkRow}>Custom colours<input className={styles.switch} type="checkbox" checked={Boolean(t.colors)} onChange={e => {
      if (e.target.checked) update({ colors: { background: colors.background, surface: colors.surface, ink: colors.ink, accent: colors.accent } });
      else { const { colors: _colors, ...theme } = t; void _colors; onChange({ ...d, theme }); }
    }} /></label>
    {t.colors ? <div className={styles.twoColumns}>{(["background", "surface", "ink", "accent"] as const).map(key => color(`theme.colors.${key}`, `${key[0].toUpperCase() + key.slice(1)} colour`, t.colors?.[key] ?? colors[key], value => update({ colors: { ...t.colors, [key]: value } })))}</div> : null}
    </div>
    <div className={styles.contrast}>
      {contrast.readable && <EditorIcon name="contrastIcon" />}
      <span>{contrast.readable ? "Text contrast meets 4.5:1" : "Text contrast needs attention"}</span>
      <span className={styles.srOnly}>Sampled text ratio {contrast.text.toFixed(2)}:1. Boundary and focus ratio {contrast.boundaries.toFixed(2)}:1. Photos and intermediate gradient colours need a visual check.</span>
    </div>
  </section>;
}
