import * as React from "react";

import { getPublicDocument, type ProfileDocument } from "@/domain/profile";

import styles from "./profile-view.module.css";

type ProfileViewProps = {
  document: ProfileDocument;
  username: string;
  siteDomain: string;
};

function platformOrigin(siteDomain: string): string {
  // The caller owns hostname policy. This extra check prevents a path, userinfo
  // or scheme from changing where platform/support anchors navigate.
  if (!/^[a-z0-9.-]+(?::[0-9]+)?$/i.test(siteDomain)) {
    throw new Error("ProfileView requires a caller-validated apex domain.");
  }
  const origin = new URL(`https://${siteDomain}`);
  if (origin.host !== siteDomain.toLowerCase() || !origin.hostname) {
    throw new Error("ProfileView requires a caller-validated apex domain.");
  }
  return origin.origin;
}

/** Read-only, server-renderable public content. All authored text is escaped. */
export function ProfileView({
  document,
  username,
  siteDomain,
}: ProfileViewProps): React.JSX.Element {
  const profile = getPublicDocument(document);
  const origin = platformOrigin(siteDomain);

  return (
    <main
      className={styles.profile}
      data-preset={profile.theme.preset}
      data-layout={profile.theme.layout}
      data-font={profile.theme.font}
    >
      <div className={styles.frame}>
        <div className={styles.content}>
          <header className={styles.identity}>
            <p className={styles.address}>
              <span>@{username}</span>
              <span className={styles.domain}>{siteDomain}</span>
            </p>
            <h1 className={styles.name}>{profile.displayName}</h1>
            {profile.pronouns ? <p className={styles.pronouns}>{profile.pronouns}</p> : null}
            {profile.bio ? <p className={styles.bio}>{profile.bio}</p> : null}
          </header>

          {profile.links.length > 0 ? (
            <nav aria-label="Profile links" className={styles.navigation}>
              <ul className={styles.links}>
                {profile.links.map((link) => (
                  <li key={link.id}>
                    <a className={styles.link} href={link.url}>
                      <span className={styles.linkText}>
                        <span className={styles.linkLabel}>{link.label}</span>
                        <span className={styles.linkHost}>{new URL(link.url).host}</span>
                      </span>
                      <span className={styles.arrow} aria-hidden="true">→</span>
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ) : (
            <p className={styles.empty}>No public links yet.</p>
          )}
        </div>

        <footer className={styles.footer}>
          <p className={styles.attribution}>
            A page on <a href={origin}>{siteDomain}</a>
          </p>
          <a className={styles.support} href={`${origin}/support`}>
            Report this page or get support
          </a>
          <p className={styles.supportNote}>
            Support and reporting policy is pending configuration.
          </p>
        </footer>
      </div>
    </main>
  );
}
