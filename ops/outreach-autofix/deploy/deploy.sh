#!/usr/bin/env bash
# ARGUS P0 Auto Outreach fix (2026-11-21).
#   deploy.sh stage     live backend + this patch on a throwaway DB (full live schema, no rows), Kev's 12 tests
#   deploy.sh apply     additive migration, 3 new services, anchor patches (compare-and-swap), seed the library,
#                       restart, verify, auto-restore on any failure
#   deploy.sh seed      (idempotent) insert the 150 library texts that are not there yet
#   deploy.sh rollback  restore the 4 patched files, remove the 3 new services (tables kept; down.sql drops them)
#   deploy.sh verify
# Sends nothing by itself and arms nothing: no account is started by this deploy.
set -euo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
LIVE=/opt/2906-system/backend
CT=2906_backend
PG=2906_postgres
STAGE=/tmp/argus-autofix-stage
BKROOT=/opt/2906-system/backups
NEW="services/outreachLibrary.js services/outreachLibrarySeed.js services/outreachAutoStatus.js"
PATCHED="services/outreachPlanner.js services/outreachTemplates.js services/adminCommands.js routes/crm.js"
MIG=migrations/20261121g_outreach_autofix.sql
URL=http://127.0.0.1:3001
TESTNET=argus-autofix-testnet
TESTDB=argus-autofix-testdb
code() { curl -s -o /dev/null -m 10 -w '%{http_code}' "$@" || echo 000; }
wait_up() { for i in $(seq 1 45); do [ "$(code "$URL/api/properties")" = 200 ] && return 0; sleep 2; done; return 1; }
cleanup_test() { docker rm -f "$TESTDB" >/dev/null 2>&1 || true; docker network rm "$TESTNET" >/dev/null 2>&1 || true; }
psql_live() { docker exec -i "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q'; }
seed() { docker exec "$CT" node -e "require('./services/outreachLibrary').ensureSeed().then(n=>{console.log('library texts inserted:',n);process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})"; }
verify() {
  local fail=0
  [ "$(code "$URL/api/properties")" = 200 ] && echo "ok   properties" || { echo "FAIL properties"; fail=1; }
  [ "$(code "$URL/api/crm/outreach/accounts/3/auto-status")" = 401 ] && echo "ok   auto-status needs login" || { echo "FAIL auto-status"; fail=1; }
  [ "$(code "$URL/api/crm/outreach/library")" = 401 ] && echo "ok   library needs login" || { echo "FAIL library"; fail=1; }
  [ "$(code "$URL/api/crm/outreach/accounts")" = 401 ] && echo "ok   accounts needs login" || { echo "FAIL accounts"; fail=1; }
  [ "$fail" = 0 ] && echo "VERIFY OK" || { echo "VERIFY FAILED"; return 1; }
}
case "${1:-}" in
  stage)
    cleanup_test; rm -rf "$STAGE"; mkdir -p "$STAGE"
    rsync -a --exclude node_modules --exclude uploads --exclude logs --exclude '.*' --exclude 'backups' --exclude '*.log' --exclude 'exports' --exclude private-docs "$LIVE/" "$STAGE/"
    mkdir -p "$STAGE/test" "$STAGE/node_modules"
    for f in $NEW; do cp "$PKG/backend/$f" "$STAGE/$f"; done
    python3 "$PKG/deploy/patch_autofix.py" "$STAGE"
    cp "$PKG/backend/test/outreach-autofix.test.js" "$STAGE/test/"
    for f in $NEW $PATCHED; do docker run --rm --network none -v "$STAGE:/app:ro" -w /app --entrypoint node 2906-system-backend --check "$f"; done
    docker network create --internal "$TESTNET" >/dev/null
    docker run -d --rm --name "$TESTDB" --network "$TESTNET" -e POSTGRES_PASSWORD=test pgvector/pgvector:pg16 >/dev/null
    for i in $(seq 1 40); do docker exec "$TESTDB" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 2
    docker exec "$PG" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -s --no-owner --no-privileges' > "$STAGE/schema.sql"
    docker exec "$TESTDB" psql -U postgres -q -c 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"' -c 'CREATE EXTENSION IF NOT EXISTS btree_gist' >/dev/null
    docker exec -i "$TESTDB" psql -U postgres -q < "$STAGE/schema.sql" > "$STAGE/schema.log" 2>&1 || true
    docker exec -i "$TESTDB" psql -U postgres -v ON_ERROR_STOP=1 -q < "$PKG/backend/$MIG"
    set +e
    docker run --rm --network "$TESTNET" -v "$STAGE:/app:ro" -v "$LIVE/node_modules:/app/node_modules:ro" -w /app \
      -e BACKEND_DIR=/app -e NODE_ENV=test -e PGHOST="$TESTDB" -e TZ=UTC --entrypoint timeout 2906-system-backend 300 node --test --test-force-exit --test-concurrency=1 test/outreach-autofix.test.js > /tmp/argus-autofix-test.out 2>&1
    r=$?
    set -e
    grep -E '^(ok|not ok) ' /tmp/argus-autofix-test.out | cut -c1-160 || true
    grep -E '^# (pass|fail|tests)' /tmp/argus-autofix-test.out || true
    [ "$r" != 0 ] && grep -A30 "^not ok" /tmp/argus-autofix-test.out | grep -E "error|expected|actual|message|at .*(test|services)" | cut -c1-260 | head -80 || true
    docker exec -i "$TESTDB" psql -U postgres -v ON_ERROR_STOP=1 -q < "$PKG/backend/migrations/20261121g_outreach_autofix.down.sql" && echo "down.sql ok"
    docker exec -i "$TESTDB" psql -U postgres -v ON_ERROR_STOP=1 -q < "$PKG/backend/$MIG" && echo "re-apply ok"
    cleanup_test
    [ "$r" = 0 ] && echo "STAGE TESTS PASSED" || { echo "STAGE TESTS FAILED"; exit 1; }
    ;;
  apply)
    cd "$LIVE"
    sha256sum -c "$PKG/deploy/base.sha256" || { echo "REFUSE: a live file changed since the patch was built"; exit 1; }
    for f in $NEW; do [ -e "$LIVE/$f" ] && { echo "REFUSE: $f exists"; exit 1; }; done
    TS=$(date -u +%Y%m%dT%H%M%SZ); BK="$BKROOT/outreach-autofix-$TS"; mkdir -p "$BK/services" "$BK/routes"
    for f in $PATCHED; do cp -p "$f" "$BK/$f"; done; echo "$BK" > "$BKROOT/outreach-autofix-latest"; echo "backup: $BK"
    restore() { echo "ROLLING BACK"; for f in $PATCHED; do cp -p "$BK/$f" "$LIVE/$f"; done; for f in $NEW; do rm -f "$LIVE/$f"; done; docker restart "$CT" >/dev/null; wait_up && echo "rolled back, backend up"; }
    psql_live < "$PKG/backend/$MIG" || { echo "migration failed, nothing else changed"; exit 1; }
    cp "$PKG/backend/$MIG" "$LIVE/$MIG"; cp "$PKG/backend/migrations/20261121g_outreach_autofix.down.sql" "$LIVE/migrations/"
    for f in $NEW; do cp "$PKG/backend/$f" "$LIVE/$f"; done
    python3 "$PKG/deploy/patch_autofix.py" "$LIVE" || { restore; exit 1; }
    for f in $NEW $PATCHED; do docker run --rm --network none -v "$LIVE:/app:ro" -w /app --entrypoint node 2906-system-backend --check "$f" || { restore; exit 1; }; done
    docker restart "$CT" >/dev/null
    if ! wait_up; then docker logs --tail 30 "$CT" 2>&1 | cut -c1-200; restore; exit 1; fi
    sleep 5
    verify || { restore; exit 1; }
    if docker logs --since 2m "$CT" 2>&1 | grep -E "Cannot find module|SyntaxError|ReferenceError" | head -3 | grep -q .; then restore; exit 1; fi
    seed || echo "WARN: library seed failed (Auto falls back to the old persona rotation until seeded)"
    echo "APPLIED AND VERIFIED"
    ;;
  seed) seed ;;
  rollback)
    BK=$(cat "$BKROOT/outreach-autofix-latest"); for f in $PATCHED; do cp -p "$BK/$f" "$LIVE/$f"; done; for f in $NEW; do rm -f "$LIVE/$f"; done
    psql_live <<'SQL'
UPDATE outreach_plans SET message_mode='persona_rotation' WHERE message_mode='library' AND status IN ('draft','saved','ready','blocked_session') AND template_slot IS NOT NULL;
UPDATE outreach_plans SET message_mode='free_text' WHERE message_mode='library';
SQL
    docker restart "$CT" >/dev/null; wait_up && echo "rolled back to $BK (tables kept; down.sql drops them)"
    ;;
  verify) verify ;;
  *) echo "usage: deploy.sh stage|apply|seed|rollback|verify"; exit 2 ;;
esac
