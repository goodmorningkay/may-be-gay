"use client";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { accountRequest as sendAccountRequest } from "./auth-form";

type SessionRow = { id: string; createdAt: string; expiresAt: string; current: boolean };
export function SecurityPanel({ accountId, email, initialSessions }: { accountId: string; email: string; initialSessions: SessionRow[] }) {
  const router = useRouter();
  const accountRequest = (path: string, body: unknown, method = "POST") => sendAccountRequest(path, body, method, { "x-account-id": accountId });
  function signedOut() { router.replace("/sign-in"); router.refresh(); }
  const [sessions, setSessions] = useState(initialSessions); const [message, setMessage] = useState("");
  const [setup, setSetup] = useState<{ totpURI?: string; backupCodes?: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  async function refreshSessions() {
    const response = await fetch("/api/account/session", { cache: "no-store", credentials: "same-origin", headers: { "x-account-id": accountId } });
    if (!response.ok) throw new Error("Your security change completed. Reload this page to refresh the session list.");
    const data = await response.json();
    setSessions(data.sessions);
  }
  async function run(action: () => Promise<void>) { setBusy(true); setMessage(""); try { await action(); } catch (error) { setMessage(error instanceof Error ? error.message : "Request failed."); } finally { setBusy(false); } }
  function form(action: (fields: Record<string, FormDataEntryValue>) => Promise<void>) {
    return (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const fields = Object.fromEntries(new FormData(event.currentTarget)); void run(() => action(fields)); };
  }
  const secret = setup?.totpURI ? new URL(setup.totpURI).searchParams.get("secret") : null;
  return <section><h1>Account security</h1><p>Signed in as {email}</p><p><Link href="/editor">Edit your page</Link></p>
    <noscript>Enable JavaScript to use account security forms. Submitted credentials are never added to the address.</noscript>
    <h2>Confirm your password</h2><p>Confirmation lasts ten minutes. Sensitive actions may ask you to confirm again.</p>
    <form action="/api/account/form-help" method="post" onSubmit={form(async fields => { await accountRequest("/api/account/reauthenticate", fields); setMessage("Password confirmed."); })}><label>Password <input name="password" type="password" required autoComplete="current-password" maxLength={128} /></label><button disabled={busy}>Confirm password</button></form>
    <h2>Choose your username</h2><p>Your username is fixed during beta. Use 3–30 lowercase letters, digits or hyphens.</p>
    <form action="/api/account/form-help" method="post" onSubmit={form(async fields => { const data = await accountRequest("/api/account/username", fields); setMessage(`${data.username} is reserved for you. Your page is unpublished; open the editor to get started.`); })}><label>Username <input name="username" required minLength={3} maxLength={30} pattern={"[a-z0-9][a-z0-9\\-]{1,28}[a-z0-9]"} autoComplete="off" /></label><button disabled={busy}>Claim username</button></form>
    <h2>Authenticator and recovery codes</h2><p>Use an authenticator app with six-digit codes that change every 30 seconds. Administrators must complete a code challenge to access administration.</p>
    <form action="/api/account/form-help" method="post" onSubmit={form(async fields => { const data = await accountRequest("/api/auth/two-factor/enable", { ...fields, method: "totp" }); setSetup(data); setMessage("Add this account to your authenticator, save the recovery codes privately, then enter the code below."); })}><label>Password <input name="password" type="password" required autoComplete="current-password" maxLength={128} /></label><button disabled={busy}>Set up authenticator</button></form>
    {secret && <div><p>Manual setup key: <code style={{ overflowWrap: "anywhere" }}>{secret}</code></p><p>Account: {email}. Issuer: may-be.gay. Type: time based, SHA-1, 6 digits, 30 seconds.</p></div>}
    {setup?.backupCodes && <div><p>Save these single-use recovery codes privately. They are shown here only for this operation.</p><pre>{setup.backupCodes.join("\n")}</pre><button onClick={() => setSetup(null)}>Hide setup and recovery codes</button></div>}
    <form action="/api/account/form-help" method="post" onSubmit={form(async fields => { await accountRequest("/api/auth/two-factor/verify-totp", fields); setSetup(null); await refreshSessions(); setMessage("Authenticator verified. Second-factor confirmation lasts ten minutes for administration."); })}><label>Authenticator code <input name="code" required autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" /></label><button disabled={busy}>Verify authenticator</button></form>
    <form action="/api/account/form-help" method="post" onSubmit={form(async fields => { const data = await accountRequest("/api/auth/two-factor/generate-backup-codes", fields); setSetup({ backupCodes: data.backupCodes }); setMessage("New recovery codes replace your previous set. Save them privately."); })}><label>Password <input name="password" type="password" required autoComplete="current-password" maxLength={128} /></label><button disabled={busy}>Replace recovery codes</button></form>
    <form action="/api/account/form-help" method="post" onSubmit={form(async fields => { await accountRequest("/api/auth/two-factor/disable", fields); await refreshSessions(); setMessage("Two-factor authentication disabled. Administrator accounts must keep it enabled."); })}><label>Password <input name="password" type="password" required autoComplete="current-password" maxLength={128} /></label><button disabled={busy}>Disable authenticator</button></form>
    <h2>Change password</h2><form action="/api/account/form-help" method="post" onSubmit={form(async fields => { await accountRequest("/api/auth/change-password", { ...fields, revokeOtherSessions: true }); await refreshSessions(); setMessage("Password changed and other sessions signed out."); })}><label>Current password <input name="currentPassword" type="password" required autoComplete="current-password" maxLength={128} /></label><label>New password <input name="newPassword" type="password" required minLength={12} maxLength={128} autoComplete="new-password" /></label><button disabled={busy}>Change password</button></form>
    <h2>Sessions</h2><ul>{sessions.map(s => <li key={s.id}>{s.current ? "This session" : "Other session"} — created {new Date(s.createdAt).toISOString()} <button disabled={busy} onClick={() => void run(async () => { if (s.current) { await accountRequest("/api/auth/sign-out", {}); signedOut(); } else { await accountRequest("/api/account/session", { sessionId: s.id }, "DELETE"); await refreshSessions(); setMessage("Session signed out."); } })}>Sign out this session</button></li>)}</ul>
    <button disabled={busy} onClick={() => void run(async () => { await accountRequest("/api/account/session", {}, "DELETE"); signedOut(); })}>Sign out all sessions</button>{" "}
    <button disabled={busy} onClick={() => void run(async () => { await accountRequest("/api/auth/sign-out", {}); signedOut(); })}>Sign out</button>
    <p role="status" aria-live="polite">{message}</p>
  </section>;
}
