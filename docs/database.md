# Persistence foundation

Phase 1 provides a PostgreSQL schema, reviewed Drizzle migrations, lazy server-only
connections, and `getPublishedProfile` in `src/server/profiles.ts`. It exposes no
Better Auth handler or account, invite, editing, publishing, upload, moderation,
analytics, or job-processing endpoints. Table availability does not implement
those workflows or their policies.

## Connections and roles

The application reads `DATABASE_URL` only when `getDatabase()` is first called.
An explicit `postgres://` or `postgresql://` URL with a host, username and database
is required; driver defaults and a migration-URL fallback are deliberately absent.
The pool permits at most five connections per process, with a 10-second connection
timeout, a 20-second idle timeout and a 30-minute maximum connection lifetime.
`closeDatabase()` closes the pool for workers, tests and shutdown handling.
Connection configuration errors omit URLs, passwords and parser causes.

The expected infrastructure contract is:

- Database `may_be_gay`, with `public` owned by `may_be_migrator`.
- `may_be_migrator` owns the tables, trigger functions and migration journal. It
  can create the `drizzle` journal schema. Use it only for reviewed migrations.
- `may_be_app` has `USAGE` on `public` and `SELECT`, `INSERT`, `UPDATE`, `DELETE`
  on application tables. It is neither a superuser nor a role/database creator,
  has no `BYPASSRLS`, DDL, `TRUNCATE`, or migration-journal access, and is not a
  member of the migrator role.
- Infrastructure sets default table privileges **for the migrator role** before
  migration and removes public schema creation rights. No roles, credentials,
  databases or grants are provisioned by this migration runner.

The server's public reader does not use a visitor session. It projects exactly
`id`, `username`, `revisionId`, and the published `document`, with explicit joins
between the claim owner, user, profile and current revision. Retired claims,
suspended/deleted or unverified users, suspended/deleted profiles, and profiles without a current revision
are excluded. The JSON is passed through the renderer's `getPublicDocument`;
validation failure returns `null`, and hidden link labels and destinations are
removed before the result leaves the data layer. There is no application cache.

A missing `DATABASE_URL` returns `null` **only when `NODE_ENV=development`**. This
lets an unconfigured `next dev` show the local landing page and profile 404s.
Production and tests fail clearly for a valid profile lookup without a URL.
Malformed usernames return `null` before connecting. Configured database failures
propagate instead of silently producing fictional profiles or concealing an outage.
Keep database exceptions out of public response bodies and redact production logs.

## Migrations

After installing the pinned packages, run from the repository root:

```sh
# Supply this through the environment/secret manager, using the migrator role.
npm run db:migrate
```

`MIGRATION_DATABASE_URL` is mandatory. The runner never uses `DATABASE_URL`.
It runs Drizzle's PostgreSQL migrator against `drizzle/meta/_journal.json` and the
checked-in SQL, recording migrations in `drizzle.__drizzle_migrations`. A session
advisory lock serializes accidental simultaneous runner processes. Its dedicated
one-connection client is closed on success or error, releasing the lock; failure
returns a nonzero exit status with a redacted error code. Run once per deployment
as the migrator, with the normal backup/release review process.

`npm run db:generate` generates offline from `src/server/db/schema.ts`; the config
contains no credential or live database fallback. Review generated SQL and its
snapshot before applying it. Do not substitute `drizzle-kit push` for the migration
history. `0000_foundation.sql` is generated schema; `0001_persistence_guards.sql`
is a custom SQL migration for triggers which Drizzle snapshots do not represent.
`0002_deferred_cascade_guards.sql` defers the current-revision and retained-media
foreign keys until transaction commit. Account deletion can then complete its
cascades in either order, while a transaction leaving a missing retained asset
or an invalid publication pointer still fails. These SQL-only constraint settings
are not represented by Drizzle snapshots.
Future schema generation must preserve those guards and add new reviewed custom
migrations when guard changes are required.

## Database invariants and their limits

