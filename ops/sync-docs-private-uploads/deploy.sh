#!/usr/bin/env bash
# Confidential owner documents: private storage for CRM / WhatsApp uploads + migration of the Cloudinary originals (2026-11-21).
#   deploy.sh stage     throwaway PostgreSQL + patched copy: new tests + all SYNC suites
#   deploy.sh apply     backup (files + database), migration d (staging table + trigger), patch 5 workflows, restart, verify
#   deploy.sh migrate   manifest of the original references -> copy (virus check) -> verify -> cleanup report. Originals untouched.
#   deploy.sh rollback  previous code back (the trigger stays harmless: only rows with 'sync-private:' urls use it)
#   deploy.sh verify
set -euo pipefail
PKG="$(cd "$(dirname "$0")" && pwd)"; LIVE=/opt/2906-system/backend; CT=2906_backend; PG=2906_postgres; BKROOT=/opt/2906-system/backups
PATCHED="routes/crm.js routes/crmOwnergroups.js routes/ownerUpload.js routes/crmScheduleBoard.js services/bookRelay.js"
F=services/syncDocuments.js; BASE_SHA=687dd9a19560cf90c12acfe61a25224ed07d7fe0c57cf126e4334725b4072242
SCRIPT=scripts/cloudinary-docs-migrate.js
MIG=migrations/20261121d_owner_documents_private_uploads.sql; MIGDOWN=migrations/20261121d_owner_documents_private_uploads.down.sql
STAGE=/tmp/argus-docs-up-stage; TESTNET=argus-docs-up-net; TESTDB=argus-docs-up-db
TESTS="test/staff-docs-private.test.js test/sync-delegates-docs.test.js test/sync-conditions.test.js test/sync-account.test.js test/sync-inbox-roles.test.js"
URL=http://127.0.0.1:3001
code() { curl -s -o /dev/null -m 10 -w '%{http_code}' "$@" || echo 000; }
wait_up() { for i in $(seq 1 45); do [ "$(code "$URL/api/properties")" = 200 ] && return 0; sleep 2; done; return 1; }
psql_live() { docker exec -i "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -v ON_ERROR_STOP=1 -q'; }
verify() {
  local fail=0
  [ "$(code "$URL/api/properties")" = 200 ] && echo "ok   properties 200" || { echo "FAIL properties"; fail=1; }
  [ "$(code "$URL/api/crm/owners/1")" = 401 ] && echo "ok   owner profile needs login" || { echo "FAIL owner profile auth"; fail=1; }
  [ "$(code -X POST "$URL/api/crm/owners/1/documents")" = 401 ] && echo "ok   CRM document upload needs login" || { echo "FAIL upload auth"; fail=1; }
  [ "$(code "$URL/api/crm/owner-documents/1/file?exp=1&sig=x")" = 404 ] && echo "ok   staff file link needs a valid signature" || { echo "FAIL staff file route"; fail=1; }
  [ "$(echo "SELECT COUNT(*) FROM pg_trigger WHERE tgname='owner_documents_private_link'" | docker exec -i "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -At')" = 1 ] && echo "ok   private-link trigger present" || { echo "FAIL trigger"; fail=1; }
  c=$(docker exec 2906_waha node -e "fetch('http://backend:3001/webhook/waha',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event:'security.probe',session:'x',payload:{}})}).then(r=>console.log(r.status)).catch(()=>console.log(0))" 2>/dev/null || echo 0)
  [ "$c" = 200 ] && echo "ok   WhatsApp gateway reaches the backend" || { echo "FAIL gateway -> backend ($c)"; fail=1; }
  [ "$fail" = 0 ] && echo "VERIFY OK" || { echo "VERIFY FAILED"; return 1; }
}
case "${1:-}" in
  stage)
    docker rm -f "$TESTDB" >/dev/null 2>&1 || true; docker network rm "$TESTNET" >/dev/null 2>&1 || true; rm -rf "$STAGE"; mkdir -p "$STAGE"
    rsync -a --exclude node_modules --exclude uploads --exclude logs --exclude '.*' --exclude backups --exclude '*.log' --exclude exports --exclude private-docs "$LIVE/" "$STAGE/"
    mkdir -p "$STAGE/test" "$STAGE/node_modules" "$STAGE/uploads" "$STAGE/scripts"
    python3 "$PKG/patch.py" "$STAGE"
    cp "$PKG/backend/$F" "$STAGE/$F"; cp "$PKG/backend/$SCRIPT" "$STAGE/$SCRIPT"; cp "$PKG"/backend/test/*.test.js "$STAGE/test/"
    for f in $PATCHED $F $SCRIPT; do docker run --rm --network none -v "$STAGE:/app:ro" -w /app --entrypoint node 2906-system-backend --check "$f"; done
    docker network create --internal "$TESTNET" >/dev/null
    docker run -d --rm --name "$TESTDB" --network "$TESTNET" -e POSTGRES_PASSWORD=test pgvector/pgvector:pg16 >/dev/null
    for i in $(seq 1 40); do docker exec "$TESTDB" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 2
    docker exec "$PG" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -s --no-owner --no-privileges' > "$STAGE/schema.sql"
    docker exec "$TESTDB" psql -U postgres -q -c 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"'
    docker exec -i "$TESTDB" psql -U postgres -q < "$STAGE/schema.sql" > /dev/null 2>&1 || true
    docker exec -i "$TESTDB" psql -U postgres -v ON_ERROR_STOP=1 -q < "$PKG/backend/$MIG"
    set +e; r=0
    for t in $TESTS; do
      docker exec -e PGOPTIONS="-c client_min_messages=warning" "$TESTDB" psql -U postgres -q -c "DO \$\$ DECLARE r record; BEGIN FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP EXECUTE 'TRUNCATE ' || quote_ident(r.tablename) || ' RESTART IDENTITY CASCADE'; END LOOP; END \$\$" >/dev/null
      docker run --rm --network "$TESTNET" -v "$STAGE:/app" -v "$LIVE/node_modules:/app/node_modules:ro" -w /app \
        -e BACKEND_DIR=/app -e NODE_ENV=test -e PGHOST="$TESTDB" --entrypoint timeout 2906-system-backend 300 node --test --test-force-exit --test-concurrency=1 "$t" > /tmp/argus-docs-up.out 2>&1
      rt=$?; echo "== $t"; grep -E "^# (pass|fail)" /tmp/argus-docs-up.out || head -40 /tmp/argus-docs-up.out
      [ "$rt" = 0 ] || { r=1; grep -B2 -A30 "^not ok" /tmp/argus-docs-up.out | cut -c1-300 | head -120; }
    done
    docker exec -i "$TESTDB" psql -U postgres -v ON_ERROR_STOP=1 -q < "$PKG/backend/$MIGDOWN" && docker exec -i "$TESTDB" psql -U postgres -v ON_ERROR_STOP=1 -q < "$PKG/backend/$MIG" && echo "ok   migration down + up" || r=1
    set -e
    docker rm -f "$TESTDB" >/dev/null 2>&1 || true; docker network rm "$TESTNET" >/dev/null 2>&1 || true; rm -rf "$STAGE"
    [ "$r" = 0 ] && echo "STAGE TESTS PASSED" || { echo "STAGE TESTS FAILED"; exit 1; }
    ;;
  apply)
    python3 "$PKG/patch.py" "$LIVE" --check
    [ "$(sha256sum "$LIVE/$F" | cut -c1-64)" = "$BASE_SHA" ] || { echo "REFUSE: $F changed since it went live"; exit 1; }
    TS=$(date -u +%Y%m%dT%H%M%SZ); BK="$BKROOT/docs-private-uploads-$TS"; mkdir -p "$BK/routes" "$BK/services"
    for f in $PATCHED $F; do cp -p "$LIVE/$f" "$BK/$f"; done
    docker exec "$PG" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$BK/argus-db.dump"
    n=$(docker exec -i "$PG" pg_restore -l < "$BK/argus-db.dump" | grep -c "TABLE DATA" || true)
    [ "${n:-0}" -gt 50 ] || { echo "REFUSE: database backup looks wrong ($n tables)"; exit 1; }
    echo "$BK" > "$BKROOT/docs-private-uploads-latest"; echo "backup: $BK ($n tables in the dump)"
    restore() { echo "ROLLING BACK"; for f in $PATCHED $F; do cp -p "$BK/$f" "$LIVE/$f"; done; docker restart "$CT" >/dev/null; wait_up && echo "rolled back, backend up"; }
    psql_live < "$PKG/backend/$MIG" || { echo "migration failed, nothing else changed"; exit 1; }
    cp "$PKG/backend/$MIG" "$PKG/backend/$MIGDOWN" "$LIVE/migrations/"
    cp "$PKG/backend/$F" "$LIVE/$F"; cp "$PKG/backend/$SCRIPT" "$LIVE/$SCRIPT"
    python3 "$PKG/patch.py" "$LIVE" || { restore; exit 1; }
    for f in $PATCHED $F $SCRIPT; do docker run --rm --network none -v "$LIVE:/app:ro" -w /app --entrypoint node 2906-system-backend --check "$f" || { restore; exit 1; }; done
    docker restart "$CT" >/dev/null; wait_up || { restore; exit 1; }; sleep 5
    verify || { restore; exit 1; }
    if docker logs --since 2m "$CT" 2>&1 | grep -E "Cannot find module|SyntaxError|ReferenceError" | head -3 | grep -q .; then restore; exit 1; fi
    echo "APPLIED AND VERIFIED"
    ;;
  migrate)
    BK="$BKROOT/cloudinary-docs-$(date -u +%Y%m%dT%H%M%SZ)"; mkdir -p -m 700 "$BK"
    docker exec "$PG" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -t owner_documents' > "$BK/owner_documents.dump"
    docker exec -i "$PG" pg_restore -l < "$BK/owner_documents.dump" | grep -q "TABLE DATA public owner_documents" || { echo "REFUSE: table backup failed"; exit 1; }
    echo "table backup: $BK"
    docker exec "$CT" node /app/$SCRIPT check
    docker exec "$CT" node /app/$SCRIPT manifest
    cp -p "$LIVE/private-docs/.cloudinary-manifest.json" "$BK/" && chmod 600 "$BK/.cloudinary-manifest.json"
    docker exec "$CT" node /app/$SCRIPT copy
    docker exec "$CT" node /app/$SCRIPT verify
    docker exec "$CT" node /app/$SCRIPT report
    cp -p "$LIVE/private-docs/.cloudinary-cleanup-report.json" "$BK/"
    ;;
  rollback)
    BK=$(cat "$BKROOT/docs-private-uploads-latest"); for f in $PATCHED $F; do cp -p "$BK/$f" "$LIVE/$f"; done
    docker restart "$CT" >/dev/null; wait_up && echo "rolled back to $BK (migrated rows: docker exec $CT node /app/$SCRIPT revert)"
    ;;
  verify) verify ;;
  *) echo "usage: deploy.sh stage|apply|migrate|rollback|verify"; exit 2 ;;
esac
