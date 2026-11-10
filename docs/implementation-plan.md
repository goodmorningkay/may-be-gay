# may-be.gay implementation plan

Status: implementation started on 10 November 2026. The first foundation milestone and public renderer are implemented; account flows, editing, media, operations and hosting remain subsequent phases. See the [implementation and review record](implementation-review.md) for delivered scope, verification and limitations. Research checked on 10 November 2026.

Build a free profile service where an invited user creates an account, claims `username.may-be.gay`, edits an expressive links page, previews it, and publishes it. Start with a small invite-only beta and open registration after the product and its operating procedures have been exercised.

## Confirmed direction

- Balance straightforward link editing with themes, backgrounds, and optional music.
- Free, invite-only beta followed by public registration.
- Cloudflare manages DNS for `may-be.gay`.
- Target a Hetzner CX23: 2 shared vCPU, 4 GB RAM, 40 GB disk. Purchase the server near deployment, when the app is ready.
- This plan is the review checkpoint before building.

All feature limits, service choices beyond those above, and performance targets below are proposals, not existing capabilities or measured results.

## First release

The main journey is **invite → verified account → username → template → edit → preview → publish → share**. A newly claimed username remains unpublished until its owner deliberately publishes.

| Area | Beta scope |
| --- | --- |
| Accounts | Email and password, email verification, password reset, session management, account export and deletion. Two-factor authentication required for administrators. |
| Usernames | One page per account; 3–30 lowercase ASCII letters, digits and hyphens, starting and ending with a letter or digit; reject the `xn--` prefix. Database-enforced uniqueness. Reserve infrastructure and support names. Keep usernames fixed during beta and retain minimal deleted-name tombstones to prevent impersonation through reuse. |
| Profile | Display name, optional pronouns, short bio, avatar, social icons, page title and share metadata. Login email stays private; any public contact information is a separate deliberate choice. |
| Links | Add, edit, hide, delete and reorder up to 30 links. Keyboard alternatives to dragging. Links continue to work without JavaScript. |
| Appearance | Two responsive layouts and six distinct presets; controlled colour, font, button, background, overlay and spacing choices. Static uploaded backgrounds, solid colours and gradients. Accessible defaults and contrast feedback. |
| Music | One optional MP3 track, maximum 10 MB and three minutes, with play/pause, volume and attribution. Playback starts only after a visitor chooses it. Profile content is accessible without playing music. |
| Editing | Autosaved draft with clear save/error states, mobile and desktop previews, explicit publish/unpublish, and restoration of up to five retained published revisions. Assets referenced by retained revisions count against the quota and remain available for restoration. |
| Statistics | Approximate daily page views and per-link clicks for the last 30 days. No claim of unique visitors, no advertising trackers, and no identifying visitor information shown to page owners. |
| Administration | Issue/revoke invites, adjust quotas, review reports, suspend/reinstate accounts or pages, remove media, record moderation actions, and pause registrations or uploads. |
| Visitor controls | Report a page or asset, report an unsafe link, and contact support. Public profiles have clear platform attribution and reporting access. |

Initial operating limits: 50 invited accounts, 100 MB total retained media per account, image uploads capped at 5 MB each, and one media-processing job at a time. These limits include draft/history assets and derived files. Expand the invite cap based on measured resource use and moderation workload.

Keep raw HTML, arbitrary CSS/JavaScript, arbitrary embeds, custom domains, video backgrounds, public file hosting, comments, direct messages, directories/leaderboards, payments and external metadata scraping out of the first release. Discord login, additional layouts and subtle effects are sensible later additions. This keeps the first product centred on pages people can safely customise and share.

## Recommended architecture

Use **Next.js and TypeScript**, **PostgreSQL**, **Drizzle**, and **Better Auth** on the CX23, deployed through **Docker Compose** behind **Caddy**. Use **Cloudflare R2** for media and a transactional email service, initially **Resend**, for verification and recovery messages.

