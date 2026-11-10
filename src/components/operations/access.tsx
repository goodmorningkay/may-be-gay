import { AppError } from "@/server/http";
import styles from "./operations.module.css";
export function AccessHelp({ error }: { error: unknown }) {
  return <main className={styles.shell}><h1>Account access</h1><p>{error instanceof AppError ? error.message : "Unable to load this page right now. Try again shortly."}</p><nav className={styles.nav}><a href="/sign-in">Sign in</a><a href="/account/security">Confirm password and two-factor access</a><a href="/account">Account</a></nav></main>;
}
