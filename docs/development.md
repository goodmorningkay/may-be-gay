# Local development

This checkout implements accounts, private editing, publication, media, reports,
administration, aggregate analytics, export/deletion and operational recovery.
The default stack is for local development with dummy secrets, private local
mail and media, and a development certificate authority. Hosted acceptance and
launch configuration remain separate. See [the current review record](non-launch-review.md).

## Prerequisites

- Node **22.19.0** and npm **10.9.3** for host-side commands. The container uses
  the same Node version. pnpm is not used.
- Docker Engine and Docker Compose v2 (or newer), with permission to use the
  Docker daemon. Local ports **80** and **443** must be free.
- Internet access for the first npm install and image pull. A trusted browser
  and an OS/browser certificate import facility are needed for local HTTPS.
- A PostgreSQL client is optional; the commands below use the client in the DB
  container. Host-side integration tests optionally use port **5432**.
- Host-side media/worker tests require Linux, a C compiler/libc headers, FFmpeg,
  FLAC and `prlimit` (Debian/Ubuntu packages `gcc`, `libc6-dev`, `ffmpeg`, `flac`,
  `util-linux`).
  Application/worker images include the compiled guardian, parser tools and Tini.

The versioned package manifest and `package-lock.json` belong together. Use
`npm ci` after checkout. Update dependency pins and the lockfile deliberately.
The framework uses App Router, strict TypeScript and `@/*` → `src/*` imports.
System fonts are used; there is no build-time font download.

## Start the complete local stack

```sh
cp .env.example .env
npm ci
docker compose up --build -d --wait
docker compose ps -a
docker compose logs migrate app caddy
```

The default Compose file builds a standalone production-mode Next server.
The Caddy configuration enables HTTP/1 full-duplex handling so an upload can be
rejected before the client finishes sending it. The application still enforces
authentication, reservation, byte and receive-time limits on the raw stream.
PostgreSQL initializes a private database and separate roles. The one-shot
`migrate` service waits for PostgreSQL health, then executes `npm run db:migrate`.
The app starts only after that service exits successfully; Caddy starts after
the app-host `/api/health` check succeeds. The worker dispatches durable jobs;
the checks service runs operational checks every minute. The migration service remaining
`Exited (0)` is expected. Startup does not insert demonstration profiles.

Open `https://may-be.localhost` for the landing page and
`https://app.may-be.localhost` for sign-in and the editor. Profile addresses use
`https://<username>.may-be.localhost`; missing/unpublished profiles must return
404. A fresh database has no published pages. The integration tests own their
fixtures and verify independent profile hosts. Registration requires an
email-bound invitation and verification. Follow [accounts.md](accounts.md) for
the explicitly enabled local bootstrap CLI and private mail-outbox workflow.
The fictional renderer demonstration at `https://may-be.localhost/examples`
works without inserting database content and offers the available looks,
layouts and system-font choices.

The browser must resolve these hosts to loopback. Many browsers resolve
`*.localhost` automatically, but some OS resolvers, VPNs and tools do not. For
tools, use `curl --resolve` as below. If necessary, add explicit loopback entries
for the apex, editor and each profile hostname to your local hosts file; hosts
files do not support wildcard entries. Do not edit public DNS for this setup.

### Trust the local CA

Caddy creates its development CA on the **first local stack start** and retains
it in the `caddy_data` Docker volume. The repository contains no certificates.
Export only the public root certificate after starting the stack:

```sh
mkdir -p .local
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .local/may-be-local-root.crt
```

Import that certificate as a trusted website CA into your OS/browser trust store.
On Debian/Ubuntu, an optional system-wide import is:

```sh
sudo install -m 0644 .local/may-be-local-root.crt /usr/local/share/ca-certificates/may-be-local.crt
sudo update-ca-certificates
```

On macOS use Keychain Access; on Windows use the trusted root certificate store.
Firefox may need its own Authorities import, depending on platform/settings.
Restart the browser after importing. Trust applies only to this development
machine. Do not copy the private CA key, share it or trust this CA in production.
Remove the imported trust when you discard the local CA volume.