Next.js explicitly supports self-hosting and recommends a reverse proxy. PostgreSQL support is documented by both Drizzle and Better Auth. Pin compatible supported stable releases when implementation starts; do not copy prerelease installation commands blindly. [Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting), [Drizzle PostgreSQL support](https://orm.drizzle.team/docs/get-started-postgresql), [Better Auth installation](https://better-auth.com/docs/installation).

| Address/component | Responsibility |
| --- | --- |
| `may-be.gay` | Landing page, explanations, terms, privacy, support and sign-in link. |
| `app.may-be.gay` | Authentication, account settings, editor, private previews, uploads and administration. |
| `<username>.may-be.gay` | Read-only published profile, its public metadata and bounded reporting/analytics endpoints. |
| `media.may-be.gay` | Validated, published media delivered directly from R2 through its custom domain. |
| CX23 | Caddy, one application instance, PostgreSQL and a small bounded background worker using the application image. |
| Private R2 buckets | Quarantined uploads, new draft assets and encrypted backup material, with separate credentials and access policies. |
| External email | Verification, recovery, invitations and essential account notices. |

A single application and database are sufficient architectural starting points. Avoid Kubernetes, a separate microservice for each feature, a full self-hosted Supabase installation, or a separate Redis dependency in beta. Use PostgreSQL for small durable jobs/outbox records, with retry limits and idempotent processing. Build production container images in CI or on a development machine, then pull them onto the VPS.

The CX23 is a plausible beta target, not a promise of a particular number of users or requests. Keep runtime memory below the server's capacity with bounded database connections, upload processing and logs. Its single-server design means a host outage takes the application offline. Public media can remain independently available through R2.

## DNS and HTTPS

At deployment, preserve existing email and verification records and configure apex, `app`, and wildcard records for the server. Reserve explicit service hosts, including `www`, `app`, `api`, `auth`, `admin`, `media`, `cdn`, `assets`, `mail`, `support`, `abuse`, `status` and `staging`. Connect `media.may-be.gay` through R2's custom-domain flow.

Cloudflare supports proxied wildcard records on all plans. In a full DNS setup, Universal SSL covers the apex and first-level subdomains. Set the edge-to-origin connection to Full (strict). At the origin, Caddy should manage the apex and wildcard certificates using Let's Encrypt DNS-01. The Cloudflare DNS module must be included in the Caddy image, with a token scoped to this zone and only the required DNS-edit/zone-read permissions. No per-user DNS record or certificate issuance is needed. [Cloudflare wildcard DNS](https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/), [Universal SSL coverage](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/), [Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/), [Caddy TLS configuration](https://caddyserver.com/docs/caddyfile/directives/tls), [Cloudflare module](https://github.com/caddy-dns/cloudflare/blob/master/README.md).

The application must validate the hostname itself: accept the apex, explicitly named service hosts, or exactly one valid username label under `may-be.gay`. Reject unrelated hosts, nested labels, malformed values and spoofed forwarded headers. DNS can match more names than the application or certificate should accept. Unknown or unpublished usernames return a real 404.

Public page lookups and every cache key must include the resolved profile identity and published revision. Never use only `/` as a cache key across usernames. Dashboard, authentication, previews and authenticated APIs use `no-store`; public pages must never incorporate the visitor's login session. Start with bounded application caching and no edge caching of profile HTML. Publish, unpublish and suspension invalidate affected application caches.

## Accounts and tenant isolation

Use the authentication library for password hashing, verification, recovery and sessions. Email/password with verification is the proposed starting method: ordinary sign-in will not require a fresh email on every visit. Email OTP remains an alternative if preferred, with a stronger dependency on delivery and daily email quotas. Enforce invitation eligibility on every account-creation route, including any provider added later; hiding a sign-up button is insufficient. Invites are expiring, revocable and single-use, with only a hash of the invite secret retained. Bind invitations to an email address during beta. Claim usernames only after verification and use a database transaction/unique constraint to resolve competing claims.

Keep authentication at a fixed `https://app.may-be.gay` base URL. Set a host-only, `Secure`, `HttpOnly`, `Path=/`, `SameSite=Lax` session cookie using the `__Host-` prefix; disable cross-subdomain cookie sharing. Allow only the editor's exact origin for authenticated mutations and apply CSRF protection to application routes as well as authentication routes. Sibling subdomains are not a sufficient SameSite security boundary. [Better Auth security](https://better-auth.com/docs/reference/security), [cookie configuration](https://better-auth.com/docs/concepts/cookies), [MDN cookie prefixes](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie), [OWASP CSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).

Gate editor/authentication/admin routes by hostname at both the proxy and application. Direct server calls to `auth.api` bypass Better Auth's handler CSRF and rate-limit checks, so any custom wrapper must enforce origin, redirect, invitation and rate-limit rules itself. Require recent authentication for sensitive account changes and deletion. Test cookies and privacy in normal HTML, framework data/prefetch responses and error paths. [Better Auth handler boundaries](https://better-auth.com/docs/reference/security), [rate-limit boundaries](https://better-auth.com/docs/concepts/rate-limit).

The database is private to the server. Use a non-superuser application role and a separate migration role. Resolve ownership from the authenticated session on every private read and write; never trust a submitted owner ID. Centralise this in server-only data access functions and test with two unrelated accounts. Public reads select only explicitly published fields. Authentication alone does not establish ownership, and an ORM does not supply tenant isolation automatically.

For this server-only design, mandatory controls are explicit ownership checks, database constraints and adversarial integration tests. Row-level security is an optional additional defence if implemented with transaction-local identity and tested connection-pool behaviour; this plan does not assume it exists automatically.

## Data and publishing

| Record group | Important invariants |
| --- | --- |
| Authentication tables | Library-owned users, credentials, sessions, verification tokens and administrator second factors. No public exposure. |
| Username claims | Normalised unique name, one active name per owner, reserved-name checks and retained tombstones. |
| Profiles and drafts | Stable profile ID, owner ID, validated versioned theme/content schema, optimistic edit version and publication state. |
| Profile revisions | Immutable published snapshots containing link order, text, appearance and owned asset references. One active published revision. |
| Links | Stable identifiers for edits and aggregate counts; HTTP/HTTPS destinations validated before publication. No server-side fetch of arbitrary destinations. |
| Media assets | Owner, object key, type, actual bytes, processing state, dimensions/duration, publication references and deletion state. |
| Invites | Token hash, intended recipient, expiry, revocation and single-use redemption record. |
| Reports and audit events | Target, reason, workflow state and attributed administrator action. Reporter details remain private. |
| Daily metrics and jobs | Bounded aggregates; durable retryable work for email, media, deletion and cache purging. |

Publishing validates a complete draft, confirms asset ownership/readiness and switches the published revision atomically. A failed media job or publish leaves the old page intact. Autosave uses an edit-version check so a stale browser tab cannot silently overwrite newer edits. Restoring an older revision creates a new publication rather than mutating history.

## Media and privacy

New uploads remain private until validation and publication. For beta, stream through an authenticated byte-limited endpoint; a client-declared size is insufficient. Generate object keys on the server, verify actual types, accept only static JPEG/PNG/WebP images, cap decoded inputs at 16 megapixels, re-encode and remove metadata. Reject active formats such as SVG/HTML and unrestricted archives. Precompute a small set of responsive image sizes instead of unbounded request-time transformations. Run parsing with bounded resources and concurrency. MP3 inspection must also have time and resource limits; the first release does not transcode arbitrary media. Serve validated files with correct content types and `nosniff`. [OWASP file upload guidance](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html).

R2 public custom domains support Cloudflare caching; the `r2.dev` endpoint is intended for development and is rate-limited. The media bucket and domain zone must be in the same Cloudflare account. Keep original/quarantine/draft buckets private and publish only approved assets. Use random immutable public object keys and track references so replacing, unpublishing or suspending a page triggers deletion and cache purge where appropriate. Target removal of the profile within 60 seconds and public media within five minutes, including CDN cache handling. A public asset is public to anyone with its URL; previously downloaded copies cannot be recalled. [R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/).

Use a restrictive Content Security Policy aligned with the renderer, trusted fonts and media origin. No arbitrary remote image/font URLs, active uploaded documents or user-authored script are accepted. Allow ordinary outbound link navigation without fetching destinations on the server. Purge abandoned uploads automatically and prevent new uploads when account or global storage limits are reached.

Music uses a visible user-initiated player, `preload="none"`, and a rights/attribution field. Do not promise audible autoplay: browsers commonly block it before interaction. [MDN autoplay behaviour](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay).

Draft previews require authentication. Published pages are public even during an invite-only beta. Default to no public directory and `noindex`, with an explicit indexing choice; `noindex` is not access control. Collect only information needed for accounts and chosen profile fields. Use aggregate analytics rather than persistent visitor identifiers. Proposed retention: 30 days of statistics, seven days of redacted operational logs, and 30 days of encrypted backup history. Retention for moderation evidence should be narrowly justified and documented separately.

Account deletion immediately revokes sessions and removes the public page; a durable job removes private records and media within 24 hours. Backups expire on their retention schedule. A restore procedure must reapply recorded deletions and suspensions before reopening the service. Export contains the user's profile, links, appearance settings and available media, not authentication secrets.

## Moderation and launch policy

Reporting, administrator suspension, media removal, a monitored support contact and a short appeals process belong in the beta. Define rules for impersonation, harassment, scams, malicious links and copyright complaints. The .gay registry has specific anti-harassment protections and can act against violating domains; this makes responsive moderation relevant to the domain itself. [Registry policy](https://ohhey.gay/gay-cares/).

Before accepting beta users, decide the operator identity/jurisdiction, intended audience and age policy, content rules, moderation responsibility, privacy notice and terms. Optional music requires uploaders to have the necessary rights and a working takedown process. The domain name itself does not establish an adult-content policy.

Check applicable rules against the actual service and audience. For example, Ofcom describes services where users upload content others can encounter as potentially user-to-user services; lack of comments or messages alone does not settle scope, nor does a small invite-only launch. If the service has UK links, complete the relevant scope assessment and any applicable duties before launch. If children are likely to use it, evaluate the applicable children's privacy requirements. These questions depend on the operator and audience, which are not yet established. [Ofcom scope checker](https://www.ofcom.org.uk/os-toolkit/regulation-checker/regulation-checker), [ICO children's code introduction](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/childrens-information/childrens-code-guidance-and-resources/introduction-to-the-childrens-code/).

## Costs and capacity

Use the current Hetzner checkout quote when provisioning. The official page confirms the requested CX23 resources and EU included traffic of 20 TB, but currently labels new orders unavailable and did not expose a usable live base price in the fetched page. A search-indexed price-adjustment document could not be reopened, so its advertised price is not treated as a verified quote. Region, availability and tax remain deployment-time checks. [Hetzner CX plans](https://www.hetzner.com/cloud/cost-optimized/).

| Item | Verified price or planning basis |
| --- | --- |
| CX23 | Current checkout price, denoted `S`, excluding tax. Server location still to be selected. |
| Primary IPv4 | €0.50/month excluding VAT; check whether the checkout total already includes it. |
| Hetzner automatic backups | Additional 20% of server price. Seven daily backup slots. |
| R2 Standard | 10 GB-month, 1 million Class A and 10 million Class B operations included monthly. Beyond these: $0.015/GB-month, $4.50/million Class A and $0.36/million Class B. Internet egress has no R2 bandwidth charge; operations, storage and other services can still cost money. |
| Resend | Free up to 3,000 emails/month and 100/day. Its published Pro starting tier is $20/month for 50,000 emails; configure alerts before any upgrade or overage. |
| Other costs | Domain renewal, CI/registry usage if beyond their included allowances, backup storage, and any paid monitoring or additional disaster-recovery storage. |

The Hetzner baseline is **`1.2 × S + €0.50/month`**, excluding VAT, when using both automatic backups and a separately charged IPv4. R2/email are additional usage-based items in USD, so do not present a mixed-currency sum as a precise bill. [Primary IP pricing](https://docs.hetzner.com/cloud/servers/primary-ips/overview/), [backup billing](https://docs.hetzner.com/cloud/billing/faq/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [Resend pricing](https://resend.com/pricing).

For scale intuition only: 100,000 visits transferring 1 MB of images each is about 100 GB; a 3 MB song played on 25% of those visits adds about 75 GB. This excludes HTML/JavaScript, retries, bots and caching. Fifty accounts retaining an average of 20 MB each use about 1 GB of media, while the proposed 100 MB quota permits about 5 GB across the beta. Neither calculation predicts application throughput. Backup copies and retained derivatives consume additional storage.

## Deployment and operations

Provision the server only after local and CI acceptance checks pass. Use a supported Linux release, SSH keys, a restrictive firewall, private container networking and persistent PostgreSQL/Caddy volumes. Expose only required web traffic; do not publish PostgreSQL or the app's internal port. Restrict origin traffic appropriately when relying on Cloudflare, and trust forwarded client-IP headers only from verified proxies. Application-level rate limits remain necessary.

Build and tag immutable release images outside the VPS. Run reviewed database migrations once per release, back up first, perform health checks and retain the previous image. Prefer backward-compatible schema changes so rolling back application code does not require reversing a destructive migration. A single-instance deployment may have a brief maintenance interruption; high availability is outside beta scope.

Use an external mail API over HTTPS, or authenticated SMTP on port 587. Hetzner blocks ports 25 and 465 by default. Verify the sending domain, configure its SPF/DKIM/DMARC records without breaking existing mail, and test delivery, retries and quota exhaustion. [Hetzner mail restrictions](https://docs.hetzner.com/cloud/servers/faq/).

Enable Hetzner backups as a useful additional recovery route. Also create a consistent daily PostgreSQL export and an associated media/asset manifest, encrypt the backup, and store it off the VPS with credentials separate from the application's media credentials. Include required media copies, roles/configuration and a secure recovery method for secrets. Coordinate asset retention with backups so every object referenced by a retained database export remains restorable; verify that relationship during restore drills. R2 durability alone is not a backup strategy. Hetzner warns that running-server snapshots do not guarantee data consistency, and attached Hetzner Cloud Volumes are excluded; ordinary Docker volumes on the root disk are a different thing. [Hetzner backup caveats](https://docs.hetzner.com/cloud/servers/backups-snapshots/faq/), [PostgreSQL export semantics](https://www.postgresql.org/docs/current/app-pgdump.html).

For this small beta, propose a recovery point within 24 hours and recovery within four hours, subject to a successful restore drill. Retain encrypted backups for 30 days. Before wider registration, reassess off-provider copies and continuous database archiving if a 24-hour loss window is unacceptable. Alert on failed backups, disk usage, memory pressure, repeated application errors, certificate expiry, email quotas and storage spend. Use an external uptime check so server failure cannot silence its own monitoring.

## Ordered build phases and acceptance checks

| Phase | Deliverable | Exit condition |
| --- | --- | --- |
| 1. Product and foundations | Agreed flows/theme direction; pinned stack; local HTTPS host routing; schema, Compose and CI. | Clean checkout builds reproducibly; local apex/editor/two profile hosts route correctly; schema migrations work from empty DB. |
| 2. Accounts and ownership | Invites, verification, recovery, username claims, private editor shell and administrator access. | Concurrent claims yield one owner; expired/reused invites fail; direct sign-up cannot bypass invites; recovery works; account A cannot read or mutate B's drafts/assets. |
| 3. Profiles and editor | Responsive public renderer, links, themes, live preview, autosave, publish/unpublish and revision restoration. | Unsaved/draft content stays private; stale edits are detected; failed publishes preserve the old page; changes never appear on another username. |
| 4. Media and music | Private upload pipeline, validated images, R2 publication, playback controls and storage quotas. | Oversize/spoofed/unsupported files fail; processing remains bounded; audio waits for a click/tap; unpublished assets remain private; media removal and cache purge work. |
| 5. Beta operations | Analytics, reports, administration, export/deletion, policy pages, rate limits, backup/restore and deployment runbook. | Suspension removes public content promptly; deletion/export complete; a backup restores into a clean environment; failures and quota limits produce useful alerts. |
| 6. Hosted acceptance and beta | Provision CX23, configure DNS/TLS, deploy release, test real mail/media, invite a small first cohort. | Apex/editor/profile/media HTTPS works; renewal path is tested; two-user isolation passes through the proxy; rollback and restore are rehearsed; owner can handle reports. |
| 7. Public registration | Resolve beta issues, reassess usage/costs/moderation, then enable open sign-up. | No unresolved isolation or data-loss defects; resource headroom demonstrated; abuse controls and support workload sustainable; applicable launch requirements addressed. |

Run meaningful unit tests for hostname/username/URL/theme validation, integration tests for ownership/invites/publishing/deletion, and browser tests for the complete account-to-publish flow. Exercise Chromium, Firefox and WebKit, plus keyboard and reduced-motion behaviour. Keep representative upload fixtures small and controlled.

Performance acceptance is a proposed baseline: on the actual target server, sustain 10 public-page requests/second for 15 minutes with an active editing session and occasional bounded uploads, under 1% server errors and a public-response p95 below 500 ms. Record warm/cold-cache behaviour, CPU, RAM and database latency. This is an initial test target, not a capacity guarantee. Aim for mobile LCP within 2.5 seconds on a documented representative profile/network fixture, excluding music playback. If targets fail, optimise or propose a resource change before increasing the beta cohort.

## Decisions for review

The requested balance, invite-only launch, Cloudflare DNS and CX23 target are settled. The proposed choices to review are the Next.js/PostgreSQL/Better Auth stack, email/password sign-in, R2 and Resend, the initial feature/media limits, fixed usernames during beta, and the phase order. The companion [fact-check record](research-verification.md) records the evidence and changes made after reviewing the research agent's memo.

Before inviting real users, settle the age/content policy and operating jurisdiction, identify who handles reports, choose the server region, and agree whether the proposed backup recovery window is acceptable. These are recorded dependencies; they do not require provisioning a server during development.
