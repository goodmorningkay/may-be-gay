# Non-launch implementation work

Requested 10 November 2026, starting from `d87c410`. This working coordination
record covers all remaining development in phases 2–5, local acceptance and a
separate review pass. It does not authorize provisioning, public DNS changes,
external invitations, production deployment or opening public registration.

Development and review are complete. This document preserves the workstream
contracts and coordination history; [non-launch-review.md](non-launch-review.md)
is the final acceptance record and lists the remaining launch requirements.

## Teams and integration ownership

Use GPT-6.1 Sol with xhigh reasoning for implementation. After integration,
the primary agent and a separate team of GPT-6 Astra max reviewers inspect the
complete change. No implementation agent starts its own agents. Shared checkout,
disjoint ownership, no commits or pushes from agents. The primary owns migration
generation/journals, top-level routing/proxy, CI/Compose, integration and review
fixes. Preserve all existing review fixes and use the implementation plan as the
functional acceptance specification.

Wave 1:

1. Accounts: Better Auth, invite gating, session/origin/rate-limit helpers, mail
   outbox, username claiming, authentication and security UI.
2. Profiles: document/appearance/media-reference contract, owner-scoped draft and
   publish services/APIs, retained revisions, public renderer and private preview.
3. Media: private streaming uploads, image/MP3 inspection, local/R2 storage,
   quotas, reference-aware publication/removal, media job handlers and APIs.

Wave 2 (after the needed contracts are available):

4. Editor/account experience: complete usable editor, autosave/conflict states,
   ordering, templates, appearance, uploads/music, previews and revisions.
5. Operations: reports, administrator console, aggregate analytics, export and
   deletion, retention, policy configuration and audit events.
6. Workers/recovery/acceptance: durable dispatch/retries, cleanup, backup and
   restore, operational checks and browser acceptance across three engines.

Wave 2 file ownership: the editor agent owns `src/app/editor/**`,
`src/components/editor/**`, `src/domain/editor.ts`, `tests/editor/**` and
`docs/editor.md`. It consumes the account/profile/media contracts without editing
them. Operations will own `/account` (export/deletion), `/account/analytics`,
`/admin`, reporting and policy pages. The primary owns the application root,
navigation integration, host/proxy gates and migrations. Media remains the only
package/lock writer until its handoff; editor work adds no dependencies.

Operations owns `src/server/operations/**`, `src/domain/operations.ts`,
`src/server/db/schema-operations.ts`, `src/app/admin/**`, `src/app/account/page.tsx`
and account-scoped styles/components, `src/app/account/analytics/**`,
`src/app/api/admin/**`, `src/app/api/account/export/**`,
`src/app/api/account/delete/**`, `src/app/api/account/analytics/**`,
`src/app/api/reports/**`, `src/app/api/metrics/**`, apex support/privacy/terms/rules
pages, `src/components/operations/**`, `tests/operations/**` and
`docs/operations.md`. It supplies an optional public analytics component and
report URL helper; the primary wires these into the public renderer. It does not
edit the editor, auth/security UI, media modules, base schemas or shared settings.
Its worker exports must document deletion processing, retention and a paginated
recovery-event journal/replay interface for the recovery workstream.

Workers/recovery owns `src/server/worker/**`, `src/server/recovery/**`,
`src/server/db/schema-worker.ts`, `scripts/worker.ts`, `scripts/backup.ts`,
`scripts/restore.ts`, `scripts/check-operations.ts`, `tests/worker/**`,
`tests/recovery/**`, `infra/operations/**` and its worker/recovery/runbook docs.
The primary still owns Docker/Compose, package scripts, migrations and CI.
Browser acceptance is a separate assignment after the app routing is integrated.

Browser acceptance owns `playwright.config.ts`, `tests/e2e/**`, `scripts/e2e.ts`,
`infra/testing/e2e/**` and `docs/browser-acceptance.md`. It is now the sole
package/lock writer for pinned test dependencies and its package scripts. It may
fix browser-proven frontend defects in completed UI components/pages, keeping
changes small and reporting each one. It does not change server/auth/media/
operations/worker logic, migrations, root Docker/Compose or host/proxy rules.
The primary will resolve backend findings and do the comprehensive final review.

Migration 0003 now includes accounts, media and settings. The shared DB harness
resets those extensions, and media DB tests use `TEST_MEDIA_DATABASE_URL`, separate
from the foundation suite's `TEST_DATABASE_URL`. Accounts and profile DB suites
also use separate databases. A first integrated run passed all account and
profile scenarios. The primary fixed ambiguous SQL qualifiers in the media
reconciliation projection; the 35 foundation and 10 media DB cases now pass.

