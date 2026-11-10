# Encrypted backup and offline recovery

The objectives are RPO 24 hours for retained content and RTO four hours. A separate
minute journal checkpoint protects later account deletions, suspensions and
moderation removals. These are objectives, not hosted performance claims.
Archive status records both capture and completion times. Journal health uses
the manifest capture time and the same 120-second freshness window as restore;
slow upload/retention cannot make old journal contents appear fresh. Status
without a capture timestamp is not accepted as a healthy journal checkpoint.

```sh
NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env scripts/backup.ts
NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env scripts/backup.ts --journal
```

BACKUP_DATABASE_URL is an explicit read-only backup role URL with SELECT on all
application tables, sequences and the migration journal. DATABASE_URL is used
only for redacted archive status writes. Use protected environment files, never
put passwords in commands or logs. PostgreSQL server is 17; PG_DUMP_BIN and
PG_RESTORE_BIN default to pg_dump and pg_restore and must resolve to trusted
17+ binaries. No shell interprets archive data or provider errors.

BACKUP_KEY_FILE must be an operator-owned regular file containing exactly 32
random bytes, mode 0600 (or stricter), outside the archive store. BACKUP_KEY_ID
is a nonsecret 1..64 character letters/digits/underscore/hyphen identity. Create
and escrow the key through the operator's separate secret-management procedure.
Loss of that key loses recovery; copying it into the archive defeats separation.
Keep old keys with their identities until all dependent snapshots expire. This
CLI handles one key identity per invocation; select its corresponding key file
when restoring an older archive. No operational secret is embedded unencrypted.

BACKUP_LOCAL_ROOT and BACKUP_WORK_ROOT are absolute private directories, mode
0700, with no symlink aliases or public/.next paths. Production requires an
explicit, persistent BACKUP_WORK_ROOT for retention checkpoints; local development
defaults to /tmp/may-be-recovery. Compose persists /app/var/recovery. Provision
sufficient encrypted scratch disk: a DB dump,
encrypted files and restore plaintext coexist temporarily. Archive files use
0600. Plaintext work is removed in finally; after a host crash, securely inspect
and remove stale run-* directories while all recovery processes are stopped.
Filesystem deletion is not secure erasure; use encrypted host storage.

An archive first takes the nonqueued runner lock (740304,1), held until upload/
retention ends; another archive invocation fails as already running. This
serializes cache replacement/checkpoints without holding content locks during
provider I/O. A snapshot then acquires the operations/journal mutex (740302,1),
then the exclusive
exported MEDIA_BACKUP_LOCK (currently 740303,1), **before** beginning a
REPEATABLE READ transaction. It exports one PostgreSQL snapshot, passes it to
custom-format pg_dump and reads media_storage using that same transaction.
The snapshot includes the independent ledger, all schema/data and migration
history. The exclusive media lock stays held through copying ready private
original/display objects; actual keys are deduplicated (audio has one key).
Source bytes are size checked and parsed with the bounded media validator;
missing/corrupt content aborts. Quarantined/incomplete upload bytes are excluded.
The parser mutex is also acquired during snapshot validation. Both maintenance
locks are released before archive upload. Lock acquisition times out after ten
seconds (media exclusivity uses bounded try-locks so existing owner-first
publication is not blocked behind an exclusive wait); the complete archive operation aborts after three minutes, closing its
DB connection so failed backups cannot indefinitely freeze media operations.

Format v1 is an immutable generated snapshot-<milliseconds>-<UUID> or journal-
<...> directory. It contains file-N.enc and a last-written manifest.enc commit
record. Each file has MBG1 framing, a strict version/algorithm/key-identity/random
96-bit-nonce header, AES-256-GCM ciphertext and 128-bit authentication tag.
The entire header is authenticated AAD. Every file gets a new nonce. The encrypted
strict manifest includes plaintext SHA-256 and size, expected generated file
names, private object descriptors, PostgreSQL version, non-secret role names,
site/storage configuration identities, public media origin and recovery sequence.
S3 restore enforces that original public origin so normal purge jobs invalidate
the original URL namespace even when rebuilding into separate destination buckets. DB passwords,
BETTER_AUTH_SECRET, provider credentials, DNS/certificate secrets and backup keys
must be separately recovered from protected secret escrow. Role names are
informational: recreate reviewed least-privilege roles/grants using the operator
bootstrap procedure; never execute archived role/config strings as commands.

