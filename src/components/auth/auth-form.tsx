"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { withClaimUsername } from "@/domain/username-intent";

type Mode = "sign-in" | "sign-up" | "verify-email" | "forgot-password" | "reset-password" | "two-factor";
export async function accountRequest(path: string, body: unknown, method = "POST", headers: Record<string, string> = {}) {
  const response = await fetch(path, { method, headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message ?? "Unable to complete request. Check your details and try again.");
  return data;
}
const titles: Record<Mode, string> = { "sign-in": "Sign in", "sign-up": "Create your account", "verify-email": "Verify your email", "forgot-password": "Forgot your password?", "reset-password": "Choose a new password", "two-factor": "Confirm your sign-in" };
export function AuthForm({ mode, verificationStatus, claimUsername }: { mode: Mode; verificationStatus?: "success" | "error"; claimUsername?: string }) {
  const [message, setMessage] = useState(verificationStatus === "success" ? "Email verified. You can sign in now." : verificationStatus === "error" ? "This verification link is invalid or expired. Request a new one below." : ""); const [busy, setBusy] = useState(false);
  const inviteInput = useRef<HTMLInputElement>(null); const [recovery, setRecovery] = useState(false);
  const router = useRouter();
  const signedInPath = claimUsername ? withClaimUsername("/editor", claimUsername) : "/account/security";
  const verificationPath = withClaimUsername("/verify-email?verified=1", claimUsername);
  useEffect(() => {
    if (mode === "sign-up") {
      const token = new URLSearchParams(window.location.hash.slice(1)).get("invite");
      if (token && inviteInput.current) {
        inviteInput.current.value = token;
        history.replaceState(null, "", window.location.pathname + window.location.search);
      }
    }
  }, [mode]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage("");
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    try {
      if (mode === "sign-in") {
        const data = await accountRequest("/api/auth/sign-in/email", { ...fields, callbackURL: signedInPath });
        router.push(data.twoFactorRedirect ? withClaimUsername("/two-factor", claimUsername) : signedInPath); router.refresh();
      } else if (mode === "sign-up") {
        await accountRequest("/api/auth/sign-up/email", { ...fields, callbackURL: verificationPath });
        setMessage("If eligible, check your email for the verification link, then sign in.");
      } else if (mode === "verify-email") {
        await accountRequest("/api/auth/send-verification-email", { ...fields, callbackURL: verificationPath });
        setMessage("If eligible, a verification link is on its way. After verifying, sign in.");
      } else if (mode === "forgot-password") {
        await accountRequest("/api/auth/request-password-reset", { ...fields, redirectTo: "/reset-password" });
        setMessage("If an account matches, check your email for the reset link.");
      } else if (mode === "reset-password") {
        const token = new URLSearchParams(window.location.search).get("token");
        await accountRequest("/api/auth/reset-password", { ...fields, token });
        history.replaceState(null, "", "/reset-password"); setMessage("Password reset. Your old sessions are signed out. Sign in with your new password.");
      } else {
        await accountRequest(`/api/auth/two-factor/${recovery ? "verify-backup-code" : "verify-totp"}`, { code: fields.code });
        router.push(signedInPath); router.refresh();
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : "Request failed."); }
    finally { setBusy(false); }
  }
  return <section aria-labelledby="auth-title"><h1 id="auth-title">{titles[mode]}</h1>
    {mode === "sign-up" && <p>Registration is by invitation. Your invitation must match your email address.</p>}
    {mode === "verify-email" && <p>Follow the link in your email to verify your account. You can request a fresh link here.</p>}
    <noscript>Enable JavaScript to use account forms. Submitted credentials are never added to the address.</noscript>
    <form action="/api/account/form-help" method="post" onSubmit={submit}>
      {mode === "sign-up" && <><label>Your name <input name="name" required maxLength={100} autoComplete="name" /></label><label>Invitation token <input name="inviteToken" ref={inviteInput} required maxLength={128} autoComplete="off" /></label></>}
      {!["reset-password", "two-factor"].includes(mode) && <label>Email <input name="email" type="email" required maxLength={254} autoComplete="email" /></label>}
      {["sign-in", "sign-up", "reset-password"].includes(mode) && <label>Password <input name={mode === "reset-password" ? "newPassword" : "password"} type="password" required minLength={mode === "sign-in" ? 1 : 12} maxLength={128} autoComplete={mode === "sign-in" ? "current-password" : "new-password"} /></label>}
      {mode === "two-factor" && <><label>{recovery ? "Recovery code" : "Authenticator code"}<input name="code" required autoComplete="one-time-code" inputMode={recovery ? "text" : "numeric"} maxLength={64} /></label><button type="button" onClick={() => setRecovery(!recovery)}>{recovery ? "Use authenticator" : "Use a recovery code"}</button></>}
      <button disabled={busy} type="submit">{busy ? "Please wait…" : mode === "verify-email" ? "Send verification link" : titles[mode]}</button>
    </form><p role="status" aria-live="polite">{message}</p>
    <nav aria-label="Account"><Link href={withClaimUsername("/sign-in", claimUsername)}>Sign in</Link>{" · "}<Link href={withClaimUsername("/sign-up", claimUsername)}>Use an invitation</Link>{" · "}<Link href="/forgot-password">Reset password</Link></nav>
  </section>;
}
