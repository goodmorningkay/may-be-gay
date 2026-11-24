# Profile editor and publication backend

Implemented against `d87c410`. The profile workstream adds no packages, environment
variables or tables. Product review adds a durable counter to the existing
profile schema; migration 0007 includes its backfill and guard. All generated
migrations, proxy routing and the full editor UI are integrated. The contracts
below describe the invariants to preserve.

## HTTP contract

All five endpoints require the account app hostname and a verified active session
through `requireUser(request)`. Unsafe requests require the exact app Origin.
Ownership is always `SessionPrincipal.userId`; neither an owner nor a profile ID
is accepted in a request body. Bodies are strict, bounded JSON. All responses,
including errors, use `apiJson`/`apiError` and `Cache-Control: no-store`.

Every successful endpoint returns status 200 with exactly this shape:

```ts
type ProfileEditorState = {
  profileId: string;                // UUID, owned by the session user
  username: string;                 // active, fixed claim
  editVersion: number;              // integer starting at 1
  document: ProfileDocument;        // complete private draft, including hidden links
  publishedRevisionId: string | null;
  revisions: {
    id: string;                    // UUID
    revisionNumber: number;        // increasing publication number
    createdAt: string;             // ISO timestamp
  }[];                             // newest first, at most five
};
```

| Request | Body | Effect |
| --- | --- | --- |
| `GET /api/profile` | None | Reads owned draft and history summaries; lazily creates an initial draft for a legacy account if absent. |
| `PUT /api/profile` | `{ expectedVersion, document }` | Validates and replaces the entire draft and its media references. |
| `POST /api/profile/publish` | `{ expectedVersion }` | Publishes the saved draft as a new immutable revision. |
| `POST /api/profile/unpublish` | `{}` | Clears the live revision pointer and retains history and the draft. |
| `POST /api/profile/revisions/[id]/restore` | `{ expectedVersion }` | Copies an owned retained revision into a new publication **and** the draft. |

The document body limit is 128 KiB (UTF-8 bytes); action bodies are limited to
1 KiB. Validation rejects unknown fields, including submitted ownership fields.
Every mutation additionally requires `x-editor-profile` containing the profileId
that the editor originally loaded. This is an identity precondition, never
authorization: the server resolves ownership from the current session and checks
the expected ID inside the same transaction before any write. Switching accounts
in another tab therefore cannot send the old draft to the new account, even when
their edit versions match. GET requests do not require this header.
`expectedVersion` must be an integer in 1–2147483646. Save, publish, restore and
unpublish each advance editVersion by exactly one, including publications whose
document is unchanged. Unpublish intentionally has no expectedVersion in the
agreed API: it removes the current publication under lock and invalidates pending
saves/publications. New revisions have monotonically increasing revisionNumber;
pruning always retains the newest five, including the live revision.

Errors have exactly `{ error: { code: string, message: string } }`. Account/HTTP
helpers supply their own host, Origin, session and malformed-body errors. Profile
services use:

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `EDITOR_IDENTITY_REQUIRED` | Missing or malformed editor identity header; no mutation occurs. |
| 409 | `ACCOUNT_CHANGED` | The loaded editor belongs to a different account from the current session; retain input and sign in to the original account. |
| 409 | `EDIT_VERSION_CONFLICT` | Another operation advanced the draft. Message includes the current editVersion and directs the client to `GET /api/profile` and reconcile before retrying. |
| 404 | `PROFILE_NOT_FOUND`, `USERNAME_NOT_FOUND` | Claim a username first. |
| 404 | `REVISION_NOT_FOUND` | Unknown, pruned or another owner's revision (same response). |
| 403 | `ACCOUNT_UNAVAILABLE`, `PROFILE_UNAVAILABLE` | Missing/unverified/suspended/deleted account, or suspended/deleted profile. |
| 422 | `INVALID_PROFILE`, `INVALID_VERSION`, `INVALID_PROFILE_MEDIA` | Direct service validation failure or incorrect media kind. HTTP body schema failures use the shared `INVALID_BODY` response. |
| 503 | `MEDIA_PROMOTION_FAILED` | Media preparation returned an incomplete result; old page remains live. |
| 409 | `EDIT_VERSION_EXHAUSTED`, `REVISION_NUMBER_EXHAUSTED` | Integer counter requires maintenance; no change committed. |