Files stream through encryption/decryption and hashing, not one giant archive
buffer. Media adapter reads are bounded to one validated object (at most 10 MiB).
Limits: 16 GiB per DB/journal file, 64 GiB total plaintext,
`MAX_PRIVATE_MEDIA_OBJECTS + 1` inventory files (currently 9,999 private objects
plus one DB file), 8 MiB manifest, one million journal events, 8 KiB per journal line. There is no
tar extraction, archived path creation, archived shell command, or symlink input.
Authentication and every size/hash pass in private staging before restored
SQL/media is used. Only authenticated operator-created PostgreSQL archives are
trusted SQL input; key custody is also archive-author authority.

Local archives are real durable files (fsync file and destination directory).
Optional off-host storage requires BACKUP_OFFHOST=s3 plus **all** of:
BACKUP_S3_ENDPOINT (HTTPS origin), BACKUP_S3_REGION, BACKUP_S3_BUCKET,
BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY and BACKUP_S3_PREFIX
(backups/<lowercase-installation-id>/). These are explicit backup credentials,
not application media credentials. Reused media bucket, access ID or secret is
rejected. Scope Get/Put/Delete/List to this prefix in its private bucket; no ACL,
DNS or bucket-creation privileges. Restores into S3 also need ListObjectsV2 on
the two empty destination media buckets to establish emptiness. Requests have
abort deadlines, bounded streams, two attempts, no raw provider errors and
immutable conditional writes. A committed manifest is uploaded last. Failure
of any configured destination is a failed backup. Never enable this against a
real provider merely to run local acceptance.

Every snapshot contains all its ready private bytes independently: it does not
depend on current media, a mutable shared mirror, or a later snapshot. Durable
stores retain 30 days of history, including complete media copies. A local-only
configuration retains that full history and requires its full disk capacity; it
is suitable for explicitly sized offline/development fixtures, not a claim of
off-host protection.

With BACKUP_OFFHOST=s3, S3 is the durable 30-day archive and BACKUP_LOCAL_ROOT is
only a cache of **one snapshot and one journal**. The durable destinations are
attempted first, independently; their authenticated manifests are still written
last. Only after every durable destination commits may the previous local cache
of the same kind be removed and the new one copied. Failure to finish that cache
cleanup prevents a new local copy from growing the cache, while off-host commit
has already been attempted. An off-host failure leaves the old cache untouched
and adds no new local copy. Any configured write or cleanup error fails the
backup/status even if a different destination committed successfully. A crash
can leave a partial cache copy; the next successful off-host commit prunes it
before writing another. The cache cannot supply historical 30-day restores: use
--offhost for those. Use a fresh cache root when switching from local-only history;
preserve the old root until its contents are independently archived or expired.

Retention streams pages of at most 1,000 entries, without a store-wide inventory
or total-object cap. Local directories use bounded lexical pages; S3 uses the
last validated key as StartAfter, avoiding expiring continuation tokens. Generated
archive IDs determine expiry, including uncommitted partial uploads. Each pass
has a 16-page/15-second soft work budget, checked between objects (an in-flight
filesystem/provider operation and directory scan can exceed the soft deadline;
the overall backup abort still applies). Private atomically renamed/fsynced
retention-<identity-hash>.json checkpoints in BACKUP_WORK_ROOT resume on the next
snapshot/journal run. Deletions precede checkpoint advancement; interrupted work
replays at most 63 deleted objects, and budget exits save the last processed key.
Completed sweeps reset the cursor so newly expired entries are revisited. Keep
this root on persistent private storage. The database runner lock serializes
normal archive invocations; use one source database per backup namespace and do
not invoke standalone retention concurrently. Do not remove checkpoints during
normal operation.
A missing checkpoint safely starts over. Expiry is eligible at 30 days and is
applied over successive passes; backlog is reported as retentionPending in the
redacted successful backup result, not silently represented as a finished sweep.
Monitor continued backlog and free space. No later archive upload waits for an
older destination's cleanup to finish before attempting other durable stores.

At a 5 GiB private-media allowance, 30 independent full snapshots alone can need
150 GiB off-host (plus DB/journals). On-host off-host-mode cache needs one full
encrypted snapshot plus one encrypted whole-history journal. Let M be private
media size (at most 5 GiB here), D the custom DB dump size, and J the full journal
size. Reserve cache `C = M + D + J`, plus backup scratch of approximately
`max(2D, D + M + 10 MiB, 2J)`, plus encryption framing/manifests and safety
headroom. DB and journal encryption briefly retain both plaintext and ciphertext;
media copying retains the accumulated encrypted snapshot plus one plaintext
object. Add live DB/media, WAL, OS and operational headroom separately. Restore
needs two staged journal copies while authenticating, all snapshot plaintext and
a concurrently growing target DB/media (the target DB can exceed compressed dump
size): provision separately measured scratch capacity for a full restore drill.
The format's 16 GiB DB/journal bounds are validation ceilings, not a promise to fit
them on a 40 GiB disk. That disk requires measured DB/journal sizes, free-space
monitoring and separate restore scratch if the sum cannot fit. Tiny fixture
measurements establish no production disk sizing.

