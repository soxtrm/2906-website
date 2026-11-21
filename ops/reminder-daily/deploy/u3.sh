#!/usr/bin/env bash
# Reminder/inbox update 3 (Kev, 2026-11-21).
#   u3.sh stage     current live backend + this update on a throwaway DB; writes a stage-pass marker ONLY if every test passes
#   u3.sh release   stage, then apply — in one script under `set -e`: a failed test ends the script before apply
#   u3.sh apply     refuses unless a stage-pass marker exists for exactly this package + these live files (< 2 h old)
#   u3.sh rollback
# The marker is a fingerprint of the package files and the live base hashes, so a changed package,
# a changed live file or a failed/aborted test run can never be applied.
set -euo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
LIVE=/opt/2906-system/backend; CT=2906_backend; PG=2906_postgres; BKROOT=/opt/2906-system/backups
STAGE=/tmp/argus-reminder-u3-stage; TESTNET=argus-u3-testnet; TESTDB=argus-u3-testdb
PATCHED="services/availability.js services/ownerScopeReply.js services/ownerRecheck7d.js routes/webhook.js"
REPLACED="services/inboxDisposition.js services/reminderDaily.js services/outreachLibrary.js"
MARKER="$PKG/.stage-pass-u3"
URL=http://127.0.0.1:3001
code() { curl -s -o /dev/null -m 10 -w '%{http_code}' "$@" || echo 000; }
wait_up() { for i in $(seq 1 45); do [ "$(code "$URL/api/properties")" = 200 ] && return 0; sleep 2; done; return 1; }
cleanup_test() { docker rm -f "$TESTDB" >/dev/null 2>&1 || true; docker network rm "$TESTNET" >/dev/null 2>&1 || true; }
fingerprint() {
  ( cd "$PKG" && sha256sum deploy/patch_u3.py deploy/u3.sh backend/test/reminder-daily.test.js $(for f in $REPLACED services/safeDraftsPack.js; do echo "backend/$f"; done)
    cd "$LIVE" && sha256sum $PATCHED $REPLACED ) | sha256sum | cut -c1-64
}
verify() {
  local fail=0
  [ "$(code "$URL/api/properties")" = 200 ] || fail=1
  [ "$(code "$URL/api/crm/outreach/reminder-daily")" = 401 ] || fail=1
  [ "$(code "$URL/api/crm/outreach/library")" = 401 ] || fail=1
  [ "$fail" = 0 ] && echo "VERIFY OK" || { echo "VERIFY FAILED"; return 1; }
}
stage() {
  rm -f "$MARKER"
  cleanup_test; rm -rf "$STAGE"; mkdir -p "$STAGE"
  rsync -a --exclude node_modules --exclude uploads --exclude logs --exclude '.*' --exclude backups --exclude '*.log' --exclude exports --exclude private-docs "$LIVE/" "$STAGE/"
  mkdir -p "$STAGE/test" "$STAGE/node_modules"
  for f in $REPLACED services/safeDraftsPack.js; do cp "$PKG/backend/$f" "$STAGE/$f"; done
  python3 "$PKG/deploy/patch_u3.py" "$STAGE"
  cp "$PKG/backend/test/reminder-daily.test.js" "$STAGE/test/"
  for f in $PATCHED $REPLACED; do docker run --rm --network none -v "$STAGE:/app:ro" -w /app --entrypoint node 2906-system-backend --check "$f"; done
  docker network create --internal "$TESTNET" >/dev/null
  docker run -d --rm --name "$TESTDB" --network "$TESTNET" -e POSTGRES_PASSWORD=test pgvector/pgvector:pg16 >/dev/null
  for i in $(seq 1 40); do docker exec "$TESTDB" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 2
  docker exec "$PG" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -s --no-owner --no-privileges' > "$STAGE/schema.sql"
  docker exec "$TESTDB" psql -U postgres -q -c 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"' -c 'CREATE EXTENSION IF NOT EXISTS btree_gist' >/dev/null
  docker exec -i "$TESTDB" psql -U postgres -q < "$STAGE/schema.sql" > "$STAGE/schema.log" 2>&1 || true
  docker exec "$PG" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --data-only -t settings -t villages --no-owner --no-privileges' | docker exec -i "$TESTDB" psql -U postgres -q >/dev/null 2>&1 || true
  local r=0
  docker run --rm --network "$TESTNET" -v "$STAGE:/app:ro" -v "$LIVE/node_modules:/app/node_modules:ro" -w /app \
    -e BACKEND_DIR=/app -e NODE_ENV=test -e PGHOST="$TESTDB" -e TZ=UTC --entrypoint timeout 2906-system-backend 300 node --test --test-force-exit --test-concurrency=1 test/reminder-daily.test.js > /tmp/argus-u3-test.out 2>&1 || r=$?
  cleanup_test
  grep -E '^(ok|not ok) ' /tmp/argus-u3-test.out | cut -c1-170 || true
  grep -E '^# (pass|fail)' /tmp/argus-u3-test.out || true
  if [ "$r" != 0 ] || grep -qE '^not ok |^# fail [1-9]' /tmp/argus-u3-test.out || ! grep -qE '^# pass [1-9]' /tmp/argus-u3-test.out; then
    grep -A30 "^not ok" /tmp/argus-u3-test.out | grep -E "error|expected|actual|at .*(test|services)" | cut -c1-300 | head -40 || true
    echo "STAGE TESTS FAILED — release stopped"; return 1
  fi
  echo "$(date +%s) $(fingerprint)" > "$MARKER"
  echo "STAGE TESTS PASSED (marker written)"
}
apply() {
  [ -f "$MARKER" ] || { echo "REFUSE: no passing stage run for this package"; return 1; }
  read -r ts fp < "$MARKER"
  [ $(( $(date +%s) - ts )) -lt 7200 ] || { echo "REFUSE: stage pass older than 2 h — run stage again"; return 1; }
  [ "$fp" = "$(fingerprint)" ] || { echo "REFUSE: package or live files changed since the passing stage run"; return 1; }
  cd "$LIVE"
  TS=$(date -u +%Y%m%dT%H%M%SZ); BK="$BKROOT/reminder-u3-$TS"; mkdir -p "$BK/services" "$BK/routes"
  for f in $PATCHED $REPLACED; do cp -p "$f" "$BK/$f"; done; echo "$BK" > "$BKROOT/reminder-u3-latest"; echo "backup: $BK"
  restore() { echo "ROLLING BACK"; for f in $PATCHED $REPLACED; do cp -p "$BK/$f" "$LIVE/$f"; done; docker restart "$CT" >/dev/null; wait_up && echo "rolled back, backend up"; }
  for f in $REPLACED; do cp "$PKG/backend/$f" "$LIVE/$f"; done
  python3 "$PKG/deploy/patch_u3.py" "$LIVE" || { restore; return 1; }
  for f in $PATCHED $REPLACED; do docker run --rm --network none -v "$LIVE:/app:ro" -w /app --entrypoint node 2906-system-backend --check "$f" || { restore; return 1; }; done
  docker restart "$CT" >/dev/null
  if ! wait_up; then restore; return 1; fi
  sleep 5
  verify || { restore; return 1; }
  if docker logs --since 2m "$CT" 2>&1 | grep -E "Cannot find module|SyntaxError|ReferenceError" | head -3 | grep -q .; then restore; return 1; fi
  rm -f "$MARKER"
  echo "APPLIED AND VERIFIED"
}
case "${1:-}" in
  stage) stage ;;
  release) stage; apply ;;
  apply) apply ;;
  rollback) BK=$(cat "$BKROOT/reminder-u3-latest"); for f in $PATCHED $REPLACED; do cp -p "$BK/$f" "$LIVE/$f"; done; docker restart "$CT" >/dev/null; wait_up && echo "rolled back to $BK" ;;
  *) echo "usage: u3.sh stage|release|apply|rollback"; exit 2 ;;
esac