Media helpers can additionally throw their documented `AppError`s. Unknown
exceptions become the shared redacted 500 `REQUEST_FAILED`, never raw database,
Zod or storage exceptions. The editor should keep unsaved local input on 409,
reload server state, show the conflicting changes and ask the owner to reconcile.
Never silently retry a stale document against a new version. Preserve link UUIDs
when editing or reordering; create a new UUID only for a newly added link. Array
order is display order. Hidden links count toward the 30-link limit.

## Service exports and transactions

`src/server/profile-editor.ts` is server-only and exports:

- `ProfileEditorState` and body schemas `saveProfileSchema`,
  `expectedVersionSchema`, `unpublishProfileSchema`.
- `getProfileEditor(principal)` and `saveProfile(principal, input, expectedProfileId)`.
- `publishProfile(principal, expectedVersion, expectedProfileId)`,
  `unpublishProfile(principal, expectedProfileId)` and
  `restoreProfileRevision(principal, revisionId, expectedVersion, expectedProfileId)`.
- `requireEditorIdentity(request)` validates the mutation header.
- `getProfilePreview(principal)`: editor state plus required `media: PublicMediaMap`.

Only authenticated server callers should construct the principal, using the
shared account helpers. The services independently query live account status and
profile ownership. They lock owner then profile then draft, before validating
media, so simultaneous saves/publications/restores serialize. Every draft and
revision query/write either has an owner column predicate or an explicit owning
profile existence predicate. Media predicates and composite reference FKs enforce
same-owner relationships. Account moderation/deletion must take the owner row
before the profile/media rows in the same order to avoid lock inversions.

Publish validates the complete snapshot, checks ready owned media and its role
(image for avatar/background, audio for music), calls `publishOwnedMedia`, and
requires a result for every asset. Revision insertion, revision_media insertion,
draft/reference replacement, version increment, live-pointer switch, pruning and
reconciliation enqueue all commit together. Restore follows the same path; it
never mutates the source revision. References removed by pruning cascade through
revision_media, while the underlying media stays owned/private and quota counted.

Unpublish clears only the live pointer, advances the draft version and queues
media reconciliation. There is no shared HTML or cross-request cache in this
workstream. Public owner/profile exclusion predicates make suspension/deletion
visible on the next request.

## Media side effects and recovery integration

All five agreed media helpers are consumed from `src/server/media/service.ts`:
`assertOwnedReadyMedia`, `publishOwnedMedia`, `getPublicMedia`, `getPrivateMedia`
and `enqueueMediaReconciliation`. Draft/revision reference rows are written by
profile services within the caller transaction. Storage publication does not
constitute a successful database commit.

If media preparation or the subsequent database commit fails, the old pointer,
version, draft and revision/reference state all roll back. After preparation
starts, the service attempts to enqueue owner reconciliation in a **separate**
transaction, including for a partially failed preparation. That cleanup follows
committed live state, never the rolled-back candidate. Cleanup failure must not
replace the original error.

The media adapter must durably track provisional keys independently of the
publishing transaction (or derive them deterministically from an existing
committed asset ledger), use bounded/idempotent promotion, and periodically sweep
provisional objects against committed live references. A rolled-back outbox row
alone is insufficient: the database can be unavailable during the catch cleanup,
or the process can die between an object write and commit. Existing approved
objects needed by the old live revision must remain until the new commit and
reconciliation. `getPublicMedia` must exclude merely prepared/unpublished assets.
`getPrivateMedia` must recheck ownership and return only session-authorized
same-origin content URLs. Preview releases the draft transaction before invoking
this independently authorized resolver, avoiding nested connection-pool waits
and lock inversion. Its document is the owned draft snapshot read at that moment;
a concurrent edit may create a later version.

The central worker dispatches media jobs and periodic reconciliation. Feature
migrations, local/R2 adapter configuration and public media hostname/CSP rules
are integrated. Live provider configuration and CDN acceptance remain launch work.

## Preview and public integration

