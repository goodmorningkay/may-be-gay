# Non-launch implementation and review

10 November 2026. Work is based on `d87c410`. GPT-6.1 Sol agents with xhigh
reasoning implemented accounts, profiles, media, the editor, operations,
workers/recovery and browser acceptance. The primary agent integrated the
migrations, routing, runtime images, maintenance gate and CI, reviewed the code,
and reproduced and fixed integration defects. Independent GPT-6 Astra max
reviewers covered accounts/tenant boundaries, media/recovery, product workflows,
and native process supervision. Both final verification passes are complete.
The auth pass found no further actionable issue. The integration pass identified
one journal EOF cancellation gap; the primary reproduced it, applied the proposed
check and verified the full recovery suite. All confirmed findings are addressed.
No launch, live delivery, provisioning, commit or push is part of this batch.

## Delivered development

Phases 1–5 have local implementations: invite-gated verified accounts and
administrator second factors; username onboarding; complete profile editing,
autosave, private preview, publishing and five retained revisions; bounded
image/MP3 uploads and quotas; reporting/moderation; aggregate analytics;
export/deletion; fenced durable workers; encrypted backup/restore and operational
checks. Eight versioned migrations create 29 application tables and the required
ownership, immutability, append-only journal and runtime-role guards.

The browser fixture uses production Next, real authentication, PostgreSQL,
private local mail/storage, native media parsing and Caddy HTTPS. External mail,
R2/CDN and public DNS/certificates are excluded from these results.

## Findings and fixes

| Finding | Resolution and evidence |
| --- | --- |
| A stale tab could act on a newly signed-in account. | Profile and media mutations retain the original `x-editor-profile`; account export/deletion retain `x-account-id` and compare under the owner lock. Security/session/onboarding actions also retain account identity. PostgreSQL and browser regressions verify B remains unchanged. |
| JSONB ordering caused repeated unchanged autosaves; Zod probed dynamic code under CSP; WebKit's initial offline hint blocked saves. | Canonical document comparison, shared jitless validation and actual request/connectivity handling. Core journeys pass across all three engines. |
| Duplicate cookie parsers disagreed about which session received factor assurance. | Reject duplicate auth cookies and bind successful proof to the library-returned user and live session. Real TOTP and recovery-code regressions cover both identities. |
| An enrolled administrator could generate replacement factor credentials using only password assurance. | Enrolled factor-secret/code management requires fresh administrator factor assurance. Initial enrollment remains supported. |
| Credential rollback was disabled, and the repaired session hook then exhausted its own pool. | Ordinary credential operations use adapter transactions; the owner hook joins the active adapter. Five synchronized credential rotations and an unrelated query finish on the five-connection pool. Injected failures roll back tokens, passwords and sessions. |
| Factor changes could commit partially when session rotation, final verification or assurance failed. | All factor operations use an outer transaction; cookies wait for commit. Expected verification failures retain abuse accounting. Real PostgreSQL tests cover commit failures, concurrent proofs and recovery-code consumption. |
| Auth HTTP and SSR failures could expose SQL parameters/session tokens in logs. | Both boundaries discard raw causes. A production Next failure injection verifies its actual stderr contains only the safe auth error, then restores the runtime grant and confirms the session still works. |
| Current-session logout used a stale ID after rotation. | Use the auth sign-out endpoint and refresh session rows after rotation. Browser regressions pass for password changes and factor enable/disable. |
| Native credential forms could submit secrets in URLs; native export lacked a usable Origin. | Safe POST fallback explains JavaScript requirements without reading or reflecting credentials. Export uses authenticated fetch and downloads only a completed archive; it requires JavaScript and buffers that archive. |
| Reporting lacked usable public target choices, and uppercase UUIDs were omitted. | Native accessible selectors use the current public projection, normalize UUIDs and exclude hidden/draft assets. PostgreSQL and real native-form browser checks cover stored reports. |
| Publication numbering could repeat after retention removed history. | A durable locked counter, migration backfill and database guard keep numbers increasing independently of the five retained revisions. |
| Next's proxy buffered upload bodies before admission. | Exact raw-upload routing bypasses the clone and repeats host, method, maintenance, Origin and security-header controls. Real HTTP and HTTPS checks observe reservation/spooling before EOF and reject an actual 11 MiB request. |
| Caddy delayed anonymous HTTP/1 rejection until EOF. | Enable full-duplex handling. The verified-CA HTTPS check and a permanent browser-fixture raw HTTP/1 regression require an immediate 401. |
| Deletion could lose the locator while an upload PUT was still in flight. | Revalidate and hold owner/ledger locks through bounded object writes and finalization. Deferred-storage PostgreSQL races cover both media and account deletion. |
| Crashed writes left uncharged temporary files; rejected history hid usable assets. | Clean locator-specific partials under mutation locks before releasing charges; bound feedback separately. The shared client limit accepts all 1,000 usable assets plus 20 feedback rows. |
| Valid media inventory exceeded backup bounds; periodic sweeps multiplied queue entries. | Serialized admission reserves global private-object slots; backup uses the same bound. Stable per-asset checks coalesce while explicit removal/reconciliation retains priority and fencing. Three sweeps of 2,000 assets leave exactly 2,000 checks. |
| Retention stopped above a listing cap and could block subsequent archive destinations. | Bounded asynchronous pages and durable traversal checkpoints; destinations commit independently before cleanup. Mocks exercise 251,007 S3 and 260,000 local entries. |
| Native descendants outlived cancellation; development app and worker used different UIDs. | A compiled guardian owns deadlines, process groups and descendant reaping; Tini and a shared parser lock are packaged in invoking images. Both development services run as uid 1000. Real-process and real development Compose lifecycle checks pass. |
| Restore had a crash-gate gap and could keep publishing or start a final journal batch after cancellation. | Require the exact shared filesystem marker; check cancellation between copy/replay/publication steps, after journal EOF and before success. Real PostgreSQL fault injection keeps the service closed and creates no successful report. The EOF regression fails on the old code and verifies no tail replay or watermark advancement after the fix. |
| Journal health used upload completion instead of capture time; future jobs caused false alerts; once mode could schedule backups. | Health uses manifest capture time and only due backlog; urgent cleanup wins both claim modes; once mode has no archive timer. Regression tests cover each condition. |

