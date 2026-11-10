import { applyPreset, type FieldErrors } from "@/domain/editor";
import { getThemeColors, getThemeContrast, hexColorSchema, profilePalettes, type ProfileDocument } from "@/domain/profile";
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
  return <section id="appearance" className={styles.section} aria-labelledby="appearance-title"><h2 id="appearance-title">Set the feeling.</h2>
    <p className={styles.sectionIntro}>A preset resets custom colours, background treatment, overlay, button shape and spacing. It keeps your layout, font, words, links and media.</p>
    <div className={styles.presetGrid} role="group" aria-label="Appearance presets">{Object.entries(profilePalettes).map(([preset, palette]) => <button type="button" key={preset} aria-pressed={t.preset === preset} onClick={() => onChange(applyPreset(d, preset as Theme["preset"]))}>
      <span className={styles.swatches} aria-hidden="true">{[palette.background, palette.surface, palette.ink, palette.accent].map((color, index) => <i key={index} style={{ backgroundColor: color }} />)}</span>
      {preset[0].toUpperCase() + preset.slice(1)}</button>)}</div>
    <div className={styles.twoColumns}>
      <Field name="theme.layout" label="Layout" errors={errors}>{props => <select {...props} value={t.layout} onChange={e => update({ layout: e.target.value as Theme["layout"] })}><option value="stack">Stack · centred single column</option><option value="split">Split · identity beside links on wide screens</option></select>}</Field>
      <Field name="theme.font" label="Font" errors={errors}>{props => <select {...props} value={t.font} onChange={e => update({ font: e.target.value as Theme["font"] })}><option value="sans">Sans serif</option><option value="serif">Serif</option><option value="mono">Monospace</option></select>}</Field>
      <Field name="theme.button" label="Link button shape" errors={errors}>{props => <select {...props} value={t.button ?? "preset"} onChange={e => update({ button: e.target.value as Theme["button"] })}>{["preset", "square", "rounded", "pill"].map(option => <option key={option} value={option}>{option}</option>)}</select>}</Field>
      <Field name="theme.spacing" label="Spacing" errors={errors}>{props => <select {...props} value={t.spacing ?? "comfortable"} onChange={e => update({ spacing: e.target.value as Theme["spacing"] })}>{["compact", "comfortable", "airy"].map(option => <option key={option} value={option}>{option}</option>)}</select>}</Field>
    </div>
    <label className={styles.check}><input type="checkbox" checked={Boolean(t.colors)} onChange={e => {
      if (e.target.checked) update({ colors: { background: colors.background, surface: colors.surface, ink: colors.ink, accent: colors.accent } });
      else { const { colors: _colors, ...theme } = t; void _colors; onChange({ ...d, theme }); }
    }} /> Custom colours</label>
    {t.colors ? <div className={styles.twoColumns}>{(["background", "surface", "ink", "accent"] as const).map(key => color(`theme.colors.${key}`, `${key[0].toUpperCase() + key.slice(1)} colour`, t.colors?.[key] ?? colors[key], value => update({ colors: { ...t.colors, [key]: value } })))}</div> : null}
    <Field name="theme.background.kind" label="Background treatment" hint="An uploaded background is layered over this treatment. Solid and gradient colours override the background colour above." errors={errors}>{props => <select {...props} value={t.background?.kind ?? "preset"} onChange={e => {
      if (e.target.value === "preset") { const { background: _background, ...theme } = t; void _background; onChange({ ...d, theme }); }
      else update({ background: e.target.value === "solid" ? { kind: "solid", color: colors.background } : { kind: "gradient", from: colors.background, to: colors.surface, direction: "down" } });
    }}><option value="preset">Preset / custom base colour</option><option value="solid">Solid colour</option><option value="gradient">Gradient</option></select>}</Field>
    {t.background?.kind === "solid" ? color("theme.background.color", "Solid background", t.background.color, value => update({ background: { kind: "solid", color: value } })) : null}
    {t.background?.kind === "gradient" ? <>
      <div className={styles.twoColumns}>{color("theme.background.from", "Gradient start", t.background.from, value => { if (t.background?.kind === "gradient") update({ background: { ...t.background, from: value } }); })}
        {color("theme.background.to", "Gradient end", t.background.to, value => { if (t.background?.kind === "gradient") update({ background: { ...t.background, to: value } }); })}</div>
      <Field name="theme.background.direction" label="Gradient direction" errors={errors}>{props => <select {...props} value={t.background?.kind === "gradient" ? t.background.direction : "down"} onChange={e => { if (t.background?.kind === "gradient") update({ background: { ...t.background, direction: e.target.value as "down" | "right" | "diagonal" } }); }}><option value="down">Top to bottom</option><option value="right">Left to right</option><option value="diagonal">Diagonal</option></select>}</Field>
    </> : null}
    <Field name="theme.overlay" label="Image overlay" hint="Applies only to an uploaded background image." errors={errors}>{props => <select {...props} value={t.overlay ?? "none"} onChange={e => update({ overlay: e.target.value as Theme["overlay"] })}><option value="none">None</option><option value="light">Light</option><option value="dark">Dark</option></select>}</Field>
    <div className={styles.feedback}><strong>{contrast.readable ? "Text contrast meets 4.5:1" : "Text contrast needs attention"}</strong>
      <p>Lowest sampled text ratio: {contrast.text.toFixed(2)}:1. Boundary / focus ratio: {contrast.boundaries.toFixed(2)}:1. Aim for 4.5:1 for text and 3:1 for controls.</p>
      <p className={styles.hint}>Based on the last valid appearance and gradient endpoints. Photographs, overlays and the middle of a gradient need a visual check; these measurements cannot guarantee their contrast.</p></div>
  </section>;
}
