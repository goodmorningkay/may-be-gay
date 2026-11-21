import Link from "next/link";
import { getSiteDomain } from "@/domain/hosts";
import { AppError } from "@/server/http";
import { SiteHeader } from "../site-chrome";
import chrome from "../site-chrome.module.css";
import { OnboardingScreen } from "../auth/onboarding-screen";

export function AccessHelp({ error }: { error: unknown }) {
  return <div className={chrome.page}><div className={chrome.container}>
    <SiteHeader home={`https://${getSiteDomain()}`} />
    <main><OnboardingScreen title="Account access">
      <p>{error instanceof AppError ? error.message : "Unable to load this page right now. Try again shortly."}</p>
      <nav className={chrome.actions} aria-label="Account">
        <Link href="/sign-in" className={chrome.button}>Sign in</Link>
        <Link href="/account/security">Confirm password and two-factor access</Link>
        <Link href="/account">Account</Link>
      </nav>
    </OnboardingScreen></main>
  </div></div>;
}
