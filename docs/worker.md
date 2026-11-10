# Durable worker

Run a single central worker process per host; its dispatch concurrency is one.
Multiple hosts can safely claim different jobs. The PostgreSQL parser mutex
coordinates normal parsing; the shared native lock below also covers abrupt JS death.
Native subprocesses additionally
require the Linux guardian built from `src/server/subprocess/guardian.c`.

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

The lease is 90 seconds, renewed every ten seconds; each processor runs in its
own guarded process tree for at most 60 seconds. Lease loss, renewal failure or
shutdown signals the guardian and waits for its cleanup before doing anything
else. Children retain the separate 65-second JS watchdog and parent IPC
disconnect handler. Media's parser has an independent native 20-second deadline
and only scratch-file side effects. Native parsers retain the existing
prlimit/FFmpeg/sharp controls and container resource limits. Remote
requests already accepted by a provider cannot be recalled: processors retain
their immutable media locators and mail job idempotency key across retries.
A child rechecks an email's live claim immediately before invoking delivery.

Each guardian uses Linux parent-death signals, a private payload process group,
and child-subreaper adoption. It kills the payload group on cancellation,
deadline, parent death, or payload exit (including success), then kills and reaps
adopted descendants until `waitpid` reports ECHILD. This includes descendants
that create new sessions/groups. `/proc` inspection is limited to the guardian's
own direct children; SIGCHLD is blocked and no reaping occurs between listing
and signalling those children, so their PIDs cannot be recycled in that interval.
Nested guardians have independent groups and receive TERM instead of KILL so
they retain their parser locks until their own reaping barrier. Node observes
completion only after that barrier. The scheduled backup and offline PostgreSQL
tool boundaries use the same mechanism, with 200-second and 180-second deadlines.

