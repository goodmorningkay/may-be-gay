#!/bin/sh
set -eu

# Executed by the official image on an empty volume; may also be explicitly
# rerun by an operator. Passwords are passed via environment, never CLI args.
: "${MIGRATION_DATABASE_PASSWORD:?Set the local migration role password}"
: "${APP_DATABASE_PASSWORD:?Set the local runtime role password}"
export MIGRATION_DATABASE_PASSWORD APP_DATABASE_PASSWORD

psql --no-psqlrc --set=ON_ERROR_STOP=1 \
  --username="${POSTGRES_USER:-postgres}" \
  --dbname="${POSTGRES_DB:-may_be_gay}" \
  --file=/opt/may-be-gay/bootstrap.sql