For backup consistency, `db/maintenance-lock.ts` defines `MEDIA_BACKUP_LOCK`
as `(740303, 1)`. `lockMediaOwner` acquires its shared transaction lock before
media storage side effects. Backup must acquire the exclusive counterpart before
exporting a consistent DB snapshot and copying ready private originals/derivatives,
and hold it until both finish. In-flight quarantine is not retained user content;
restore must safely expire/reconcile incomplete uploads. Validate this protocol
with a concurrent cleanup/backup test. No backup reader may expose credentials
or copy plaintext artifacts into public paths.

## Shared server contracts

The account agent owns `src/server/auth/**`, `src/server/http.ts`,
`src/server/rate-limit.ts`, `src/server/mail.ts`, `src/server/invites.ts` and
`src/server/accounts.ts`. Other agents consume these interfaces:

```ts
// src/server/auth/session.ts
type SessionPrincipal = {
  userId: string;
  sessionId: string;
  email: string;
  emailVerified: boolean;
  role: "user" | "admin";
  authenticatedAt: Date;
};
getSession(headers: Headers): Promise<SessionPrincipal | null>;
requireUser(input: Request | Headers, options?: {
  recent?: boolean; allowUnverified?: boolean;
}): Promise<SessionPrincipal>;
requireAdmin(input: Request | Headers): Promise<SessionPrincipal>;

// src/server/http.ts
class AppError extends Error {
  constructor(status: number, code: string, message: string);
}
assertAppHost(headers: Headers): void;
assertMutationOrigin(request: Request): void;
readJson<T>(request: Request, schema: z.ZodType<T>, maxBytes?: number): Promise<T>;
apiJson(data: unknown, status?: number): Response;
apiError(error: unknown): Response;

// src/server/rate-limit.ts
rateLimit(key: string, limit: number, windowSeconds: number): Promise<void>;
```

`requireUser` checks app host, live session, account suspension/deletion,
verification by default, and exact-origin CSRF for unsafe Request methods.
For server pages, pass Headers and handle a missing session with an app-local
sign-in redirect. `recent` requires actual recent reauthentication, not a mutable
client field. `requireAdmin` additionally enforces administrator role and the
library's verified second-factor session. Do not equate role or enrollment alone
with successful administrator authentication.

API failures use `{ error: { code, message } }`, with no private data or raw
exceptions. `apiJson`/`apiError` set no-store. Bodies are byte-bounded before JSON
parsing. Rate limit identifiers must be bounded and hashed when sensitive; do
not store visitor IDs in analytics. Do not trust forwarded client IPs without
verifying the trusted proxy boundary. Public endpoints may use conservative
shared limits when a trusted client address is unavailable.

The authentication base is fixed to `https://app.${SITE_DOMAIN}`. Local HTTPS is
the normal test path. No insecure production cookies or wildcard origins.
Production secrets are explicit environment values, with no development fallback.
Development/test secrets may be deliberately dummy and limited to local mode.

## Database and migration coordination

`src/server/db/types.ts` exports Database and Transaction. Existing tables remain
in schema.ts. Additional tables go in feature-owned `schema-accounts.ts`,
`schema-media.ts`, `schema-operations.ts`, etc. The primary owns schema-settings.ts
and will update Drizzle config, generate/review the next migration and integrate
test bootstrap. Do not generate migrations concurrently or rewrite 0000–0002.
Record any custom SQL guard changes in your feature documentation for integration.

Shared settings tables already defined in schema-settings.ts:

- `serviceSettings`: singleton `id=true`; registrationMode closed/invite/public
  (default invite), uploadsPaused=false, accountLimit=50, totalMediaLimitBytes=5 GiB.
- `accountQuotas`: userId and mediaLimitBytes (default 100 MiB).

Use defaults if the singleton is absent. For a serialized registration/quota
decision, insert it on conflict do nothing, then lock it within the transaction.
No public registration is enabled in this work. Implementing its guarded switch
does not authorize flipping it. Every private operation derives ownership from
SessionPrincipal; submitted owner IDs are never authority.

## Profile/media integration

The profile agent owns profile.ts, profiles.ts, profile-editor.ts, profile API
routes, renderer components/CSS and preview. Preserve legacy v1 documents and
retained revisions. Prefer additive optional v1 fields with defaults matching
old appearance; breaking changes require explicit migration support.

Use `avatarAssetId?: string|null`, `backgroundAssetId?: string|null`, and
`music?: { assetId: string; attribution: string }|null` for owned media references.
Export `getProfileAssetIds(document: ProfileDocument): string[]`, deduplicated.
No authored asset URL, arbitrary CSS or active markup. Controlled custom colors,
font, button shape, solid/gradient backgrounds, overlay and spacing are required,
with contrast feedback. Public contact information is an explicit separate field.

Media agent owns `src/server/media/**`, media API routes and schema-media.ts.
Shared types go in `src/domain/media.ts`, owned by the media agent:

