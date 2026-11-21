#!/usr/bin/env bash
# Viewing request follow-up (2026-11-21).
#   deploy.sh stage     copy live backend + this package, run the tests on a throwaway DB
#   deploy.sh apply     additive migration, 3 new files, 1 anchor edit in index.js, restart, verify, auto-restore
#   deploy.sh grant     owner-contact access for Olga (2) and Katya (13) only
#   deploy.sh rollback  restore index.js, remove the new files (tables kept; down.sql drops them)
#   deploy.sh verify
# Sends nothing by itself; the first agent question goes out the day after a booking slot.
set -euo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
LIVE=/opt/2906-system/backend
CT=2906_backend
PG=2906_postgres
STAGE=/tmp/argus-followups-stage
BKROOT=/opt/2906-system/backups
NEW="services/viewingFollowups.js routes/crmViewingFollowups.js"
MIG="migrations/20261121f_viewing_followups.sql migrations/20261121f_viewing_followups.down.sql"
URL=http://127.0.0.1:3001
TESTNET=argus-followups-testnet
TESTDB=argus-followups-testdb
TABLES="agents properties owner_contacts property_viewings agent_workspace_config pii_reveal_log"
code() { curl -s -o /dev/null -m 10 -w '%{http_code}' "$@" || echo 000; }
wait_up() { for i in $(seq 1 45); do [ "$(code "$URL/api/properties")" = 200 ] && return 0; sleep 2; done; return 1; }
cleanup_test() { docker rm -f "$TESTDB" >/dev/null 2>&1 || true; docker network rm "$TESTNET" >/dev/null 2>&1 || true; }
psql_live() { docker exec -i "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q'; }
verify() {
  local fail=0
  [ "$(code "$URL/api/properties")" = 200 ] && echo "ok   properties" || { echo "FAIL properties"; fail=1; }
  [ "$(code "$URL/api/crm/viewing-followups")" = 401 ] && echo "ok   follow-ups need login" || { echo "FAIL follow-ups auth"; fail=1; }
  [ "$(code "$URL/api/crm/viewing-followups/by-viewing/1/owner-info")" = 401 ] && echo "ok   owner info needs login" || { echo "FAIL owner info auth"; fail=1; }
  [ "$fail" = 0 ] && echo "VERIFY OK" || { echo "VERIFY FAILED"; return 1; }
}
case "${1:-}" in
  stage)
    cleanup_test; rm -rf "$STAGE"; mkdir -p "$STAGE"
    rsync -a --exclude node_modules --exclude uploads --exclude logs --exclude '.*' --exclude 'backups' --exclude '*.log' --exclude 'exports' "$LIVE/" "$STAGE/"
    mkdir -p "$STAGE/test" "$STAGE/node_modules" "$STAGE/uploads"
    for f in $NEW $MIG; do cp "$PKG/backend/$f" "$STAGE/$f"; done
    python3 "$PKG/backend/apply_followups.py" "$STAGE"
    cp "$PKG/backend/test/viewing-followups.test.js" "$STAGE/test/"
    for f in index.js $NEW; do docker run --rm --network none -v "$STAGE:/app:ro" -w /app --entrypoint node 2906-system-backend --check "$f"; done
    docker network create --internal "$TESTNET" >/dev/null
    docker run -d --rm --name "$TESTDB" --network "$TESTNET" -e POSTGRES_PASSWORD=test pgvector/pgvector:pg16 >/dev/null
    for i in $(seq 1 40); do docker exec "$TESTDB" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 2
    T=""; for t in $TABLES; do T="$T -t $t"; done
    docker exec "$PG" sh -c "pg_dump -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -s --no-owner --no-privileges $T" > "$STAGE/schema.sql"
    docker exec "$TESTDB" psql -U postgres -q -c 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"'
    docker exec -i "$TESTDB" psql -U postgres -q < "$STAGE/schema.sql" > "$STAGE/schema.log" 2>&1 || true
    docker exec -i "$TESTDB" psql -U postgres -v ON_ERROR_STOP=1 -q < "$PKG/backend/migrations/20261121f_viewing_followups.sql"
    set +e
    docker run --rm --network "$TESTNET" -v "$STAGE:/app:ro" -v "$LIVE/node_modules:/app/node_modules:ro" -w /app \
      -e BACKEND_DIR=/app -e NODE_ENV=test -e PGHOST="$TESTDB" -e TZ=UTC --entrypoint timeout 2906-system-backend 240 node --test --test-force-exit test/viewing-followups.test.js > /tmp/argus-followups-test.out 2>&1
    r=$?
    set -e
    grep -E '^# (pass|fail|tests)' /tmp/argus-followups-test.out
    [ "$r" != 0 ] && grep -B2 -A26 "^not ok" /tmp/argus-followups-test.out | cut -c1-240 | head -140
    docker exec -i "$TESTDB" psql -U postgres -v ON_ERROR_STOP=1 -q < "$PKG/backend/migrations/20261121f_viewing_followups.down.sql"
    docker exec -i "$TESTDB" psql -U postgres -v ON_ERROR_STOP=1 -q < "$PKG/backend/migrations/20261121f_viewing_followups.sql"
    cleanup_test
    [ "$r" = 0 ] && echo "STAGE TESTS PASSED" || { echo "STAGE TESTS FAILED"; exit 1; }
    ;;
  apply)
    cd "$LIVE"
    sha256sum -c "$PKG/deploy/base.sha256" || { echo "REFUSE: index.js changed since the patch was built"; exit 1; }
    for f in $NEW; do [ -e "$LIVE/$f" ] && { echo "REFUSE: $f exists"; exit 1; }; done
    python3 "$PKG/backend/apply_followups.py" "$LIVE" --check || exit 1
    TS=$(date -u +%Y%m%dT%H%M%SZ); BK="$BKROOT/viewing-followups-$TS"; mkdir -p "$BK"
    cp -p index.js "$BK/index.js"; echo "$BK" > "$BKROOT/viewing-followups-latest"; echo "backup: $BK"
    restore() { echo "ROLLING BACK"; cp -p "$BK/index.js" "$LIVE/index.js"; for f in $NEW; do rm -f "$LIVE/$f"; done; docker restart "$CT" >/dev/null; wait_up && echo "rolled back, backend up"; }
    psql_live < "$PKG/backend/migrations/20261121f_viewing_followups.sql" || { echo "migration failed, nothing else changed"; exit 1; }
    for f in $NEW $MIG; do cp "$PKG/backend/$f" "$LIVE/$f"; done
    python3 "$PKG/backend/apply_followups.py" "$LIVE" || { restore; exit 1; }
    docker restart "$CT" >/dev/null
    if ! wait_up; then docker logs --tail 30 "$CT" 2>&1 | cut -c1-200; restore; exit 1; fi
    sleep 5
    verify || { restore; exit 1; }
    if docker logs --since 2m "$CT" 2>&1 | grep -E "Cannot find module|SyntaxError|ReferenceError" | head -3 | grep -q .; then restore; exit 1; fi
    echo "APPLIED AND VERIFIED"
    ;;
  grant)
    echo "UPDATE agents SET can_view_owner_contact = (id IN (2, 13)); SELECT id, username, can_view_owner_contact FROM agents WHERE can_view_owner_contact;" | psql_live
    ;;
  rollback)
    BK=$(cat "$BKROOT/viewing-followups-latest"); cp -p "$BK/index.js" "$LIVE/index.js"; for f in $NEW; do rm -f "$LIVE/$f"; done
    docker restart "$CT" >/dev/null; wait_up && echo "rolled back to $BK (tables kept; down.sql drops them)"
    ;;
  verify) verify ;;
  *) echo "usage: deploy.sh stage|apply|grant|rollback|verify"; exit 2 ;;
esac