`GET /preview` is force-dynamic, revalidate=0, noindex and session-only. It reads
the owned draft, uses `getPrivateMedia`, displays an explicit private-preview
notice and never invokes publication. Missing sessions redirect to
`/sign-in?returnTo=%2Fpreview`; the notice links back to `/editor`. It accepts no
owner/profile ID or unauthenticated token. Routing keeps `/preview` and all profile
APIs app-host-only; private HTML/RSC/error responses use no-store.

`getPublishedProfile(username)` still selects only publication fields:
`{ id, username, revisionId, document, media? }`. It validates the entire stored
snapshot, projects away hidden links before returning any serializable result,
and resolves only asset IDs from that public document via `getPublicMedia`.
`media` is omitted for asset-free profiles, preserving the old return shape.
Unknown/unpublished/unverified/suspended/deleted/invalid profiles return null.
There is no account login email, owner identity, private draft or hidden link URL
in that response.

The public route in `src/app/page.tsx` passes `media={profile.media}` to ProfileView.
Existing metadata fields (`pageTitle`, `pageDescription`, `allowIndexing`) remain
compatible; public metadata uses the validated published document. The media host
and controlled custom-property styles are integrated with the central CSP. Values emitted
by the renderer are validated hex colors and fixed gradient directions only.

## Verification and remaining acceptance

`npm test -- tests/profile tests/publishing` runs the owned pure/renderer tests.
The PostgreSQL suite is opt-in with `TEST_PROFILE_DATABASE_URL` and optional
`TEST_PROFILE_APP_DATABASE_URL`. Use a separate disposable migrator-owned
`*_test` database from `TEST_DATABASE_URL` because each suite destructively
bootstraps migrations and may execute concurrently. Never use a shared database.

The shared DB harness resets all feature tables and guards before reapplying the
complete migration chain. The profile suite deletes its fixture media ledger
between cases. Its media fixtures include ready ledger records. Storage promotion
and public URL resolution are controlled test adapters; real media readiness,
PostgreSQL transactions, ownership FKs, version guards, reconciliation queue and
immutability guards remain active. A deferred PostgreSQL trigger exercises an
actual commit failure after preparation. Tests cover two-owner isolation,
stale/concurrent saves and publications, asset ownership/readiness/kind failures,
rollback, immutable restore/reference reconciliation, pruning, public-field
separation, unpublish and all disabled account/profile states.

Integrated PostgreSQL acceptance passed all 20 profile cases using the restricted
runtime role, including account-switch rejection for every editor mutation.
The broader 415-test run passed with all five feature databases configured.
Browser acceptance and independent review are recorded separately; these tests
do not establish hosted-provider or CDN behavior.

## Durable publication counter migration (product review)

`profiles.publication_number` is an integer, not null, default 0, with
`profiles_publication_number_check` enforcing 0..2147483647. The service increments
it under the existing owner/profile lock in the same transaction as insertion.
Removing latest/all revisions must never reduce it. Failed commits roll it back.
Migration `0007_publication_counter.sql` and its snapshot/journal are integrated.
After ADD COLUMN/check and before reopening writers, it backfills and replaces
the existing identity guard as follows in the migration transaction:

```sql
LOCK TABLE public.profiles IN ACCESS EXCLUSIVE MODE;
UPDATE public.profiles p
SET publication_number = greatest(p.publication_number, r.maximum)
FROM (SELECT profile_id, max(revision_number) AS maximum
      FROM public.profile_revisions GROUP BY profile_id) r
WHERE p.id = r.profile_id;

CREATE OR REPLACE FUNCTION public.guard_profile_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    RAISE EXCEPTION 'Profile identity and ownership are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.publication_number < OLD.publication_number THEN
    RAISE EXCEPTION 'Publication counter cannot decrease' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
```

The existing `profile_identity_guard` trigger already invokes this function.
Backfill must run before installing the new function on a fresh migration, and
all statements must commit together. Retained maxima are the only recoverable
legacy history; numbers erased before this migration cannot be reconstructed.
Operations and publishing suites pass against this real migration, including the
restricted app role. A rollback-only migration probe restores the old table/guard
shape with existing revisions, executes the actual upgrade, and verifies the
backfilled maximum, empty-profile default and monotonic guard. Numbers erased
before the upgrade cannot be inferred from absent history.
