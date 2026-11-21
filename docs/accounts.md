# Accounts and ownership

Implemented against installed Better Auth **1.7.19**. Password hashing, credential
verification, email-verification signatures, reset tokens, session cookies, TOTP
secrets/challenges and encrypted single-use backup codes belong to Better Auth.
There are no OAuth providers, account linking, anonymous accounts, email OTP,
passwordless signup, cross-domain cookies, or public administrator promotion.

## HTTP and import contract

`src/server/auth/session.ts` exports exactly the shared `SessionPrincipal`,
`getSession(Headers)`, `requireUser(Request | Headers, { recent?,
allowUnverified? }?)`, and `requireAdmin(Request | Headers)` interfaces in
`non-launch-work.md`. `getSession` returns null for a missing/revoked/expired
session or suspended/deleted account. `requireUser` requires verified email by
default, checks the app host, and checks exact Origin for unsafe Request methods.
Session reads also enforce a supplied Origin and a shared persistent 1,000/minute read budget. Server pages should catch only a 401 to redirect to `/sign-in`. `recent` means
password sign-in or recorded password confirmation within ten minutes; normal
session refresh does not renew it. A completed factor challenge is recorded
against the actual live session. `requireAdmin` requires role admin, active
verified account, recent password authentication, enabled and verified library
TOTP enrollment, and recorded successful second-factor verification within ten
minutes. An enrollment flag or admin role alone never grants access.

All three session entry points discard unexpected library/database exceptions
and throw a fresh `AppError(503, "AUTH_UNAVAILABLE", ...)` without the original
cause, SQL, parameters, headers or custom properties. This includes configuration,
persistent read-budget failures, the library lookup, the authoritative session
query and the administrator proof query. Expected application errors retain their
status/code/message in a fresh error. An outage never becomes a null session or
a sign-in redirect. The boundary emits no diagnostic log. Framework logging may
print the safe error and its local stack; SQL-driver diagnostics must not be
reattached or logged elsewhere. Tests inspect hidden properties, nested causes,
JSON and stack rendering using an injected token-bearing library/driver error.

`src/server/http.ts` exports `AppError(status, code, message)`,
`assertAppHost(Headers)`, `assertMutationOrigin(Request)`,
`readJson<T>(Request, z.ZodType<T>, maxBytes = 16384)`, `apiJson(data, status = 200)`
and `apiError(error)`. Extra exports: `appOrigin()` and `assertLocalRedirect()`.
Failures are `{ error: { code, message } }` with no-store and redacted unexpected
exceptions. JSON is counted as streamed bytes before parsing, including when
Content-Length is absent or incorrect. Redirects must resolve to the exact app
origin; protocol-relative, backslash and control-character forms are rejected.

`src/server/rate-limit.ts` exports `rateLimit(key, limit, windowSeconds)` and
`authRequestLimit(path, email?)`. Counters use atomic PostgreSQL upserts and HMAC
SHA-256 keys, expire within at most one day, clamp counts, bound key input, and
remove up to 100 expired records on every call. Auth uses a shared 120/minute
per-route budget plus 8/15 minutes per submitted normalized email. Unknown proxy
identity always shares the conservative budget. No forwarded IP is trusted or
stored; Better Auth IP tracking is disabled. Other public handlers should apply
a shared budget before accepting arbitrary identifier-specific keys. These
records are abuse controls, never analytics visitor identifiers.

`src/server/accounts.ts` exports:

- `claimUsername(input: Request | Headers, username: string)` returns
  `{ username, profileId }`. It requires a verified live owner, locks that owner,
  inserts the unique immutable claim, unpublished profile and default v1 draft in
  one transaction. Database tombstone and reserved-name guards remain intact.
- `listAccountSessions(input)` returns only `{ id, createdAt, expiresAt, current }[]`.
- `revokeAccountSessions(input, sessionId?)` requires recent authentication and
  deletes only sessions belonging to the current owner. Omitting the ID revokes
  all of that owner's sessions. Session tokens are never returned by this API.

## Account creation transaction

