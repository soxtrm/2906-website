#!/usr/bin/env bash
# NEXUS SYNC step 2 (2026-11-19): phone sign-in over WhatsApp, owner viewings/hours/nicknames,
# CRM inbox counter, context and claim decisions. Replaces only the three SYNC files of step 1
# (compare-and-swap on their live hashes) and runs one additive migration.
#   deploy2.sh stage | apply | rollback | verify
set -euo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
LIVE=/opt/2906-system/backend
CT=2906_backend
PG=2906_postgres
STAGE=/tmp/argus-sync2-stage
BKROOT=/opt/2906-system/backups
FILES="services/syncAccount.js routes/syncAccountService.js routes/crmSyncInbox.js"
MIG="migrations/20261119b_sync_owner_tools.sql migrations/20261119b_sync_owner_tools.down.sql"
URL=http://127.0.0.1:3001
TESTNET=argus-sync2-testnet
TESTDB=argus-sync2-testdb
TABLES="clients owner_contacts owner_phone_variants properties agents agent_activity_log owner_contact_log owner_availability_answers nexus_owner_links nexus_owner_invitations nexus_owner_property_claims nexus_property_links nexus_inbound_events nexus_owner_property_updates nexus_owner_viewing_schedules nexus_owner_answers nexus_distribution_grants nexus_distribution_routes nexus_sync_outbox property_viewing_windows property_viewings website_source_inventory"
code() { curl -s -o /dev/null -m 10 -w '%{http_code}' "$@" || echo 000; }
wait_up() { for i in $(seq 1 45); do [ "$(code "$URL/api/properties")" = 200 ] && return 0; sleep 2; done; return 1; }
cleanup_test() { docker rm -f "$TESTDB" >/dev/null 2>&1 || true; docker network rm "$TESTNET" >/dev/null 2>&1 || true; }
verify() {
  local fail=0
  [ "$(code "$URL/api/properties")" = 200 ] && echo "ok   properties" || { echo "FAIL properties"; fail=1; }
  [ "$(code -X POST -H 'content-type: application/json' -d '{}' "$URL/api/sync-account/v1/login/phone/start")" = 401 ] && echo "ok   unsigned phone login 401" || { echo "FAIL unsigned phone login"; fail=1; }
  [ "$(code "$URL/api/crm/sync-inbox/summary")" = 401 ] && echo "ok   inbox summary needs login" || { echo "FAIL inbox summary"; fail=1; }
  [ "$fail" = 0 ] && echo "VERIFY OK" || { echo "VERIFY FAILED"; return 1; }
}
case "${1:-}" in
  stage)
    cleanup_test; rm -rf "$STAGE"; mkdir -p "$STAGE"
    rsync -a --exclude node_modules --exclude uploads --exclude logs --exclude '.*' --exclude 'backups' --exclude '*.log' --exclude 'exports' "$LIVE/" "$STAGE/"
    mkdir -p "$STAGE/test" "$STAGE/node_modules" "$STAGE/uploads"
    for f in $FILES $MIG; do cp "$PKG/backend/$f" "$STAGE/$f"; done
    cp "$PKG/backend/test/sync-account.test.js" "$STAGE/test/"
    for f in $FILES; do docker run --rm --network none -v "$STAGE:/app:ro" -w /app --entrypoint node 2906-system-backend --check "$f"; done
    docker network create --internal "$TESTNET" >/dev/null
    docker run -d --rm --name "$TESTDB" --network "$TESTNET" -e POSTGRES_PASSWORD=test pgvector/pgvector:pg16 >/dev/null
    for i in $(seq 1 40); do docker exec "$TESTDB" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 2
    T=""; for t in $TABLES; do T="$T -t $t"; done
    docker exec "$PG" sh -c "pg_dump -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -s --no-owner --no-privileges $T" > "$STAGE/schema.sql"
    docker exec "$TESTDB" psql -U postgres -q -c 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"'
    docker exec -i "$TESTDB" psql -U postgres -q < "$STAGE/schema.sql" > "$STAGE/schema.log" 2>&1 || true
    docker exec -i "$TESTDB" psql -U postgres -v ON_ERROR_STOP=1 -q < "$PKG/backend/migrations/20261119_sync_accounts.sql"
    docker exec -i "$TESTDB" psql -U postgres -v ON_ERROR_STOP=1 -q < "$PKG/backend/migrations/20261119b_sync_owner_tools.sql"
    set +e
    docker run --rm --network "$TESTNET" -v "$STAGE:/app:ro" -v "$LIVE/node_modules:/app/node_modules:ro" -w /app \
      -e BACKEND_DIR=/app -e NODE_ENV=test -e PGHOST="$TESTDB" --entrypoint timeout 2906-system-backend 240 node --test --test-force-exit test/sync-account.test.js > /tmp/argus-sync2-test.out 2>&1
    r=$?
    set -e
    grep -E '^# (pass|fail|tests)' /tmp/argus-sync2-test.out
    [ "$r" != 0 ] && grep -B2 -A26 "^not ok" /tmp/argus-sync2-test.out | cut -c1-240 | head -120
    docker exec -i "$TESTDB" psql -U postgres -v ON_ERROR_STOP=1 -q < "$PKG/backend/migrations/20261119b_sync_owner_tools.down.sql"
    docker exec -i "$TESTDB" psql -U postgres -v ON_ERROR_STOP=1 -q < "$PKG/backend/migrations/20261119b_sync_owner_tools.sql"
    cleanup_test
    [ "$r" = 0 ] && echo "STAGE TESTS PASSED" || { echo "STAGE TESTS FAILED"; exit 1; }
    ;;
  apply)
    cd "$LIVE"
    sha256sum -c "$PKG/deploy/base2.sha256" || { echo "REFUSE: live SYNC files changed since step 1"; exit 1; }
    TS=$(date -u +%Y%m%dT%H%M%SZ); BK="$BKROOT/sync-step2-$TS"; mkdir -p "$BK/services" "$BK/routes"
    for f in $FILES; do cp -p "$f" "$BK/$f"; done
    echo "$BK" > "$BKROOT/sync-step2-latest"; echo "backup: $BK"
    restore() { echo "ROLLING BACK"; for f in $FILES; do cp -p "$BK/$f" "$LIVE/$f"; done; docker restart "$CT" >/dev/null; wait_up && echo "rolled back, backend up"; }
    docker exec -i "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q' < "$PKG/backend/migrations/20261119b_sync_owner_tools.sql" || { echo "migration failed, nothing else changed"; exit 1; }
    for f in $FILES $MIG; do cp "$PKG/backend/$f" "$LIVE/$f"; done
    docker restart "$CT" >/dev/null
    if ! wait_up; then docker logs --tail 30 "$CT" 2>&1 | cut -c1-200; restore; exit 1; fi
    sleep 5
    verify || { restore; exit 1; }
    if docker logs --since 2m "$CT" 2>&1 | grep -E "Cannot find module|SyntaxError|ReferenceError" | head -3 | grep -q .; then restore; exit 1; fi
    echo "APPLIED AND VERIFIED"
    ;;
  rollback)
    BK=$(cat "$BKROOT/sync-step2-latest"); for f in $FILES; do cp -p "$BK/$f" "$LIVE/$f"; done
    docker restart "$CT" >/dev/null; wait_up && echo "rolled back to $BK (columns kept; down.sql removes them)"
    ;;
  verify) verify ;;
  *) echo "usage: deploy2.sh stage|apply|rollback|verify"; exit 2 ;;
esac
