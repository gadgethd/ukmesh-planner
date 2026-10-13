#!/usr/bin/env bash
# test-export.sh — fixture-test the planner export provisioning SQL.
#
# Spins up a scratch postgres:16-alpine (tmpfs — no volumes), builds the
# synthetic source fixture (fixtures/source/01_source_fixture.sql), applies
# db/source-export-provision/*.sql exactly as they would run on the live
# database, then asserts:
#   1. privacy semantics (member-wide 🚫 exclusion, scope rules, link filters)
#   2. reader-role permission boundaries (SELECT-only, read-only transactions)
#   3. idempotency of the provisioning SQL and correctness of the rollback
#
# Usage: fixtures/source/test-export.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
C=planner-src-fixture
READER_PW="fixture-reader-pw"

cleanup() { docker rm -f "$C" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker rm -f "$C" >/dev/null 2>&1 || true

docker run -d --rm --name "$C" --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_PASSWORD=test -e POSTGRES_USER=meshcore -e POSTGRES_DB=meshcore \
  postgres:16-alpine >/dev/null

# Wait for the FINAL server AND the target database: pg_isready alone can
# succeed against the entrypoint's temporary init server (no user DB yet),
# which made CI fail with 'database "meshcore" does not exist'.
ready=""
for _ in $(seq 1 60); do
  if docker exec "$C" psql -U meshcore -d meshcore -qtA -c "SELECT 1" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ -z "$ready" ]; then
  echo "FATAL: scratch postgres never became ready"
  docker logs "$C" 2>&1 | tail -20
  exit 1
fi

ADMIN_Q()  { docker exec -i "$C" psql -U meshcore -d meshcore -qtA "$@"; }
READER_Q() { docker exec -i "$C" psql -U ukmesh_planner_reader -d meshcore -qtA "$@"; }

fail=0
check() { # check <label> <expected> <sql>
  local got
  got="$(ADMIN_Q -c "$3" 2>&1)"
  if [ "$got" = "$2" ]; then echo "PASS: $1"; else echo "FAIL: $1 — expected [$2] got [$got]"; fail=1; fi
}
allow() { # allow <label> <expected> <sql> — as the reader role
  local got
  got="$(READER_Q -c "$3" 2>&1)"
  if [ "$got" = "$2" ]; then echo "PASS: $1"; else echo "FAIL: $1 — expected [$2] got [$got]"; fail=1; fi
}
deny() { # deny <label> <sql> — must fail as the reader role
  if READER_Q -c "$2" >/dev/null 2>&1; then
    echo "FAIL: $1 — unexpectedly allowed"; fail=1
  else
    echo "PASS: $1 (denied)"
  fi
}

echo "==> applying synthetic source fixture"
docker exec -i "$C" psql -U meshcore -d meshcore -v ON_ERROR_STOP=1 -q < "$HERE/01_source_fixture.sql"

echo "==> applying provisioning SQL (reader role + views, exactly as deploy)"
docker exec -i "$C" psql -U meshcore -d meshcore -v ON_ERROR_STOP=1 -q \
  -v reader_password="$READER_PW" -f - < "$REPO/db/source-export-provision/01_reader_role.sql"
docker exec -i "$C" psql -U meshcore -d meshcore -v ON_ERROR_STOP=1 -q \
  -f - < "$REPO/db/source-export-provision/02_schema_views.sql"

echo "==> idempotency: re-apply both files"
docker exec -i "$C" psql -U meshcore -d meshcore -v ON_ERROR_STOP=1 -q \
  -v reader_password="$READER_PW" -f - < "$REPO/db/source-export-provision/01_reader_role.sql"
docker exec -i "$C" psql -U meshcore -d meshcore -v ON_ERROR_STOP=1 -q \
  -f - < "$REPO/db/source-export-provision/02_schema_views.sql"

