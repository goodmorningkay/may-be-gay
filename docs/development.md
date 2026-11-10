# Local development

This checkout implements the phase-1 platform foundation. It is not ready for a
public launch. Better Auth is installed for phase 2; no authentication handler,
registration endpoint, email service or authentication secret is configured.
The editor host is a placeholder. User accounts, private editing, publishing,
uploads, moderation and operational recovery are later work.

## Prerequisites

- Node **22.19.0** and npm **10.9.3** for host-side commands. The container uses
  the same Node version. pnpm is not used.
- Docker Engine and Docker Compose v2 (or newer), with permission to use the
  Docker daemon. Local ports **80** and **443** must be free.
- Internet access for the first npm install and image pull. A trusted browser
  and an OS/browser certificate import facility are needed for local HTTPS.
- A PostgreSQL client is optional; the commands below use the client in the DB
  container. Host-side integration tests optionally use port **5432**.

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
PostgreSQL initializes a private database and separate roles. The one-shot
`migrate` service waits for PostgreSQL health, then executes `npm run db:migrate`.
The app starts only after that service exits successfully; Caddy starts after
the app's apex HTTP healthcheck succeeds. The migration service remaining
`Exited (0)` is expected. Startup does not insert demonstration profiles.

Open `https://may-be.localhost` for the landing page and
`https://app.may-be.localhost` for the editor placeholder. Profile addresses use
`https://<username>.may-be.localhost`; missing/unpublished profiles must return
404. A fresh database has no published pages. The integration tests own their
fixtures and verify independent profile hosts; there is no registration flow.
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
Migrations still run from the migration image. Use the same Compose file flags
for subsequent operations on that stack.

For a host-side server, `npm run dev` listens on `127.0.0.1:3000`. Set
`SITE_DOMAIN=may-be.localhost`, access `http://may-be.localhost:3000` (or send an
explicit Host header), and provide a reachable runtime DB URL as described
below. Direct HTTP is useful for development but does not exercise local TLS.
Plain `localhost` is deliberately outside the application's host contract.
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
These grants are not row-level ownership enforcement: private data access
checks belong in later application work.

The `postgres` administrator exists only for cluster bootstrap/maintenance. It
is never given to the application or migration service. The application
container receives only `DATABASE_URL`; the migration container receives only
`MIGRATION_DATABASE_URL`. No secret uses a `NEXT_PUBLIC_` variable.

| Key | Purpose |
| --- | --- |
| `SITE_DOMAIN` | Bare domain, without scheme/port/path. Application default: `may-be.gay`; local Compose/example: `may-be.localhost`. |
| `DATABASE_URL` | Runtime connection as `may_be_app`. |
| `MIGRATION_DATABASE_URL` | DDL connection as `may_be_migrator`, used by `scripts/migrate.ts`. |
| `POSTGRES_PASSWORD` | Local cluster administrator password. |
| `MIGRATION_DATABASE_PASSWORD` | Local bootstrap password for the migration role. Must match its URL. |
| `APP_DATABASE_PASSWORD` | Local bootstrap password for the runtime role. Must match its URL. |

The example passwords and Compose fallbacks are **public, local-only values**.
Production must supply unique secret values through a separate secret delivery
mechanism. URL-encode password characters in connection URLs. Do not reuse these
development credentials externally. `.env`, certificate keys and `.local` are
ignored by Git and excluded from Docker build context. No external credentials
are generated or required in phase 1.

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

Run build after the database, renderer and host-routing work is integrated.
Vitest runs in Node with the `@` import alias and a test-only no-op for
`server-only`; Next still enforces the actual server-only boundary in builds.
The test include patterns cover `src/**/*.test.{ts,tsx}` and
`tests/**/*.test.{ts,tsx}`. DB-backed tests use `TEST_DATABASE_URL` for a
migrator-owned disposable database whose name ends in `_test`, and
`TEST_APP_DATABASE_URL` for the same database as the runtime role. The harness
resets tables and applies migrations; never point it at a database containing
data you need. Without a test URL these tests skip locally; CI requires one.
For a local test database:

```sh
docker compose exec db psql -X -U postgres -d may_be_gay -v ON_ERROR_STOP=1 -c 'CREATE DATABASE may_be_gay_test OWNER may_be_migrator'
docker compose exec db psql -X -U postgres -d may_be_gay_test -v ON_ERROR_STOP=1 -f /opt/may-be-gay/bootstrap.sql
TEST_DATABASE_URL=postgres://may_be_migrator:local-only-migrator@127.0.0.1:5432/may_be_gay_test TEST_APP_DATABASE_URL=postgres://may_be_app:local-only-app@127.0.0.1:5432/may_be_gay_test npm test
```

Start the DB with `compose.tools.yaml` before that host-side test command.
Creating the test DB is a one-time operation; omit CREATE on reruns.

GitHub Actions installs with `npm ci`, bootstraps the two non-superuser roles
against an empty pinned PostgreSQL service, applies migrations twice to check
reruns, verifies runtime CRUD/DDL boundaries, creates a separate disposable test
DB with the same role grants, then runs typecheck, lint, tests,
build and the production HTTP smoke test. It also validates standard/development/tooling Compose syntax. This
is not a browser, real-email, media, backup, restore or deployment acceptance
test. CI publishes no images and deploys nothing.

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

This Compose stack is a local foundation, not a production deployment recipe.
Its internal CA, loopback bindings and public fallback passwords are intentional
local settings. Production needs independently supplied secrets, a pinned Caddy
build containing the Cloudflare DNS module, scoped DNS credentials, DNS-01
certificates for the apex/wildcard, public DNS, strict origin TLS and a reviewed
network/firewall setup. Setting `SITE_DOMAIN=may-be.gay` alone does not provide
any of those. The stock Caddy image here does not contain the Cloudflare module.

Host routing, public reads, schema constraints and renderer tests are foundation
checks. Invitation enforcement, authentication/cookies/CSRF, owner isolation,
media safety, rate limits, mail delivery, backups/restore, monitoring,
moderation, policy decisions and hosted browser acceptance remain later phase
requirements in [the implementation plan](implementation-plan.md). Do not infer
launch readiness from a successful build, container healthcheck or CI run.