The parser guardian also holds an exclusive `flock` for its complete lifetime,
including descendant cleanup. The default is
`$TMPDIR/may-be-parser-<uid>.lock` (Node's temporary directory). Set the absolute
`NATIVE_PARSER_LOCK_FILE` to one stable file shared by all parser invocations
in the deployment; web, worker, and offline recovery must use the same inode
and uid. Never unlink or replace the file while services can run. The lock file
must be a regular file owned by that uid with mode 0600; symlinks fail closed.
Waiting for this lock counts against the parser wall deadline. This closes the
local crash gap where processor death releases its PostgreSQL advisory lock
before the parser is reaped. The replacement-parser regression checks the old
descendant PID at the first instruction after acquiring this file lock.

The PostgreSQL lock is still held by the calling JS transaction/session, not
the native guardian. Consequently separate hosts or containers with independent
lock files can briefly overlap after an abrupt JS death. A strict deployment-wide
one-parser guarantee requires a shared filesystem with reliable cross-host flock
semantics, or moving the global mutex into a surviving supervisor that releases
it only after the reaping barrier. The existing DB advisory lock alone does not
prove that guarantee. The local tests do not exercise cross-host locking.

Runtime packaging is required before these calls can succeed. Compile the
guardian in a build stage with a C compiler and libc development headers:

```sh
cc -std=c11 -O2 -Wall -Wextra -Werror src/server/subprocess/guardian.c -o may-be-guardian
```

Copy the executable to `/usr/local/libexec/may-be-guardian` (0755) in every image
that can invoke parsing, processors, or recovery tools. `NATIVE_GUARDIAN_BIN` can
select another absolute, trusted executable path for local development/tests.
There is no unsupervised fallback. The helper needs Linux prctl, signalfd,
flock, and readable procfs (`/proc/self/task/<pid>/children`, owned child exe
links). It uses libc only, runs as the service uid, and needs no capabilities or
setuid. Nested invocations must use the same guardian executable inode (the
normal immutable-image layout); drain active work before replacing that binary.
Existing util-linux supplies the retained `/usr/bin/prlimit` controls;
neither `setpriv` alone nor `timeout` supplies the required descendant join.
Use an init/subreaper such as Compose `init: true` for every invoking service,
including one-off recovery containers, to reap an orphan guardian after its JS
owner dies. Mount a shared private lock directory and configure the lock path
for separate web/worker/recovery containers. Application and worker images now
include the compiled guardian and a Tini subreaper entrypoint. Compose shares
`native_lock:/app/var/native` between app and worker at uid 1000. Offline recovery
containers must mount that same volume and run at the same uid; retain the image
entrypoint. The browser fixture similarly shares its private native volume.

Cancellation assumes the guardian itself remains alive and readable procfs is
available. SIGKILL/OOM of the guardian cannot run its cleanup; an init only reaps
orphans and does not replace that cleanup. Kernel uninterruptible I/O can delay
SIGKILL and therefore delay the join indefinitely. Completion never claims that
a still-running descendant has exited merely because a JS timeout expired.

Retries start after 2–4 seconds, grow exponentially, cap at ten seconds for
public deletion/purge and 30 seconds for other jobs, with small jitter. Attempts
are bounded by the existing 1..20 max_attempts. Invalid/versioned payloads fail
terminally, and missing providers never count as success. Email attempts stop
23 hours after creation, inside the provider's finite idempotency lifetime;
uncertain old delivery is failed and scrubbed, never resent days later.

Deletion/purge have first priority, then explicit media reconciliation. Ordinary
work precedes periodic reconciliation/expiry/sweeps. Every fourth claim uses
oldest available order among non-urgent work; urgent cleanup retains priority
in both modes. Email and account deletion progress once urgent work drains.
This supports the five
minute media-removal objective when providers and workers are healthy. It is
not a guarantee during outages; failed/over-age work alerts and keeps locators.
SIGTERM/SIGINT stops claiming, kills active work, waits for subprocess exit and
closes DB pools. Interrupted jobs keep their fenced lease for crash recovery.

Every host enqueues a fresh media sweep and cleans its local scratch on a
30-second schedule (ten-second scheduler tick), independent of job execution.
Maintenance runs in a separate process with a 25-second kill deadline so a
blocked retention query cannot stop scheduling indefinitely. Bounded
maintenance also calls operationsMaintenance(500), expires sessions,
verification and auth-rate controls, scrubs terminal email payloads immediately,
fails/scrubs pending email older than 23 hours, and deletes succeeded jobs after
seven days. Local private mail fixture files expire after 23 hours. Pending,
running and failed cleanup jobs, storage ledger and recovery journal are retained.
Heartbeats are written every ten seconds with only provider readiness booleans.

With BACKUP_KEY_FILE, BACKUP_KEY_ID and BACKUP_LOCAL_ROOT configured, a separate
bounded archive scheduler claims worker_schedules rows atomically. Full snapshots
run daily and separate complete journal checkpoints every minute, with failed
schedules retried after one minute. A dead scheduler's five-minute reservation
expires. The archive subprocess has a 200-second supervisor and 180-second own
deadline. Heartbeat/media sweeps continue while backups run. The journal sequence
in recovery_status advances only after encrypted archives commit to every
configured destination. Full checkpoints deliberately include all journal pages;
sequence gaps from aborted transactions are allowed, missing pages are not.

Migration 0006 creates worker_heartbeats, worker_schedules and recovery_status,
with runtime DML supplied by the infrastructure's default grants. Existing jobs
constraints are unchanged. The Docker `worker` target packages tsx, worker and
recovery sources, the media parser and sharp native modules, PostgreSQL 17.11
pg_dump/pg_restore, FFmpeg and util-linux, and runs as the unprivileged node user.
The fixture wrappers under infra/operations are for isolated tests only.

Local Compose runs the worker with shared private media/mail volumes, a 1.5 GiB
memory limit and one CPU. Its heartbeat healthcheck rejects a missing or stale
heartbeat for that container. The `checks` service runs operational checks every
minute and keeps bounded private operational logs. Docker logs use the local
driver with three 10 MiB files per service; this is a size bound, not an age
retention policy. Configure the host's seven-day operational log policy at launch.
Archive destinations, credentials and key custody remain explicit operator
configuration; an unconfigured backup is reported as unavailable.

Worker startup fails closed when the required production SERVICE_CLOSED_FILE
configuration is missing, the marker exists, the database has a `restore` recovery_status row (including validated),
or the gate cannot be checked. Stop active writers/workers before recovery;
validation never reopens the service automatically. See recovery.md.

Acceptance: WORKER_TEST_DATABASE_URL must point to a disposable *_test database,
separate from every other suite. tests/worker uses real PostgreSQL constraints,
claim races, stale fencing, renewal loss, retry windows, shutdown, fairness and
actual unconfigured-mail subprocess failure. All feature tables come from the
real migration chain; no temporary feature DDL substitutes for migrations. Do not
interpret skipped PostgreSQL tests without these variables as acceptance.

`tests/worker/native-supervision.test.ts` needs a local C compiler and no database.
It executes the real subprocess helpers through Node processor fixtures, waits
for descendant PID startup, and tests cancellation, abrupt intermediate death,
independent parent-death cleanup, parser timeout, recovery grandchildren,
successful-payload cleanup, and lock handoff. It checks PID absence (including
zombies) at completion and absence of delayed writes. The existing media parser
contract suite should also run with a compiled `NATIVE_GUARDIAN_BIN` configured.