The current database recovery journal is not pruned. Old complete journal
checkpoints can expire because each newer checkpoint contains the whole ordered
history. Scale beyond the bounded journal requires a reviewed incremental chain
format; silently skipping old pages is not permitted.

Before restore, close traffic at proxy/maintenance gate, stop all app writers and
workers, establish the authoritative final recovery sequence/cutover time, then
archive the journal again. If the primary is unavailable and no checkpoint can
be attested to cover every committed removal, **do not reopen**. A recent clock
timestamp alone cannot prove completeness. An operator must obtain the final
sequence from the frozen primary or an independently durable authoritative
checkpoint. Never infer the expected sequence from the stale daily snapshot.

Prepare a distinct empty database and empty destination private/public media
store. RESTORE_DATABASE_URL is its dedicated restore/migration-role URL;
MEDIA_* variables must refer to its new target storage. Source and target DB and
media identities must differ. Keep BACKUP_DATABASE_URL pointing at the protected
source identity. RESTORE_REPORT_DIRECTORY must be a new private directory. Set SERVICE_CLOSED_FILE
to exactly `<absolute RESTORE_REPORT_DIRECTORY>/SERVICE_CLOSED` in the restore,
app and worker environments, on the same persistent private mounted path. Use
the same filesystem UID for restore/app/worker so the 0700 report directory can
be checked; filesystem access errors keep the service closed. Restore
rejects an absent, relative, aliased or mismatched marker configuration before
creating a report or touching a target. App/worker production startup must require
this shared setting; do not independently configure an optional unrelated gate.

```sh
NODE_OPTIONS=--conditions=react-server npx tsx --env-file=restore.env scripts/restore.ts \
  --target-name chosen_empty_database --ack-maintenance \
  --snapshot snapshot-<milliseconds>-<UUID> \
  --journal journal-<milliseconds>-<UUID> \
  --expected-recovery-sequence <verified-final-sequence> \
  --recovery-through <verified-UTC-cutover-time>
```

Add --offhost to read the configured S3 backup store; default reads local.
The checkpoint must be at least as new as the acknowledged cutover, have exactly
the expected high-water sequence, match the snapshot's source, and be at most
120 seconds old when restore starts. Acquire/verify a fresh checkpoint first.
All complete ordered journal pages are verified, the prefix is compared with
the restored snapshot, and events after its recorded watermark are replayed
using the existing operations API and durable replay checkpoint; rollback gaps are valid. The
restore process never creates owners from the journal. It invalidates restored
sessions and one-time verification/recovery values, cancels old mail,
resets interrupted leases, expires incomplete uploads and retries/drains cleanup
before allowing validation. It restores private content first and reconstructs
only approved still-live publications through publishOwnedMedia afterward.
Unpublish/suspension reversal does not republish. Failed/pending cleanup blocks
validation, including unavailable storage or purge providers.

The configured SERVICE_CLOSED_FILE is created and fsynced before validation and
deliberately remains after success and failure. The CLI never changes a proxy, starts traffic, or authorizes
launch. Application routing and worker startup check that same absolute
SERVICE_CLOSED_FILE and the database's `restore` recovery_status row. Any restore
row, including validated, keeps the service closed; unavailable schema, database
or marker checks fail closed too. The filesystem gate covers the interval after
pg_restore commits but before
the restore status row is inserted. Public health exposes only readiness, never
recovery_status details. Successful
restore writes restore-report.json and state validated; failures record a
redacted stage in restore-failure.json and keep the gate closed. After failure,
inspect stage and durable job/error status privately. Repair providers and resume
cleanup offline or discard only the explicit isolated target and start with a
new clean target/report directory. No destructive overwrite/retry bypass exists.

After validation, reapply reviewed runtime grants, verify account/media exclusion
and purge independently, rotate/recover operational secrets as appropriate,
measure storage/DB health, then have the operator explicitly authorize reopening.
With application and workers still stopped, the operator removes only the
validated target's `recovery_status` row whose id is `restore`, removes the matching
SERVICE_CLOSED_FILE, then starts the services and
checks `/api/health` on the app host. Do not remove snapshot/journal status rows.
These are deliberate operational steps, not actions performed by the restore CLI.
Previously cached source CDN objects require the original provider's revocation
checks; a new bucket cannot invalidate another bucket's cached URLs. The local
fixture proves DB replay and local storage behavior, not CDN propagation.

