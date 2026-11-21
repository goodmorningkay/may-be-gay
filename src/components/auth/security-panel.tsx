"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { accountRequest as sendAccountRequest } from "./auth-form";
import chrome from "../site-chrome.module.css";
import styles from "../operations/operations.module.css";

type SessionRow = { id: string; createdAt: string; expiresAt: string; current: boolean };
type Authenticator = "off" | "pending" | "enabled";
const sessionDate = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
const formHelp = "/api/account/form-help";

function PasswordField({ name = "password", label = "Password", isNew = false }: { name?: string; label?: string; isNew?: boolean }) {
  return <div className={chrome.field}>
    <label className={chrome.field}><span>{label}</span>
      <input className={chrome.control} name={name} type="password" required minLength={isNew ? 12 : undefined}
        autoComplete={isNew ? "new-password" : "current-password"} maxLength={128} aria-describedby={isNew ? "new-password-length" : undefined} />
    </label>
    {isNew && <small className={chrome.muted} id="new-password-length">At least 12 characters.</small>}
  </div>;
}

export function SecurityPanel({ accountId, email, initial, initialSessions }: {
  accountId: string; email: string; initial: { username?: string; authenticator: Authenticator }; initialSessions: SessionRow[];
}) {
  const router = useRouter();
  const [sessions, setSessions] = useState(initialSessions);
  const [username, setUsername] = useState(initial.username);
  const [authenticator, setAuthenticator] = useState(initial.authenticator);
  const [message, setMessage] = useState("");
  const [setup, setSetup] = useState<{ totpURI?: string; backupCodes?: string[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const accountRequest = (path: string, body: unknown, method = "POST") => sendAccountRequest(path, body, method, { "x-account-id": accountId });
  function signedOut() { router.replace("/sign-in"); router.refresh(); }
  async function refreshSessions() {
    const response = await fetch("/api/account/session", { cache: "no-store", credentials: "same-origin", headers: { "x-account-id": accountId } });
    if (!response.ok) throw new Error("Your security change completed. Reload this page to refresh the session list.");
    const data = await response.json();
    setSessions(data.sessions);
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try { await action(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Request failed."); }
    finally { setBusy(false); }
  }
  function form(action: (fields: Record<string, FormDataEntryValue>) => Promise<void>) {
    return (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const fields = Object.fromEntries(new FormData(event.currentTarget));
      void run(() => action(fields));
    };
  }

  const secret = setup?.totpURI ? new URL(setup.totpURI).searchParams.get("secret") : null;
  return <>
    <noscript>Enable JavaScript to use account security forms. Submitted credentials are never added to the address.</noscript>
    <p role="status" className={message ? chrome.notice : styles.emptyStatus}>{message}</p>
    {!username && <section className={`${chrome.card} ${chrome.stack}`}>
      <h2 className={chrome.subheading}>Choose your username</h2>
      <p className={chrome.muted}>Your username is fixed during beta. Use 3–30 lowercase letters, digits or hyphens.</p>
      <form className={styles.inlineForm} action={formHelp} method="post" onSubmit={form(async fields => {
        const data = await accountRequest("/api/account/username", fields);
        setUsername(data.username);
        setMessage(`${data.username} is reserved for you. Your page is unpublished.`);
      })}>
        <label className={chrome.field}><span>Username</span><input className={chrome.control} name="username" required
          minLength={3} maxLength={30} pattern={"[a-z0-9][a-z0-9\\-]{1,28}[a-z0-9]"} autoComplete="off" /></label>
        <button className={chrome.primary} disabled={busy}>Claim username</button>
      </form>
    </section>}
    <div className={`${chrome.split} ${setup ? styles.enrollment : ""}`}>
      <div className={chrome.stack}>
        <section className={`${chrome.card} ${styles.securityCard}`} id="confirm-password">
          <h2 className={chrome.subheading}>Confirm your password</h2>
          <p className={chrome.muted}>Confirm before exporting or deleting your account. Confirmation lasts ten minutes.</p>
          <form className={styles.inlineForm} action={formHelp} method="post" onSubmit={form(async fields => {
            await accountRequest("/api/account/reauthenticate", fields);
            setMessage("Password confirmed.");
          })}>
            <PasswordField />
            <button className={chrome.primary} disabled={busy}>Confirm password</button>
          </form>
        </section>
        <section className={`${chrome.card} ${styles.securityCard}`}>
          <h2 className={chrome.subheading}>Change password</h2>
          <p className={chrome.muted}>Changing your password signs out your other sessions.</p>
          <form className={styles.securityForm} action={formHelp} method="post" onSubmit={form(async fields => {
            await accountRequest("/api/auth/change-password", { ...fields, revokeOtherSessions: true });
            await refreshSessions();
            setMessage("Password changed and other sessions signed out.");
          })}>
            <PasswordField name="currentPassword" label="Current password" />
            <PasswordField name="newPassword" label="New password" isNew />
            <button className={chrome.button} disabled={busy}>Change password</button>
          </form>
        </section>
      </div>
      <section className={`${chrome.card} ${styles.securityCard} ${styles.factors}`}>
        <div className={styles.row}>
          <h2 className={chrome.subheading}>Authenticator and recovery codes</h2>
          {authenticator === "enabled" && <span className={styles.enabled}>Enabled</span>}
        </div>
        {authenticator !== "enabled" && <p className={chrome.muted}>Use an authenticator app that generates a six-digit code every 30 seconds.</p>}
        {!setup && authenticator !== "enabled" && <form className={styles.inlineForm} action={formHelp} method="post" onSubmit={form(async fields => {
          const data = await accountRequest("/api/auth/two-factor/enable", { ...fields, method: "totp" });
          setSetup(data);
          setAuthenticator("pending");
          setMessage("Add this account to your authenticator, save the recovery codes, then enter the code below.");
        })}>
          <PasswordField />
          <button className={chrome.button} disabled={busy}>Set up authenticator</button>
        </form>}
        {setup && <div className={chrome.split}>
          {secret && <div className={styles.factorDetails}>
            <h3>Manual setup key</h3><code className={chrome.mono}>{secret}</code>
            <h3>Authenticator app details</h3>
            <p className={chrome.muted}>Account {email}</p>
            <p className={chrome.muted}>Issuer may-be.gay</p>
            <p className={chrome.muted}>Time based · SHA-1 · 6 digits · 30 seconds</p>
          </div>}
          {setup.backupCodes && <div className={styles.factorDetails}>
            <h3>Recovery codes</h3>
            <p className={chrome.muted}>Save these single-use codes privately. This set is shown once.</p>
            <ul className={styles.recoveryCodes}>{setup.backupCodes.map(code => <li key={code}>{code}</li>)}</ul>
            <button type="button" className={chrome.button} onClick={() => setSetup(null)}>Hide setup and recovery codes</button>
          </div>}
        </div>}
        {authenticator !== "off" && <form className={`${styles.inlineForm} ${setup ? styles.cardDivider : ""}`} action={formHelp} method="post" onSubmit={form(async fields => {
          await accountRequest("/api/auth/two-factor/verify-totp", fields);
          setSetup(null);
          setAuthenticator("enabled");
          await refreshSessions();
          setMessage("Authenticator verified. Second-factor confirmation lasts ten minutes for administration.");
        })}>
          <label className={chrome.field}><span>Authenticator code</span><input className={chrome.control} name="code" required
            autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" /></label>
          <button className={setup ? chrome.primary : chrome.button} disabled={busy}>Verify authenticator</button>
        </form>}
        {authenticator === "enabled" && !setup && <>
          <div className={styles.cardDivider}>
            <p className={chrome.muted}>Replacing your recovery codes invalidates your previous set.</p>
            <form className={styles.inlineForm} action={formHelp} method="post" onSubmit={form(async fields => {
              const data = await accountRequest("/api/auth/two-factor/generate-backup-codes", fields);
              setSetup({ backupCodes: data.backupCodes });
              setMessage("Recovery codes replaced.");
            })}>
              <PasswordField />
              <button className={chrome.button} disabled={busy}>Replace recovery codes</button>
            </form>
          </div>
          <div className={styles.cardDivider}>
            <p className={chrome.muted}>Disabling your authenticator removes the code requirement at sign-in.</p>
            <form className={styles.inlineForm} action={formHelp} method="post" onSubmit={form(async fields => {
              await accountRequest("/api/auth/two-factor/disable", fields);
              setAuthenticator("off");
              await refreshSessions();
              setMessage("Two-factor authentication disabled. Administrator accounts must keep it enabled.");
            })}>
              <PasswordField />
              <button className={styles.dangerButton} disabled={busy}>Disable authenticator</button>
            </form>
          </div>
        </>}
      </section>
    </div>
    <section className={`${chrome.card} ${styles.securityCard}`}>
      <h2 className={chrome.subheading}>Sessions</h2>
      <ul className={styles.sessions}>{sessions.map(row => <li key={row.id}>
        <div><strong>{row.current ? "This session" : "Other session"}</strong>
          <time className={`${chrome.muted} ${chrome.mono}`} dateTime={row.createdAt}>Created {sessionDate.format(new Date(row.createdAt))} UTC</time>
        </div>
        <button className={chrome.button} disabled={busy} onClick={() => void run(async () => {
          if (row.current) { await accountRequest("/api/auth/sign-out", {}); signedOut(); }
          else { await accountRequest("/api/account/session", { sessionId: row.id }, "DELETE"); await refreshSessions(); setMessage("Session signed out."); }
        })}>Sign out this session</button>
      </li>)}</ul>
      <div className={styles.row}>
        <p className={chrome.muted}>Sign out here and on every other device.</p>
        <div className={chrome.actions}>
          <button className={chrome.button} disabled={busy} onClick={() => void run(async () => { await accountRequest("/api/account/session", {}, "DELETE"); signedOut(); })}>Sign out all sessions</button>
          <button className={chrome.button} disabled={busy} onClick={() => void run(async () => { await accountRequest("/api/auth/sign-out", {}); signedOut(); })}>Sign out</button>
        </div>
      </div>
    </section>
  </>;
}