Verify without modifying OS trust:

```sh
curl --cacert .local/may-be-local-root.crt --resolve may-be.localhost:443:127.0.0.1 https://may-be.localhost/
curl --cacert .local/may-be-local-root.crt --resolve app.may-be.localhost:443:127.0.0.1 https://app.may-be.localhost/
curl --cacert .local/may-be-local-root.crt --resolve alice.may-be.localhost:443:127.0.0.1 -i https://alice.may-be.localhost/
```

The last request is 404 until an independently provisioned local fixture is
published. Do not disable TLS validation to make a browser test pass.

## Source-mounted development

Use the optional override for hot reload through the same HTTPS proxy:

```sh
docker compose -f compose.yaml -f compose.dev.yaml up --build -d --wait
docker compose -f compose.yaml -f compose.dev.yaml logs -f app
```

The app mounts `src`, `next.config.ts` and `tsconfig.json` read-only; Next writes
its cache inside the container. Dependency changes need an image rebuild.
The development app runs as uid 1000, matching the worker and production app.
Its image owns the writable Next cache; media and parser-lock volumes stay
private and shared by that same uid.
Migrations still run from the migration image. Use the same Compose file flags
for subsequent operations on that stack.

For a host-side server, `npm run dev` listens on `127.0.0.1:3000`. Set
`SITE_DOMAIN=may-be.localhost`, access `http://may-be.localhost:3000` (or send an
explicit Host header), and provide a reachable runtime DB URL as described
below. Direct HTTP is useful for development but does not exercise local TLS.
Plain `localhost` is deliberately outside the application's host contract.
Run `npm run native:build` before host-side media/worker commands and export
`NATIVE_GUARDIAN_BIN="$PWD/.native/may-be-guardian"`. Production also requires
an explicit shared `NATIVE_PARSER_LOCK_FILE` and `SERVICE_CLOSED_FILE`. Use the
same stable lock file and uid for every local parser; never replace its inode
while services run. Rebuild/restart images after guardian source changes.
`npm run build` followed by `npm start` runs the host production server; the
Docker image instead runs standalone `node server.js` as the unprivileged
`node` user.

## Database roles, migrations and secrets

The database name is **`may_be_gay`**. Its public schema is owned by
**`may_be_migrator`**, a non-superuser login that owns migration-created objects.
**`may_be_app`** can connect and use public-schema tables with SELECT, INSERT,
UPDATE and DELETE, plus USAGE/SELECT on sequences. It has no schema creation,
database creation, role creation, superuser or temporary-table privileges.
Default privileges apply to objects subsequently created by the migrator. The
Drizzle migration journal is not in `public` and is not granted to the app.
Private data access independently derives ownership from the authenticated
session. Recovery events are append-only for the app role, and the replay
checkpoint is restricted to the recovery operator role.

The `postgres` administrator exists only for cluster bootstrap/maintenance. It
is never given to the application or migration service. The application
container receives the runtime `DATABASE_URL` and application configuration;
the migration container receives `MIGRATION_DATABASE_URL`. No secret uses a
`NEXT_PUBLIC_` variable.

| Key | Purpose |
| --- | --- |
| `SITE_DOMAIN` | Bare domain, without scheme/port/path. Application default: `may-be.gay`; local Compose/example: `may-be.localhost`. |
| `DATABASE_URL` | Runtime connection as `may_be_app`. |
| `MIGRATION_DATABASE_URL` | DDL connection as `may_be_migrator`, used by `scripts/migrate.ts`. |
| `POSTGRES_PASSWORD` | Local cluster administrator password. |
| `MIGRATION_DATABASE_PASSWORD` | Local bootstrap password for the migration role. Must match its URL. |
| `APP_DATABASE_PASSWORD` | Local bootstrap password for the runtime role. Must match its URL. |
| `BETTER_AUTH_SECRET` | Explicit authentication secret; local Compose uses a deliberately dummy value. |
| `MAIL_TRANSPORT`, `MAIL_OUTBOX_DIR` | Private local mail delivery for development. |
| `MEDIA_STORAGE`, `MEDIA_LOCAL_ROOT` | Private local media storage for development. |
| `SERVICE_CLOSED_FILE` | Required in production; share the absolute marker path and volume with app, worker and restore. Its presence keeps the service closed. |
| `BACKUP_WORK_ROOT` | Explicit persistent private recovery workspace in production; contains retention restart checkpoints. |

