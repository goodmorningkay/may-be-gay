import Link from "next/link";
import { USERNAME_PATTERN } from "@/domain/hosts";
import { UsernameTakenDialog } from "../username-taken-dialog";
import styles from "./homepage.module.css";

const features = [
  { title: "Links & socials", icon: styles.linksIcon },
  { title: "Custom themes", icon: styles.themeIcon },
  { title: "Music & embeds", icon: styles.musicIcon },
];

function ProfilePreview() {
  return (
    <Link href="/examples" prefetch={false} className={styles.preview} aria-label="Explore a sample profile">
      <div className={styles.profile}>
        <div className={styles.addressBar}>kay.may-be.gay</div>
        <div className={styles.profileContent}>
          <div className={styles.identity}>
            <div className={styles.avatar} />
            <div>
              <p className={styles.profileName}>kay</p>
              <p className={styles.bio}>stuck at my 9 to 5</p>
            </div>
          </div>
          <div className={styles.profileLinks}>
            <div className={styles.profileLink}>Stuff I made</div>
            <div className={styles.profileLink}>Find me on Discord</div>
          </div>
          <div className={styles.audio}>
            <span className={styles.play} />
            <span>Midnight Static</span>
            <span className={styles.waveform} />
          </div>
        </div>
      </div>
    </Link>
  );
}

export function Homepage({ appOrigin, domain, rejectedUsername, takenUsername }: {
  appOrigin: string;
  domain: string;
  rejectedUsername?: string;
  takenUsername?: string;
}) {
  const invalid = takenUsername !== undefined || rejectedUsername !== undefined;
  const initialUsername = takenUsername ?? rejectedUsername;
  const errorMessage = takenUsername
    ? `${takenUsername}.${domain} is already taken. Choose another username.`
    : "Choose another username.";
  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <header className={styles.header}>
          <Link href="/" prefetch={false} className={styles.wordmark}>
            <span className={styles.brandMark} aria-hidden="true" />
            may-be.gay
          </Link>
          <a href={`${appOrigin}/sign-in`} className={styles.logIn}>Log in</a>
        </header>
        <main>
          <div className={styles.hero}>
            <div className={styles.heroCopy}>
              <h1 className={styles.headline}>
                A link-in-bio<br />page you can<br /><span>make yours</span>
              </h1>
              <form action="/" method="get" className={styles.claim}>
                <label htmlFor="homepage-username">Username</label>
                <div className={styles.claimControls}>
                  <div className={styles.addressField}>
                    <input id="homepage-username" name="username" placeholder="yourname" defaultValue={initialUsername}
                      required minLength={3} maxLength={30} pattern={USERNAME_PATTERN}
                      title="Use 3–30 lowercase letters, numbers or hyphens. Start and end with a letter or number."
                      autoComplete="off" autoCapitalize="none" spellCheck={false}
                      aria-invalid={invalid || undefined} aria-describedby={invalid ? "homepage-username-error" : undefined} />
                    <span aria-hidden="true">.{domain}</span>
                  </div>
                  <button type="submit">Claim address</button>
                </div>
                {invalid && <p id="homepage-username-error" role="alert">{errorMessage}</p>}
              </form>
            </div>
            <ProfilePreview />
          </div>
          <ul className={styles.features} aria-label="Profile features">
            {features.map(({ title, icon }) => (
              <li key={title}><span aria-hidden="true" className={`${styles.featureIcon} ${icon}`} />{title}</li>
            ))}
          </ul>
        </main>
        <footer className={styles.footer}>
          <p>© may-be.gay</p>
          <nav aria-label="Legal"><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link></nav>
        </footer>
      </div>
      {takenUsername && (
        <UsernameTakenDialog
          username={takenUsername}
          siteDomain={domain}
          signInHref={`${appOrigin}/sign-in`}
          focusInputId="homepage-username"
        />
      )}
    </div>
  );
}
