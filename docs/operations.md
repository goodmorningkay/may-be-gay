# Operations workstream

Implemented locally on 10 November 2026, within the operations-owned paths. No
packages, migrations, root navigation/renderer, host/proxy code, workers or
infrastructure were edited by this workstream. Product review additionally
updates the owned auth/security forms and the publication-counter schema. No deployment, live
mail, external communications, commits, pushes or PRs were performed.

## Integration status

The parent has integrated migrations through 0007, the append-only journal and
runtime-role restrictions, host/method and CSP routing, navigation, public
analytics/report links, central dispatch/retention, encrypted journal archival
and the fail-closed full restore. The shared harness now uses real migrations;
there is no temporary feature-table DDL. Real PostgreSQL, local recovery and
browser integration pass. The [current review record](non-launch-review.md)
tracks the final combined evidence and independent rechecks. The contract below also records launch
requirements for provider/CDN revocation; local tests do not establish those.

Integration responsibilities and invariants:

1. Export `schema-operations.ts` through schema-all and include it in Drizzle
   generation. Add **recovery_events** and **recovery_replay** to the parent
   migration and destructive test-harness reset. Operations tests use the real
   shared migration chain. Existing deferred reference FKs,
   immutable-revision UPDATE guard, draft edit-version guard and username
   tombstone triggers must remain active.
2. Add an append-only guard on `recovery_events`: reject UPDATE, DELETE and
   TRUNCATE, including ordinary application-role attempts. Grant the app only
   SELECT/INSERT on this table (normal sequence USAGE/SELECT for appends), and
   no app access to `recovery_replay`. Its reset/truncation is exclusively for
   the migrator-owned disposable test harness. Retention must **never** delete
   this journal. Restore runs offline with the separate restore/migration role;
   replay needs explicit sequence insertion, checkpoint write and sequence
   `setval` privileges. Do not grant those to normal HTTP handlers. Parent owns
   this custom SQL/role integration and testing of its guards.
3. App host only: `/admin`, `/account`, `/account/analytics` and the admin/account
   APIs below. Apex only: `/support`, `/privacy`, `/terms`, `/rules`, and
   `POST /api/reports`. Profile host only: `POST /api/metrics`. The handlers
   independently validate Host/Origin. Keep private HTML, RSC and failures
   `no-store`, no-referrer and noindex at the parent boundary. Public support
   uses same-origin referrer policy so native POST retains its exact Origin;
   cross-origin referrers remain omitted.
4. Mount `PublicAnalytics` from `components/operations/public-analytics.tsx`
   **only on the public ProfileView**, passing username and the actual
   `SITE_DOMAIN` as `domain`. Add `data-profile-link={link.id}` to each visible
   native link anchor. Do not mount in the editor or private preview. Existing
   anchor hrefs remain direct and functional without JS. Add a platform report
   anchor using `reportUrl(username, {linkId? | mediaId?}, domain)` from
   `domain/operations.ts`; its URL uses encoded query references. The helper
   accepts no destination URL and reporting never fetches arbitrary URLs.
5. Link Account and Analytics from the account navigation, Administration for
   admins, and apex policy/support pages. Wire the worker exports below into the
   **one central dispatcher**. Schedule maintenance and the existing media
   sweep/reconciliation. No alternate worker or dispatcher is supplied here.
6. Restore acceptance must archive the latest recovery journal outside app
   storage, replay it **before reopening any profile/media traffic**, drain
   reconciliation/deletion/cache-purge work, and verify provider/CDN revocation.
   Runtime database exclusion cannot invalidate an already cached R2 public URL.
   The existing durable media pipeline owns that deletion/purge and its retries.

## Private authorization and locking

Every admin page/API, including reads, calls existing `requireAdmin` and adds a
live database assurance check. Administrator access requires a current active,
verified admin, a real `session_assurance.reauthenticated_at` within ten minutes,
verified/enabled TOTP and `second_factor_at` within ten minutes. Session creation
alone is insufficient. API auth failures include sign-in/security links; pages
render an accessible access-help view, not private exceptions.

Unsafe app requests use the existing exact app Origin check. Bodies are strict
Zod objects, byte bounded before parsing. No role, bootstrap flag or mail option
is accepted from clients. Mutations recheck actor/session/target within their
transaction. Privileged changes and minimal redacted audit metadata commit in
that same transaction; no token/email/detail is included in privileged audit
metadata. Administrative record projections explicitly select fields; no session
bearers, credentials, invitation hashes, job/mail payloads or TOTP data are read
into the console.

