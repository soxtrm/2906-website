#!/usr/bin/env bash
# Viewing windows (2026-11-21): an owner's yes to one viewing and SYNC calendar hours/proposals no longer wipe the other hours of that day. No schema change.
#   deploy.sh stage | apply | rollback | verify
set -euo pipefail
PKG="$(cd "$(dirname "$0")" && pwd)"; LIVE=/opt/2906-system/backend; CT=2906_backend; PG=2906_postgres; BKROOT=/opt/2906-system/backups
PATCHED="services/viewingWindows.js"
STAGE=/tmp/argus-vws-stage; TESTNET=argus-vws-net; TESTDB=argus-vws-db
TESTS="test/viewing-windows-siblings.test.js test/sync-calendar-2.test.js test/booking-owner-portal.test.cjs test/argus-dynamic-facts-booking-20260923.test.js test/marketplace-conversations.test.js test/sync-calendar.test.js test/claim-review.test.js test/staff-docs-private.test.js test/sync-delegates-docs.test.js test/sync-conditions.test.js test/sync-account.test.js test/sync-inbox-roles.test.js"
URL=http://127.0.0.1:3001
code() { curl -s -o /dev/null -m 10 -w '%{http_code}' "$@" || echo 000; }
wait_up() { for i in $(seq 1 45); do [ "$(code "$URL/api/properties")" = 200 ] && return 0; sleep 2; done; return 1; }
verify() {
  local fail=0
  [ "$(code "$URL/api/properties")" = 200 ] && echo "ok   properties 200" || { echo "FAIL properties"; fail=1; }
  [ "$(code -X POST -H 'content-type: application/json' -d '{}' "$URL/api/sync-account/v1/owner/window/add")" = 401 ] && echo "ok   unsigned window/add 401" || { echo "FAIL window/add auth"; fail=1; }
  [ "$(code -X POST -H 'content-type: application/json' -d '{}' "$URL/api/sync-account/v1/owner/viewings/decide")" = 401 ] && echo "ok   unsigned viewings/decide 401" || { echo "FAIL decide auth"; fail=1; }
  c=$(docker exec 2906_waha node -e "fetch('http://backend:3001/webhook/waha',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event:'security.probe',session:'x',payload:{}})}).then(r=>console.log(r.status)).catch(()=>console.log(0))" 2>/dev/null || echo 0)
  [ "$c" = 200 ] && echo "ok   WhatsApp gateway reaches the backend" || { echo "FAIL gateway -> backend ($c)"; fail=1; }
  [ "$fail" = 0 ] && echo "VERIFY OK" || { echo "VERIFY FAILED"; return 1; }
}
case "${1:-}" in
  stage)
    docker rm -f "$TESTDB" >/dev/null 2>&1 || true; docker network rm "$TESTNET" >/dev/null 2>&1 || true; rm -rf "$STAGE"; mkdir -p "$STAGE"
    rsync -a --exclude node_modules --exclude uploads --exclude logs --exclude '.*' --exclude backups --exclude '*.log' --exclude exports --exclude private-docs "$LIVE/" "$STAGE/"
    mkdir -p "$STAGE/test" "$STAGE/node_modules" "$STAGE/uploads"
    python3 "$PKG/patch.py" "$STAGE"; cp "$PKG"/backend/test/*.test.js "$STAGE/test/"
    for f in $PATCHED; do docker run --rm --network none -v "$STAGE:/app:ro" -w /app --entrypoint node 2906-system-backend --check "$f"; done
    docker network create --internal "$TESTNET" >/dev/null
    docker run -d --rm --name "$TESTDB" --network "$TESTNET" -e POSTGRES_PASSWORD=test pgvector/pgvector:pg16 >/dev/null
    for i in $(seq 1 40); do docker exec "$TESTDB" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 2
    docker exec "$PG" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -s --no-owner --no-privileges' > "$STAGE/schema.sql"
    docker exec "$TESTDB" psql -U postgres -q -c 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"'
    docker exec -i "$TESTDB" psql -U postgres -q < "$STAGE/schema.sql" > /dev/null 2>&1 || true
    set +e; r=0
    for t in $TESTS; do
      docker exec -e PGOPTIONS="-c client_min_messages=warning" "$TESTDB" psql -U postgres -q -c "DO \$\$ DECLARE r record; BEGIN FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP EXECUTE 'TRUNCATE ' || quote_ident(r.tablename) || ' RESTART IDENTITY CASCADE'; END LOOP; END \$\$" >/dev/null
      docker run --rm --network "$TESTNET" -v "$STAGE:/app" -v "$LIVE/node_modules:/app/node_modules:ro" -w /app \
        -e BACKEND_DIR=/app -e NODE_ENV=test -e PGHOST="$TESTDB" --entrypoint timeout 2906-system-backend 300 node --test --test-force-exit --test-concurrency=1 "$t" > /tmp/argus-vws.out 2>&1
      rt=$?; echo "== $t"; grep -E "^# (pass|fail)" /tmp/argus-vws.out || head -40 /tmp/argus-vws.out
      [ "$rt" = 0 ] || { r=1; grep -B2 -A30 "^not ok" /tmp/argus-vws.out | cut -c1-300 | head -120; }
    done
    set -e
    docker rm -f "$TESTDB" >/dev/null 2>&1 || true; docker network rm "$TESTNET" >/dev/null 2>&1 || true; rm -rf "$STAGE"
    [ "$r" = 0 ] && echo "STAGE TESTS PASSED" || { echo "STAGE TESTS FAILED"; exit 1; }
    ;;
  apply)
    python3 "$PKG/patch.py" "$LIVE" --check
    TS=$(date -u +%Y%m%dT%H%M%SZ); BK="$BKROOT/viewing-windows-siblings-$TS"; mkdir -p "$BK/routes" "$BK/services"
    for f in $PATCHED; do cp -p "$LIVE/$f" "$BK/$f"; done
    echo "$BK" > "$BKROOT/viewing-windows-siblings-latest"; echo "backup: $BK"
    restore() { echo "ROLLING BACK"; for f in $PATCHED; do cp -p "$BK/$f" "$LIVE/$f"; done; docker restart "$CT" >/dev/null; wait_up && echo "rolled back, backend up"; }
    python3 "$PKG/patch.py" "$LIVE" || { restore; exit 1; }
    for f in $PATCHED; do docker run --rm --network none -v "$LIVE:/app:ro" -w /app --entrypoint node 2906-system-backend --check "$f" || { restore; exit 1; }; done
    docker restart "$CT" >/dev/null; wait_up || { restore; exit 1; }; sleep 5
    verify || { restore; exit 1; }
    if docker logs --since 2m "$CT" 2>&1 | grep -E "Cannot find module|SyntaxError|ReferenceError" | head -3 | grep -q .; then restore; exit 1; fi
    echo "APPLIED AND VERIFIED"
    ;;
  rollback)
    BK=$(cat "$BKROOT/viewing-windows-siblings-latest"); for f in $PATCHED; do cp -p "$BK/$f" "$LIVE/$f"; done
    docker restart "$CT" >/dev/null; wait_up && echo "rolled back to $BK"
    ;;
  verify) verify ;;
  *) echo "usage: deploy.sh stage|apply|rollback|verify"; exit 2 ;;
esac
