"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import type { RegistrationMode } from "@/domain/registration";
import { withClaimUsername } from "@/domain/username-intent";
import chrome from "../site-chrome.module.css";
import { UsernameTakenDialog } from "../username-taken-dialog";
import styles from "./onboarding.module.css";
import { OnboardingScreen } from "./onboarding-screen";

type Mode = "sign-in" | "sign-up" | "verify-email" | "forgot-password" | "reset-password" | "two-factor";

export async function accountRequest(path: string, body: unknown, method = "POST", headers: Record<string, string> = {}) {
  const response = await fetch(path, { method, headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message ?? "Unable to complete request. Check your details and try again.");
  return data;
}

const copy = {
  "sign-in": { title: "Sign in", action: "Sign in" },
  "sign-up": { title: "Create your account", action: "Create your account" },
  "verify-email": { title: "Request a new verification link", action: "Send verification link" },
  "forgot-password": { title: "Reset your password", action: "Send reset link" },
  "reset-password": { title: "Choose a new password", action: "Reset password" },
  "two-factor": { title: "Confirm your sign-in", action: "Verify code" },
} satisfies Record<Mode, { title: string; action: string }>;

export function AuthForm({ mode, verificationStatus, claimUsername, takenUsername, returnTo, siteDomain = "may-be.gay", registrationMode }: {
  mode: Mode; verificationStatus?: "success" | "error"; claimUsername?: string; takenUsername?: string; returnTo?: string; siteDomain?: string; registrationMode?: RegistrationMode;
}) {
  const [message, setMessage] = useState(
    verificationStatus === "error"
      ? "This verification link is invalid or expired."
      : mode === "sign-up" && takenUsername
        ? `${takenUsername}.${siteDomain} is already taken. You can still create an account and choose a different username.`
        : "",
  );
  const [failure, setFailure] = useState(verificationStatus === "error" || (mode === "sign-up" && Boolean(takenUsername)));
  const [complete, setComplete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const inviteInput = useRef<HTMLInputElement>(null);
  const linkInvite = useRef<string | undefined>(undefined);
  const signIn = withClaimUsername("/sign-in", claimUsername);
  const signedInPath = claimUsername ? withClaimUsername("/editor", claimUsername) : returnTo || "/account/security";
  const verificationPath = withClaimUsername("/verify-email?verified=1", claimUsername);
  const address = claimUsername ? `${claimUsername}.${siteDomain}` : undefined;
  const publicSignup = mode === "sign-up" && registrationMode === "public";
  const privacyLink = <Link href={`https://${siteDomain}/privacy`} prefetch={false}>Privacy notice</Link>;

  useEffect(() => {
    if (mode !== "sign-up") return;
    const token = new URLSearchParams(window.location.hash.slice(1)).get("invite");
    if (token) {
      linkInvite.current = token;
      if (inviteInput.current) inviteInput.current.value = token;
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }, [mode]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    setMessage("");
    setFailure(false);
    try {
      if (mode === "sign-in") {
        const data = await accountRequest("/api/auth/sign-in/email", { ...fields, callbackURL: signedInPath });
        window.location.assign(data.twoFactorRedirect ? withClaimUsername("/two-factor", claimUsername) : signedInPath);
      } else if (mode === "sign-up") {
        await accountRequest("/api/auth/sign-up/email", {
          ...fields,
          ...(publicSignup && linkInvite.current ? { inviteToken: linkInvite.current } : {}),
          callbackURL: verificationPath,
        });
        setMessage("If eligible, check your email for the verification link, then sign in.");
        setComplete(true);
      } else if (mode === "verify-email") {
        await accountRequest("/api/auth/send-verification-email", { ...fields, callbackURL: verificationPath });
        setMessage("If eligible, a verification link is on its way. After verifying, sign in.");
      } else if (mode === "forgot-password") {
        await accountRequest("/api/auth/request-password-reset", { ...fields, redirectTo: "/reset-password" });
        setMessage("If an account matches that email, you’ll get a password reset link.");
        setComplete(true);
      } else if (mode === "reset-password") {
        const token = new URLSearchParams(window.location.search).get("token");
        await accountRequest("/api/auth/reset-password", { ...fields, token });
        history.replaceState(null, "", "/reset-password");
        setMessage("Your old sessions are signed out. Sign in with your new password.");
        setComplete(true);
      } else {
        await accountRequest(`/api/auth/two-factor/${recovery ? "verify-backup-code" : "verify-totp"}`, { code: fields.code });
        window.location.assign(signedInPath);
      }
    } catch (error) {
      setFailure(true);
      setMessage(error instanceof Error ? error.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  if (mode === "verify-email" && verificationStatus === "success") {
    return <OnboardingScreen title="Email verified" address={address}>
      <p role="status"><span className={chrome.srOnly}>Email verified. </span>{claimUsername ? "Sign in to finish claiming your address." : "You can sign in now."}</p>
      <Link className={chrome.primary} href={signIn} prefetch={false}>Sign in</Link>
    </OnboardingScreen>;
  }

  if (complete) {
    const title = mode === "reset-password" ? "Password reset" : "Check your email";
    return <OnboardingScreen title={title} address={address}>
      <p role="status">{message}</p>
      <Link className={mode === "forgot-password" ? chrome.button : chrome.primary} href={signIn} prefetch={false}>{mode === "forgot-password" ? "Back to sign in" : "Sign in"}</Link>
      {mode === "sign-up" && <nav className={styles.nav} aria-label="Verification"><Link href={withClaimUsername("/verify-email", claimUsername)}>Resend verification email</Link></nav>}
    </OnboardingScreen>;
  }

  if (mode === "sign-up" && registrationMode === "closed") {
    return <OnboardingScreen title="Registration is closed" address={address}>
      <Link className={chrome.button} href={signIn} prefetch={false}>Sign in</Link>
    </OnboardingScreen>;
  }

  return <OnboardingScreen title={copy[mode].title} address={address}
    description={mode === "sign-up" && !publicSignup ? "Use the email address your invitation was sent to." : undefined}>
    <noscript>Enable JavaScript to use account forms. Submitted credentials are never added to the address.</noscript>
    <p role="status" className={failure ? chrome.error : undefined}>{message}</p>
    <form action="/api/account/form-help" method="post" onSubmit={submit}>
      {mode === "sign-up" && <>
        <label className={chrome.field}><span>Your name</span><input className={chrome.control} name="name" required maxLength={100} autoComplete="name" /></label>
        {!publicSignup && <label className={chrome.field}><span>Invitation token</span><input className={chrome.control} name="inviteToken" ref={inviteInput} required maxLength={128} autoComplete="off" /></label>}
      </>}
      {mode !== "reset-password" && mode !== "two-factor" &&
        <label className={chrome.field}><span>Email</span><input className={chrome.control} name="email" type="email" required maxLength={254} autoComplete="email" /></label>}
      {(["sign-in", "sign-up", "reset-password"] as Mode[]).includes(mode) &&
        <div className={chrome.field}><label htmlFor="auth-password">{mode === "reset-password" ? "New password" : "Password"}</label>
          <input id="auth-password" className={chrome.control} name={mode === "reset-password" ? "newPassword" : "password"} type="password"
            required minLength={mode === "sign-in" ? 1 : 12} maxLength={128} autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
            aria-describedby={mode !== "sign-in" ? "password-length" : undefined} />
          {mode !== "sign-in" && <small id="password-length">Use at least 12 characters.</small>}
        </div>}
      {mode === "sign-in" && <Link href="/forgot-password">Forgot password?</Link>}
      {mode === "two-factor" && <label className={chrome.field}><span>{recovery ? "Recovery code" : "Authenticator code"}</span>
        <input key={String(recovery)} className={chrome.control} name="code" required autoComplete="one-time-code" inputMode={recovery ? "text" : "numeric"} maxLength={64} />
      </label>}
      <button className={chrome.primary} disabled={busy} type="submit">{busy ? "Please wait…" : recovery ? "Verify recovery code" : copy[mode].action}</button>
      {mode === "two-factor" && <button className={styles.textButton} type="button" disabled={busy} onClick={() => { setRecovery(!recovery); setMessage(""); setFailure(false); }}>
        {recovery ? "Use authenticator" : "Use a recovery code"}
      </button>}
    </form>
    {mode === "sign-in" && <nav className={styles.nav} aria-label="Account">New here? <Link href={withClaimUsername("/sign-up", claimUsername)}>Create an account</Link></nav>}
    {mode === "sign-up" && <nav className={styles.nav} aria-label="Account">{privacyLink}<Link href={signIn} prefetch={false}>Sign in</Link></nav>}
    {(mode === "verify-email" || mode === "forgot-password") && <nav className={styles.nav} aria-label="Account"><Link href={signIn} prefetch={false}>{mode === "verify-email" ? "Sign in" : "Back to sign in"}</Link></nav>}
    {mode === "sign-up" && takenUsername && (
      <UsernameTakenDialog
        username={takenUsername}
        siteDomain={siteDomain}
        signInHref="/sign-in"
        dismissLabel="Continue without this username"
      />
    )}
  </OnboardingScreen>;
}