All operations/journal writers first take advisory `(740302,1)`, then the actor
owning user and target owning user, then profile/draft/revision/media rows. This
serializes admin cross-target changes and guarantees journal commit ordering.
Non-admin profile/media services retain their owner-first order. Quota changes
lock target owner then service_settings then account_quota, matching uploads.
Settings changes lock the actor before service_settings. Admission locks settings
before *creating* a new user, never an existing owning user. Report queue capacity
uses separate `(740302,2)` after its owner/profile shared lock; click cardinality
uses a profile-scoped hash advisory lock after its shared owner/profile lock.

No HTTP operation can suspend/delete an administrator account or suspend the
current operator's own profile. Hand over access through the existing private
operator bootstrap/recovery process first; there is no public promotion or
self-lockout override. Reinstatement keeps the profile unpublished and revokes
sessions again. Suspension history remains in the recovery journal.

## Routes

All API JSON responses use the shared `{error:{code,message}}` failures and
no-store; admin/account auth errors also supply `links.signIn` and
`links.security`. Unexpected errors are redacted. No HTTP journal/replay route
exists. All private pages are force-dynamic/noindex.

| Host | Method/path | Input/result |
| --- | --- | --- |
| app | GET `/admin` | Accessible responsive reports/accounts/invitations/settings/audit console; recent password and successful 2FA required. |
| app | GET `/api/admin/reports` | `state=open|reviewing|resolved|dismissed`, optional UUID `id`, `offset=0..10000`, `limit=1..50` (default 25). Queue omits private report details/contact. Exact-ID detail read includes them for follow-up. |
| app | GET `/api/admin/accounts` | Optional `q` (100 characters), same bounded pagination. Email/username search, verification/role, account/profile state, publication pointer and quota only. |
| app | GET `/api/admin/invites` | Same pagination. Recipient, expiry, used/revoked state, never tokens/hashes. |
| app | GET `/api/admin/settings` | Registration mode, uploads pause, account and total storage caps. Default singleton values when absent. |
| app | GET `/api/admin/audit` | Same pagination. Attributed action/subject/time, no private payload projection. |
| app | POST `/api/admin/actions` | Strict discriminated action, maximum 4096 bytes; documented below. |
| app | GET `/account` | Owner account tools, editor/security/analytics links, export and deliberate deletion. |
| app | GET `/account/analytics` | Owner daily UTC aggregates and per-link daily counts for 30 days, limitations displayed. |
| app | GET `/api/account/analytics` | `{days:[{day,views,clicks}],links:[{day,linkId,clicks}],limitations}` for session owner only. No submitted owner ID. |
| app | POST `/api/account/export` | Empty body, `x-account-id` rendered-identity precondition, no owner/path body parameters; downloadable streaming `.tar`. Actual recent password assurance and exact app Origin required. The account UI uses a same-origin JavaScript fetch. GET is deliberately unavailable. |
| app | POST `/api/account/delete` | At most 256 bytes, exactly `{confirmation:"DELETE MY ACCOUNT"}`, plus `x-account-id` rendered-identity precondition. Recent owner authentication, actual password assurance, session-derived owner. 202 reports queued cleanup, not completed physical deletion. |
| apex | GET `/support` | Accessible public form, optional encoded username/linkId/mediaId target. Native POST fallback works without JS. No app cookie dependency. |
| apex | POST `/api/reports` | JSON or native URL-encoded form, at most 4096 bytes. Always generic receipt/errors with no private target enumeration. Native form returns minimal static HTML with no reflected fields. |
| profile | POST `/api/metrics` | At most 256 bytes, exactly `{event:"view"}` or `{event:"click",linkId:UUID}`. Profile derives from validated Host; mandatory exact HTTPS profile Origin. No app session lookup. 204 on accepted/ignored events; generic 400 on invalid/unavailable requests. |
| apex | GET `/privacy`, `/terms`, `/rules` | Configurable honest development drafts and current behavior; no invented approved legal terms. |

`POST /api/admin/actions` accepts these exact shapes (unknown fields fail):

