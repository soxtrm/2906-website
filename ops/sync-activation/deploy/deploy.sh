#!/usr/bin/env bash
# NEXUS SYNC activation on ARGUS (2026-11-19).
#   deploy.sh stage     copy live backend, apply this package, run the tests on a throwaway DB
#   deploy.sh apply     migration (new tables only) + new files + 2 anchor edits, restart, verify, auto-restore
#   deploy.sh activate  generate the shared SYNC secret into .env (never printed), recreate the backend
#   deploy.sh rollback  restore the two edited files, remove the new files, restart (tables stay; down.sql drops them)
#   deploy.sh verify    route checks
# Sends no message to anyone. Owner notifications stay off (SYNC_STAFF_NOTIFY_TO unset).
set -euo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
LIVE=/opt/2906-system/backend
COMPOSE=/opt/2906-system
CT=2906_backend
PG=2906_postgres
STAGE=/tmp/argus-sync-stage
BKROOT=/opt/2906-system/backups
EDITED="index.js routes/webhook.js"
NEW="services/syncAccount.js routes/syncAccountService.js routes/crmSyncInbox.js migrations/20261119_sync_accounts.sql migrations/20261119_sync_accounts.down.sql"
URL=http://127.0.0.1:3001
TESTNET=argus-sync-testnet
TESTDB=argus-sync-testdb
TABLES="clients owner_contacts owner_phone_variants properties agents agent_activity_log owner_contact_log owner_availability_answers nexus_owner_links nexus_owner_invitations nexus_owner_property_claims nexus_property_links nexus_inbound_events nexus_owner_property_updates nexus_owner_viewing_schedules nexus_owner_answers nexus_distribution_grants nexus_distribution_routes nexus_sync_outbox property_viewing_windows property_viewings website_source_inventory"

