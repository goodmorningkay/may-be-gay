/* eslint-disable @next/next/no-html-link-for-pages -- Full document navigation is consistent with the editor's pending-change protection. */
"use client";
import "@/components/validation-runtime";
import { useEffect, useRef, useState } from "react";
import { isValidUsername } from "@/domain/hosts";
import { EditorRequestError, type EditorState } from "@/domain/editor";
import { editorTransport, requestJson } from "./api";
import { ProfileEditor } from "./profile-editor";
import styles from "./editor.module.css";

export function EditorEntry({ accountId, siteDomain }: { accountId: string; siteDomain: string }) {
  const [state, setState] = useState<EditorState | null>(null);
  const [claim, setClaim] = useState(false);
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(true);
  const [problem, setProblem] = useState<EditorRequestError | null>(null);
  const mounted = useRef(false);
  async function load() {
    setBusy(true); setProblem(null);
    try { const data = await editorTransport.read(); if (mounted.current) { setState(data); setClaim(false); } }
    catch (error) {
      if (!mounted.current) return;
      if (error instanceof EditorRequestError && ["PROFILE_NOT_FOUND", "USERNAME_NOT_FOUND"].includes(error.code)) setClaim(true);
      else setProblem(error instanceof EditorRequestError ? error : new EditorRequestError(500, "REQUEST_FAILED", "Could not open your editor."));
    } finally { if (mounted.current) setBusy(false); }
  }
  useEffect(() => { mounted.current = true; const timer = setTimeout(() => { void load(); }, 0); return () => { mounted.current = false; clearTimeout(timer); }; }, []);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (!isValidUsername(username)) return;
    setBusy(true); setProblem(null);
    try {
      await requestJson("/api/account/username", { method: "POST", headers: { "content-type": "application/json", "x-account-id": accountId }, body: JSON.stringify({ username }) });
      if (mounted.current) { setClaim(false); await load(); }
    } catch (error) { if (mounted.current) { setProblem(error as EditorRequestError); setBusy(false); } }
  }
  if (state) return <ProfileEditor initial={state} siteDomain={siteDomain} />;
  return <main className={styles.entry}>
    <a href="/">may-be.gay</a><h1>{claim ? "A place with your name on it." : "Your private editor"}</h1>
    {claim ? <form onSubmit={submit}>
      <p>Choose your address. Usernames are fixed during beta, so take a moment to check yours. Claiming a name does not publish your page.</p>
      <label htmlFor="claim-username">Username</label>
      <div className={styles.addressInput}><input id="claim-username" autoComplete="off" autoCapitalize="none" spellCheck={false} required minLength={3} maxLength={30}
        value={username} onChange={e => setUsername(e.target.value)} aria-describedby="username-help username-error" aria-invalid={Boolean(username && !isValidUsername(username))} /><span>.{siteDomain}</span></div>
      <p id="username-help" className={styles.hint}>3–30 lowercase letters, digits or hyphens. Start and end with a letter or digit. Service names and the xn-- prefix are reserved.</p>
      <p id="username-error" className={styles.fieldError}>{username && !isValidUsername(username) ? "Choose an available format before continuing. Availability is checked when you claim." : ""}</p>
      <button className={styles.primary} disabled={busy || !isValidUsername(username)}>Claim this username</button>
      <p className={styles.hint}>Your login email and authentication name stay private. You choose every public field in the editor.</p>
    </form> : busy ? <p role="status">Loading your private draft…</p> : null}
    {problem ? <div role="status"><p>{problem.message} <small>({problem.code})</small></p>
      {problem.status === 401 ? <a href="/sign-in?returnTo=%2Feditor" target="_blank" rel="noopener noreferrer">Sign in in a new tab</a> : null}
      {problem.code === "VERIFICATION_REQUIRED" ? <p><a href="/verify-email">Verify your email</a></p> : null}
      <button type="button" disabled={busy} onClick={() => void load()}>Retry loading editor</button></div> : null}
    <nav className={styles.inlineActions} aria-label="Account"><a href="/account/security">Security</a><a href="/account">Account</a></nav>
  </main>;
}