`src/server/auth/handler.ts` exports `handleAuth(Request)` and
`reauthenticate(Request)`. Only the guarded handler is wired into Next.
`createAccountAuth` in `auth/config.ts` is server-only infrastructure, not an API
route. Never expose its handler or mutation methods directly.

Signup proceeds as follows:

1. Check Host, exact mutation Origin, local redirects, bounded JSON and persistent
   rate limits. Require name, normalized email and a 12–128 character password.
   The server assigns the account role and verification state.
2. Start a PostgreSQL transaction. Insert the singleton service settings if
   absent and lock `id=true FOR UPDATE`. Closed mode denies registration. Count
   existing accounts under the lock and enforce `min(accountLimit, 50)`.
3. If an invitation is supplied, or invitation mode requires one, lock the
   invitation matched by token hash and normalized email. It must be unexpired,
   nonrevoked and unredeemed.
4. Instantiate Better Auth with a Drizzle adapter bound to that exact transaction
   and `transaction:false`. This prevents a separate library commit: the adapter
   still executes all its writes through the outer transaction. Its user-create
   hook rejects every creation without the single-use in-memory admission scoped
   to this handler, including direct library calls and future provider paths.
5. Await the complete library handler. Require a successful result, an actually
   executed creation hook and an actual newly inserted credential owner. Existing
   account synthetic responses cannot consume an invitation. Verification mail
   is awaited and inserted into jobs through the same transaction.
6. Conditionally redeem the invitation against the inserted user. The existing
   database trigger independently checks recipient, expiry, revocation and
   immutability. Apply a private bootstrap designation if present. Commit before
   returning anything to the client.

Any handler failure, mail insert failure, redemption conflict/expiry/trigger
failure or commit failure rolls back the user, credential, mail job and invite.
No correctness decision depends on Better Auth's queued database after-hooks.
`autoSignIn:false`, required verification and a session-create hook rejecting
unverified/suspended/deleted owners prevent a signup session from escaping.
Tests force a failure at the final invite UPDATE and assert no user, session or
mail job remains. Racing redemptions and the 50th account slot are real database
tests. Never replace this transaction with an eligibility pre-check followed by
an ordinary independent auth handler call.

## Credential and factor transactions

`createAccountAuth()` uses the shared runtime pool with adapter transactions
enabled. The session-create hook resolves `getCurrentAdapter` from the endpoint
context, joining credential rotation's active transaction. Its owner predicate
requires current stored email verification and null suspension/deletion flags;
the latter fields are explicitly registered as non-input, non-returned library
fields. It never requests a second pool connection. Password-change and reset
rollback remain enabled. Tests mutate each owner flag inside the credential
transaction and require the entire operation to roll back.

`createAccountAuthInTransaction(tx, admission?)` is internal infrastructure for
signup and factor requests. The caller must provide an already-open Drizzle
transaction and withhold all responses until its commit succeeds. Only this
factory disables the adapter's independent transaction; every query still uses
the supplied connection. `admission` remains exclusive to invitation signup.
Do not call either factory's handler directly from a new route.

After the facade validates Host, Origin, duplicate cookies, optional rendered
account identity, bounded input and persistent route budgets, every allowed
`/two-factor/*` request uses `handleFactorRequest(path, request)` inside an outer
transaction. This covers enable/re-enrollment, disable, TOTP and backup-code
verification, backup-code replacement, and TOTP URI retrieval. Binding an entire
auth instance to that connection also covers direct plugin adapter writes, which
do not use Better Auth's transaction context automatically. Session refreshes,
factor flags, secret/code changes, challenge consumption, session insertion and
revocation, and successful proof assurance commit together. Final verification,
session insertion, assurance insertion or commit failure releases no replacement
cookie and rolls everything back.

Successful proof parses the returned user ID and resolves its recipient through
the library session lookup using request cookies merged with response cookies,
on the same transaction. It then requires a live session belonging to that same
verified active user with an enabled, verified factor before writing
`session_assurance.secondFactorAt`. Initial TOTP confirmation returns an old
token while rotating its cookie; comparing tokens would reject valid enrollment.