The example passwords and Compose fallbacks are **public, local-only values**.
Production must supply unique secret values through a separate secret delivery
mechanism. URL-encode password characters in connection URLs. Do not reuse these
development credentials externally. `.env`, certificate keys and `.local` are
ignored by Git and excluded from Docker build context. No external credentials
are generated or needed for local acceptance. Provider configuration is documented
in [accounts.md](accounts.md), [media.md](media.md) and [recovery.md](recovery.md).

The official PostgreSQL entrypoint runs `infra/postgres/bootstrap.sh` only when
the data volume is empty. Its SQL is safe to rerun and reapplies ownership,
passwords and grants. Changing environment variables alone does not rotate an
existing database password. After setting matching passwords and URLs in the
local environment, explicitly reapply bootstrap and migrations:

```sh
docker compose up -d --force-recreate db
docker compose exec db sh /docker-entrypoint-initdb.d/10-bootstrap.sh
docker compose run --rm migrate
docker compose up -d --force-recreate app caddy
```

Normal migration commands:

```sh
docker compose run --rm migrate
docker compose exec db psql -X -U postgres -d may_be_gay -v ON_ERROR_STOP=1 -f /opt/may-be-gay/bootstrap.sql
docker compose exec -T db psql -X -U postgres -d may_be_gay -v ON_ERROR_STOP=1 < infra/postgres/check-roles.sql
```

The second command explicitly reapplies bootstrap if needed; the last checks
role boundaries and default grants using a transactionally rolled-back probe
table. SQL/schema migrations live in `drizzle/`; use reviewed migrations rather
than schema push. `npm run db:generate` invokes Drizzle Kit using
`drizzle.config.ts`. `npm run db:migrate` invokes
`tsx --env-file-if-exists=.env scripts/migrate.ts`; shell variables override the
optional `.env`. The migration URL must remain separate from the runtime URL.

For host-side DB tooling, opt into the loopback-only port override:

```sh
docker compose -f compose.yaml -f compose.tools.yaml up -d db
MIGRATION_DATABASE_URL=postgres://may_be_migrator:local-only-migrator@127.0.0.1:5432/may_be_gay npm run db:migrate
DATABASE_URL=postgres://may_be_app:local-only-app@127.0.0.1:5432/may_be_gay SITE_DOMAIN=may-be.localhost npm run dev
```

The standard Compose file publishes neither PostgreSQL nor Next.js. Only Caddy
publishes HTTP/HTTPS, bound to loopback. Caddy has no database network access;
PostgreSQL and migration services use an internal network. App outbound access
is possible through its web network, but the DB has no public port. The tooling
override attaches PostgreSQL to an additional tooling network because Docker
does not publish ports from an internal-only network. Its published port is
still bound to loopback. This override is for local use only and is not part of
a production network design.

Caddy rejects authenticated route paths on sibling hosts and returns explicit
404s for unmatched HTTP authorities. The application independently validates
the Host header, including framework data/prefetch requests, and ignores
forwarded-host values when selecting a profile. A public-availability check
before rendering ensures missing profiles do not begin an HTTP 200 RSC stream.
The page then performs its own public-only read; no document or session is
carried in proxy headers. This adds a second public lookup for profile requests.
The initial milestone favors immediate publication-state visibility and no-store
responses; any later cache must preserve identity/revision isolation.

`docker compose down` stops the stack and retains data. To deliberately discard
all local profiles, database state **and the local CA**, use
`docker compose down --volumes`; this is destructive. Export needed data first.