Local constrained-role acceptance uses the unique disposable
`may-be-recovery-review-20261110` project from
infra/operations/recovery-review.compose.yml, loopback port 55439. It never touches
the parent non-launch container. PostgreSQL 17 tool wrappers address only this
fixture and mount /tmp/may-be-recovery-review at the same path. Its dummy roles
have no superuser, CREATEDB, CREATEROLE or BYPASSRLS privileges. The bootstrap
superuser only creates isolated databases/roles, never backs up or restores.

The source owner applies migrations. The backup role receives CONNECT on the
source DB, USAGE on public/drizzle, SELECT on all their tables and sequences;
no INSERT/UPDATE/DELETE/TRUNCATE, sequence USAGE/nextval, schema CREATE or role
membership is needed. Apply matching default SELECT grants for future migrations,
and grant new schema USAGE explicitly. PostgreSQL catalog reads, snapshot export
and built-in advisory lock calls retain their normal permissions. Backup source
transactions and pg_dump are read-only. Archive status writes require a separate
runtime connection. The fixture asserts writes, schema creation and nextval fail.

The restore identity owns only its isolated target DB/schema and can create
objects there; it needs no cluster privileges or source-owner membership.
--no-owner --no-privileges leaves restored objects owned by this target identity,
without restoring source ACLs. Restore replay uses that target owner while closed;
append-only journal triggers and domain constraints remain enabled. Runtime
access is deliberately absent until the operator grants CONNECT, schema USAGE,
SELECT/INSERT/UPDATE/DELETE on runtime tables and USAGE/SELECT on runtime sequences,
then reapplies the narrower journal policy: only SELECT/INSERT on recovery_events,
no recovery_replay access, no TRUNCATE or DDL. Review function/default privileges
as part of that bootstrap. Never run app/worker as the restore owner. Reopening
requires separately removing the target restore row and matching file gate; the
fixture proves removing only the DB row leaves serviceState closed.

Actual review acceptance restored four tiny assets (eight 68-byte private
objects), replayed later account deletion/suspension/media removal, expired an
incomplete upload, invalidated sessions and reconstructed only allowed public
media. A native-tool failure injected immediately after successful pg_restore
commit left real restored tables/data, no restore status row yet, and the shared
filesystem gate still closed. The redacted measurements are in
infra/operations/recovery-review-acceptance.json; these establish local executable
recovery, not production RTO, hosted-provider or CDN acceptance.

Final primary acceptance passes **30 recovery tests across five files** against
the full migration chain. The tiny eight-object restore took **32.748 seconds**.
The last independent review found a missed cancellation check when the journal
iterator reached EOF with a partial batch. A real encrypted-restore regression
first reproduced post-cancellation replay on the old code. Restore now checks
the signal before that tail batch as well as afterward; the regression proves
no replay call, no changed subject or replay watermark, no validated report, and
a closed service. The full rerun also retains private-copy/publication abort,
post-pg_restore crash, constrained-role and retention coverage.

Reproduce (dummy fixture only):

```sh
mkdir -p /tmp/may-be-recovery-review
chmod 700 /tmp/may-be-recovery-review
docker compose -p may-be-recovery-review-20261110 -f infra/operations/recovery-review.compose.yml up -d --wait
RECOVERY_TEST_DATABASE_URL=postgres://recovery_source:source_local_dummy@127.0.0.1:55439/recovery_test \
RECOVERY_READONLY_DATABASE_URL=postgres://recovery_backup:backup_local_dummy@127.0.0.1:55439/recovery_test \
RESTORE_TEST_DATABASE_URL=postgres://recovery_target:target_local_dummy@127.0.0.1:55439/restore_test \
RECOVERY_CRASH_DATABASE_URL=postgres://recovery_target:target_local_dummy@127.0.0.1:55439/crash_test \
RECOVERY_RUNTIME_DATABASE_URL=postgres://recovery_runtime:runtime_local_dummy@127.0.0.1:55439/restore_test \
RECOVERY_TEST_WORK_ROOT=/tmp/may-be-recovery-review \
PG_DUMP_BIN="$PWD/infra/operations/recovery-review-pg-dump.sh" \
PG_RESTORE_BIN="$PWD/infra/operations/recovery-review-pg-restore.sh" \
RECOVERY_ACCEPTANCE_REPORT=infra/operations/recovery-review-acceptance.json \
  npx vitest run tests/recovery
docker compose -p may-be-recovery-review-20261110 -f infra/operations/recovery-review.compose.yml down --volumes
```

The fixture uses the complete migration chain, including 0007_publication_counter.
All URLs must name dedicated *_test DBs. A
supplied inaccessible URL fails; missing source/target variables explicitly skip
DB acceptance. Other recovery tests mock every S3 request, including 251,007 remote
objects and 260,000 local directory entries, bounded restart/checkpoint traversal,
independent destination failure and admission-size manifests. No real provider
calls or external messages are part of this acceptance.