Only explicit expected verification rejections commit their abuse accounting:
`INVALID_CODE`, `INVALID_BACKUP_CODE`,
`TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE` and `ACCOUNT_TEMPORARILY_LOCKED`, on a 4xx
proof response. `INVALID_TWO_FACTOR_COOKIE` rolls back because it can follow a
correct proof whose final challenge consumption failed. All other unsuccessful
factor responses or exceptions roll back. This preserves challenge budgets,
account failure increments, challenge invalidation and lockouts; a failed
success/assurance write cannot reset a previous failed-attempt count. Persistent
facade budgets run before the transaction and survive either outcome. The
library's own challenge locks and single-use recovery-code compare-and-swap are
preserved. No library source or schema change is required.

## Routes and UI

All account URLs belong only to `https://app.${SITE_DOMAIN}`. TLS can terminate at
the local reverse proxy: after validating Host/Origin, the handler canonicalizes
Next's internal request URL to the fixed auth origin. Forwarded host, protocol
and address headers are removed before invoking Better Auth.

- Pages: `/sign-in`, `/sign-up`, `/verify-email`, `/forgot-password`,
  `/reset-password`, `/two-factor`, `/account/security`.
- POST `/api/account/username`: `{ username }` → `{ username, profileId }` (201).
- GET `/api/account/session`: `{ sessions }` without bearer tokens or IPs.
- DELETE `/api/account/session`: `{ sessionId? }`, recent authentication required.
- POST `/api/account/reauthenticate`: `{ password }`; verifies through the
  library's server-only password endpoint, with explicit Host, Origin, bounded
  strict schema and persistent rate checks. This renews password assurance only,
  never second-factor assurance. No callback fields are accepted.
- POST `/api/auth/sign-up/email`: `{ name, email, password, inviteToken?,
  callbackURL? }`. Public mode accepts signup without an invitation. Invitation
  mode requires `inviteToken`. Acceptance returns 202.
- POST auth endpoints allowed: `/sign-in/email`, `/sign-out`,
  `/send-verification-email`, `/request-password-reset`, `/reset-password`,
  `/change-password`, `/two-factor/enable`, `/two-factor/disable`,
  `/two-factor/verify-totp`, `/two-factor/verify-backup-code`,
  `/two-factor/generate-backup-codes`, `/two-factor/get-totp-uri`.
- GET auth endpoints allowed: `/get-session`, `/verify-email`,
  `/reset-password/:token`. Email token callbacks may be navigated without Origin;
  a supplied foreign Origin is always rejected. All callbacks still pass through
  Better Auth's handler. Other auth routes and methods are disabled.

The account-security page supports manual authenticator setup (private Base32
key, six digits, SHA-1, 30 seconds), confirmation, code replacement, password
change, username claim and individual/all-session revocation. The sign-in
challenge supports single-use recovery codes. There is no external QR service.
Authenticator management and password changes require recent authentication;
administrators cannot disable their second factor. Remembered-device bypasses
and backup-code verification without creating a session are rejected. Private
session bearer tokens are removed from library JSON responses. The library still
owns secure cookie issuance and challenge rotation.

Every library cookie, including temporary two-factor cookies, uses a `__Host-mbg`
prefix, Secure, HttpOnly, Path=/ and SameSite=Lax with no Domain. Better Auth's
`useSecureCookies:false` only suppresses its automatic `__Secure-` name prefix;
`defaultCookieAttributes.secure:true` enforces Secure while supplying the stricter
`__Host-` names. Cookie caching is disabled, so revocation always consults storage.
Trusted origins contain only the one exact app origin. There is no insecure
production/development cookie fallback.

## Invitations and operator bootstrap

`src/server/invites.ts` exports `normalizeEmail`, `hashInviteToken`,
`issueInvite({ email, createdBy?, expiresInHours?, sendEmail?, bootstrap? })`,
`listInvites(limit = 100)`, `revokeInvite(id)`, and the internal transaction helpers
`lockSignupAdmission(tx, email, inviteToken?)` and
`consumeInvite(tx, inviteId, userId)`.
Administrative callers **must first call requireAdmin**; these are server-only
services, not independently exposed routes. Do not spread an unvalidated public
request into service options. `bootstrap` is reserved for the operator CLI.

