#!/usr/bin/env bash
# NEXUS SYNC owner conditions + owner activity (2026-11-21).
#   deploy.sh stage    patched copy of the live backend + throwaway PostgreSQL (live schema, no rows): new tests + existing SYNC tests
#   deploy.sh apply    backup (files + full database dump), additive migration, new service file, exact-anchor patch, restart, verify
#   deploy.sh rollback restore the two patched files, remove the new service file, restart (the table stays; down.sql removes it)
#   deploy.sh verify
set -euo pipefail
PKG="$(cd "$(dirname "$0")" && pwd)"; LIVE=/opt/2906-system/backend; CT=2906_backend; PG=2906_postgres; BKROOT=/opt/2906-system/backups
STAGE=/tmp/argus-sync-cond-stage; TESTNET=argus-sync-cond-net; TESTDB=argus-sync-cond-db
PATCHED="routes/syncAccountService.js services/syncAccount.js"; NEWFILE=services/syncPropertyConditions.js
MIG=migrations/20261121_sync_property_conditions.sql; MIGDOWN=migrations/20261121_sync_property_conditions.down.sql
URL=http://127.0.0.1:3001
code() { curl -s -o /dev/null -m 10 -w '%{http_code}' "$@" || echo 000; }
wait_up() { for i in $(seq 1 45); do [ "$(code "$URL/api/properties")" = 200 ] && return 0; sleep 2; done; return 1; }
cleanup() { docker rm -f "$TESTDB" >/dev/null 2>&1 || true; docker network rm "$TESTNET" >/dev/null 2>&1 || true; }
psql_live() { docker exec -i "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -v ON_ERROR_STOP=1 -q'; }
verify() {
  local fail=0
  [ "$(code "$URL/api/properties")" = 200 ] && echo "ok   properties 200" || { echo "FAIL properties"; fail=1; }
  for p in owner/conditions owner/conditions/set owner/conditions/decide owner/activity owner/viewings; do
    [ "$(code -X POST -H 'content-type: application/json' -d '{}' "$URL/api/sync-account/v1/$p")" = 401 ] && echo "ok   unsigned $p 401" || { echo "FAIL unsigned $p"; fail=1; }
  done
  [ "$(echo "SELECT to_regclass('nexus_property_conditions') IS NOT NULL" | docker exec -i "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -At')" = t ] && echo "ok   table present" || { echo "FAIL table"; fail=1; }
  [ "$fail" = 0 ] && echo "VERIFY OK" || { echo "VERIFY FAILED"; return 1; }
}
case "${1:-}" in
  stage)
    cleanup; rm -rf "$STAGE"; mkdir -p "$STAGE"
    rsync -a --exclude node_modules --exclude uploads --exclude logs --exclude '.*' --exclude backups --exclude '*.log' --exclude exports "$LIVE/" "$STAGE/"
    mkdir -p "$STAGE/test" "$STAGE/node_modules" "$STAGE/uploads" "$STAGE/migrations"
    python3 "$PKG/patch.py" "$STAGE"
    cp "$PKG/backend/$NEWFILE" "$STAGE/$NEWFILE"; cp "$PKG"/backend/test/*.test.js "$STAGE/test/"
    for f in $PATCHED $NEWFILE; do docker run --rm --network none -v "$STAGE:/app:ro" -w /app --entrypoint node 2906-system-backend --check "$f"; done
    docker network create --internal "$TESTNET" >/dev/null
    docker run -d --rm --name "$TESTDB" --network "$TESTNET" -e POSTGRES_PASSWORD=test pgvector/pgvector:pg16 >/dev/null
    for i in $(seq 1 40); do docker exec "$TESTDB" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 2
    docker exec "$PG" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -s --no-owner --no-privileges' > "$STAGE/schema.sql"
    docker exec "$TESTDB" psql -U postgres -q -c 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"'
    docker exec -i "$TESTDB" psql -U postgres -q < "$STAGE/schema.sql" > "$STAGE/schema.log" 2>&1 || true
    docker exec -i "$TESTDB" psql -U postgres -v ON_ERROR_STOP=1 -q < "$PKG/backend/$MIG"
    set +e; r=0
    for t in test/sync-conditions.test.js test/sync-account.test.js test/sync-inbox-roles.test.js; do
      docker exec -e PGOPTIONS="-c client_min_messages=warning" "$TESTDB" psql -U postgres -q -c "DO \$\$ DECLARE r record; BEGIN FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP EXECUTE 'TRUNCATE ' || quote_ident(r.tablename) || ' RESTART IDENTITY CASCADE'; END LOOP; END \$\$" >/dev/null
      docker run --rm --network "$TESTNET" -v "$STAGE:/app:ro" -v "$LIVE/node_modules:/app/node_modules:ro" -w /app \
        -e BACKEND_DIR=/app -e NODE_ENV=test -e PGHOST="$TESTDB" --entrypoint timeout 2906-system-backend 240 node --test --test-force-exit --test-concurrency=1 "$t" > /tmp/argus-sync-cond.out 2>&1
      rt=$?; echo "== $t"; grep -E "^# (pass|fail)" /tmp/argus-sync-cond.out
      [ "$rt" = 0 ] || { r=1; grep -B2 -A24 "^not ok" /tmp/argus-sync-cond.out | cut -c1-260 | head -120; }
    done
    docker exec -i "$TESTDB" psql -U postgres -v ON_ERROR_STOP=1 -q < "$PKG/backend/$MIGDOWN" && docker exec -i "$TESTDB" psql -U postgres -v ON_ERROR_STOP=1 -q < "$PKG/backend/$MIG" && echo "ok   migration down + up" || r=1
    set -e
    cleanup; rm -rf "$STAGE"
    [ "$r" = 0 ] && echo "STAGE TESTS PASSED" || { echo "STAGE TESTS FAILED"; exit 1; }
    ;;
  apply)
    python3 "$PKG/patch.py" "$LIVE" --check
    [ ! -e "$LIVE/$NEWFILE" ] || { echo "REFUSE: $NEWFILE already exists"; exit 1; }
    TS=$(date -u +%Y%m%dT%H%M%SZ); BK="$BKROOT/sync-conditions-$TS"; mkdir -p "$BK/routes" "$BK/services"
    for f in $PATCHED; do cp -p "$LIVE/$f" "$BK/$f"; done
    docker exec "$PG" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$BK/argus-db.dump"
    n=$(docker exec -i "$PG" pg_restore -l < "$BK/argus-db.dump" | grep -c "TABLE DATA" || true)
    [ "${n:-0}" -gt 50 ] || { echo "REFUSE: database backup looks wrong ($n tables)"; exit 1; }
    echo "$BK" > "$BKROOT/sync-conditions-latest"; echo "backup: $BK ($n tables in the dump)"
    restore() { echo "ROLLING BACK"; for f in $PATCHED; do cp -p "$BK/$f" "$LIVE/$f"; done; rm -f "$LIVE/$NEWFILE"; docker restart "$CT" >/dev/null; wait_up && echo "rolled back, backend up" || echo "ROLLBACK: backend not answering"; }
    psql_live < "$PKG/backend/$MIG" || { echo "migration failed, nothing else changed"; exit 1; }
    mkdir -p "$LIVE/migrations"; cp "$PKG/backend/$MIG" "$PKG/backend/$MIGDOWN" "$LIVE/migrations/"
    cp "$PKG/backend/$NEWFILE" "$LIVE/$NEWFILE"
    python3 "$PKG/patch.py" "$LIVE" || { restore; exit 1; }
    for f in $PATCHED $NEWFILE; do docker run --rm --network none -v "$LIVE:/app:ro" -w /app --entrypoint node 2906-system-backend --check "$f" || { restore; exit 1; }; done
    docker restart "$CT" >/dev/null
    wait_up || { docker logs --tail 30 "$CT" 2>&1 | cut -c1-200; restore; exit 1; }
    sleep 5
    verify || { restore; exit 1; }
    if docker logs --since 2m "$CT" 2>&1 | grep -E "Cannot find module|SyntaxError|ReferenceError" | head -3 | grep -q .; then restore; exit 1; fi
    echo "APPLIED AND VERIFIED"
    ;;
  rollback)
    BK=$(cat "$BKROOT/sync-conditions-latest"); for f in $PATCHED; do cp -p "$BK/$f" "$LIVE/$f"; done; rm -f "$LIVE/$NEWFILE"
    docker restart "$CT" >/dev/null; wait_up && echo "rolled back to $BK (table kept; $MIGDOWN removes it)"
    ;;
  verify) verify ;;
  *) echo "usage: deploy.sh stage|apply|rollback|verify"; exit 2 ;;
esac