- Better Auth 1.7.19 core models use the `user`, `session`, `account`, and
  `verification` exports. The `twoFactor` export contains the installed plugin's
  encrypted-secret/backup-code fields, enrollment verification, failed-attempt
  count, and lockout expiry. Library identifiers remain text. Case-insensitive
  email uniqueness supplements the library email constraint. These tables match
  the [core model contract](https://better-auth.com/docs/concepts/database) and
  [second-factor model](https://better-auth.com/docs/plugins/2fa); tests also check
  fields against the actual installed library. The admin role column is application
  data, not a configured Better Auth admin plugin. Requiring administrator 2FA,
  encryption, verified email and invite eligibility is future application work.
- Username primary keys accept 3–30 lowercase ASCII letters/digits/hyphens with
  alphanumeric ends, disallow `xn--`, and reserve service/support names. An owner
  can have one claim. Triggers prohibit changing names/owners, deleting
  reservations or reclaiming retired names. Setting an owner to null, including
  the user's `ON DELETE SET NULL`, timestamps retirement. The remaining row holds
  the name and reservation/retirement times, with no former user identifier.
  Full account erasure must also purge other private records, invitation email,
  job payloads, report details and any identifying audit metadata where required;
  the schema alone does not implement that process or a retention policy.
- A profile has one owner, and profile identity/ownership cannot be reassigned.
  A composite FK `(profile.id, current_revision_id)` references
  `(revision.profile_id, revision.id)`, so a profile cannot publish another
  profile's snapshot. Updates to snapshot rows are rejected. To restore history,
  insert a new revision; unpublish before deleting a current revision. Historical
  rows can be deleted for retention and account deletion. An unpublished inserted
  revision is not automatically public.
- Draft and revision JSON must be objects with a numeric `schemaVersion: 1`
  matching the schema-version column. Full theme/link/content validation belongs
  to the shared document validator. Revision numbers are positive and unique per
  profile. Draft edit versions are positive, and every update must increment
  exactly once. Future autosaves must still use an ownership-scoped transaction
  and `WHERE edit_version = expectedVersion`, interpreting zero affected rows as
  a stale save; a version increment by itself is not compare-and-swap protection.
- Invitations store a 64-character lowercase SHA-256 digest, never a raw token,
  and a normalized bound email. This foundation checks digest representation,
  not entropy or whether a value was actually hashed. Issued identity is immutable;
  redemption requires the matching account email, a non-revoked unexpired invite,
  and cannot be reset. Recipient deletion clears its FK without making it reusable.
  Token generation, constant-time comparisons, signup gating and transactional
  creation/redemption are future work. Do not expose authentication before these
  checks cover every account-creation route.
- Media object keys are unique. States, inspected-byte/dimension/duration metadata,
  allowed ready-state content types and deletion timestamps have constraints.
  Composite draft/revision asset FKs prevent references to another owner's media.
  Retained revision references prevent physical asset-row deletion. This does not
  inspect files, assert readiness of a whole publication, enforce quotas, check
  every asset embedded in JSON, serve media or implement R2 cleanup/purging.
- Reports and audit tables keep private details separate from public projections.
  Audit events are not an append-only tamper-proof log in phase 1. Daily aggregate
  keys contain a profile, UTC date (the writer must supply UTC), and optional
  stable link ID, with nonnegative bounded counts and date-retention indexes; no
  visitor identifier is stored. Durable jobs have unique idempotency keys, versioned
  JSON payloads, bounded attempts and consistent lock/finished state. Consumers,
  retention, atomic claiming (`FOR UPDATE SKIP LOCKED`), retry/backoff, redaction,
  and external side-effect idempotency still need implementation.

There is no RLS or private data-access API in this milestone. The runtime role's
CRUD rights do not enforce tenant ownership on arbitrary queries. Future private
reads and writes must resolve the owner from the authenticated session and scope
all queries to that owner; never accept a submitted owner ID as authorization.
The current public reader is the only application data-access function.

## PostgreSQL integration tests

Use an isolated PostgreSQL database such as `may_be_gay_test`, owned by the
migrator role. `TEST_DATABASE_URL` must target a database with a lowercase name
ending in `_test`. The harness is **destructive within that test database**: it
drops the foundation tables, trigger functions and `drizzle` journal, applies the
actual checked-in migrations from empty tables, and truncates fixtures per test.
It preserves the `public` schema and infrastructure's default privileges. Do not
point it at a shared or production database, or run two copies against one database.
It leaves the final migrated schema/fixtures in place for inspection.

```sh
# Set TEST_DATABASE_URL to the disposable DB using migrator credentials.
# Also set TEST_APP_DATABASE_URL to the same DB using may_be_app for role checks.
npm exec vitest run tests/db
```

The integration suite tests migration replay, installed auth fields, username
constraints and simultaneous claims, deletion tombstones, cross-profile publication
rejection, immutable revisions, concurrent optimistic saves, JSON versions,
unknown/unpublished/suspended/deleted public exclusions, hidden/private data
removal, malformed-public-document rejection, cross-owner asset FKs, inspected
media metadata, aggregate/job constraints and invitation restrictions. With
`TEST_APP_DATABASE_URL`, public reads run through the app role and tests check its
privileges plus actual DDL/TRUNCATE denial. Supply both test URLs in CI; only
`TEST_DATABASE_URL` is mandatory for the suite, so absence of the app-role URL
explicitly skips that one role test locally. CI requires both test URLs and fails
instead of silently skipping integration or runtime-role checks. Both URLs must
target the same host, port and database. Locally, a missing migration URL skips the DB
suite; configuration/auth-contract tests still run without PostgreSQL.

`tests/db/harness.ts` exports `bootstrapTestDatabase` for CI or future database test
suites. A migration-capable URL is required, not the normal app connection.
Passing unit tests or generating SQL does not establish migration safety. Run this
suite against real PostgreSQL and the intended production major version before
claiming empty-database migration, concurrency or role-isolation acceptance.
