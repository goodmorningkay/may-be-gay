import type { ReactNode } from "react";
import type { FieldErrors } from "@/domain/editor";
import styles from "./editor.module.css";

export function Field({ name, label, hint, errors, children }: { name: string; label: string; hint?: string; errors: FieldErrors; children: (props: { id: string; "aria-invalid": boolean; "aria-describedby": string }) => ReactNode }) {
  const id = `field-${name}`, error = errors[name];
  return <div className={styles.field}><label htmlFor={id}>{label}</label>
    {children({ id, "aria-invalid": Boolean(error), "aria-describedby": `${id}-hint ${id}-error` })}
    <span id={`${id}-hint`} className={styles.hint}>{hint}</span>
    <span id={`${id}-error`} className={styles.fieldError}>{error}</span></div>;
}
