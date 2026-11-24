#!/bin/sh
# Isolated fixture only. Uses the dedicated test container, never application DB.
set -eu
exec docker exec --user "$(id -u):$(id -g)" -e PGPASSWORD -e PGDATABASE -e PGUSER -e PGHOST=127.0.0.1 -e PGPORT=5432 may-be-worker-fixture-db-1 pg_dump "$@"
