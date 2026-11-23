# Media implementation and integration

The media service accepts raw authenticated uploads, reserves storage before
reading, streams the body into a private temporary file, and durably queues
validation. POST returns **202**, not a claim that a file is ready. The editor
must poll GET `/api/media` and use only `state=ready` IDs. No MIME header,
filename, Content-Length or user-supplied owner ID is validation authority.
Mutations use the shared `requireUser` and exact origin helper. HTTP errors use
the shared redacted `{error:{code,message}}` shape.

## Upload ingress and editor identity

The exact `/api/media` collection path bypasses Next 16's proxy. The installed
`next-server.js` calls body-clone `finalize()` before handing off; its
`body-streams.js` eagerly accumulates the request and defaults to a 10 MiB cap.
Increasing that cap would still delay admission and spooling until EOF. The
proxy matcher instead excludes only `/api/media` and its trailing slash form.
Descendants, differently cased paths, `.json` and encoded spellings still match
proxy; the installed Next matcher compiler is covered by a regression.
Next's default trailing-slash redirect occurs before routing. The collection
handler additionally accepts only the canonical literal `/api/media`, so an
encoded/trailing alias cannot acquire capacity through a second entry point.
Redirects do not themselves reserve or store anything; a followed canonical
request must pass all admission checks again.

`mediaIngress` enforces the exact app Host (or app Host with `:443`),
GET/HEAD/POST methods, maintenance gate, and private/no-store plus CDN no-store,
CSP, nosniff, frame, referrer, permissions and robots headers on every handler
outcome. Other methods receive 405 and `Allow: GET, HEAD, POST`; wrong hosts or
noncanonical paths receive 404. The shared session and exact mutation Origin
checks run before reservation/body consumption. Forwarded authority headers
never select an owner or admit this route. No extra request-body clone is used.

GET `/api/media`, POST `/api/media?kind=image|audio`, and DELETE
`/api/media/<id>` require `x-editor-profile: <original editor profile UUID>`.
Missing/malformed identity returns 400 `EDITOR_IDENTITY_REQUIRED`. Under the
session-derived owner lock, the service locks that owner's profile and compares
the precondition before list disclosure, reservation, or deletion; a stale tab
returns 409 `ACCOUNT_CHANGED`. The ID never grants ownership. The component
retains its original identity even if new props arrive during its lifetime.
Private native image/audio GET `/api/media/<id>/content` continues to authorize
the session against the asset independently and does **not** require this header.

## Limits and processing

- Images: GIF and static JPEG/PNG/WebP, up to 5 MiB received and 16,000,000
  decoded pixels including all GIF frames. GIF uploads may have up to 120
  frames. Container inspection rejects APNG and animated WebP uploads.
  Strict decoding produces a metadata-free WebP original (maximum 4096 pixels
  per side, 5 MiB) and a display derivative (1 MiB, maximum 1600 pixels per
  side for still images). Animated GIFs use lossless WebP to retain subtle frame
  changes and compress flat colors. The parser resizes GIF frames separately
  and compares the full-size WebP with a candidate up to 1280 pixels per side.
  For display, it selects the smallest file within 1 MiB that retains the most
  frames and tries a smaller size if needed. Public rendering uses the display
  derivative.
  Original upload bytes are removed after validation commits.
- Audio: MP3 only, 10 MiB, at most 180 seconds. A complete frame walk rejects
  free bitrate, reserved fields, mixed sample rate/channel configurations,
  truncation, non-MP3 tails and overlong tracks. Bounded ID3v2.3/v2.4 and ID3v1
  tags are stripped. At least three frames are required. FFmpeg then fully
  decodes the stripped frames with the MP3 demuxer, strict error handling, one
  thread and only the `file` protocol. There is no arbitrary input format or
  transcoding. APE and unsupported tag layouts are rejected rather than guessed.
  Frame-based duration includes encoder padding and can conservatively reject
  a nominally three-minute track with extra padding.
- Upload receive timeout: 60 seconds. Reservation expiry: 15 minutes.
- One parser across **all processes** via
  `pg_try_advisory_xact_lock(740301,1)`, held for the entire parser operation.
  Contention returns `MEDIA_PARSER_BUSY` (429) for worker retry, without waiting
  inside another worker. No process-local mutex is the concurrency authority.
