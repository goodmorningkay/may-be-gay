# Local browser acceptance

Status: final local browser acceptance passed, 10 November 2026. The fresh
`npm run test:e2e` completed with **14 passed, 0 failed, 0 skipped, 0 retries** in
**4.4 minutes for the browser phase** (264.054 seconds; build/stack setup is
additional). All five projects ran; no engine was omitted. Primary and independent
Astra review status is tracked in [non-launch-review.md](non-launch-review.md).

From a Linux x86-64 checkout with Node 22.19.0, npm 10.9.3 and Docker Engine with
Compose supporting `up --wait` (verified Docker 29.7.1 / Compose 5.4.0):

```sh
npm ci
npm run test:e2e
```

This is also the exact CI invocation. The runner builds production Next output,
copies static assets and the parser into the standalone tree, builds the browser
runtime, creates a randomly named `may-be-e2e-<hex>` Compose project, applies all
current Drizzle migrations, starts the standalone server and runs Playwright.
Its finally block removes that project's containers, internal network and volumes
on success or failure. Do not build Next concurrently. No existing parent
project, database, port, volume or container is reused. No host ports are published.
The database is always `browser_acceptance_test`, with separate migration and
application roles created by the real bootstrap. The fixture CLI also checks its
marker, exact database/host, local domain and local-only transports before access.

