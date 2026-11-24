#!/bin/sh
# Dedicated disposable recovery-review project only; no application DB tools.
set -eu
exec docker exec --user "$(id -u):$(id -g)" -e PGPASSWORD -e PGDATABASE -e PGUSER -e PGHOST=127.0.0.1 -e PGPORT=5432 may-be-recovery-review-20261110-db-1 pg_restore "$@"
