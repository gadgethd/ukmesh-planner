#!/usr/bin/env bash
# test-ingest.sh — end-to-end ingester test on scratch databases.
#
#   1. scratch SOURCE db: synthetic fixture + real provisioning SQL
#   2. scratch PLANNER db: migration 0001_core
#   3. run the ingester (--once) three times and verify:
#        run 1: publishes snapshot (3 repeaters / 2 links / generation 810)
#        run 2: publishes a new snapshot, previous becomes 'superseded'
#        run 3: rejected by the hard floor — nonzero exit, nothing published
#
# Usage: fixtures/source/test-ingest.sh   (from the repo root or anywhere)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
SRC=planner-src-e2e
PLN=planner-pln-e2e
SRC_PORT=55441
PLN_PORT=55442
READER_PW=fixture-reader-pw

cleanup() { docker rm -f "$SRC" "$PLN" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker rm -f "$SRC" "$PLN" >/dev/null 2>&1 || true

docker run -d --rm --name "$SRC" --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_PASSWORD=test -e POSTGRES_USER=meshcore -e POSTGRES_DB=meshcore \
  -p 127.0.0.1:$SRC_PORT:5432 postgres:16-alpine >/dev/null
docker run -d --rm --name "$PLN" --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_PASSWORD=test -e POSTGRES_USER=planner -e POSTGRES_DB=planner \
  -p 127.0.0.1:$PLN_PORT:5432 postgres:16-alpine >/dev/null

wait_ready() {
  for _ in $(seq 1 60); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "FATAL: database never became ready: $*"
  exit 1
}
wait_ready docker exec "$SRC" psql -U meshcore -d meshcore -qtA -c "SELECT 1"
wait_ready docker exec "$PLN" psql -U planner -d planner -qtA -c "SELECT 1"

echo "== applying source fixture + provisioning =="
docker exec -i "$SRC" psql -U meshcore -d meshcore -v ON_ERROR_STOP=1 -q < "$HERE/01_source_fixture.sql"
docker exec -i "$SRC" psql -U meshcore -d meshcore -v ON_ERROR_STOP=1 -q \
  -v reader_password="$READER_PW" -f - < "$REPO/db/source-export-provision/01_reader_role.sql"
docker exec -i "$SRC" psql -U meshcore -d meshcore -v ON_ERROR_STOP=1 -q \
  -f - < "$REPO/db/source-export-provision/02_schema_views.sql"

echo "== applying planner migration =="
docker exec -i "$PLN" psql -U planner -d planner -v ON_ERROR_STOP=1 -q < "$REPO/db/planner-migrations/0001_core.sql"

PQ() { docker exec -i "$PLN" psql -U planner -d planner -qtA -c "$1"; }
check() {
  local got
  got="$(PQ "$2")"
  if [ "$got" = "$3" ]; then echo "PASS: $1"; else echo "FAIL: $1 — expected [$3] got [$got]"; exit 1; fi
}

export SOURCE_DB_READONLY_URL="postgres://ukmesh_planner_reader:${READER_PW}@127.0.0.1:${SRC_PORT}/meshcore"
export PLANNER_DB_URL="postgres://planner:test@127.0.0.1:${PLN_PORT}/planner"
export INGEST_REPEATER_MIN=1 INGEST_LINK_MIN=1

cd "$REPO"

echo "== run 1: expect publish =="
npx tsx apps/ingest/src/main.ts --once >/tmp/ingest-run1.log 2>&1 || { cat /tmp/ingest-run1.log; exit 1; }
check "one published snapshot"    "SELECT count(*) FROM source_snapshots WHERE status = 'published';" "1"
check "published counts 3/2"      "SELECT repeater_count || '/' || link_count FROM source_snapshots WHERE status = 'published';" "3/2"
check "repeaters stored = 3"      "SELECT count(*) FROM source_repeaters;" "3"
check "links stored = 2"          "SELECT count(*) FROM source_observed_links;" "2"
check "generation recorded = 810" "SELECT source_generation FROM source_snapshots WHERE status = 'published';" "810"
check "fence checked recently"    "SELECT (fence_checked_at > now() - interval '10 minutes')::text FROM source_snapshots WHERE status = 'published';" "true"

echo "== run 2: expect supersede of run-1 snapshot =="
RUN1_ID="$(PQ "SELECT id FROM source_snapshots WHERE status = 'published';")"
npx tsx apps/ingest/src/main.ts --once >/tmp/ingest-run2.log 2>&1 || { cat /tmp/ingest-run2.log; exit 1; }
check "still exactly one published" "SELECT count(*) FROM source_snapshots WHERE status = 'published';" "1"
check "run-1 snapshot superseded"   "SELECT status FROM source_snapshots WHERE id = '$RUN1_ID';" "superseded"
check "superseded kept for rollback" "SELECT count(*) FROM source_snapshots WHERE status = 'superseded';" "1"

echo "== run 3: expect rejection by hard floor (nonzero exit) =="
if INGEST_REPEATER_MIN=1000 npx tsx apps/ingest/src/main.ts --once >/tmp/ingest-run3.log 2>&1; then
  echo "FAIL: run 3 unexpectedly succeeded"; cat /tmp/ingest-run3.log; exit 1
else
  echo "PASS: run 3 rejected (nonzero exit)"
fi
check "no extra snapshot rows"   "SELECT count(*) FROM source_snapshots;" "2"
check "published untouched"      "SELECT count(*) FROM source_snapshots WHERE status = 'published';" "1"

echo "== ALL INGEST E2E CHECKS PASSED =="