- Parser process: Linux `prlimit`, 2 GiB address space, 12 CPU seconds, 10 MiB
  output-file limit, 64 descriptors, no core dumps; Node runs JIT-less with a
  128 MiB JS heap. Parent wall timeout is 20 seconds and kills the process group.
  Combined stdout/stderr are capped at 16 KiB and never returned/logged as raw
  errors. Sharp cache is disabled, libvips concurrency and worker pool are one.
  Audio's decoder additionally has a 512 MiB address-space limit, 10 CPU
  seconds, 32 descriptors and a 10-second wall timeout. Address-space bounds
  are not a promise of a particular RSS; the container needs an appropriate
  aggregate memory/CPU limit and monitored disk capacity as defense in depth.
- Scratch directories use private modes and generated names in `TMPDIR`.
  The periodic sweep removes scratch directories older than 15 minutes.

Dependencies are pinned directly to `sharp@0.35.5` and
`@aws-sdk/client-s3@3.1165.0`; package-lock pins transitives. Relevant official
contracts: [sharp strict decode and pixel limits](https://sharp.pixelplumbing.com/api-constructor/),
[AWS S3 SDK](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/s3/),
[FFmpeg input restrictions](https://ffmpeg.org/ffmpeg.html), and
[Cloudflare URL purge](https://developers.cloudflare.com/api/resources/cache/methods/purge/).

## Configuration and provider privileges

Configuration is explicit. Missing provider configuration returns 503
`MEDIA_PROVIDER_UNCONFIGURED`; there is no production local-storage fallback.
Storage failures use `MEDIA_STORAGE_UNAVAILABLE`; malformed media uses
`MEDIA_INVALID`/`MEDIA_PROCESSING_LIMIT`; capacity uses 507
`MEDIA_QUOTA_EXCEEDED` or `MEDIA_OBJECT_CAPACITY`, and upload pause uses `MEDIA_UPLOADS_PAUSED`.

Local development and production-build acceptance need `SITE_DOMAIN=may-be.localhost`,
`MEDIA_STORAGE=local`, and `MEDIA_LOCAL_ROOT=/absolute/private/directory`.
Keep this directory outside `public/`, `.next/`, the source tree's served
assets and any web server document root. The directory must be owned by the
application account and not writable by other users; do not configure symlink
aliases into a public directory. Separate `private/` and `public/` trees are
created with private permissions. Local approved reads go through
`https://media.may-be.localhost/media/v1/...` and check committed live references
on **every request**, with no-store and nosniff. Private previews use authenticated
same-origin `/api/media/<UUID>/content`, also no-store, and support bounded single
byte ranges for seeking. The media host must expose only the public media route.

Production S3/R2 configuration:

| Variable | Meaning |
| --- | --- |
| `MEDIA_STORAGE=s3` | Explicit adapter selection |
| `MEDIA_S3_ENDPOINT` | HTTPS S3-compatible endpoint; R2 account endpoint |
| `MEDIA_S3_REGION` | Explicit region (`auto` for R2) |
| `MEDIA_PRIVATE_BUCKET` | Private quarantine and validated originals/derivatives |
| `MEDIA_PUBLIC_BUCKET` | Separate bucket serving approved copies only |
| `MEDIA_S3_ACCESS_KEY_ID`, `MEDIA_S3_SECRET_ACCESS_KEY` | Explicit scoped object credentials |
| `MEDIA_PUBLIC_ORIGIN` | Exactly `https://media.<SITE_DOMAIN>`, with no trailing slash/path |
| `MEDIA_CLOUDFLARE_ZONE_ID` | 32-character zone ID for public domain |
| `MEDIA_CLOUDFLARE_PURGE_TOKEN` | Zone-scoped Cache Purge token |

The S3 adapter requires only GetObject/HeadObject, PutObject and DeleteObject on
the **two named media buckets**. It does not require ListBuckets, bucket creation,
ACL changes, DNS rights, public-policy changes, arbitrary account access or backup
bucket access. Keep bucket administration and backup credentials separate.
Private keys are `v1/<asset UUID>/<private token UUID>/...`; public bucket keys
are `media/v1/.../public-<random UUID>.webp|mp3`, matching their URLs. S3 writes
set Content-Type and cache control explicitly, use conditional `If-None-Match: *`
and digest metadata, and use two attempts plus a 10-second abort deadline.
Object keys are generated and validated; no file name becomes a shell argument.
Do not enable public access to the private bucket or an additional `r2.dev` URL.
Disable object versioning or provide a lifecycle policy to remove deleted versions;
otherwise physical retained copies outside this ledger need separate accounting.

**Parent/provider integration requirement:** the public custom domain must add
`X-Content-Type-Options: nosniff` (R2 custom-domain response header transform),
allow the controlled image/audio content types, honor the object's 60-second
cache lifetime, disable stale-on-error/Always Online behavior for removed media,
and use a cache key that ignores query strings (or reject query strings).
Do not introduce a longer edge/browser TTL or independent cache variants.
The app cannot set arbitrary HTTP response headers on direct R2 responses using
S3 object metadata. Verify these headers and purge behavior against real R2
before launch; no live provider acceptance was performed here.

Cloudflare purge uses the actual zone API, accepts at most 30 exact configured
media URLs per call, aborts after 10 seconds, bounds response data, and fails
closed on provider rejection. Local mode uses no CDN and verifies live DB state.

## Ledger, quota and transaction boundary

`schema-media.ts` owns `media_storage`. It intentionally has **no foreign key**
to users or the base media table: hard account deletion cannot lose cleanup
locators, quota charges or private object keys. Do not add a cascading FK or
remove this table from deletion recovery/export/backup manifests.

All reservations lock owner, settings singleton, account quota, then storage.
The singleton and quota rows are inserted on conflict before locking. Defaults
come from the shared settings schema: 100 MiB/account, 5 GiB/global, uploads
unpaused. Global and account limits apply to the sum of all ledger charges,
including missing-owner records awaiting physical cleanup. Account overrides and
uploadsPaused are read under the same decision locks. Simultaneous reservations
therefore cannot spend the same capacity. A separate global inventory admission
budget uses the shared `MAX_PRIVATE_MEDIA_OBJECTS = 9999`: reserve two retained
private-object slots per image and one per audio. Every ledger state counts,
including uploading, rejected, deleting and missing-owner cleanup records. The
settings singleton serializes the decision independently of byte limits and the
1000-assets-per-owner limit. This bounds a ready backup inventory to 9999 private
objects plus its one database file (10000 manifest entries). Object slots are
released only by successful physical cleanup/ledger deletion. Inventory exhaustion
returns 507 `MEDIA_OBJECT_CAPACITY` with a cleanup/retry message; collection quota
availability also accounts for inventory exhaustion. The profile service already locks the
owner before calling the media contract; media does not invert that order or
open another pool transaction inside publication.

Upload reservation commits before body spooling, which holds no database locks.
After spooling, owner/profile and ledger locks revalidate the active account,
reservation token/state and expiry **before** quarantine PUT; those locks remain
held through the bounded PUT and queued-state commit. Explicit/account deletion
and physical cleanup serialize with that storage mutation. If deletion wins
while bytes are still spooling, finalization performs no PUT. A PUT/commit failure
retains its durable ledger charge and expiry/deletion jobs until cleanup succeeds.

Local storage crash temporaries use random `<object>.<UUID>.partial` names.
Under the same owner/ledger mutation ownership, retry, publication, trim and
ready reconciliation remove stale temporaries only for that asset's exact
private/public locators (including revoking keys). This runs before an existing
immutable final-object retry and before shrinking peak charges. Ready live assets
are checked too. Cleanup cannot race another active writer for those locators;
unrelated assets/locators are untouched. Physical deletion also removes matching
temporaries before releasing any reservation.

Uploads reserve their maximum simultaneous footprint: 24 MiB/image or
50 MiB/audio. Reservations include quarantine, sanitized originals, separate
image derivatives, retry copies and parser scratch input/output, and one possible
public copy. This conservative peak reservation can exceed the eventual ready
asset size; it also prevents concurrent upload spools from exhausting the budget. They shrink after processing
and after quarantine deletion **commits**. Audio uses one private object for
original and display, counted once. Images count both stored private objects,
even when their bytes happen to match. Draft and all retained history assets
remain in the ledger and continue to count.

Every ready asset conservatively reserves one public-copy slot even while
unpublished. GET reports `usage.chargedBytes`, `privateBytes` and
`publicReservedBytes`; the remaining charge can be an in-flight upload
reservation. This can reserve more than the bytes physically stored, by design,
so publication does not acquire another quota transaction while the profile
transaction holds owner/profile locks. It also accounts for provisional copies
left by rollback. A replacement public generation cannot be copied until its old
copy's deletion and CDN invalidation finish (`MEDIA_REVOCATION_PENDING`). This
prevents two public generations from spending a single slot.

`publishOwnedMedia(tx,ownerId,ids)` runs in the caller's transaction. At most
three ready owned assets are copied sequentially, with bounded provider calls.
Copy keys are precommitted random immutable locators; retries verify matching
bytes and do not overwrite an existing object. The function never switches a
profile pointer. If any copy/SQL step fails, the caller rolls back and leaves its
previous revision visible. A provider copy and PostgreSQL commit are **not a
distributed atomic transaction**: a rollback can leave a provisional public
bucket object. No public resolver or local route exposes its URL without a live
committed reference; a direct public bucket cannot make SQL commit atomic with
an object becoming retrievable by a holder of its secret random URL. Do not
expose/log provisional keys, private ledger metadata, or bucket listings. If
absolute precommit inaccessibility is required, a gated origin/edge worker is
needed instead of direct public-bucket delivery.

The periodic sweep examines all ledger rows, including commits that have no
successful job enqueue after a later failure. For each non-live asset it checks
whether its precommitted public key exists, rotates to a fresh key and durably
queues deletion/invalidation of the old key. Ownership locks serialize this with
publication. This discovers provisional copies even after a SQL rollback or
process crash. `getPublicMedia` joins only active verified owner/profile/current
revision references and ready assets. Arbitrary draft/history IDs resolve to
nothing. Private media resolves only for the active owner.

DELETE rejects both draft and revision references, then tombstones the base
media row and durably queues physical deletion. Jobs recheck references before
physical removal. No ready retained private files are pruned merely because they
are unpublished. Explicit deletion/unreferenced removal, account deletion and
abandoned-upload expiry release quota only after all known copies and purge
operations succeed. The ledger survives errors. The latest 20 cleaned rejected rows remain as user feedback; older cleaned
rejections are pruned under owner ownership by cleanup and listing. Rows with a
ledger or profile references are never pruned as feedback. Usable assets are
listed independently through the admitted ledger, so rejection history cannot
crowd out either old or new ready assets. Operations that moderate a referenced
asset must first remove its references or keep it privately retained and enqueue
reconciliation; do not bypass reference checks to physically delete history.

## Worker payloads and retry contract

Exports live in `src/server/media/jobs.ts`. Central claiming, leases, backoff,
logging and worker startup belong to the parent/worker agent. All payloads are
strictly validated, `jobs.payloadVersion=1`, and contain `version:1`:

| Job kind / processor | Payload |
| --- | --- |
| `media` / `processMediaJob` | `{version:1,action:"process",assetId,token}` |
| same | `{version:1,action:"trim",assetId,token}` removes committed quarantine |
| same | `{version:1,action:"expire",assetId,token}` checks abandoned reservation |
| same | `{version:1,action:"reconcileAsset",assetId,token,periodic?:true}` |
| same | `{version:1,action:"reconcile",ownerId,eventId?:string}`; numeric tx ID event |
| same | `{version:1,action:"sweep",sweepId,cursor?:assetId}`; UUID sweep ID |
| `media_deletion` / `processMediaDeletionJob` | `{version:1,assetId,token}` |
| `cache_purge` / `processCachePurgeJob` | `{version:1,assetId,token,key}` |

Tokens/locators are private worker data and must not be logged or exported in
public responses. Cleanup jobs deliberately omit the nullable jobs.ownerId FK;
their payloads survive owner deletion. Repeated jobs and completed operations
are idempotent. Copy preparation uses no nested pool transaction. Failed parse
validation commits rejected state and queues cleanup; storage/binary failures
and parser contention throw for retry. Dispatchers must redact schema and
provider exceptions; preserve AppError codes, never raw exception messages.

Call `enqueueMediaReconciliation(tx,ownerId)` in the same transaction after
unpublish, suspension, draft/reference changes, revision pruning and deletion.
The owner deletion job may hard-delete user rows once reconciliation is queued;
the independent ledger is also discovered by sweep if enqueueing was missed.
Reconciliation fans out to per-asset bounded jobs. Schedule
`enqueueMediaSweep(randomUUID())` **at least once per minute** (on every worker
host to clean its local scratch). Sweep pages at 100 rows and durably queues
continuations with a stable sweep ID. Only one pending/running sweep chain is admitted at a time. Periodic asset
checks use a stable asset/token key: pending/running equivalents coalesce,
terminal jobs reset for later repair, and successful check history does not grow
one row per asset every 30 seconds. Page admission batches up to 100 inserts.
Explicit owner events keep independent keys so a new event cannot be lost when
it races a running periodic check. Queue claims prioritize deletion/cache purge,
then explicit reconciliation, above periodic work even on fairness turns; claim
renewal/finish fencing is unchanged. This bounds outstanding periodic checks by
the admitted ledger inventory and repairs exhausted periodic checks on later
sweeps. It does not promise provider throughput or a removal SLA during outages.

Public cleanup gets up to 20 durable attempts; central dispatch must prioritize
media deletion/cache purge, retry transient failures quickly enough for the
**<=5 minute removal objective**, reclaim crashed leases, and alert on failed or
over-age revocations. Ordinary object cache TTL is 60 seconds as an additional
bound. A sustained provider outage or stopped worker can break the objective;
this is an operational alert, not a success result. A failed cache_purge job
keeps revokingKey and blocks republication; retry/reset that failed durable job
after fixing the provider. Previously downloaded copies cannot be recalled.

## Integrated runtime contract

Items 1–6 below are implemented and verified locally. They describe requirements
that must be preserved during future changes. R2 response-header/cache settings
and real Cloudflare purge acceptance still require launch configuration.

1. Add `schema-media.ts` and shared settings tables to Drizzle migration
   generation/aggregation and apply the generated migration. No custom SQL
   trigger is required by media; keep existing same-owner/reference FKs. The
   app role needs CRUD on `media_storage`, settings, quotas and existing tables,
   plus normal PostgreSQL advisory lock/txid functions; no DDL or extra schema
   privileges. The migration owner, not the app, creates tables.
2. Update `tests/db/harness.ts` to drop/reset feature extension tables, including
   independent `media_storage`, before rerunning migrations. Serialize all DB
   suites against a single disposable database; never share concurrent
   destructive bootstraps. No migration/journal was edited in this wave.
3. Add the media Host kind, media-only path policy, proxy routing and CSP media
   origins. Add the shared route's trusted app session/origin enforcement (the
   media APIs already consume the shared helpers). Keep public media off app and
   profile host routing. Verify renderer map integration and user-initiated audio.
4. Install maintained distro **ffmpeg** and **util-linux** (`/usr/bin/ffmpeg`,
   `/usr/bin/prlimit`) in application/worker images, with their runtime libraries.
   **ffprobe is not used or required**: duration is frame-walked and FFmpeg does
   full bounded decode. Keep distro security updates enabled. The existing
   Dockerfile includes these packages.
5. Copy `src/server/media/parser.cjs` to exactly that runtime path relative to
   process.cwd(), and include `sharp` plus its platform-specific libvips/native
   modules in the standalone/worker image. This dynamic subprocess require must
   not be assumed to be captured by Next tracing. Test the final image as its
   non-root user and confirm /tmp is writable and private storage is persistent.
6. Wire the three processors, lease/retry logic and minute sweep. Preserve ledger
   manifests in backup/restore. Configure and verify R2 public headers/cache
   settings and Cloudflare purge before any launch acceptance.

## Verification

`npx vitest run tests/media` covers stream byte/time bounds, generated strict
image variants, metadata removal, GIF animation and bounds, APNG/WebP upload rejection, active/MIME
spoofing, truncated/overlong MP3 data, full audio decode, parser wall/output
bounds, API authorization/CSRF, storage namespace/immutability, S3 command and
failure contracts, Cloudflare purge and response headers/ranges. Fixtures are
small programmatically generated colors and sine-wave audio, with no third-party
media licenses or binary downloads. Native process tests need Linux FFmpeg,
prlimit, a C compiler and the compiled guardian (`npm run native:build` before
direct Vitest calls), plus permission to execute subprocesses; the restricted tool sandbox can
block native execution, so native acceptance must run in the actual environment.

`tests/media/persistence.test.ts` uses the existing destructive `*_test` guard
and is skipped unless TEST_MEDIA_DATABASE_URL is set. It applies the complete
versioned migration chain and fails on an inaccessible supplied test URL.
Run it alone against a disposable test database:

```sh
TEST_MEDIA_DATABASE_URL=postgres://migrator:LOCAL_TEST_PASSWORD@127.0.0.1:5432/media_test npx vitest run tests/media/persistence.test.ts
```

The implementation-wave regression run passed **54 tests across five files**, including
**20 PostgreSQL scenarios**, native image/audio parsing, routes/storage and proxy
matching. It covers delayed quarantine PUT versus both explicit and account
deletion, deletion winning during spooling, durable cleanup after a write failure,
original-exists crash retries and live ready temporary cleanup, concurrent final
inventory slot admission across all ledger states, 1000 old rejections with old
and new ready assets, stale editor identity with unchanged B ledger/quota/jobs,
and periodic queue coalescing/priority/fencing. Lint on all assigned code/tests
and repository TypeScript pass. No builds, browser harness or real HTTP server
were run in this implementation pass.

A bounded local scheduling fixture admitted 2000 assets through three repeat
sweeps: **2000 outstanding periodic checks**, 1034 ms total enqueue work; 20 ready
checks with stubbed storage HEAD took 116 ms. These are fixture measurements,
not provider/target-server capacity claims. Completed and failed periodic rows
were repaired later; a running claim retained its fence through another sweep.

Production ingress acceptance passes against the standalone container both over
direct HTTP and certificate-verified Caddy HTTPS. Each run proves pre-EOF
reservation/spooling, pre-EOF anonymous rejection and actual 11 MiB rejection.
The final worker then removed all fixture files, ledger rows and charged bytes.
The HTTPS check exposed Caddy's default HTTP/1 unread-body drain; its configured
`enable_full_duplex` now permits an admission error before EOF. Preserve this
setting when adapting the proxy for hosting; see the [Caddy option](https://caddyserver.com/docs/caddyfile/options#enable-full-duplex).

Reproduce after migration integration and the final build:

```sh
# Start the built app separately with the same disposable media_test DB,
# SITE_DOMAIN=may-be.localhost, MEDIA_STORAGE=local and a private local root.
# Keep the worker stopped for this ingress observation, then drain cleanup.
TEST_MEDIA_DATABASE_URL=postgres://may_be_migrator:local-only-migrator@127.0.0.1:55436/media_test \
  UPLOAD_SMOKE_URL=http://127.0.0.1:3000 \
  npx tsx scripts/upload-smoke.ts
```

The script creates a local verified fixture and signs in through real auth; it
asserts that 32 KiB sent without EOF has both committed a reservation and reached
the spool, that an anonymous request is rejected before EOF without reservation,
and that actual 11 MiB audio returns 413 `MEDIA_TOO_LARGE` (rather than a truncated
202). It also checks route security/cache headers. Only loopback HTTP(S) and
local `media_test` are accepted. If the app uses another scratch mount, set
`UPLOAD_SMOKE_SCRATCH_ROOT` to its host-visible directory; for local Caddy TLS,
set `TEST_CA_FILE` and the loopback HTTPS URL. Finally it queues normal asset
cleanup and deletes its own fixture owner; drain the worker or discard the
**disposable** database/storage afterwards. It never drops ledger locators or
charges to fake cleanup. No real provider/mail acceptance is performed.

`tests/e2e/media-review.spec.ts` passes in the final 14-scenario browser matrix,
including the raw HTTP/1 early-rejection regression. The media identity
regression switches a shared cookie from A to B while A's editor remains open,
checks A's retained library header and ACCOUNT_CHANGED errors for list/upload/
delete, verifies B's library/usage remains unchanged, and confirms native private
content still loads without an editor header. Real provider/CDN propagation and
deployment remain excluded.

The separate development Compose regression passes with app and worker both at
uid 1000: valid HTTP upload, native worker parsing, private derivative access,
physical deletion and released quota. The image gives the development app a
writable Next cache without changing shared-media permissions. Reproduce with
`infra/testing/dev-media.compose.yaml` and `scripts/dev-media-smoke.ts` as documented
in development.md; the fixture has no published ports and is removed afterward.
