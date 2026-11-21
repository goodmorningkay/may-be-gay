"use client";
import "@/components/validation-runtime";
import { useEffect, useRef, useState } from "react";
import { isValidUsername } from "@/domain/hosts";
import { EditorRequestError, type EditorState } from "@/domain/editor";
import { editorTransport, requestJson } from "./api";
import { OnboardingScreen } from "../auth/onboarding-screen";
import onboarding from "../auth/onboarding.module.css";
import { SiteHeader } from "../site-chrome";
import chrome from "../site-chrome.module.css";
import { ProfileEditor } from "./profile-editor";

export function EditorEntry({ accountId, siteDomain, initialUsername = "" }: { accountId: string; siteDomain: string; initialUsername?: string }) {
  const [state, setState] = useState<EditorState | null>(null);
  const [claim, setClaim] = useState(false);
  const [username, setUsername] = useState(initialUsername);
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
  const invalid = Boolean(username && !isValidUsername(username));
  return <div className={chrome.page}><div className={chrome.container}>
    <SiteHeader home={`https://${siteDomain}`}><a className={chrome.button} href="/account">Account</a></SiteHeader>
    <main>
      <OnboardingScreen title={claim ? "Claim your address" : "Your private editor"}
        description={claim ? "Your username is fixed during beta. Your page starts as a private draft." : undefined}>
        {problem && <div role="status" className={chrome.error}>
          <p>{problem.code === "USERNAME_UNAVAILABLE" ? "That username is taken. Choose another." : problem.message}</p>
          {problem.status === 401 && <a href="/sign-in?returnTo=%2Feditor" target="_blank" rel="noopener noreferrer">Sign in in a new tab</a>}
          {problem.code === "VERIFICATION_REQUIRED" && <a href="/verify-email">Verify your email</a>}
          {!claim && <button className={chrome.button} type="button" disabled={busy} onClick={() => void load()}>Retry loading editor</button>}
        </div>}
        {claim ? <form onSubmit={submit}>
          <div className={chrome.field}>
            <label htmlFor="claim-username">Username</label>
            <span className={`${chrome.control} ${onboarding.usernameControl}`} aria-invalid={invalid || problem?.code === "USERNAME_UNAVAILABLE"}>
              <input id="claim-username" autoComplete="off" autoCapitalize="none" spellCheck={false} required minLength={3} maxLength={30}
                value={username} onChange={e => { setUsername(e.target.value); setProblem(null); }} aria-describedby="username-help"
                aria-invalid={invalid || problem?.code === "USERNAME_UNAVAILABLE"} /><span aria-hidden="true">.{siteDomain}</span>
            </span>
          </div>
          <small id="username-help">Use 3–30 lowercase letters, numbers or hyphens. Start and end with a letter or number. Service names and the xn-- prefix are reserved.</small>
          <button className={chrome.primary} disabled={busy || !isValidUsername(username)}>Claim address</button>
        </form> : busy ? <p role="status">Loading your private draft…</p> : null}
        <nav className={onboarding.nav} aria-label="Account"><a href="/account/security">Security</a></nav>
      </OnboardingScreen>
    </main>
  </div></div>;
}
