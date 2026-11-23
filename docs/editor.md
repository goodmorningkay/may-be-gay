# Private profile editor

Implemented in the assigned editor-only paths. No dependencies, server contracts,
schema changes, builds, commits, external services or deployment were added by
this workstream. Shared profile/media/account implementations remain authoritative.

## Entry and privacy

`/editor` is force-dynamic, `revalidate=0`, `fetchCache=force-no-store`, with
noindex/nofollow metadata. Its server page calls `assertAppHost`, `getSession`
and `requireUser`; only missing/expired sessions redirect to the app-local
`/sign-in?returnTo=%2Feditor`. Verification, host/access failures and unexpected
render failures have useful redacted screens. No login email, authentication
name, session principal or bearer token is serialized into editor props.

The authenticated client loads `GET /api/profile`. Only `PROFILE_NOT_FOUND` or
`USERNAME_NOT_FOUND` offers username onboarding. Claim uses the actual
`POST /api/account/username` JSON contract, then reloads the editor. Both local
username format checks and server-side availability errors are explained. A
successful claim followed by a failed profile read offers another load without
requiring another claim. The fixed beta username and unpublished initial state
are explicit. Profile content is never filled from account identity.

All private fetches use no-store, same-origin credentials and reject redirects.
Success responses are validated before entering editor state. Errors display
only bounded `error.code`/`error.message`; unexpected payloads and exceptions use
generic messages. Text and JSON comparisons are React-escaped, never raw HTML.
No draft, session or token goes to localStorage, sessionStorage or telemetry.
An explicit Download action creates a private JSON file locally with a temporary
Blob URL; there is no automatic disk persistence or server upload of that copy.

## Editing and appearance

Every editable v1 field is represented: display name, pronouns, bio, deliberately
separate public contact email, avatar, background image, music asset/rights,
up to 30 links (including hidden links), theme controls, page title/description
and explicit indexing opt-in. Clearing contact removes it. Links get a UUID only
when added; edit, visibility, icon choice and keyboard Up/Down preserve it. Move
and Add focus the affected link label. Delete confirms removal from the draft.
All nine supported social icons and no-icon are available.

Six presets reset custom colours/background/overlay/button/spacing while keeping
layout/font, all content, media and metadata. The UI describes this effect.
Both layouts, all three fonts, controlled hex colours, all button shapes,
solid/gradient backgrounds and directions, overlays and spacing are editable.
The domain's text/boundary contrast measurements are advisory and explicitly
exclude guarantees about image backgrounds or intermediate gradient colours.

The layout uses the site's warm paper colours, readable type and restrained
spacing, with responsive single-column fallback. DOM order matches visual order.
Controls have labels, field errors/descriptions, focus treatment, touch targets,
keyboard alternatives and reduced-motion support. Save state and discrete action
feedback use polite live regions; every keystroke is not announced.

## Saving, conflicts and publication

`src/domain/editor.ts` owns a pure, injected-transport coordinator. Valid changes
debounce for 800 ms in the UI. A single save writer sends complete validated
documents with the last accepted `expectedVersion`. It drains subsequent edits
made in flight against the returned version; save responses never replace newer
local input. Invalid input remains editable and unsaved, with field-level errors;
the last fully valid document remains available for rendering. Profile identity
and monotonically increasing versions are checked before accepting responses.
Disposed coordinators ignore late responses.

Statuses distinguish saved version, pending, saving, invalid fields, offline,
failure, conflict and publication activity. Failures stop automatic retries.
Retry is deliberate and uses the same version until a conflict is reconciled.
HTTP 401 keeps input in place and offers sign-in in a new tab. After expiry,
Retry first reads and checks the original profile identity/version; signing into
another account cannot resume that retained draft through the retry path.

On `EDIT_VERSION_CONFLICT` (or an outdated response), local input stays intact,
writes pause, and the coordinator fetches the latest draft. The comparison shows
starting/server versions, changed top-level fields, and expandable complete local
and server JSON. It supports local download and explicit comparison refresh;
out-of-order comparison reads are ignored. Confirmed choices either discard
local input for the compared server draft or retain the complete local document
for replacement against the compared version. Only that deliberate local choice
allows autosave to resume with a fresh version; another concurrent edit produces
another conflict. There is no automatic merge or stale-content retry.

Publish, Unpublish and Restore confirm their effects. All three serialize with
autosave and first flush valid pending edits. Editing pauses while an action
runs. Publish uses the final returned version and cannot publish an older
in-flight snapshot. Unpublish sends `{}` as required, then consumes the advanced
version. Restore sends `{expectedVersion}`, names the selected publication and
timestamp, and accepts the returned new publication **and** replacement draft.
All actions remain disabled while invalid fields, unresolved conflicts or errors
need attention; the UI explains correction/retry. Restore offers a local download
before replacing a draft. Up to five actual server revision summaries are shown,
including the live marker and honest history/storage explanation. A publication
failure keeps the old publication pointer and the editor draft visible; retrying
editing does not silently retry the publication itself.