echo "==> privacy + scope assertions"
check "repeater count = 3"                      "3" "select count(*) from planner_export.public_repeaters_v1;"
check "N1 public present"                       "1" "select count(*) from planner_export.public_repeaters_v1 where canonical_id = repeat('1',64);"
check "N2 legacy-network included"              "1" "select count(*) from planner_export.public_repeaters_v1 where canonical_id = repeat('2',64);"
check "N3 sighting-scoped included"             "1" "select count(*) from planner_export.public_repeaters_v1 where canonical_id = repeat('3',64);"
check "N4 no-scope excluded"                    "0" "select count(*) from planner_export.public_repeaters_v1 where canonical_id = repeat('4',64);"
check "N5 direct-private excluded"              "0" "select count(*) from planner_export.public_repeaters_v1 where canonical_id = repeat('5',64);"
check "N6 alias-member-private excluded"        "0" "select count(*) from planner_export.public_repeaters_v1 where canonical_id = repeat('6',64);"
check "N7 role-null excluded"                   "0" "select count(*) from planner_export.public_repeaters_v1 where canonical_id = repeat('7',64);"
check "N8 unpositioned excluded"                "0" "select count(*) from planner_export.public_repeaters_v1 where canonical_id = repeat('8',64);"
check "N9 test-only excluded"                   "0" "select count(*) from planner_export.public_repeaters_v1 where canonical_id = repeat('a',64);"
check "N10 prefix-registry-private excluded"    "0" "select count(*) from planner_export.public_repeaters_v1 where canonical_id = repeat('b',64);"
check "links count = 2"                         "2" "select count(*) from planner_export.public_observed_links_v1;"
check "link N1-N2 kept with counts"             "40|30|10|12" "select observed_count||'|'||count_a_to_b||'|'||count_b_to_a||'|'||strong_observation_count from planner_export.public_observed_links_v1 where source_id = repeat('1',64) and target_id = repeat('2',64);"
check "link N2-N3 kept"                         "1" "select count(*) from planner_export.public_observed_links_v1 where source_id = repeat('2',64) and target_id = repeat('3',64);"
check "links to direct-private dropped"         "0" "select count(*) from planner_export.public_observed_links_v1 where source_id = repeat('5',64) or target_id = repeat('5',64);"
check "links to alias-private dropped"          "0" "select count(*) from planner_export.public_observed_links_v1 where source_id = repeat('6',64) or target_id = repeat('6',64);"
check "links to unpublished endpoint dropped"   "0" "select count(*) from planner_export.public_observed_links_v1 where source_id = repeat('4',64) or target_id = repeat('4',64) or source_id = repeat('7',64) or target_id = repeat('7',64);"
check "links to prefix-private dropped"         "0" "select count(*) from planner_export.public_observed_links_v1 where source_id = repeat('b',64) or target_id = repeat('b',64);"
check "fence generation = 810"                  "810" "select generation from planner_export.visibility_fence_v1;"

echo "==> reader-role permission boundaries"
allow "reader SELECTs public_repeaters_v1"      "3" "select count(*) from planner_export.public_repeaters_v1;"
allow "reader SELECTs public_observed_links_v1" "2" "select count(*) from planner_export.public_observed_links_v1;"
allow "reader SELECTs visibility_fence_v1"      "810" "select generation from planner_export.visibility_fence_v1;"
allow "reader transactions are read-only"       "on" "show default_transaction_read_only;"
allow "reader defaults to hash joins"           "off" "show enable_nestloop;"
deny  "reader CANNOT read raw nodes"            "select count(*) from nodes;"
deny  "reader CANNOT read raw node_links"       "select count(*) from node_links;"
deny  "reader CANNOT insert into views"         "insert into planner_export.visibility_fence_v1 (generation) values (1);"
deny  "reader CANNOT create tables"             "create table planner_export.evil (i int);"
deny  "reader CANNOT write source tables"       "update nodes set name = 'x' where node_id = repeat('1',64);"

echo "==> rollback proof"
docker exec -i "$C" psql -U meshcore -d meshcore -v ON_ERROR_STOP=1 -q -f - < "$REPO/db/source-export-provision/99_rollback.sql"
check "views removed"        "0" "select count(*) from pg_views where schemaname = 'planner_export';"
check "role removed"         "0" "select count(*) from pg_roles where rolname = 'ukmesh_planner_reader';"
check "source data untouched" "11" "select count(*) from nodes;"

if [ "$fail" -eq 0 ]; then
  echo "==> ALL CHECKS PASSED"
else
  echo "==> FAILURES PRESENT"; exit 1
fi