```ts
{ action: "report", id: UUID, state: "open"|"reviewing"|"resolved"|"dismissed", assign?: "me"|"none" }
{ action: "invite", email: string, expiresInHours?: number /* integer 1..168; default 72 */ }
{ action: "revoke-invite", id: UUID }
{ action: "suspend", userId: string, scope: "account"|"profile", suspended: boolean }
{ action: "remove-media", userId: string, mediaId: UUID }
{ action: "quota", userId: string, bytes: number /* integer 0..1 TiB */ }
{ action: "settings", registrationMode: "closed"|"invite"|"public", uploadsPaused: boolean,
  accountLimit: number /* integer 1..50 */, totalMediaLimitBytes: number /* integer 0..1 TiB */ }
```

Public mode is the default for new installations. Existing installations can
select **Public** under **Administration → Settings → Registration**. Invite issuance returns
`{invite:{id,email,expiresAt,token}}` once. The UI shows its fragment link once,
with an explicit Copy button; no copy/share/email happens automatically.
Invitation creation/revocation uses a transactional facade over the existing
invite service's exported normalizeEmail/hashInviteToken primitives and exact
existing table/redemption contract. The existing service's issueInvite/revokeInvite
start independent transactions and cannot supply same-transaction privileged
audit; the facade is deliberate. Parent can later add optional tx support there
and replace the facade without changing these routes. No bootstrap escalation
or invitation mail is available from this UI. Existing explicit local/live mail
settings remain the only authority for other mail delivery.

Report input: `{username, reason, details?, contact?, linkId?, mediaId?, website?}`.
Reason is harassment/impersonation/unsafe-link/copyright/other; details max 2000,
contact optional private email max 254, website is an empty honeypot, and linkId
and mediaId are mutually exclusive UUIDs. The service verifies a currently
published active/verified owner/profile, visible link or currently exposed
same-profile asset under owner/profile locks. No URL fetches, cookies or assumed
IP identity. Invalid/hidden/missing targets and filled honeypots receive the same
success and do not persist. Overload and malformed transport get generic errors.
Budget is shared 12/minute and 150/day, capped at 10,000 retained reports under
lock. These conservative shared budgets can reject legitimate traffic; they
avoid a tracking identifier. Reporting is functional with no mail transport.
The support page honestly says operator contact is pending unless configured and
marked monitored. Reports never appear in owner analytics/export.

Administrator reads are 120/minute and mutations 60/minute per existing operator
ID. Owner analytics reads are 60/minute, export two/hour per owner and ten/hour
globally, deletion three/hour per owner. Shared rate-limit storage contains only
HMAC keys; public keys contain constants/public profile identities, never visitor
fingerprints, IPs, UAs or referrers. Parent access logs must likewise avoid
collecting these through analytics endpoints; analytics does not control proxy
logging.

## Publication, media removal and account deletion

Suspension revokes all sessions, clears the live pointer and queues owner media
reconciliation in the transaction. Public database lookups immediately exclude
unavailable owners/profiles; local public media requests do too. S3 objects/CDN
copies remain pending until existing reconciliation/purge jobs finish. Never
promise completion from the HTTP moderation response alone.

Forced media removal locks owner then profile/draft. It unpublishes an affected
live snapshot, deletes every affected retained immutable revision (never modifies
its document), removes forbidden draft fields/references and advances editVersion
by one. It marks media deleted and its noncascading ledger deleting, queues the
existing media_deletion job and reconciliation, and records both privileged audit
and minimal recovery event atomically. A malformed draft or exhausted editVersion
fails shut pending maintenance. Invalid retained documents are discarded in this
removal path. Concurrent publishing cannot commit forbidden media: it either
finishes first and is detached, or runs after the media state change and fails.

Owner deletion atomically revokes all sessions, marks owner/profile unavailable,
clears publication and queues account_deletion plus reconciliation and a recovery
event. HTTP only claims unavailable/cleanup queued. The job removes private data
within 24 hours **when central workers/providers are healthy**; monitoring and
retry escalation belong to the parent worker. Backups expire separately.