## Verification

- **515 tests pass in 35 files** in the integrated application/worker run, using
  six separate disposable PostgreSQL databases. This includes the final 52
  account tests and 39 account database scenarios.
- **30 recovery tests pass in five files** against the complete migration chain,
  including SELECT-only backup and non-superuser restore. Some pure tests also
  appear in the 515-test run; these counts are not additive. The encrypted tiny
  eight-object fixture restored in **32.748 seconds**. This is executable local
  recovery evidence, not a hosted capacity or recovery-time measurement.
- Production direct HTTP: **42 checks pass**, including actual SSR stderr
  redaction after a session SELECT failure. Standalone container through Caddy:
  **38 HTTPS checks pass** with its local CA verified. Both cover HTML/RSC tenant
  isolation, CSP, no-store, unpublish, suspension and the restore gate.
- Streaming uploads pass over direct HTTP and verified-CA HTTPS: pre-EOF
  authenticated reservation/spooling, pre-EOF anonymous rejection and actual
  11 MiB rejection. The real worker leaves **zero files, locators and charges**.
- **14/14 browser and ingress scenarios pass**, without retries or skips, across
  Chromium, Firefox, WebKit, mobile and the expanded lifecycle project. The final
  browser phase took 264.054 seconds after the proxy/report-label corrections.
- Repository TypeScript and lint pass. App, worker and migrator images build;
  the production container starts healthy. A standalone worker-image fixture
  parses an image as uid 1000 without network/source mounts and has PostgreSQL
  17.11 tools. The separate development Compose upload/parse/delete check passes.
- `git diff --check` passes. The locked dependency audit reported zero advisories
  during this implementation; dependency pins have not changed since that check.
- All task-owned browser, development, recovery and integration containers,
  disposable databases, volumes and networks are removed. No acceptance server
  remains running. Build/test artifacts remain local and ignored by version control.

The acceptance harnesses use dummy identities, private disposable storage and
local transports. Browser contexts trust the fixture through an explicit test
exception; the separate Node HTTPS checks verify its actual CA chain. No OS
trust store is changed. See [browser acceptance](browser-acceptance.md),
[accounts](accounts.md), [media](media.md), [workers](worker.md) and
[recovery](recovery.md) for commands and limits.

## Review completion and remaining launch work

The final independent passes inspected the dirty tree, installed dependency
behavior, callers, runtime contracts and regression code. They were source
reviews and did not independently rerun the primary's acceptance tests. The
primary reproduced the last journal-tail finding against encrypted archives and
real PostgreSQL: the old code replayed an event after cancellation at EOF. The
one-line guard prevents that replay; the complete 30-test recovery rerun passes.
No confirmed review finding remains unresolved. No further implementation work
from phases 1–5 is outstanding; the development and review scope is complete.

Launch remains excluded: operator/audience/policy decisions and monitored support,
server purchase/region, production credentials, public DNS/TLS, real mail/R2/CDN
acceptance, external monitoring, and measured target-server performance/recovery.
Public registration remains disabled. Large account archives require a completed
browser Blob; maximum-size browser memory behavior is not measured by these
small fixtures. Native parser serialization assumes the documented single host
and shared lock inode; separate hosts need reliable shared locking. Direct
public-bucket copies have the documented distributed-transaction boundary; a
gated origin is required for absolute denial before SQL commit. These limits and
hosted removal/capacity checks must remain visible in launch planning.
