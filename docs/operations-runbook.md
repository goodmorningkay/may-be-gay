# Operator runbook (non-launch implementation)

Do not provision or deploy from this document without separate operator
instructions. The implementation adds executable local tools; no hosted
provider, certificate renewal, external uptime or live alert acceptance was run.

```sh
NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env scripts/check-operations.ts
```

Run this private check every minute from a timer/cron with the application
runtime configuration. Exit 1 means a critical check or check failure. The JSON
projection contains fixed codes, severities and bounded counts/ages only: no
job payloads, addresses, private keys/locators, provider messages or tokens.
It tests database/schema reachability, ten-second worker heartbeats (critical
at 45 seconds), queue failures/delay, deletion/purge/reconciliation older than
five minutes, account deletion older than 24 hours, snapshot age (25 hours),
journal age (120 seconds), charged storage quota (80% warning/90% critical),
configured mail quota, disk and memory pressure. A failure is an alert, never a
claim that cleanup succeeded. Inspect detailed durable jobs privately by job
ID/kind/state/age/last_error_code; do not SELECT payload into ordinary logs.

OPERATIONS_DISK_PATH selects a fixed trusted local mount, default /tmp. Monitor
all persistent DB/media/archive mounts separately if they differ. Memory reads
cgroup v2 usage/limit where available, otherwise host memory. MAIL_DAILY_QUOTA is
the actual provider daily limit; absent quota is a warning. DB mail counts are
estimates, not the provider's account usage. OPERATIONS_USAGE_FILE can point to a
fixed protected 0600 file, at most 4096 bytes, updated within five minutes by a
trusted provider/app collector:

```json
{"at":"2026-11-10T00:00:00.000Z","storagePercent":10,"emailPercent":20,"appErrors":0}
```

This allows real provider quota and redacted app error counts without scraping
user input or fabricating usage. Missing/stale samples warn. No provider usage
collector or hosted app-error acceptance is claimed by the local tests.

Set OPERATIONS_CERTIFICATES=true only when checks may connect to the fixed three
production TLS hosts (apex, app and media) on port 443. Connections verify peer
certificates with five-second deadlines, warn below 21 days and become critical
below seven days. No request supplies a URL, hostname or port. Keep this disabled
in isolated fixture runs. Configure an independent off-host uptime service for
fixed HTTPS apex/app health URLs, a designated synthetic unpublished-profile
404 and an approved synthetic public media fixture. Use no private account,
bearer links, arbitrary redirect destinations or user-selected URLs. Validate
DNS/TLS, outage delivery and certificate renewal separately before launch. The
parent's HTTP health endpoint should expose only an overall nonsensitive health
state, never this operator JSON, DB role/configuration, queue payload or report.

OPERATIONS_LOG_ROOT enables redacted local JSONL, one file per UTC day, at most
10 MiB per day plus one bounded concurrent append per writer, retained seven
calendar days (roughly 70 MiB maximum). Files use 0600 under a private 0700 root.
The fixed record projection includes no arbitrary messages. Keep check runner
stdout/stderr and Docker/Caddy logs subject to the same seven-day/size policy;
parent owns Compose logging configuration. A timer that never runs cannot prune
its logs: include retention checks in host maintenance. Do not log auth URLs,
query strings, reset token paths, report details or full request headers.

Default alert delivery is local output/log only. Live Slack webhook delivery is
implemented but requires OPERATIONS_ALERT_TRANSPORT=slack,
OPERATIONS_ALLOW_LIVE_ALERTS=true and an explicit protected
OPERATIONS_SLACK_WEBHOOK at the fixed hooks.slack.com/services endpoint. It
sends only fixed check codes/severity/numbers, no payloads, and uses no redirects
and a five-second deadline. It was never enabled or called against a live
provider here. Configure timer suppression/rate policy for repeated incidents
and test alert receipt explicitly under later authorization. Alert delivery
failure exits unsuccessfully and must itself be monitored off-host.

