#!/usr/bin/env bash
# ARGUS Facebook Pages — run the unit and integration tests against a THROW-AWAY
# Postgres restored from the newest verified ARGUS backup, on an internal Docker
# network (no internet: Meta is the in-memory fake; no production database).
# Production backend code is mounted read-only; this change's files are overlaid.
# Everything is removed at the end.   Usage (on the VPS):  bash run_isolated_tests.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
NET=fbpages-test-net; DB=fbpages-testdb; RD=fbpages-testredis; PW="t$(date +%s)"
DUMP="$(ls -t /var/backups/2906/premigration/postgres/2906db_*.dump /var/backups/2906/postgres/2906db_*.dump 2>/dev/null | head -1)"
[ -s "$DUMP" ] || { echo "no backup dump found" >&2; exit 2; }
cleanup() { docker rm -f "$DB" "$RD" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
docker network create --internal "$NET" >/dev/null
docker run -d --name "$RD" --network "$NET" redis:7-alpine >/dev/null
docker run -d --name "$DB" --network "$NET" -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB=argus_test pgvector/pgvector:pg16 >/dev/null
for i in $(seq 1 60); do docker exec "$DB" pg_isready -U postgres -d argus_test >/dev/null 2>&1 && break; sleep 1; done
sleep 2
echo "restoring $(basename "$DUMP") into the throw-away database"
docker cp "$DUMP" "$DB:/tmp/db.dump"
docker exec "$DB" pg_restore -U postgres -d argus_test --no-owner --no-acl -j 4 /tmp/db.dump > /tmp/fbpages-restore.log 2>&1 || true
docker exec "$DB" psql -U postgres -d argus_test -Atc "select count(*) from properties" | sed 's/^/properties in copy: /'
echo "applying migration (twice: it must be re-runnable)"
for i in 1 2; do docker exec -i "$DB" psql -U postgres -d argus_test -v ON_ERROR_STOP=1 -q < "$HERE/backend/migrations/20261114_facebook_pages.sql"; done
docker run --rm --network "$NET" -v /opt/2906-system/backend:/base:ro -v "$HERE/backend":/src:ro \
  -e ARGUS_BASE_DIR=/base -e NODE_PATH=/base/node_modules -e TEST_DB_HOST="$DB" -e TEST_DB_NAME=argus_test -e TEST_DB_USER=postgres -e TEST_DB_PASSWORD="$PW" \
  -e TEST_REDIS_HOST="$RD" \
  -w /src 2906-system-backend sh -c 'node --test test/facebookPages.unit.test.js && node --test --test-concurrency=1 test/facebookPages.integration.test.js && node --test --test-force-exit test/facebookPages.jobs.test.js'
echo "down migration check"
docker exec -i "$DB" psql -U postgres -d argus_test -v ON_ERROR_STOP=1 -q < "$HERE/backend/migrations/20261114_facebook_pages.down.sql"
docker exec "$DB" psql -U postgres -d argus_test -Atc "select count(*) from information_schema.tables where table_name like 'agent_facebook_%'" | sed 's/^/agent_facebook tables after down: /'