Worker export: `processAccountDeletionJob(payload)` from
`server/operations/deletion.ts`, strict payload `{version:1,ownerId:string}`,
`kind=account_deletion`, `payloadVersion=1`. No owner FK on this job. The processor
refuses a present owner whose deletion was never requested; missing owners are
safe retries. It removes profile/history/reference records, marks all bounded
owner ledger assets deleting and durably enqueues existing media deletion jobs
before removing the owner. Ledger rows have no cascading owner FK, so locators
survive crashes/retries and hard deletion. Username tombstone triggers preserve
the claimed name. Other owners' records are untouched.

It scrubs/cancels obsolete private email jobs matching owner/recipient, removes
bound invitations/bootstrap markers and Better Auth recovery/verification values,
scrubs matching private reporter contact,
then cascades credentials, TOTP/recovery codes, sessions/assurance and quotas.
A worker must recheck email-job state immediately before delivery; a message
already submitted to a provider cannot be recalled. Its bearer links cease to
authorize the removed owner. Failed/pending media cleanup jobs, reconciliation,
cache purges and account deletion jobs are preserved after owner removal.
Processor resolution means records removed and cleanup queued; **it does not
mean CDN/storage cleanup is complete**. Existing media processors provide that
idempotent second phase, retaining their ledger/charge until all deletes/purges
succeed. No competing dispatcher or per-feature leases are implemented here.

## Export format and bounded streaming

Archive is ustar `.tar` containing `account.json` and generated
`media/<UUID>/original.webp|mp3`, plus `display.webp` for images. Manifest includes
private email/username, complete validated draft, current publication identity,
at most five immutable retained documents, stable links/appearance and generated
archive paths for available ready media. Quarantine/rejected/deleted/unavailable
media is excluded. Authentication records, reports, audit/journal, mail/jobs,
infrastructure locators, object tokens/keys and other owners are excluded.

Owner profile/media metadata snapshot is taken under the owner lock. Documents
are revalidated, with manifest capped at 1 MiB, media at 1000 assets and 1 GiB total
before streaming. Before each file, current ownership, live session/password
assurance, asset readiness and immutable ledger token are rechecked under the
owner lock. Only generated expected private adapter keys are read. No client
path, object key or owner ID is accepted. Adapter reads buffer at most one
validated file (10 MiB); archive yields 64 KiB chunks with byte-counted Node and
Web stream backpressure. No giant base64/JSON archive materialization, public URL
fetches or temporary archive files. Tar headers reject traversal/absolute/control
paths and use fixed file modes and generated names.

This is a metadata snapshot plus checked file reads, not an unbounded transaction
held for the whole download. Concurrent deletion/removal, expired assurance,
provider failure, request abort or five-minute elapsed limit aborts the stream;
there is no success trailer for an incomplete archive. Bytes already downloaded
cannot be recalled. Retry a new export rather than using a partial archive.
Download cancellation destroys the underlying generator/stream and releases its
in-flight bounded transaction when that adapter operation completes/timeouts.

The account UI fetches the stream and creates a browser download only after the
complete archive has arrived. It requires JavaScript and buffers the archive in
the browser; the server still uses bounded streaming as described above. A native
form sent Origin:null under the private page's no-referrer policy, so it is no
longer used. The fetch preserves the exact-Origin server guard. Tiny real-media
browser fixtures passed; maximum-size browser memory behavior is not measured.

## Aggregate analytics

Only profile-host POSTs with the exact same profile Origin count. Server resolves
current published document under shared owner/profile locks, rejects hidden or
unknown link IDs and strict unknown fields, and upserts existing daily UTC tables.
One global shared budget caps 2000 events/minute; each daily counter saturates at
1,000,000, and link churn is capped at 100 distinct link IDs/profile/day under an
advisory lock. Owner reads are bounded to 30 daily rows and at most 3000 daily-link
rows; they display stable link IDs rather than silently relabeling historical
clicks. Retention deletes days older than today minus 29 UTC days.

No persistent visitor IDs, cookies, localStorage, IPs, UAs, referrers, external
trackers or redirect dependency. Client fetches use credentials omit and
no-referrer, respect DNT/GPC, wait for visible real navigation and listen only to
trusted native clicks (including middle-click). Server honors DNT/GPC and ignores
RSC/prefetch requests. Bots/direct POSTs, repeats, privacy choices, script blockers
and shared abuse budgets affect counts; these are approximate events, **not
unique people**. Parent must never mount the optional component in a preview.

## Recovery journal and restore API