The official `@playwright/test` dependency is precisely pinned to 1.65.0, with its
matching official Noble browser image pinned by digest. Authority:
[npm package metadata](https://registry.npmjs.org/@playwright/test/1.65.0),
[Playwright Docker documentation](https://playwright.dev/docs/docker).
The image supplies all three browser engines/native libraries; the test image
adds FFmpeg/util-linux/PulseAudio, the compiled native guardian and Tini, and
copies the official pinned Node 22.19.0 binary. A private parser-lock volume and
maintenance-marker volume are shared by the app and fixture runner. The
host only needs build dependencies from `npm ci`; it needs no browser or system
browser libraries. Initial image downloads/builds require network access. Test
containers then use an internal Docker network without internet routing; browser
request guards additionally fail unexpected origins. WebKit's browser-local
`blob:https://<fixture-host>/…` media URLs are allowed only for fixture origins.
The browser container runs a real silent PulseAudio sink over a private Unix
socket, with no host audio device or TCP listener. This supplies Firefox's audio
output clock; native MP3 decode/playback/seeking are still real. No live mail, provider
credentials, external asset downloads, DNS changes or deployment are used.

Canonical apex, app, profile and media HTTPS origins use port 443 inside the
fixture. Browsers share Caddy's network namespace because `.localhost` resolves
to loopback. Container-only host aliases support Node API requests; no host
`/etc/hosts` edit is made. The actual root Caddyfile issues internal-CA certificates.
Every browser context explicitly uses `ignoreHTTPSErrors: true`. This verifies
HTTPS behavior and Secure cookie semantics, **not OS certificate trust**. The
parent's separate HTTP smoke owns real TLS trust verification.

Mail/media live in private disposable volumes outside public source, with 0700
directories and actual mail files written by the local transport with 0600 modes.
Only the server-side CLI reads this fixture's private outbox. Invites are created
through `issueInvite`, with one-hour expiry and bound `@example.invalid` emails;
signup, verification navigation, sign-in and username claims use the real UI.
There is no SQL session creation, auth bypass or mail-debug HTTP endpoint.

The deterministic drainer uses the final central worker's `Queue.claim`,
`executeClaim` and actual central `dispatch`/feature processors against persisted
jobs, with dispatch in process to avoid one Node startup per job. Native media
validation still uses its real bounded parser subprocess. It processes only
currently eligible jobs; it neither invents a
production dispatcher nor advances expiry clocks. This is **not** acceptance of
the scheduler, fairness, process supervision, lease crash recovery, maintenance or backup/restore.
Those belong to the independent worker/recovery suite. The harness always
applies every current migration before starting the app.

Project matrix (one worker, no retries or skipped tests):

| Project | Engine | Scope |
| --- | --- | --- |
| chromium | Chromium | Complete two-owner core journey, real media and privacy boundaries |
| firefox | Firefox | Same complete core journey |
| webkit | WebKit | Same complete core journey |
| mobile | Chromium, 375 × 812, touch | Same core journey, narrow layout and reduced motion |
| lifecycle | Chromium | Autosave/history/admin/export/deletion; session-rotation logout; stale editor/media/account controls; native forms and reports; raw HTTP/1 ingress |

All contexts record console errors, uncaught page errors and CSP violations.
Expected console resource failures are limited to exact app profile endpoints
and statuses deliberately induced by onboarding/conflict/expiry/network tests.
CSP violations and uncaught exceptions are never allowed. All successful API
responses are real. Request interception is used only to enforce local origins,
delay a real in-flight save, or deliberately abort a failure-path request. There
are no mocked successful API responses. Waits use UI state, requests/responses,
media readiness/time, or bounded DB observations; there are no arbitrary sleeps.

Core checks include host-only Secure/HttpOnly/SameSite cookies, two-owner media
and draft isolation, unpublished/unknown real 404s, sibling-host app/API denial,
framework-prefetch privacy, exact-Origin mutation rejection, ordinary-user admin
denial, explicit public contact, keyboard create/reorder/focus with stable link
IDs, link visibility/edit/delete, all presets and controlled appearance, 375/960
pixel actual private iframes and rendered images, saved-preview analytics absence,
publish flushing pending input, public image/MP3 rendering, preload none/native
controls/no autoplay, user-initiated playback/seeking/HTTP byte ranges, real
aggregate views/clicks, no-JavaScript native public links, and no private browser
storage. The heavier Chromium case exercises genuine invalid/oversize upload
rejection, retained-asset delete refusal, five retained revisions and restoration,
private reports resolved by a real TOTP administrator, actual tar media bytes,
secret exclusions, deletion revocation and real asynchronous cleanup.

Artifacts remain in ignored `playwright-report/` and `test-results/`; traces,
screenshots, downloads and reports may contain private dummy fixture data and
bearer verification URLs. Keep them private and expire CI artifacts deliberately.
No artifact/outbox is committed. Filter a reproduction using, for example:

```sh
npm run test:e2e -- --project=chromium
npm run test:e2e -- --project=lifecycle -g 'retained editor'
```

`npm run test:e2e:runner` is only for an already prepared container in this
fixture's proxy namespace, with the Compose environment/volumes; it does not
start services. Prefer the self-contained command above on local/CI hosts.

Observed frontend findings and changes:

- Real second-link editing kept autosave in an unbounded PUT/version/job loop.
  `EditorCoordinator` compared JSON property order; JSONB/schema-normalized
  objects were semantically identical but serialized differently. Comparison
  now canonicalizes object keys while preserving array order. The real browser
  save, stable-ID order and in-flight-save scenarios are its regression checks.
- Zod attempted a caught dynamic-code probe under production CSP, producing
  `securitypolicyviolation: script-src eval`. Client editor/reporting entrypoints
  configure Zod's supported `jitless` mode through a shared bootstrap before
  schemas with parsed defaults are imported.
  Browser CSP collection is its regression check; CSP itself is unchanged.
- WebKit reported `navigator.onLine=false` in the internal network despite real
  successful HTTPS authentication/profile reads. Initializing from this heuristic
  disabled every save/publication action. The freshly loaded editor now starts
  reachable and listens for subsequent online/offline transitions; real request
  failures still preserve input and require retry. WebKit core plus the actual
  offline/reconnect lifecycle scenario are the regression checks.
- The report/security/admin HTML patterns used an unescaped hyphen rejected by
  modern HTML's Unicode-sets regular-expression mode. The patterns now escape
  that literal. Public report submission is the real-browser regression; console
  errors remain disallowed. The admin report queue selector now has the precise
  accessible name “Queue” so its label does not absorb all option text.

Final recorded matrix:

| Project/scenario | Actual engine version | Result | Duration |
| --- | --- | --- | --- |
| chromium core | Chromium 158.0.8127.18 | pass | 34.4 s |
| firefox core | Firefox 159.0 | pass | 37.5 s |
| webkit core | WebKit 27.2 | pass | 33.6 s |
| mobile core | Chromium 158.0.8127.18 | pass | 31.2 s |
| lifecycle/export/report/admin/deletion | Chromium 158.0.8127.18 | pass | 39.3 s |
| logout after password rotation | Chromium 158.0.8127.18 | pass | 6.2 s |
| logout after factor enrollment | Chromium 158.0.8127.18 | pass | 6.3 s |
| logout after factor removal | Chromium 158.0.8127.18 | pass | 6.8 s |
| stale editor after account switch | Chromium 158.0.8127.18 | pass | 12.5 s |
| stale media library after account switch | Chromium 158.0.8127.18 | pass | 16.3 s |
| anonymous upload before EOF | Node HTTP/1 over Caddy TLS | pass | 0.065 s |
| stale account/security/export/deletion controls | Chromium 158.0.8127.18 | pass | 12.6 s |
| native credential forms without JavaScript | Chromium 158.0.8127.18 | pass | 8.2 s |
| native public target reports without JavaScript | Chromium 158.0.8127.18 | pass | 13.1 s |

The final run used the current migrations through 0007 and the actual fail-closed
maintenance gate. There were no unexpected console errors, page errors, CSP
violations or external requests. Final runner exit: 0. Its randomly named
Compose project was removed with all volumes/network; a subsequent filtered
Docker inspection found no remaining acceptance containers, volumes or networks.
No browser/server/runner remains pending. `.next` ownership is released.

Additional implementation checks passed: production `npm run build` (also includes typechecking),
`npm run typecheck -- --incremental false`, `npx vitest run tests/editor`
(34 cases), scoped ESLint with zero warnings over all changed frontend/acceptance
files and editor tests, and `git diff --check`. Existing package versions,
overrides and scripts were preserved; only pinned Playwright and E2E scripts
were added by this assignment. No commits/pushes/PRs or subagents were created.

Earlier incomplete runs diagnosed fixture permissions/host aliases/headless
audio, then the UI findings above. After fixes, the lifecycle-only run passed
both cases in 55.0 seconds before the final complete matrix. The final 14-case matrix also incorporates the subsequent review regressions.
No browser/backend functional blocker remains from these scenarios. Provider/hosted acceptance and
the explicitly bounded coverage below remain outside this local result.

Final review acceptance also fixed the report target selector's accessible name
and Caddy's HTTP/1 request-body drain. `enable_full_duplex` lets the proxy forward
an authentication error before an anonymous client sends EOF. A raw Node HTTPS
request in the isolated fixture verifies this without completing its request body;
root separately verifies the CA chain and authenticated pre-EOF spool/reservation.
The native-form test reads visible noscript content directly because Playwright's
text matcher skips that element. Stale-upload assertions use the actual rendered
error plus independent API checks, avoiding Chromium's discarded DevTools copy of
a file-upload response. Neither change mocks a successful API response.

Confirmed backend finding, subsequently fixed by the parent (initial independent
Chromium reproduction: 24.5 seconds):
`a retained editor cannot overwrite a different account after session switching`
originally failed because B's actual saved bio became A's retained input. Reproduce with
the filtered command above. Steps: invite/verify/sign in/claim A, leave its editor
open at version 1; use another tab to sign out and invite/verify/sign in/claim B
at version 1; edit A's old tab. Its real PUT uses B's new session and the matching
numeric expectedVersion, committing A's document into B's profile. The client
detects the different response identity only after the write. The regression
compares B's actual document/version with its pre-write snapshot. The parent
added a required `x-editor-profile` precondition checked under the owner/profile
lock on save/publish/unpublish/restore. The frontend transport now passes the
coordinator's retained profile ID on every mutation; it never reads a new session
identity to generate that header. Missing/malformed headers fail 400; another
profile fails 409 `ACCOUNT_CHANGED`. The browser regression now passes, including
all publication actions, with no change to B. No backend change was made here.

The native account export form was also browser-proven to send `Origin: null`
under the private page's no-referrer policy, producing 403 `ORIGIN_REJECTED`.
The account UI now sends a same-origin POST fetch (explicit same-origin referrer
policy), downloads only a complete tar, and displays errors within the account
page. Exact-Origin server protection is unchanged. This private download now
requires JavaScript and buffers the server-bounded completed archive in browser
memory; large-archive browser memory acceptance is not established by these tiny
fixtures. `docs/operations.md` now records this download contract. The lifecycle case uses
the actual password-confirmation form, downloads and parses the tar, compares
exported image/audio bytes to authenticated owned content, and checks secrets
are absent before deliberate deletion.

External-provider mail/R2/CDN purge/propagation, target-server throughput/LCP,
production image non-root execution, OS TLS trust, backup/restore, independent
root/Astra review and launch/operator policy decisions are not established by
this suite. No provider or hosted acceptance is represented as completed.
