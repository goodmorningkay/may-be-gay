# Durable worker

Run one worker container per host. Each worker processes one job at a time.
PostgreSQL coordinates claims and media parsing across workers.

```sh
NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env scripts/worker.ts
NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env scripts/worker.ts --once
```

`--once` performs maintenance and at most one claim, without scheduling archives.
Use the same runtime DATABASE_URL, SITE_DOMAIN and explicit mail/media variables
as the application; see accounts.md and media.md. Missing providers are recorded
as readiness limitations and processor failures. They do not prevent unrelated
maintenance. There is no local fallback for a missing production provider.

Claims use one `UPDATE … FROM (SELECT … FOR UPDATE SKIP LOCKED)` statement.
Every attempt gets a random locked_by identity and increments attempts exactly
once. Running rows have both locks, no finished_at; terminal rows have finished_at
and no locks. Pending retries have neither. Renewal and completion require the
job ID, claim identity, attempt number, running state and an unexpired lease.
Duplicate acknowledgements and acknowledgements from a reclaimed process do
nothing. Up to 100 expired leases are reclaimed each loop; exhausted ones fail.

The lease is 90 seconds and is renewed every ten seconds. Jobs run in the
worker process with a 60-second deadline. A timeout, lost lease or failed
renewal stops the container without acknowledging the job. Docker restarts the
container and the queue reclaims the interrupted claim when its lease expires.
A watchdog thread stops the process if the main JavaScript event loop goes
20 seconds without a heartbeat. Run the worker in its own container so the
container's exit also ends any native subprocesses.

The media parser has its own 20-second deadline and writes to scratch space
under the existing prlimit and container resource limits. PostgreSQL recovery
tools have a 180-second deadline. The worker rechecks the live claim before
sending mail. If a provider already accepted a request, it may still complete
after the container stops, so retries keep the same media locators and mail
job identity.

Retries start after 2–4 seconds, grow exponentially, cap at ten seconds for
public deletion/purge and 30 seconds for other jobs, with small jitter. Attempts
are bounded by the existing 1..20 max_attempts. Invalid/versioned payloads fail
terminally, and missing providers never count as success. Email attempts stop
23 hours after creation, inside the provider's finite idempotency lifetime;
uncertain old delivery is failed and scrubbed, never resent days later.

Deletion/purge have first priority, then explicit media reconciliation. Ordinary
work precedes periodic reconciliation/expiry/sweeps. Every eighth claim uses
oldest available order among non-urgent work; urgent cleanup retains priority
in both modes. Email and account deletion progress once urgent work drains.
This supports the five
minute media-removal objective when providers and workers are healthy. It is
not a guarantee during outages; failed/over-age work alerts and keeps locators.
SIGTERM or SIGINT stops claiming. During an active job the worker exits and
leaves its lease for recovery. On idle shutdown it closes its database pools.

Every host enqueues a fresh media sweep and cleans its local scratch on a
30-second schedule (ten-second scheduler tick), independent of job execution.
Maintenance runs in the worker process. A pass that exceeds 25 seconds exits
the worker so Docker can restart it. Maintenance calls
operationsMaintenance(500), expires sessions,
verification and auth-rate controls, scrubs terminal email payloads immediately,
fails/scrubs pending email older than 23 hours, and deletes succeeded jobs after
seven days. Local private mail fixture files expire after 23 hours. Pending,
running and failed cleanup jobs, storage ledger and recovery journal are retained.
Heartbeats are written every ten seconds with only provider readiness booleans.

With BACKUP_KEY_FILE, BACKUP_KEY_ID and BACKUP_LOCAL_ROOT configured, a separate
bounded archive scheduler claims worker_schedules rows atomically. Full snapshots
run daily and separate complete journal checkpoints every minute, with failed
schedules retried after one minute. A dead scheduler's five-minute reservation
expires. Archives run in-process with a 180-second deadline. Heartbeats and
media sweeps continue while backups run. The journal sequence in recovery_status
advances after the encrypted archive commits to the local store. Full checkpoints deliberately include all journal pages;
sequence gaps from aborted transactions are allowed, missing pages are not.

Migration 0006 creates worker_heartbeats, worker_schedules and recovery_status,
with runtime DML supplied by the infrastructure's default grants. Existing jobs
constraints are unchanged. The Docker `worker` target packages tsx, worker and
recovery sources, the media parser and sharp native modules, PostgreSQL 17.11
pg_dump/pg_restore, FFmpeg, FLAC and util-linux, and runs as the unprivileged node user.
The fixture wrappers under infra/operations are for isolated tests only.

Local Compose runs the worker with shared private media/mail volumes, a 1.5 GiB
memory limit and one CPU. Its heartbeat healthcheck rejects a missing or stale
heartbeat for that container. For a detailed status check, run
`node --conditions=react-server --import tsx scripts/check-operations.ts`
inside the worker. Docker keeps three 10 MiB log files per service.
Archive destinations, credentials and key custody remain explicit operator
configuration; an unconfigured backup is reported as unavailable.

Worker startup fails closed when the required production SERVICE_CLOSED_FILE
configuration is missing, the marker exists, the database has a `restore` recovery_status row (including validated),
or the gate cannot be checked. Stop active writers/workers before recovery;
validation never reopens the service automatically. See recovery.md.

Acceptance: WORKER_TEST_DATABASE_URL must point to a disposable *_test database,
separate from every other suite. tests/worker uses real PostgreSQL constraints,
claim races, stale fencing, renewal loss, retry windows, shutdown, fairness and
unconfigured-mail job failure. All feature tables come from the
real migration chain; no temporary feature DDL substitutes for migrations. Do not
interpret skipped PostgreSQL tests without these variables as acceptance.

`tests/worker/native-supervision.test.ts` exercises the process-group runner,
including timeout, abort, descendant cleanup and output limits.