For a stopped/stale worker, confirm process/container health, DB connectivity,
provider readiness and clock. Start the immutable intended worker image, let
leases expire and inspect retry progress. Do not clear all jobs or media_storage.
For public purge over five minutes, confirm storage DeleteObject and Cloudflare
purge permissions/availability and target cache configuration; keep removed
pages unpublished. Retry specific failed durable cleanup records only after
repair, with an explicit bounded attempt reset under maintenance. Preserve
payloads/locators and inspect both worker jobs and the independent ledger. For
account deletion over 24 hours, inspect account_deletion plus downstream ledger
cleanup, not just whether a username disappeared. Failed parser binaries and
missing providers require repair; changing a failed state to succeeded is not a
repair.

For backup failure/age, inspect redacted recovery_status and worker_schedules,
key-file permissions, separate store credentials, native tool version, free
scratch disk and lock timeouts. Confirm manifest commit records exist in every
durable store, not just partial file uploads. Every destination is attempted before
another destination's cleanup can fail. Any write/retention error still marks the
backup failed even if off-host commit succeeded: check each commit record privately
before retrying, and run a fresh snapshot/journal after repair.

BACKUP_OFFHOST=s3 keeps 30-day history off-host and only one snapshot plus one
journal in the local cache. Cache replacement occurs after durable commits; a
failed/incomplete local prune blocks cache growth. Local-only mode keeps full
30-day history and needs the corresponding disk budget. Do not claim that a short
cache is 30-day local protection. At 5 GiB media, 30 daily full snapshots can need
150 GiB plus DB/journals. Off-host mode still needs cache `M + D + J` plus scratch
`max(2D, D + M + 10 MiB, 2J)`, where M is private media size, D the DB dump
size and J the complete journal size, plus framing and headroom beyond live
data/OS/WAL. Restore staging needs its own measured budget. A 40 GiB root disk is not sufficient
for the format's maximum DB/journal bounds without separately sized scratch.

Retention uses bounded pages and persistent private checkpoints in BACKUP_WORK_ROOT
and resumes on each minute journal/daily snapshot run. Keep that root persistent,
run one archive/retention runner per namespace and monitor retentionPending until
a sweep completes. Expiry eligibility is 30 days with bounded sweep lag. Do not
wipe a checkpoint to bypass an error; inspect directory permissions and validated
store layout, repair the cause, then resume. Above 250,000 objects there is no
inventory cap or allocation of the entire namespace. Cache roots upgraded from
old local-only history should be changed to a fresh root while preserving old
history until independently archived/expired.

Every retained DB archive carries its ready private bytes; never prune a shared
media mirror independently of retained snapshots. Escrow secrets separately.
Before restore, configure SERVICE_CLOSED_FILE identically in the restore, app and
worker processes as the absolute RESTORE_REPORT_DIRECTORY/SERVICE_CLOSED on a
shared persistent private mount. Restore validates this exact path and writes the
gate before any SQL; the gate remains across a post-pg_restore crash even before
the database restore status is written. Follow recovery.md for cutover attestation,
constrained backup/restore role grants, runtime grants and explicit removal of
both gates only after operator validation. A validated restore never reopens itself.

An eventual release should be built/tested as an immutable image in CI and
identified by digest. Package the worker/recovery CLI sources, tsx, sharp native
modules, media/parser.cjs, FFmpeg/prlimit and PostgreSQL 17+ tools in that image.
Set explicit private volumes/ownership, secrets, resource limits and capped logs.
Use a non-superuser runtime role, separate migration/backup/restore roles and
private PostgreSQL networking. Missing mail/storage is degraded readiness, not
an invitation to turn on a fallback. Production storage, mail, backup, DNS and
purge credentials must remain separately scoped.

Before an authorized release: close traffic/stop writers as required by the
migration, take and verify a fresh encrypted snapshot plus current journal,
record the previous image digest/schema compatibility, then run reviewed
migrations exactly once using the migration role **before** starting application
and worker processes. Never let runtime startup generate DDL or apply an
unreviewed migration. Check provider configuration, worker/queue/backup health,
then exercise synthetic acceptance before the operator reopens traffic.

Rollback to the previous immutable image only when the new schema is backward
compatible. Do not reverse data migrations blindly. Otherwise remain closed,
restore into a new empty DB and distinct empty media target, replay the current
journal, drain cleanup, verify reports/exclusion/provider revocation and obtain
operator reopening authorization. Preserve the failed target and redacted
report for diagnosis within private retention bounds. No script automatically
changes DNS, switches live databases, removes the maintenance marker or deploys.