`server/operations/recovery.ts` exports strict `recoveryPayloadSchema`,
`recoveryRecordSchema`, `readRecoveryEvents(afterSequence=0,limit=100)` and
`replayRecoveryEvents(records)`. These are trusted offline operator/worker APIs,
not HTTP or owner-export data. Read limit is 1..500, cursor is a nonnegative safe
integer and exclusive; rows return strictly ascending. Replay accepts at most
500 strictly increasing records (duplicates/out-of-order within the batch fail).

```ts
type RecoveryRecord = {
  sequence: number; // positive safe integer, monotonic; rollback gaps allowed
  version: 1;
  createdAt: string; // ISO UTC datetime
  payload:
    | {action:"delete-account";ownerId:string}
    | {action:"account-suspension";ownerId:string;suspended:boolean}
    | {action:"profile-suspension";ownerId:string;profileId:string;suspended:boolean}
    | {action:"remove-media";ownerId:string;assetId:string};
};
```

No reporter contact, email, password, reason/details, storage credential/key or
mail content is journaled. No cascading FKs. All original mutations and journal
inserts share one transaction and global operations lock, so sequence order is
commit order. Reversal appends a new event and never erases original history.

The recovery agent must archive complete contiguous **pages** in order (sequence
gaps from rollbacks are normal) to separate encrypted storage, retaining the
journal horizon needed for the oldest restorable backup. Start archive cursor
from its last durably archived sequence; persist cursor only after archival.
No journal pruning is supplied because pruning requires verified off-app archival
and backup-horizon coordination. Its minimal owner identifiers remain private.

During offline restore, replay starts from the checkpoint in recovery_replay (or
zero on an older backup), takes the operations lock, ignores sequences already
applied, imports original journal rows preserving their sequence/time, rejects
conflicting local history, applies the action and advances checkpoint atomically.
It advances the sequence allocator so new events cannot reuse imported IDs.
Caller must feed **all archive pages in order** without skipping a page: the API
cannot distinguish skipped archive pages from legitimate sequence gaps. Restored
local rows after checkpoint are compared to the archived event; a mismatch aborts
instead of choosing one history silently.

Deletion remains one-way and requeues cleanup. Suspension and reversal revoke
sessions/unpublish; reversal never auto-publishes. Missing/deleted owners are
never recreated or reactivated. Removal/deletion still queue ledger cleanup if
owner rows are absent. Media removals detach references again idempotently (draft
versions can advance again on an explicit newer removal; repeated checkpointed
replay is a no-op). Restore before reopening then drain existing deletion/purge
jobs and confirm no prohibited content is exposed. Archival freshness, backup
restore ordering and production app-role guard acceptance are parent-owned.

## Maintenance and policy configuration

`operationsMaintenance(limit=500)` in `server/operations/maintenance.ts` accepts
1..1000 and deletes/scrubs at most limit rows per category in one transaction.
Central worker should call on its schedule and repeat bounded batches as needed:
30 days metrics; reporter contact/details scrubbed after 30 days (even unresolved);
report records capped at 90 days; redacted privileged audit at 180 days to support
appeals. A 10,000-record queue bound protects storage before maintenance. Recovery
journal is never removed. This retention is current development behavior, not an
approved legal retention policy.

Central worker owns expired auth/verification/rate-limit rows and terminal job
retention. Scrub delivered/canceled private email payloads promptly; do not retain
bearer URLs in ordinary logs or backups unnecessarily. Never prune pending,
running or failed account_deletion/media_deletion/cache_purge jobs just because
ownerId is null, nor lose the independent media_storage ledger. Retry/dead-letter
alerts must include only job ID/kind/redacted error codes, never payloads. Media
sweep is the media workstream's existing export, not a second operations sweep.

`launchReadiness()` / `policyConfiguration()` in `server/operations/policy.ts`
returns `{values,missing,ready,reviewed,supportMonitored}`. Missing launch inputs
are visible in the admin UI and draft public pages; they do not disable functional
local reporting/export/deletion. New environment inputs (plain text; never HTML):

- OPERATOR_IDENTITY, OPERATOR_JURISDICTION, POLICY_AUDIENCE_AGE.
- POLICY_CONTENT_RULES, POLICY_MEDIA_RIGHTS_TAKEDOWN.
- SUPPORT_EMAIL, APPEALS_EMAIL (valid private/operator addresses).
- POLICY_PRIVACY_NOTICE, POLICY_TERMS.
- POLICY_REVIEWED=true and SUPPORT_MONITORED=true only after actual operator
  approval and a monitored contact exist. This implementation does not set them.

