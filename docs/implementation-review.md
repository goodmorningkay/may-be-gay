# First implementation milestone and review

10 November 2026. Three GPT-6.1 Sol agents at xhigh reasoning implemented the
platform, persistence and renderer workstreams. The primary agent integrated
the application and personally reviewed the resulting code and configuration,
including its own integration changes. This review covers the new working-tree
implementation on top of `3207c7a`; no commit or external deployment was made.

## Delivered scope

This is the first foundation milestone from the implementation plan, with the
profile document and renderer brought forward to exercise it. It provides:

- Exact npm dependencies and lockfile, TypeScript/lint/test tooling, a standalone
  production container, local Compose/Caddy HTTPS, and CI checks.
- Separate migration/runtime database roles, 18 application tables, three
  versioned migrations, constraints and trigger guards, and a lazy bounded pool.
- Strict apex/app/profile hostname classification, reserved names, path gates
  in the application and proxy, no-store dynamic responses and a nonce-based CSP.
- Public-only profile reads with validated immutable snapshots, private/hidden
  field exclusion, and no visitor-session dependency. Unknown, unpublished,
  unverified, suspended and deleted profiles are unavailable.
- A responsive public renderer with six presets, two layouts, three system-font
  choices, native outbound anchors, metadata and explicit indexing preference.
- An apex introduction, fictional sample chooser, honest support-status page,
  and app-host beta entry placeholder. No account data is created by the sample.

Better Auth's installed schema contract is checked, but its HTTP handlers are
not exposed. Schema presence does not implement signup, authorization, editing,
publishing, media processing or administrative workflows.

## Review coverage and fixes

The source review covered routing and framework responses; database queries,
migrations, ownership constraints and deletion paths; renderer escaping and URL
validation; CSS contrast/focus/reduced-motion rules; dependencies; container
networking, roles, secrets and startup order; CI; and the test harnesses. Security
review used the security-audit skill's source-first guidance, within this personal
code review rather than a separately delegated security audit.

| Finding | Resolution and evidence |
| --- | --- |
| Account deletion could fail when media cascaded before its retained revision references. | Added `0002_deferred_cascade_guards.sql`: validate the retained-media and current-revision FKs at commit. The real PostgreSQL deletion test passes; separate deletion of a retained asset and cross-profile publication still fail. |
| A missing profile's RSC response could stream HTTP 200 even though HTML returned 404. | Resolve published availability in `src/proxy.ts` before rendering begins. Production HTTP checks cover unknown and unpublished names, normal HTML, RSC navigation and prefetch, and suspension. Database failure returns a generic no-store 503. |
| The local tooling override's published database port was ineffective on an internal-only Docker network. | Added a tooling network only to `compose.tools.yaml`. The standard stack still has no published DB/app port; the optional tooling port binds loopback. Verified with real Docker and PostgreSQL. |
| Public reads did not independently exclude unverified owners. | Added the email-verification predicate and a database regression test. Claim-time verification and account eligibility still belong to phase 2. |
| Link destination size was unbounded, and application/database reserved-name rules could drift. | Added a 2,048-character URL limit, reused the hostname validator in public reads, and tested every application-reserved name against PostgreSQL. |
| The locked dependency tree included vulnerable esbuild and minimatch versions. | Added narrow overrides for their affected parent packages, then verified clean installation, lint/build/tests and npm audit. See advisory details below. |
| Caddy initially forwarded authenticated route paths on sibling profile hosts. | Added an independent host/path rejection before proxying. Application routes also validate their own hostname. |
| With valid local TLS SNI but an unmatched/nested HTTP Host, Caddy returned an empty 200 without reaching application validation. | Added explicit HTTP and HTTPS catch-all 404 handlers. The full HTTPS smoke suite now rejects nested and unrelated hosts, and a separate HTTP check confirms 404 while the valid apex still redirects to HTTPS. |

The esbuild override addresses its development-server CORS advisory; this app
does not expose esbuild's development server. The minimatch advisory affects
pattern preprocessing in a transitive lint dependency. These were dependency
maintenance findings, not demonstrations of a remotely exploitable profile
endpoint. Patched versions and conditions are documented in the
[esbuild advisory](https://github.com/advisories/GHSA-67mh-4wv8-2f99) and
[minimatch advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249).

## Verification

Verification uses dummy accounts and local disposable PostgreSQL 17.11 data.
No live service, real user's account, public DNS or external mail/media account
was accessed. The code is checked through both application-level tests and
actual production-server responses, not just mocked route calls.

- Clean `npm ci`, repository-wide lint, TypeScript and `next build` passed.
- Drizzle generation reports no schema drift. Empty-database migrations,
  migration replay and runtime-role CRUD/DDL boundaries were exercised.
- All **233 tests pass**, including **35 real PostgreSQL integration checks**,
  with no skipped tests when both test database URLs are supplied. Coverage includes concurrent claims/saves, invitation
  constraints, deletion/tombstones, retained references, malformed snapshots,
  public-only reads, two-account separation and absence of hidden data.
- The production HTTP smoke script passes 27 checked requests covering hostname
  separation, HTML/RSC/prefetch, CSP script nonces, indexing/canonical metadata,
  missing-profile status codes, no-store and publication-state changes.
- `npm audit` reports zero advisories in the final dependency tree, including
  development dependencies, as checked on this date.
- Production-mode Docker images build, migrations exit successfully, and the
  Caddy/app/database stack reaches healthy startup. The same **27 checks also
  pass through Caddy HTTPS**, with its local CA verified. Separate checks confirm
  valid-host HTTP redirects (308), unknown-host HTTP rejection (404) and the
  editor host's certificate/response (200). Compose variants, Caddy parsing and
  database role probes pass. Disposable review containers, volumes and the
  exported public CA certificate are removed after verification; no system trust
  store is changed.

The sandbox blocked local IPC/sockets and Next's detached compiler output;
those checks were rerun with local execution access. They passed without
disabling typechecking or TLS validation. The app and migration containers run
as the non-root `node` user. Tests use separate runtime and migration credentials.

## Remaining work and limits

No unresolved functional defect is intentionally accepted in the delivered
foundation. This is a reviewed development milestone, not a launch approval or
an exhaustive security guarantee. The next implementation phase is invitations,
verified accounts, recovery, username claims and authenticated ownership checks.

Still unimplemented: the real editor and autosave/publish/restore transactions;
media/music and quotas; reports/moderation; analytics; export/deletion jobs;
mail/outbox workers; rate limits; operator policy decisions; backups/restore;
production DNS-01 TLS, deployment, monitoring and capacity acceptance. Database
constraints tested here do not substitute for those workflows or their tests.

Cross-browser visual and keyboard interaction tests in Chromium, Firefox and
WebKit have not been run. Source/markup and palette checks are not browser or
screen-reader acceptance. There is no authenticated browser journey to exercise
yet. Real email, R2, public TLS renewal, restoration and target-server performance
remain later acceptance work.

ESLint 9 and Drizzle Kit's older loader packages remain upstream maintenance
dependencies. Their compatibility/pins and the two scoped overrides are
documented in [development setup](development.md); revisit them on dependency
updates. CI is configured locally but has not been run on GitHub in this task.
