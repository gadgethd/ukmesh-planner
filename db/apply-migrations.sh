#!/usr/bin/env bash
# apply-migrations.sh — apply planner datastore migrations in filename order.
#
# Usage:
#   DATABASE_URL=postgres://planner:...@host:5432/planner db/apply-migrations.sh
#
# Requires psql on PATH (at deploy time, run from a postgres container or the
# VPS host). Migrations are written idempotently; re-running is safe.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
DIR="$(cd "$(dirname "$0")" && pwd)/planner-migrations"

shopt -s nullglob
files=("$DIR"/*.sql)
if [ ${#files[@]} -eq 0 ]; then
  echo "no migrations found in $DIR" >&2
  exit 1
fi

for f in "${files[@]}"; do
  echo "applying $(basename "$f")"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f"
done

echo "migrations applied (${#files[@]} file(s))"
