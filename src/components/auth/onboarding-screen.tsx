import type { ReactNode } from "react";
import chrome from "../site-chrome.module.css";
import styles from "./onboarding.module.css";

export function OnboardingScreen({ title, description, address, children }: {
  title: string; description?: string; address?: string; children: ReactNode;
}) {
  return <section className={styles.screen} aria-labelledby="auth-title">
    <div className={styles.intro}>
      <h1 className={chrome.heading} id="auth-title">{title}</h1>
      {description && <p>{description}</p>}
      {address && <div className={styles.address}><span>Requested address</span><strong>{address}</strong></div>}
    </div>
    <div className={`${chrome.card} ${styles.formCard}`}>{children}</div>
  </section>;
}
