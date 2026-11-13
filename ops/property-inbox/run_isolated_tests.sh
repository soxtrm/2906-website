#!/usr/bin/env bash
# Runs the Incoming Properties tests against a THROW-AWAY Postgres restored from the
# newest verified ARGUS backup, on an internal Docker network (no internet, no
# production database). Production backend code is mounted read-only; this
# change's files are overlaid. Everything is removed at the end.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
NET=intake-test-net; DB=intake-testdb; PW="t$(date +%s)"
DUMP="$(ls -t /var/backups/2906/premigration/postgres/2906db_*.dump /var/backups/2906/postgres/2906db_*.dump 2>/dev/null | head -1)"
[ -s "$DUMP" ] || { echo "no backup dump found" >&2; exit 2; }
cleanup() { docker rm -f "$DB" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
docker network create --internal "$NET" >/dev/null
docker run -d --name "$DB" --network "$NET" -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB=argus_test pgvector/pgvector:pg16 >/dev/null
for i in $(seq 1 60); do docker exec "$DB" pg_isready -U postgres -d argus_test >/dev/null 2>&1 && break; sleep 1; done
sleep 2
echo "restoring $(basename "$DUMP")"
docker cp "$DUMP" "$DB:/tmp/db.dump"
docker exec "$DB" pg_restore -U postgres -d argus_test --no-owner --no-acl -j 4 /tmp/db.dump > /tmp/intake-restore.log 2>&1 || true
docker exec "$DB" psql -U postgres -d argus_test -Atc "select count(*) from properties" | sed 's/^/properties in copy: /'
for m in "$@"; do echo "applying $(basename "$m")"; docker exec -i "$DB" psql -U postgres -d argus_test -v ON_ERROR_STOP=1 -q < "$m"; done
docker run --rm --network "$NET" -v /opt/2906-system/backend:/base:ro -v "$HERE/backend":/src:ro \
  -e ARGUS_BASE_DIR=/base -e NODE_PATH=/base/node_modules -e TEST_DB_HOST="$DB" -e TEST_DB_NAME=argus_test -e TEST_DB_USER=postgres -e TEST_DB_PASSWORD="$PW" \
  -w /src 2906-system-backend node --test --test-concurrency=1 test/intake.unit.test.js test/intake.integration.test.js