Full-document navigation and a `beforeunload` guard warn about pending edits,
requests or conflicts where the browser permits it. This includes account
navigation; there is no SPA link bypass. Browser process termination cannot be
reliably prevented, so offline/error screens offer a local download. Preview and
public links open separately without unloading the editor.

## Private previews

The existing authenticated `/preview` is linked as **saved** private preview;
it reads the saved backend draft and never publishes. The inline preview uses
the actual `ProfileView` with the last valid local document and a map derived
only from ready owned assets. Every URL in that private media map is the
same-origin authenticated `/api/media/[id]/content` path.

`LivePreview` portals the renderer into an empty same-origin `srcdoc` iframe,
copying the application's existing styles. The renderer loads the supported
third-party frames only when the editor user chooses to load an embed. Its real viewport
is 375 px or 960 px, so the renderer's responsive media queries work accurately
instead of responding to the whole editor window. Its scroll region and title
are accessible. A stylesheet observer is disconnected on unmount. Renderer links
target new tabs; the existing music player requires user-initiated playback and
retains native controls, volume and rights/attribution.

## Media contract and processing

Media listing consumes the inspected `listOwnedMedia` projection: assets have
`id,kind,state,contentType,bytes,width,height,durationMs,createdAt`; usage is
`chargedBytes,privateBytes,publicReservedBytes`; quota is
`limitBytes,uploadsPaused,globalCapacityAvailable`. There is no invented filename,
download URL, rejection reason or client-controlled storage key. Short IDs,
dimensions and duration identify assets. Only ready matching-kind assets can be
new selections; an unavailable existing selection is labelled and can be cleared.
UUID case is normalized when matching existing references.

Upload sends the raw File body to `POST /api/media?kind=image|audio`, never
multipart or an owner ID. The UI states static JPEG/PNG/WebP, 5 MiB / 16 MP,
and MP3, 10 MiB / 180 seconds. Client byte checks are convenience only; backend
validation remains authoritative. A 202 upload means accepted for processing,
not ready. The quota UI uses actual server charges and explains retained assets,
derivatives and upload reservations (24 MiB/image, 50 MiB/MP3).

Processing refresh runs immediately plus at most 20 additional checks spaced
three seconds apart; each list request has a 15-second abort timeout. Polling
stops on errors or exhausted checks, and Refresh media restarts it deliberately.
Timers/requests/uploads are cancelled on unmount and superseded reads are ignored.
Paused uploads, capacity, provider/quota/request errors and rejected states are
visible. The UI never claims processing completed without the ready state.

Deletion confirms first, refuses currently selected local references, and uses
only `DELETE /api/media/[id]`. Backend `MEDIA_RETAINED` explains saved draft and
retained-publication protection without removing any reference. Accepted deletion
explains asynchronous storage cleanup. Rejected rows show automatic cleanup and
remain read-only: the current worker can retain rejected metadata after removing
its storage ledger, after which DELETE cannot remove that status row. No broken
Delete control is offered for this state.

## Integration and acceptance

Host/proxy/navigation, private response policies, exact-origin mutations,
renderer/media CSP, same-origin preview frames and worker dispatch are integrated.
The public URL uses the validated SITE_DOMAIN. The editor stops waiting and offers
refresh if processing is unavailable.

Every mutation sends `x-editor-profile` from the original editor state. The backend
compares that identity inside its owner/profile transaction before any write;
ownership still comes from the session. This prevents a silent account switch
from saving one account's input into another even when edit versions match.

Real browser acceptance covers claim-to-edit, presets/layouts, CSP/preview/audio,
autosave conflicts, retained revisions, uploads, keyboard/reduced motion and
two-owner isolation. See [browser-acceptance.md](browser-acceptance.md) for exact
coverage and limits. Independent review status is in [non-launch-review.md](non-launch-review.md).

## Validation

- `npx vitest run tests/editor`: 34 tests cover stable ordering, appearance/content
  preservation, invalid drafts, in-flight edits, serialized versions, conflict
  retention/explicit resolution, comparison freshness, publication flush/failure,
  restore/unpublish serialization, stale responses, session expiry/account
  mismatch, HTTP error redaction, strict response parsing and exact API bodies.
- `npx eslint src/app/editor src/components/editor src/domain/editor.ts tests/editor --max-warnings=0`.
- `npm run typecheck -- --incremental false` (repository-wide, no build output).

Editor tests and lint pass. Repository typechecking and production builds pass;
the temporary operations-test typing error from the implementation handoff is
resolved. Browser findings fixed canonical document equality, client validation
CSP initialization, WebKit connectivity hints and HTML pattern escaping.
