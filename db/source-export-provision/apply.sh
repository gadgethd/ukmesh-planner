#!/usr/bin/env bash
# apply.sh — provision the planner export surface on the SOURCE database.
#
# ADDITIVE ONLY: creates/updates one role and three read views. No source data
# is modified. Run as a superuser against the source DB (on the VPS this is
# `docker exec` into the TimescaleDB container, or a psql with admin creds).
#
# Usage:
#   SOURCE_ADMIN_URL='postgres://meshcore@…/meshcore' \
#   PLANNER_READER_PASSWORD="$(cat /path/to/secret-file)" \
#   ./apply.sh
#
# The password is read from the environment and never stored in Git.
set -euo pipefail

: "${SOURCE_ADMIN_URL:?SOURCE_ADMIN_URL is required}"
: "${PLANNER_READER_PASSWORD:?PLANNER_READER_PASSWORD is required}"

DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> 01: reader role"
psql "$SOURCE_ADMIN_URL" -v ON_ERROR_STOP=1 -v reader_password="$PLANNER_READER_PASSWORD" -f "$DIR/01_reader_role.sql"

echo "==> 02: schema + views + grants"
psql "$SOURCE_ADMIN_URL" -v ON_ERROR_STOP=1 -f "$DIR/02_schema_views.sql"

echo "==> done: planner export provisioned"