code() { curl -s -o /dev/null -m 10 -w '%{http_code}' "$@" || echo 000; }
wait_up() { for i in $(seq 1 45); do [ "$(code "$URL/api/properties")" = 200 ] && return 0; sleep 2; done; return 1; }
cleanup_test() { docker rm -f "$TESTDB" >/dev/null 2>&1 || true; docker network rm "$TESTNET" >/dev/null 2>&1 || true; }
psql_live() { docker exec -i "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q' ; }

verify() {
  local fail=0
  chk() { local want="$1" got; shift; got=$(code "$@"); if [ "$got" = "$want" ]; then echo "ok   $got $*"; else echo "FAIL $got (want $want) $*"; fail=1; fi; }
  chk 200 "$URL/api/properties"
  # unsigned call: 503 before activation, 401 after
  got=$(code -X POST -H 'content-type: application/json' -d '{}' "$URL/api/sync-account/v1/me")
  if [ "$got" = 503 ] || [ "$got" = 401 ]; then echo "ok   $got unsigned /api/sync-account/v1/me"; else echo "FAIL $got unsigned /api/sync-account/v1/me"; fail=1; fi
  chk 401 "$URL/api/crm/sync-inbox/threads"
  [ "$fail" = 0 ] && echo "VERIFY OK" || { echo "VERIFY FAILED"; return 1; }
}

case "${1:-}" in
  stage)
    cleanup_test; rm -rf "$STAGE"; mkdir -p "$STAGE"
    rsync -a --exclude node_modules --exclude uploads --exclude logs --exclude '.*' --exclude 'backups' --exclude '*.log' --exclude 'exports' "$LIVE/" "$STAGE/"
    mkdir -p "$STAGE/test" "$STAGE/node_modules" "$STAGE/uploads"
    for f in $NEW; do mkdir -p "$STAGE/$(dirname "$f")"; cp "$PKG/backend/$f" "$STAGE/$f"; done
    python3 "$PKG/backend/apply_sync.py" "$STAGE"
    cp "$PKG/backend/test/sync-account.test.js" "$STAGE/test/"
    for f in $EDITED services/syncAccount.js routes/syncAccountService.js routes/crmSyncInbox.js; do
      docker run --rm --network none -v "$STAGE:/app:ro" -w /app --entrypoint node 2906-system-backend --check "$f"; done
    docker network create --internal "$TESTNET" >/dev/null
    docker run -d --rm --name "$TESTDB" --network "$TESTNET" -e POSTGRES_PASSWORD=test pgvector/pgvector:pg16 >/dev/null
    for i in $(seq 1 40); do docker exec "$TESTDB" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
    sleep 2
    # live schema of the tables involved, no rows
    T=""; for t in $TABLES; do T="$T -t $t"; done
    docker exec "$PG" sh -c "pg_dump -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -s --no-owner --no-privileges $T" > "$STAGE/schema.sql"
    docker exec "$TESTDB" psql -U postgres -q -c 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"'
    docker exec -i "$TESTDB" psql -U postgres -q < "$STAGE/schema.sql" > "$STAGE/schema.log" 2>&1 || true
    echo "schema errors (missing cross-table objects are expected): $(grep -c ERROR "$STAGE/schema.log" || true)"
    docker exec -i "$TESTDB" psql -U postgres -v ON_ERROR_STOP=1 -q < "$PKG/backend/migrations/20261119_sync_accounts.sql"
    set +e
    docker run --rm --network "$TESTNET" -v "$STAGE:/app:ro" -v "$LIVE/node_modules:/app/node_modules:ro" -w /app \
      -e BACKEND_DIR=/app -e NODE_ENV=test -e PGHOST="$TESTDB" --entrypoint timeout 2906-system-backend 240 node --test --test-force-exit test/sync-account.test.js > /tmp/argus-sync-test.out 2>&1
    r=$?
    set -e
    grep -E '^# (pass|fail|tests)' /tmp/argus-sync-test.out
    if [ "$r" != 0 ]; then grep -B2 -A26 "^not ok\|# Subtest" /tmp/argus-sync-test.out | grep -v "^# Subtest" | cut -c1-240 | head -120; fi
    # migration down/up round trip on the throwaway DB
    docker exec -i "$TESTDB" psql -U postgres -v ON_ERROR_STOP=1 -q < "$PKG/backend/migrations/20261119_sync_accounts.down.sql"
    docker exec -i "$TESTDB" psql -U postgres -v ON_ERROR_STOP=1 -q < "$PKG/backend/migrations/20261119_sync_accounts.sql"
    cleanup_test
    [ "$r" = 0 ] && echo "STAGE TESTS PASSED" || { echo "STAGE TESTS FAILED"; exit 1; }
    ;;
  apply)
    cd "$LIVE"
    sha256sum -c "$PKG/deploy/base.sha256" || { echo "REFUSE: live files changed since the patch was built"; exit 1; }
    for f in $NEW; do [ -e "$LIVE/$f" ] && { echo "REFUSE: $f already exists"; exit 1; }; done
    python3 "$PKG/backend/apply_sync.py" "$LIVE" --check || exit 1
    TS=$(date -u +%Y%m%dT%H%M%SZ); BK="$BKROOT/sync-activation-$TS"; mkdir -p "$BK"
    for f in $EDITED; do mkdir -p "$BK/$(dirname "$f")"; cp -p "$f" "$BK/$f"; done
    echo "$BK" > "$BKROOT/sync-activation-latest"; echo "backup: $BK"
    restore() {
      echo "ROLLING BACK"
      for f in $EDITED; do cp -p "$BK/$f" "$LIVE/$f"; done
      for f in services/syncAccount.js routes/syncAccountService.js routes/crmSyncInbox.js; do rm -f "$LIVE/$f"; done
      docker restart "$CT" >/dev/null; wait_up && echo "rolled back, backend up" || echo "ROLLBACK: backend not answering, check manually"
    }
    psql_live < "$PKG/backend/migrations/20261119_sync_accounts.sql" || { echo "migration failed, nothing else changed"; exit 1; }
    for f in $NEW; do mkdir -p "$LIVE/$(dirname "$f")"; cp "$PKG/backend/$f" "$LIVE/$f"; done
    python3 "$PKG/backend/apply_sync.py" "$LIVE" || { restore; exit 1; }
    docker restart "$CT" >/dev/null
    if ! wait_up; then echo "backend did not come up"; docker logs --tail 30 "$CT" 2>&1 | cut -c1-200; restore; exit 1; fi
    sleep 5
    if ! verify; then restore; exit 1; fi
    if docker logs --since 2m "$CT" 2>&1 | grep -E "Cannot find module|SyntaxError|ReferenceError|TypeError: .* is not a function" | head -3 | grep -q .; then docker logs --since 2m "$CT" 2>&1 | grep -E "Cannot find module|SyntaxError|ReferenceError" | head -3; restore; exit 1; fi
    echo "APPLIED AND VERIFIED"
    ;;
  activate)
    cd "$COMPOSE"
    [ -f "$LIVE/routes/syncAccountService.js" ] || { echo "REFUSE: apply first"; exit 1; }
    cp -p .env "$BKROOT/env-before-sync-$(date -u +%Y%m%dT%H%M%SZ)"; chmod 600 "$BKROOT"/env-before-sync-*
    if ! grep -q '^NEXUS_LINK_INBOUND_SECRET=' .env; then
      printf '\n# NEXUS SYNC (2026-11-19): shared with the SYNC server on Vercel (server-only env); agency key of this ARGUS\nNEXUS_LINK_INBOUND_SECRET=%s\nARGUS_AGENCY_KEY=2906\nSYNC_WA_SESSION=Argus1\nSYNC_WA_NUMBER=35679675060\n' "$(openssl rand -hex 32)" >> .env
      echo "secret written to .env (not printed)"
    else echo "secret already present, kept"; fi
    docker compose up -d --no-deps backend >/dev/null 2>&1
    wait_up || { echo "backend did not come up after activation"; exit 1; }
    sleep 4
    got=$(code -X POST -H 'content-type: application/json' -d '{}' "$URL/api/sync-account/v1/me")
    [ "$got" = 401 ] && echo "ok   unsigned call now 401 (service enabled, signature required)" || { echo "FAIL unsigned call answered $got"; exit 1; }
    echo "ACTIVATED"
    ;;
  rollback)
    BK=$(cat "$BKROOT/sync-activation-latest")
    for f in $EDITED; do cp -p "$BK/$f" "$LIVE/$f"; done
    for f in services/syncAccount.js routes/syncAccountService.js routes/crmSyncInbox.js; do rm -f "$LIVE/$f"; done
    docker restart "$CT" >/dev/null; wait_up && echo "rolled back to $BK, backend up (tables kept; drop with migrations/20261119_sync_accounts.down.sql)"
    ;;
  verify) verify ;;
  *) echo "usage: deploy.sh stage|apply|activate|rollback|verify"; exit 2 ;;
esac
