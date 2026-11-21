import Link from "next/link";
import { getSiteDomain } from "@/domain/hosts";
import { AppError } from "@/server/http";
import { SiteHeader } from "../site-chrome";
import chrome from "../site-chrome.module.css";
import { OnboardingScreen } from "../auth/onboarding-screen";

export function AccessHelp({ error }: { error: unknown }) {
  if (!(error instanceof AppError)) throw new AppError(503, "ACCOUNT_UNAVAILABLE", "Unable to load this page right now. Try again shortly.");
  if (error.status >= 500) throw error;

  return <div className={chrome.page}><div className={chrome.container}>
    <SiteHeader home={`https://${getSiteDomain()}`} />
    <main><OnboardingScreen title="Account access">
      <p>{error.message}</p>
      <nav className={chrome.actions} aria-label="Account">
        <Link href="/sign-in" className={chrome.button}>Sign in</Link>
        <Link href="/account/security">Confirm password and two-factor access</Link>
        <Link href="/account">Account</Link>
      </nav>
    </OnboardingScreen></main>
  </div></div>;
}