Normal shared DATABASE_URL/BETTER_AUTH_SECRET/SITE_DOMAIN and the existing media
adapter environment are required. No new dependencies. No launch readiness check
claims a legal scope assessment is finished; jurisdiction, age/audience, content,
terms/privacy, rights/takedown and monitored appeals/support are still operator
launch inputs.

## Verification and outstanding integration

Owned lint, scoped typechecking and repository typechecking (no build or incremental output) pass.
`npx vitest run tests/operations/boundaries.test.ts tests/operations/routes.test.ts`
passes 18 cases. `OPERATIONS_TEST_DATABASE_URL=... npx vitest run
 tests/operations/postgres.test.ts` passes 15 real PostgreSQL cases in the existing
local PostgreSQL container against a distinct **may_be_operations_test** database.
Loopback required sandbox escalation; no production endpoint was used. A supplied
non-test URL is rejected by the common harness before destructive bootstrap; no
URL explicitly skips the PostgreSQL suite. Never share this URL with parallel
account/profile/media suites.

Coverage includes actual library sessions and recent password/2FA assurance,
nonadmin/Origin failures, safe invitation projections, bounded public target and
abuse validation, two-owner analytics/export isolation, saturation/cardinality,
concurrent publish/suspension/removal, immutable history/reference cleanup,
export contents and archive checksum/path safety, export concurrent deletion,
deferred cascade/tombstone preservation, ledger cleanup retries, transactional
journal failure rollback, ordered restore/replay/sequence advancement and bounded
retention. Native public-form byte bounds have route-unit coverage.

The migration/guard, worker, recovery, routing and browser integration above is
complete locally. Independent Astra max/root findings and verification are tracked
in the [current review record](non-launch-review.md). Operator decisions
and live-provider/CDN acceptance remain launch requirements. No feature is
represented as production deployed or live cleanup completed.

## Product/privacy review contracts

The rendered account page retains its account ID and supplies `x-account-id` on
both `POST /api/account/export` (still an empty body) and
`POST /api/account/delete` (unchanged strict confirmation JSON). Missing/malformed
identity fails 400 `ACCOUNT_IDENTITY_REQUIRED`; a stale account fails 409
`ACCOUNT_CHANGED`. The ID is only a comparison precondition: session authority
selects the owner, then the existing owner lock and live assurance check precede
the comparison. No archive bytes, deletion jobs, journal or account mutation
precede it. Reconfirming B cannot authorize controls originally rendered for A.

Auth and security forms use `method=post` and `/api/account/form-help` as their
native fallback. That endpoint discards the body without parsing/logging it and
returns a private, no-store JavaScript-required page. Hydrated forms keep their
existing JSON endpoints and TOTP/session refresh behavior. Routing admits POST
for this one fallback endpoint. Browser tests exercise actual native
submission with JavaScript disabled and assert secrets never enter URLs.

Support includes a native GET profile lookup and an accessible report-target
select. Choices come solely from `getPublishedProfile`: visible links and
resolved current-public avatar/background/music. Drafts, hidden links, history
and unexposed assets never supply choices. Query target IDs only preselect an
existing choice. Native report POST accepts a bounded `target` selector encoded
as `link:<uuid>` or `media:<uuid>`, converts it to the existing strict report
schema, rejects duplicates/mixed legacy target fields, and independently checks
the target against the live publication at submission. JSON clients continue to
send linkId/mediaId. Empty target means whole profile. Reporter contact/details
stay in POST bodies and private storage. Exact Origin (including null rejection)
is preserved; `/support` uses same-origin referrer policy to permit the native
browser Origin header without cross-origin referrer disclosure.

The parent also bound security-screen actions/session refresh and username
onboarding to their rendered `x-account-id`. Shared authorization rejects a
supplied mismatched identity, including password confirmation, factor operations,
password change and sign-out/revocation. Auth forms without an existing rendered
account still use the library sign-in challenge. Export/deletion always require
the precondition, including direct API clients. Other direct account API clients
without a rendered-screen precondition continue to target their authenticated
session owner; the first-party security/onboarding UI always supplies it.