## Checks and CI

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run test:http # requires the two disposable test DB URLs below
docker compose config --quiet
```

Run build after source changes and before the production HTTP smoke test.
`npm test` compiles the native guardian first. Before direct `npx vitest` runs,
run `npm run native:build`; Vitest uses that binary unless explicitly overridden.

The development media regression uses a fresh project and disposable database,
without publishing any ports. It uploads through the development HTTP app,
waits for the worker's parser, reads the private derivative and verifies that
deletion removes stored bytes and releases the reservation:

```sh
docker compose -p may-be-dev-media-test -f compose.yaml -f compose.dev.yaml -f infra/testing/dev-media.compose.yaml up --build -d --wait app worker
docker compose -p may-be-dev-media-test -f compose.yaml -f compose.dev.yaml -f infra/testing/dev-media.compose.yaml run --rm --no-deps worker node --conditions=react-server --import tsx scripts/dev-media-smoke.ts
docker compose -p may-be-dev-media-test -f compose.yaml -f compose.dev.yaml -f infra/testing/dev-media.compose.yaml down --volumes
```
Vitest runs in Node with the `@` import alias and a test-only no-op for
`server-only`; Next still enforces the actual server-only boundary in builds.
The test include patterns cover `src/**/*.test.{ts,tsx}` and
`tests/**/*.test.{ts,tsx}`. DB-backed tests use `TEST_DATABASE_URL` for a
migrator-owned disposable database whose name ends in `_test`, and
`TEST_APP_DATABASE_URL` for the same database as the runtime role. The harness
resets tables and applies migrations; never point it at a database containing
data you need. Without a suite's URL its PostgreSQL tests skip locally; CI supplies
all the required URLs. Suites that reset their databases must use separate databases.
For a local test database:

```sh
docker compose exec db psql -X -U postgres -d may_be_gay -v ON_ERROR_STOP=1 -c 'CREATE DATABASE may_be_gay_test OWNER may_be_migrator'
docker compose exec db psql -X -U postgres -d may_be_gay_test -v ON_ERROR_STOP=1 -f /opt/may-be-gay/bootstrap.sql
TEST_DATABASE_URL=postgres://may_be_migrator:local-only-migrator@127.0.0.1:5432/may_be_gay_test TEST_APP_DATABASE_URL=postgres://may_be_app:local-only-app@127.0.0.1:5432/may_be_gay_test npm test
```

Start the DB with `compose.tools.yaml` before that host-side test command.
Creating the test DB is a one-time operation; omit CREATE on reruns.

The example above runs the foundation PostgreSQL suite. Create separately named
migrator-owned databases and apply the same bootstrap grants for the feature suites:

| Environment variable | Separate disposable database |
| --- | --- |
| `ACCOUNTS_TEST_DATABASE_URL` | `accounts_test` |
| `TEST_PROFILE_DATABASE_URL`, `TEST_PROFILE_APP_DATABASE_URL` | `profiles_test`, migrator and runtime roles respectively |
| `TEST_MEDIA_DATABASE_URL` | `media_test` |
| `OPERATIONS_TEST_DATABASE_URL` | `operations_test` |

GitHub Actions has three jobs. The application job creates all five test databases,
checks empty migrations and replay, runtime grants, typecheck, lint, tests, build,
production HTTP and Compose syntax. The recovery job runs fenced-worker and
encrypted-restore tests in a separate PostgreSQL 17 fixture and verifies the
worker image's native tools. The browser job runs `npm run test:e2e` across
Chromium, Firefox, WebKit and mobile. See [browser-acceptance.md](browser-acceptance.md)
and [recovery.md](recovery.md) for local reproduction commands and limits.
CI publishes no images and deploys nothing; a local pass does not establish a
successful GitHub Actions run.

`npm run test:http` resets that same disposable database, creates two unrelated
published fixtures, starts a temporary production server on a free loopback
port, and checks HTML, RSC navigation/prefetch, metadata, CSP nonces, actual 404
status codes, hidden/draft data exclusion, hostname restrictions and immediate
unpublish/suspension visibility. Run it after a build and separately from the
Vitest suite; both reset the test DB. It stops its server when finished.

The same test can exercise an already-running local Caddy stack by setting
`TEST_HTTPS_PORT` and `TEST_CA_FILE` to its loopback HTTPS port and exported
public CA certificate. In this mode, configure that stack's app `DATABASE_URL`
to the disposable test database first. Requests stay on `127.0.0.1`, verify the
CA, and use local SNI/Host headers; TLS verification is never disabled. This
mode does not start or stop the separately managed stack.

## Exact dependency and container versions

Verified against the official npm registry and project documentation on
10 November 2026. Dependencies have exact pins; the lockfile also fixes
transitive resolution and integrity hashes.

| Package | Version |
| --- | --- |
| next / eslint-config-next | 16.4.6 |
| react / react-dom | 19.3.1 |
| typescript | 5.9.3 |
| drizzle-orm | 0.45.4 |
| drizzle-kit | 0.31.11 |
| postgres (Postgres.js driver) | 4.1.0 |
| better-auth | 1.7.19 |
| zod | 4.6.7 |
| server-only | 0.0.1 |
| vitest | 5.1.0 |
| tsx | 4.23.15 |
| eslint | 9.39.5 |
| @types/node | 22.20.5 |
| @types/react / @types/react-dom | 19.3.0 |
| sharp | 0.35.5 |
| @aws-sdk/client-s3 | 3.1165.0 |
| @playwright/test | 1.65.0 |

Next supports Node >=20.9; this project standardizes on the available Node 22.
Vitest 5 requires Node >=22.12. TypeScript 5.9.3 keeps compatibility with Next's
TypeScript integration and the lint parser; the current TypeScript 7 release is
outside that parser's supported range. ESLint 9.39.5 is the compatible last
major for the installed React/import/accessibility plugins; npm marks ESLint 9
unsupported. Upgrade those plugins and ESLint together when compatible versions
are available. Drizzle uses the stable 0.45 line; documentation showing `@rc`
is not an instruction to install a prerelease.

Two scoped npm overrides patch upstream transitive dependencies:
`@esbuild-kit/core-utils` uses esbuild **0.25.12**, and
`@typescript-eslint/typescript-estree` uses minimatch **11.0.1**. See the
[review record](implementation-review.md) for advisories and verification.
Review/remove these overrides when their upstream packages adopt patched pins.

The official container tags are **node:22.19.0-bookworm-slim**,
**postgres:17.11-bookworm** and **caddy:2.11.9-alpine**. Dockerfile/Compose/CI also
pin their manifest digests. PostgreSQL 17 is a supported stable major. Refresh
patch versions/digests deliberately as part of security maintenance; exact
pins do not update themselves.

References: [Next installation](https://nextjs.org/docs/app/getting-started/installation),
[standalone output](https://nextjs.org/docs/app/api-reference/config/next-config-js/output),
[self-hosting](https://nextjs.org/docs/app/guides/self-hosting),
[Drizzle PostgreSQL](https://orm.drizzle.team/docs/get-started-postgresql),
[Better Auth installation](https://better-auth.com/docs/installation),
[Vitest requirements](https://vitest.dev/guide/),
[PostgreSQL default privileges](https://www.postgresql.org/docs/17/sql-alterdefaultprivileges.html),
[Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/),
[Caddy local TLS](https://caddyserver.com/docs/caddyfile/directives/tls),
[official npm metadata](https://registry.npmjs.org/next/latest).

## Production differences and remaining work

This Compose stack is a local development environment.
Its internal CA, loopback bindings and public fallback passwords are intentional
local settings. Production needs independently supplied secrets, a pinned Caddy
build containing the Cloudflare DNS module, scoped DNS credentials, DNS-01
certificates for the apex/wildcard, public DNS, strict origin TLS and a reviewed
network/firewall setup. Setting `SITE_DOMAIN=may-be.gay` alone does not provide
any of those. The stock Caddy image here does not contain the Cloudflare module.

Invitation enforcement, cookies/CSRF, ownership, bounded media, rate limits,
local mail, backup/restore and moderation have local tests. Real provider delivery,
R2/CDN behavior, public certificate renewal, external uptime monitoring and target
server capacity still need hosted acceptance. Operator identity, audience, rules,
support contact and approved policies are launch inputs. The
[operations runbook](operations-runbook.md) records the deployment and recovery
procedures; local build and health checks do not establish launch readiness.