```ts
type PublicMedia = {
  url: string; contentType: string; width?: number; height?: number;
  durationMs?: number;
};
type PublicMediaMap = Record<string, PublicMedia>;

// src/server/media/service.ts
assertOwnedReadyMedia(tx: Transaction, ownerId: string, assetIds: string[]): Promise<void>;
publishOwnedMedia(tx: Transaction, ownerId: string, assetIds: string[]): Promise<PublicMediaMap>;
getPublicMedia(assetIds: string[]): Promise<PublicMediaMap>;
getPrivateMedia(ownerId: string, assetIds: string[]): Promise<PublicMediaMap>;
enqueueMediaReconciliation(tx: Transaction, ownerId: string): Promise<void>;
```

Profile publishing locks the owner/profile, checks edit version and full document,
validates media ownership/readiness and prepares approved public objects before
atomically switching to a new immutable revision. On any failure the old page
stays intact. Side effects must be idempotent, have bounded timeouts and support
cleanup of provisional objects after a rollback. Do not return unpublished
object URLs from the public resolver. Media reconciliation uses committed live
publication state; history/draft files stay privately restorable and count against
quota. Unpublish, history pruning, suspension and deletion queue reconciliation.

The renderer accepts optional `media: PublicMediaMap` to resolve asset IDs. A
private preview uses owner-authorized same-origin media URLs; it never publishes
draft media. `getPublishedProfile` may add `media` to its public return shape.
Avatar/background images use controlled URLs from these maps. Music uses a
visible user-initiated player, preload=none, no autoplay, volume and attribution.

Local public media may be served on `media.may-be.localhost` via a read-only
`/media/[...key]` route. Production approved media points at the R2 media custom
domain. The primary will add the media hostname and CSP origins. Private asset
reads remain on app host behind ownership checks. No other media-host routes.

Profile HTTP contract (owner only):

All profile mutations require `x-editor-profile` with the original editor's
profileId. Ownership still comes exclusively from the session. A locked comparison
rejects an account switch before any write, even when numeric edit versions match.

- GET `/api/profile`: `{ profileId, username, editVersion, document, publishedRevisionId, revisions }`.
- PUT `/api/profile`: `{ expectedVersion, document }`; returns current draft shape;
  stale version returns 409 with a stable conflict code.
- POST `/api/profile/publish`: `{ expectedVersion }`; explicit publication.
- POST `/api/profile/unpublish`: `{}`.
- POST `/api/profile/revisions/[id]/restore`: `{ expectedVersion }`; makes a new
  publication, preserving immutable history, retaining at most five revisions.
- GET `/preview`: authenticated draft preview; no-store, no public lookup.

Media API contract (owner only): GET `/api/media` lists usage/quota and assets;
POST `/api/media` streams a raw body with a bounded `kind=image|audio` query;
DELETE `/api/media/[id]` removes only when allowed by references; GET
`/api/media/[id]/content` serves private validated content with correct type.
Never rely on client MIME or declared Content-Length as proof of size/type.

## Jobs and external services

Use the existing jobs table and kinds (email, media, account_deletion,
media_deletion, cache_purge). Feature processors export explicit functions for
the later worker dispatcher and document payload schemas. Worker state claiming,
leases, retries and concurrency are integrated centrally in wave 2. Media agent
must enforce one active parser across worker processes, with CPU/memory/time
bounds. User-controlled files never become shell command strings.

Mail supports a real Resend adapter plus a private local transport for acceptance
fixtures. No real email is sent in this task. Do not log recovery/verification
secrets, use a public mail-inspection endpoint or export mail/session credentials.
R2 uses explicit scoped configuration plus a local filesystem adapter outside
public/. Never fabricate success if an external provider is unconfigured.

Feature agents document any required packages/env/worker entrypoints in their
handoff. Media agent exclusively owns package.json and package-lock.json during
wave 1 for sharp and the S3 SDK; other agents use existing dependencies and leave
additional dependency requests in their handoff. The primary integrates later
package scripts, worker/ffprobe Docker requirements and E2E tools.

## Acceptance and unresolved launch inputs

Use real PostgreSQL for concurrent ownership/invite/publishing/media/quota and
deletion tests. Keep suites isolated and never point destructive harnesses at
shared data. Build/browser checks occur after integration, not while another
agent edits the same generated output. Local network/IPC/Docker access may need
the tool's execution escalation; do not silently skip a feasible check.

Implement local export/deletion, encrypted backup + media manifest/copies,
restore with deletion/suspension replay, report handling and useful operational
checks. Run meaningful Chromium/Firefox/WebKit, keyboard and reduced-motion
acceptance for the complete account-to-publish flow where tooling supports it.

Operator identity, jurisdiction, audience/age policy, support contact, server
region and live provider credentials are launch inputs. Build configuration and
honest draft policy pages; do not invent approved legal policy, promise a live
support contact, invite real users, provision services or enable public signup.
