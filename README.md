<img src="assets/icon.svg" width="64" height="64" alt="">

# may-be.gay

A free link-in-bio builder for making a personal page at `yourname.may-be.gay`.

## What you can do

- **Claim your address.** Sign up, verify your email, and pick an available username.
- **Make the page yours.** Add a bio, pronouns, and links. Choose from six themes
  and two layouts, then customise colours, typography, and backgrounds.
- **Add images and music.** Upload an avatar, a background, or a music track.
  Avatars and backgrounds support animated GIFs. You can also embed Spotify
  tracks, albums, and playlists or show what you're listening to on Last.fm.
- **Preview and publish.** The editor autosaves a private draft and lets you
  preview it at phone and desktop sizes. You can unpublish or restore an earlier
  version.
- **Manage your page and account.** See approximate page views and link clicks,
  enable two-factor authentication, export your data, or delete your account.
  Visitors can report a page, link, or media item.

## Try a sample locally

With Node.js 22 and npm installed, run the app without a database.

```sh
npm ci
SITE_DOMAIN=may-be.localhost npm run dev
```

Open [the sample profile](http://may-be.localhost:3000/examples) to try the themes,
layouts, and fonts.

## Run the full app locally

Use Docker Compose to try signup, editing, uploads, and publishing over HTTPS.

```sh
test -f .env || cp .env.example .env
docker compose up --build -d --wait
```

The local stack stores verification emails in a file outbox and uploads on disk.
The [development guide](docs/development.md) covers setup, certificate trust, and tests.

- `https://may-be.localhost` serves the landing page.
- `https://app.may-be.localhost` serves signup, the editor, and account settings.
- `https://<username>.may-be.localhost` serves that user's published profile.

## How it works

Next.js serves the site, editor, public profiles, and API from one app. PostgreSQL
stores accounts, drafts, and published revisions. A background worker processes
media, sends email, and runs cleanup and backup jobs. Operators can review reports,
moderate profiles, and manage signup and upload settings.

- **Profiles and publishing** · [Renderer](docs/profile-renderer.md) · [Editor](docs/editor.md) · [Publishing](docs/profiles-editor.md)
- **Accounts and data** · [Accounts](docs/accounts.md) · [Database](docs/database.md) · [Media](docs/media.md)
- **Operations and testing** · [Worker](docs/worker.md) · [Runbook](docs/operations-runbook.md) · [Recovery](docs/recovery.md) · [Browser tests](docs/browser-acceptance.md)

## Self-hosting

This codebase is built for `may-be.gay`, not for turnkey self-hosting. Running
your own instance requires changing:

- **Domains:** Update `SITE_DOMAIN` validation in `src/domain/hosts.ts`,
  `src/server/recovery/manifest.ts`, and `src/server/worker/checks.ts`.
- **Branding:** Replace hardcoded `may-be.gay` references in UI components,
  page metadata, the auth issuer, and email subjects.
- **Infrastructure:** Cloudflare DNS-01 and cache purge, S3-compatible media
  storage, and SMTP are assumed in `compose.prod.yaml` and `infra/caddy/`.
- **Deployment:** `scripts/deploy.sh` targets the maintainer's server.

## License

[MIT](LICENSE).
