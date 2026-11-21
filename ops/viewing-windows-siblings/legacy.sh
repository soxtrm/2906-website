#!/usr/bin/env bash
# The two script-style ARGUS booking tests (owner portal, dynamic facts) against a THROWAWAY database,
# once on the live code and once with the patch, so a difference can only come from the patch.
set -uo pipefail
PKG="$(cd "$(dirname "$0")" && pwd)"; LIVE=/opt/2906-system/backend; PG=2906_postgres
NET=argus-vwl-net; DB=argus-vwl-db; ST=/tmp/argus-vwl
cleanup() { docker rm -f "$DB" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; rm -rf "$ST"; }
cleanup
rsync -a --exclude node_modules --exclude uploads --exclude logs --exclude '.*' --exclude backups --exclude '*.log' --exclude exports --exclude private-docs "$LIVE/" "$ST/"
mkdir -p "$ST/node_modules" "$ST/uploads"
docker network create --internal "$NET" >/dev/null
docker run -d --rm --name "$DB" --network "$NET" -e POSTGRES_PASSWORD=test pgvector/pgvector:pg16 >/dev/null
for i in $(seq 1 40); do docker exec "$DB" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 2
docker exec "$PG" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -s --no-owner --no-privileges' > "$ST/schema.sql"
docker exec "$DB" psql -U postgres -q -c 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"' >/dev/null
docker exec -i "$DB" psql -U postgres -q < "$ST/schema.sql" > /dev/null 2>&1 || true
run() {
  for t in test/booking-owner-portal.test.cjs test/argus-dynamic-facts-booking-20260923.test.js; do
    docker run --rm --network "$NET" -v "$ST:/app" -v "$LIVE/node_modules:/app/node_modules:ro" -w /app \
      -e NODE_ENV=test -e POSTGRES_HOST="$DB" -e POSTGRES_DB=postgres -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=test -e REDIS_HOST=127.0.0.1 \
      --entrypoint timeout 2906-system-backend 240 node "$t" > /tmp/vwl.out 2>&1
    echo "$1 $t exit=$? :: $(grep -aE "PASS|pass|ok|FAIL|Error|assert" /tmp/vwl.out | tail -3 | tr '\n' ' ' | cut -c1-300)"
  done
}
run LIVE
python3 "$PKG/patch.py" "$ST" >/dev/null && run PATCHED
cleanup