Tokens have 256 bits of randomness, base64url encoding and SHA-256 storage. The
bound email is trimmed/lowercased. Expiry defaults to 72 hours, configurable
between 1 and 168 hours. Issue returns `{ id, email, expiresAt, token }` once;
list omits all tokens and hashes. Revocation cannot reset a used invitation.
`sendEmail:true` puts the invite link into the durable private outbox, using a
URL fragment so its secret is not sent with the signup page request. The signup
form imports the fragment and clears it from browser history.

Use the private CLI with explicit DATABASE_URL, SITE_DOMAIN and BETTER_AUTH_SECRET
loaded from a protected environment. No default password or public promotion
route exists. Example commands (do not use against a live service without the
operator's authorization):

```sh
ACCOUNT_BOOTSTRAP_ENABLED=true NODE_OPTIONS=--conditions=react-server \
  npx tsx --env-file-if-exists=.env scripts/bootstrap-admin.ts \
  --designate --email existing-verified@example.invalid

ACCOUNT_BOOTSTRAP_ENABLED=true NODE_OPTIONS=--conditions=react-server \
  npx tsx --env-file-if-exists=.env scripts/bootstrap-admin.ts \
  --invite --email configured-bootstrap@example.invalid
```

Designation requires an active verified existing user, revokes their sessions and
records an audit event in the same transaction. Invite mode queues a bootstrap
invitation without printing the token; retrieve it only through the private local
transport for acceptance. Redemption designates that bound account, but the
account must verify its email and complete TOTP setup/challenge before admin
access. Disable ACCOUNT_BOOTSTRAP_ENABLED after use. The CLI is an operator
process with direct database authority, never an HTTP-accessible action.

## Mail jobs and environment

`src/server/mail.ts` exports `mailPayloadSchema`, `MailPayload`,
`enqueueMail(payload, ownerId?, tx?)` and
`processEmailJob({ id: string, payload: unknown }): Promise<void>`.
`kind=email`, `payloadVersion=1`, payload:

```json
{ "template": "verification|recovery|invite", "to": "normalized@example.invalid", "url": "https://app.<SITE_DOMAIN>/..." }
```

Enqueue is idempotent on the SHA-256 of the canonical validated payload. Jobs
contain private bearer links; never log payloads or return them through user
exports/admin list projections. The worker owns claiming, bounded retries and
state transitions. After successful delivery, the central worker should scrub
private payloads on its retention schedule. Processor errors are redacted codes.

Required server environment: DATABASE_URL, BETTER_AUTH_SECRET (explicit, at least
32 characters), SITE_DOMAIN (`may-be.gay` or `may-be.localhost`). Local acceptance:
MAIL_TRANSPORT=local and MAIL_OUTBOX_DIR set to an absolute private directory
outside public/. Its mode must be 0700; files use 0600. Atomic writes + fsync and
idempotent job filenames avoid partial successful deliveries. There is no public
email-debug endpoint. Keep the directory outside version control and backups
that are readable by untrusted users. Clear obsolete private mail fixtures.

Live delivery is disabled unless **all** of MAIL_TRANSPORT=resend,
MAIL_ALLOW_LIVE=true, RESEND_API_KEY and MAIL_FROM are explicitly configured.
Delivery uses the fixed Resend endpoint, a 10-second timeout, no redirects and a
stable job-id idempotency header. This work sends no live email. An unconfigured
transport fails rather than claiming success. Provider retention limits still
apply to retries; the central worker must use bounded retry age/attempts.

## Integrated validation

`src/server/db/schema-accounts.ts` and schema-settings.ts are included in Drizzle
schema generation and the versioned migration chain. Account tables: session_assurance (session FK cascade),
auth_rate_limits (expiry index, bounded counter and hash constraints),
bootstrap_invites (private role-designation marker). **No custom SQL guard change
is needed.** Preserve the existing username/invitation triggers and deferred
constraints. No additional npm dependency is needed.

Routing allows the listed pages/account APIs on app host only and
supplies no-store/no-referrer policies to auth pages/framework responses. Caddy access logs are disabled and operational request fields are redacted, including auth URL queries and `/api/auth/reset-password/:token` paths. The central
worker dispatches email jobs to processEmailJob and owns leases/retries and retention.
Profile/editor, export/deletion, administrator console and media integration
consume the shared session contracts; they are owned by the other workstreams.

Remediation validation on 2026-11-10: **52 account tests pass** across four files,
including **39 real PostgreSQL tests** against only the separate disposable
`accounts_test` database on port 55436 with the full eight-migration chain. Tests
cover invitations, recovery, private bootstrap CLI, stale account identity,
duplicate-cookie assurance confusion, administrator factor-management step-up,
credential rollback and library error redaction, plus these failure paths:

- Five verified fixture users reach a temporary credential-update advisory-lock
  barrier while holding all five runtime pool connections. After release, all
  five password/session rotations and an unrelated query finish within eight
  seconds; new credentials and cookies work and old cookies fail. The barrier
  waits for five actual PostgreSQL lock waiters. Cleanup removes its trigger and
  function, unlocks/releases the owned control connection, and, on regression,
  terminates only captured fixture backends and closes the owned app pool.
- Session insert failure during disable, final enrollment `verified` write
  failure, assurance insert failure, and deferred commit failure restore every
  original user/factor/session/assurance/challenge row and emit no cookies.
- TOTP and backup-code challenges preserve their code/challenge and prior failure
  count when assurance or final challenge consumption fails. A successful retry
  works and clears failed-attempt accounting. Five wrong attempts exhaust a
  challenge; ten across challenges lock the account, for both factor methods.
- Simultaneous duplicate TOTP/backup proofs create one successful session, and
  one backup code succeeds only once across distinct simultaneous challenges.
- Injected configuration, library, rate-limit, authoritative-session-query and
  administrator-query failures cannot expose token-bearing nested SQL errors
  through a server session error's JSON, inspected hidden fields or stack.

Controlled temporary reversal of the fixes reproduced eight expected failures:
the five-connection deadline, partial factor disable, partial initial enrollment,
and all five SSR error propagation paths. Fixed source was restored in `finally`
before the final passing suite. Temporary failure triggers/functions are removed
in `finally`; no migration, package or pool-size change was needed.

The parent also ran `npm run test:http` against the built production Next server:
**42 requests passed**, including a real sign-in and SSR failure injection. The
fixture temporarily revokes the runtime role's session SELECT privilege while
the maintenance gate remains operational. `/account/security` reaches Next's
production error logger, which contains `AUTH_UNAVAILABLE` without the actual
dummy bearer token, cookie, SQL or driver cause. A finally block restores the
grant and the same session can open the page again. This check now runs in CI.

Commands and results (the URL below is the authorized isolated test database):

```sh
ACCOUNTS_TEST_DATABASE_URL=postgres://may_be_migrator:local-only-migrator@127.0.0.1:55436/accounts_test npx vitest run tests/accounts
# 4 files, 52 tests passed (23.92s)
npx eslint src/server/auth/config.ts src/server/auth/handler.ts src/server/auth/session.ts src/server/auth/factors.ts tests/accounts --max-warnings=0
# passed
npx tsc --noEmit --incremental false
# passed; no build or .next writes
```

A configured URL that cannot connect fails the suite; no URL skips the PostgreSQL
suite explicitly. Do not share its destructive test URL with concurrent suites.
The test runner requires local network permission; the first sandboxed attempt
failed with EPERM, and authorized escalation ran the actual PostgreSQL suite.

Handoff: public session/facade interfaces and rendered-account identity guards
remain unchanged. Root owns whole-application checks, production stderr
acceptance, browser/build/Docker/CI/migrations, operations and the Astra auth
recheck. This remediation ran no builds, browsers, services, deployments or
external providers and changed no UI. Prior browser results are recorded in
[the current review record](non-launch-review.md); they were not rerun here.

Official references checked alongside installed source:
[security](https://better-auth.com/docs/reference/security),
[Drizzle adapter](https://better-auth.com/docs/adapters/drizzle),
[two-factor authentication](https://better-auth.com/docs/plugins/2fa).
Installed sources under api/routes/sign-up, db/with-hooks, core/context/transaction,
plugins/two-factor and cookies are the version-specific implementation authority.
