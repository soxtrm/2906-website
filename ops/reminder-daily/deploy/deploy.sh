#!/usr/bin/env bash
# ARGUS P0 (2026-11-21): Reminder Due automatic · inbox read-state · Safe Drafts pack.
#   deploy.sh stage     live backend + this patch on a throwaway DB (full live schema, no rows), tests
#   deploy.sh apply     additive migration, 3 new services + pack data, outreachLibrary.js (CAS), anchor patches,
#                       restart, verify, auto-restore on failure
#   deploy.sh import    back up the live Safe Drafts, then import the 150 pack texts as pending_review (idempotent)
#   deploy.sh rollback  restore every changed file, remove the new ones (tables kept; down.sql drops them)
#   deploy.sh verify
# Sends nothing at deploy time. The first automatic reminder run is the next 09:00 Malta (Mon-Sat).
set -euo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
LIVE=/opt/2906-system/backend; CT=2906_backend; PG=2906_postgres; BKROOT=/opt/2906-system/backups
STAGE=/tmp/argus-reminder-stage; TESTNET=argus-reminder-testnet; TESTDB=argus-reminder-testdb
NEW="services/reminderDaily.js services/inboxDisposition.js services/safeDraftsPack.js data/argus_safe_drafts_v1_1.md"
PATCHED="cron.js services/availability.js services/ownerRecheck7d.js routes/crm.js"
REPLACED="services/outreachLibrary.js"
CHECK="services/reminderDaily.js services/inboxDisposition.js services/safeDraftsPack.js services/outreachLibrary.js cron.js services/availability.js services/ownerRecheck7d.js routes/crm.js"
MIG=migrations/20261122a_reminder_daily.sql; DOWN=migrations/20261122a_reminder_daily.down.sql
URL=http://127.0.0.1:3001
code() { curl -s -o /dev/null -m 10 -w '%{http_code}' "$@" || echo 000; }
wait_up() { for i in $(seq 1 45); do [ "$(code "$URL/api/properties")" = 200 ] && return 0; sleep 2; done; return 1; }
cleanup_test() { docker rm -f "$TESTDB" >/dev/null 2>&1 || true; docker network rm "$TESTNET" >/dev/null 2>&1 || true; }
psql_live() { docker exec -i "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q'; }
verify() {
  local fail=0
  [ "$(code "$URL/api/properties")" = 200 ] && echo "ok   properties" || { echo "FAIL properties"; fail=1; }
  [ "$(code "$URL/api/crm/outreach/reminder-daily")" = 401 ] && echo "ok   reminder-daily needs login" || { echo "FAIL reminder-daily"; fail=1; }
  [ "$(code "$URL/api/crm/outreach/inbox-dispositions")" = 401 ] && echo "ok   inbox-dispositions needs login" || { echo "FAIL inbox"; fail=1; }
  [ "$(code "$URL/api/crm/outreach/library")" = 401 ] && echo "ok   library needs login" || { echo "FAIL library"; fail=1; }
  [ "$fail" = 0 ] && echo "VERIFY OK" || { echo "VERIFY FAILED"; return 1; }
}
case "${1:-}" in
  stage)
    rm -f "$PKG/.stage-pass"
    cleanup_test; rm -rf "$STAGE"; mkdir -p "$STAGE"
    rsync -a --exclude node_modules --exclude uploads --exclude logs --exclude '.*' --exclude backups --exclude '*.log' --exclude exports --exclude private-docs "$LIVE/" "$STAGE/"
    mkdir -p "$STAGE/test" "$STAGE/node_modules" "$STAGE/data"
    if [ -e "$LIVE/services/reminderDaily.js" ]; then BK0=$(cat "$BKROOT/reminder-daily-latest"); for f in $PATCHED $REPLACED; do cp -p "$BK0/$f" "$STAGE/$f"; done; fi
    for f in $NEW $REPLACED; do cp "$PKG/backend/$f" "$STAGE/$f"; done
    python3 "$PKG/deploy/patch_reminder.py" "$STAGE"
    cp "$PKG/backend/test/reminder-daily.test.js" "$STAGE/test/"
    for f in $CHECK; do docker run --rm --network none -v "$STAGE:/app:ro" -w /app --entrypoint node 2906-system-backend --check "$f"; done
    docker network create --internal "$TESTNET" >/dev/null
    docker run -d --rm --name "$TESTDB" --network "$TESTNET" -e POSTGRES_PASSWORD=test pgvector/pgvector:pg16 >/dev/null
    for i in $(seq 1 40); do docker exec "$TESTDB" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 2
    docker exec "$PG" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -s --no-owner --no-privileges' > "$STAGE/schema.sql"
    docker exec "$TESTDB" psql -U postgres -q -c 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"' -c 'CREATE EXTENSION IF NOT EXISTS btree_gist' >/dev/null
    docker exec -i "$TESTDB" psql -U postgres -q < "$STAGE/schema.sql" > "$STAGE/schema.log" 2>&1 || true
    docker exec "$PG" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --data-only -t settings -t villages --no-owner --no-privileges' | docker exec -i "$TESTDB" psql -U postgres -q >/dev/null 2>&1 || true
    docker exec -i "$TESTDB" psql -U postgres -q -c "DELETE FROM settings WHERE key='reminder_daily_since'" >/dev/null 2>&1 || true
    docker exec -i "$TESTDB" psql -U postgres -v ON_ERROR_STOP=1 -q < "$PKG/backend/$MIG"
    set +e
    docker run --rm --network "$TESTNET" -v "$STAGE:/app:ro" -v "$LIVE/node_modules:/app/node_modules:ro" -w /app \
      -e BACKEND_DIR=/app -e NODE_ENV=test -e PGHOST="$TESTDB" -e TZ=UTC --entrypoint timeout 2906-system-backend 300 node --test --test-force-exit --test-concurrency=1 test/reminder-daily.test.js > /tmp/argus-reminder-test.out 2>&1
    r=$?
    set -e
    grep -E '^(ok|not ok) ' /tmp/argus-reminder-test.out | cut -c1-170 || true
    grep -E '^# (pass|fail|tests)' /tmp/argus-reminder-test.out || true
    if [ "$r" != 0 ]; then grep -A30 "^not ok" /tmp/argus-reminder-test.out | grep -E "error|expected|actual|message|at .*(test|services)" | cut -c1-300 | head -60 || true; fi
    docker exec -i "$TESTDB" psql -U postgres -v ON_ERROR_STOP=1 -q < "$PKG/backend/$DOWN" && echo "down.sql ok"
    docker exec -i "$TESTDB" psql -U postgres -v ON_ERROR_STOP=1 -q < "$PKG/backend/$MIG" && echo "re-apply ok"
    cleanup_test
    if [ "$r" = 0 ] && ! grep -qE '^not ok |^# fail [1-9]' /tmp/argus-reminder-test.out; then date +%s > "$PKG/.stage-pass"; echo "STAGE TESTS PASSED"; else rm -f "$PKG/.stage-pass"; echo "STAGE TESTS FAILED — release stopped"; exit 1; fi
    ;;
  apply)
    # a release needs a passing stage run of this package in the last 2 h (no chained shortcuts)
    [ -f "$PKG/.stage-pass" ] && [ $(( $(date +%s) - $(cat "$PKG/.stage-pass") )) -lt 7200 ] || { echo "REFUSE: no passing stage run in the last 2 h"; exit 1; }
    rm -f "$PKG/.stage-pass"
    cd "$LIVE"
    sha256sum -c "$PKG/deploy/base.sha256" || { echo "REFUSE: a live file changed since the patch was built"; exit 1; }
    for f in $NEW; do [ -e "$LIVE/$f" ] && { echo "REFUSE: $f exists"; exit 1; }; done
    TS=$(date -u +%Y%m%dT%H%M%SZ); BK="$BKROOT/reminder-daily-$TS"; mkdir -p "$BK/services" "$BK/routes"
    for f in $PATCHED $REPLACED; do cp -p "$f" "$BK/$f"; done; echo "$BK" > "$BKROOT/reminder-daily-latest"; echo "backup: $BK"
    restore() { echo "ROLLING BACK"; for f in $PATCHED $REPLACED; do cp -p "$BK/$f" "$LIVE/$f"; done; for f in $NEW; do rm -f "$LIVE/$f"; done; docker restart "$CT" >/dev/null; wait_up && echo "rolled back, backend up"; }
    psql_live < "$PKG/backend/$MIG" || { echo "migration failed, nothing else changed"; exit 1; }
    cp "$PKG/backend/$MIG" "$PKG/backend/$DOWN" "$LIVE/migrations/"
    mkdir -p "$LIVE/data"; for f in $NEW $REPLACED; do cp "$PKG/backend/$f" "$LIVE/$f"; done
    python3 "$PKG/deploy/patch_reminder.py" "$LIVE" || { restore; exit 1; }
    for f in $CHECK; do docker run --rm --network none -v "$LIVE:/app:ro" -w /app --entrypoint node 2906-system-backend --check "$f" || { restore; exit 1; }; done
    docker restart "$CT" >/dev/null
    if ! wait_up; then docker logs --tail 30 "$CT" 2>&1 | cut -c1-200; restore; exit 1; fi
    sleep 5
    verify || { restore; exit 1; }
    if docker logs --since 2m "$CT" 2>&1 | grep -E "Cannot find module|SyntaxError|ReferenceError" | head -3 | grep -q .; then restore; exit 1; fi
    echo "APPLIED AND VERIFIED"
    ;;
  import)
    TS=$(date -u +%Y%m%dT%H%M%SZ); BK="$BKROOT/safe-drafts-$TS"; mkdir -p "$BK"
    docker exec "$PG" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --data-only -t outreach_message_templates -t outreach_library_templates -t outreach_persona_templates --no-owner --no-privileges' > "$BK/safe-drafts.sql"
    echo "Safe Drafts backup: $BK/safe-drafts.sql ($(wc -l < "$BK/safe-drafts.sql") lines)"
    docker exec -w /app "$CT" node -e "require('./services/safeDraftsPack').importPack(require('./db'),{actor:'pack-v1.1-import'}).then(function(r){console.log(JSON.stringify({parsed:r.parsed,inserted:r.inserted,refused:r.refused}));process.exit(0)}).catch(function(e){console.error(e.message);process.exit(1)})"
    ;;
  rollback)
    BK=$(cat "$BKROOT/reminder-daily-latest"); for f in $PATCHED $REPLACED; do cp -p "$BK/$f" "$LIVE/$f"; done; for f in $NEW; do rm -f "$LIVE/$f"; done
    docker restart "$CT" >/dev/null; wait_up && echo "rolled back to $BK (tables kept; down.sql drops them)"
    ;;
  verify) verify ;;
  *) echo "usage: deploy.sh stage|apply|import|rollback|verify"; exit 2 ;;
esac
