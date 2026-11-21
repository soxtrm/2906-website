#!/usr/bin/env bash
# NEXUS SYNC private documents: safeguards (Claude, 2026-11-21).
#   deploy.sh stage     throwaway PostgreSQL + patched copy: all SYNC tests incl. quarantine/infected/re-check
#   deploy.sh apply     ClamAV container, migration (additive), quarantine code, encrypted nightly backup + 10-minute re-scan.
#                       Documents stay OFF (SYNC_DOCUMENTS_ENABLED unset).
#   deploy.sh enable    switch documents on (env + recreate the backend container) and verify
#   deploy.sh disable   switch documents off again
#   deploy.sh rollback  previous document service, cron lines removed, documents off (columns and ClamAV stay)
#   deploy.sh verify
set -euo pipefail
PKG="$(cd "$(dirname "$0")" && pwd)"; LIVE=/opt/2906-system/backend; CT=2906_backend; PG=2906_postgres; BKROOT=/opt/2906-system/backups
COMPOSE_DIR=/opt/2906-system; NETWORK=2906-system_2906_net; CLAM=argus-clamav; CLAM_IMAGE=clamav/clamav:1.4
F=services/syncDocuments.js; BASE_SHA=f2996b01506873706893c61899765c449d9e382077631c955f8be44d435457e3
MIG=migrations/20261121c_sync_document_scan.sql; MIGDOWN=migrations/20261121c_sync_document_scan.down.sql
OPS=/opt/2906-system/ops/private-docs-backup; KEY=/etc/argus-backup/private-docs.key
STAGE=/tmp/argus-sync-sec-stage; TESTNET=argus-sync-sec-net; TESTDB=argus-sync-sec-db
TESTS="test/sync-delegates-docs.test.js test/sync-conditions.test.js test/sync-account.test.js test/sync-inbox-roles.test.js"
URL=http://127.0.0.1:3001
code() { curl -s -o /dev/null -m 10 -w '%{http_code}' "$@" || echo 000; }
wait_up() { for i in $(seq 1 45); do [ "$(code "$URL/api/properties")" = 200 ] && return 0; sleep 2; done; return 1; }
psql_live() { docker exec -i "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -v ON_ERROR_STOP=1 -q'; }
clam_check() {  # real clamd from inside the backend container: EICAR must be found, a PDF must pass
  docker exec "$CT" node -e "
    const s=require('/app/services/syncDocuments.js');
    const e=Buffer.from('X5O!P%@AP[4\\\\PZX54(P^)7CC)7}\$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!\$H+H*','latin1');
    Promise.all([s.clamdScan(e), s.clamdScan(Buffer.from('%PDF-1.4\\n%%EOF\\n'))]).then(([a,b])=>{console.log('clamd: eicar',a.clean?'MISSED':'found ('+a.signature+')','| pdf',b.clean?'clean':'FLAGGED');process.exit(!a.clean&&b.clean?0:1)}).catch(x=>{console.log('clamd error',x.message);process.exit(2)})"
}
verify() {
  local fail=0
  [ "$(code "$URL/api/properties")" = 200 ] && echo "ok   properties 200" || { echo "FAIL properties"; fail=1; }
  for p in documents documents/upload documents/file documents/share delegates; do
    [ "$(code -X POST -H 'content-type: application/json' -d '{}' "$URL/api/sync-account/v1/$p")" = 401 ] && echo "ok   unsigned $p 401" || { echo "FAIL unsigned $p"; fail=1; }
  done
  [ "$(code "$URL/api/crm/owner-documents/1/file?exp=1&sig=x")" = 404 ] && echo "ok   staff file link needs a valid signature" || { echo "FAIL staff file route"; fail=1; }
  clam_check && echo "ok   virus check reachable from the backend" || { echo "FAIL virus check"; fail=1; }
  [ "$fail" = 0 ] && echo "VERIFY OK" || { echo "VERIFY FAILED"; return 1; }
}
set_flag() {  # $1 = 1 | remove
  cp -p "$COMPOSE_DIR/.env" "$BKROOT/env-before-docs-flag-$(date -u +%Y%m%dT%H%M%SZ)"
  sed -i '/^SYNC_DOCUMENTS_ENABLED=/d' "$COMPOSE_DIR/.env"
  [ "$1" = 1 ] && echo 'SYNC_DOCUMENTS_ENABLED=1' >> "$COMPOSE_DIR/.env"
  (cd "$COMPOSE_DIR" && docker compose up -d --no-deps backend >/dev/null 2>&1)
  wait_up; sleep 5
}
case "${1:-}" in
  stage)
    docker rm -f "$TESTDB" >/dev/null 2>&1 || true; docker network rm "$TESTNET" >/dev/null 2>&1 || true; rm -rf "$STAGE"; mkdir -p "$STAGE"
    rsync -a --exclude node_modules --exclude uploads --exclude logs --exclude '.*' --exclude backups --exclude '*.log' --exclude exports --exclude private-docs "$LIVE/" "$STAGE/"
    mkdir -p "$STAGE/test" "$STAGE/node_modules" "$STAGE/uploads"
    cp "$PKG/backend/$F" "$STAGE/$F"; cp "$PKG"/backend/test/*.test.js "$STAGE/test/"
    docker run --rm --network none -v "$STAGE:/app:ro" -w /app --entrypoint node 2906-system-backend --check "$F"
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
      docker run --rm --network "$TESTNET" -v "$STAGE:/app:ro" -v "$LIVE/node_modules:/app/node_modules:ro" -w /app \
        -e BACKEND_DIR=/app -e NODE_ENV=test -e PGHOST="$TESTDB" --entrypoint timeout 2906-system-backend 300 node --test --test-force-exit --test-concurrency=1 "$t" > /tmp/argus-sync-sec.out 2>&1
      rt=$?; echo "== $t"; grep -E "^# (pass|fail)" /tmp/argus-sync-sec.out || head -40 /tmp/argus-sync-sec.out
      [ "$rt" = 0 ] || { r=1; grep -B2 -A30 "^not ok" /tmp/argus-sync-sec.out | cut -c1-300 | head -120; }
    done
    docker exec -i "$TESTDB" psql -U postgres -v ON_ERROR_STOP=1 -q < "$PKG/backend/$MIGDOWN" && docker exec -i "$TESTDB" psql -U postgres -v ON_ERROR_STOP=1 -q < "$PKG/backend/$MIG" && echo "ok   migration down + up" || r=1
    set -e
    docker rm -f "$TESTDB" >/dev/null 2>&1 || true; docker network rm "$TESTNET" >/dev/null 2>&1 || true; rm -rf "$STAGE"
    [ "$r" = 0 ] && echo "STAGE TESTS PASSED" || { echo "STAGE TESTS FAILED"; exit 1; }
    ;;
  apply)
    [ "$(sha256sum "$LIVE/$F" | cut -c1-64)" = "$BASE_SHA" ] || { echo "REFUSE: $F changed since it went live"; exit 1; }
    grep -q '^SYNC_DOCUMENTS_ENABLED=1' "$COMPOSE_DIR/.env" && { echo "REFUSE: documents are already switched on"; exit 1; }
    TS=$(date -u +%Y%m%dT%H%M%SZ); BK="$BKROOT/sync-docs-security-$TS"; mkdir -p "$BK/services"
    cp -p "$LIVE/$F" "$BK/$F"; crontab -l > "$BK/crontab.before"
    docker exec "$PG" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$BK/argus-db.dump"
    n=$(docker exec -i "$PG" pg_restore -l < "$BK/argus-db.dump" | grep -c "TABLE DATA" || true)
    [ "${n:-0}" -gt 50 ] || { echo "REFUSE: database backup looks wrong ($n tables)"; exit 1; }
    echo "$BK" > "$BKROOT/sync-docs-security-latest"; echo "backup: $BK ($n tables in the dump)"
    # 1. virus scanner: official ClamAV image, on the backend network only, no published port, memory capped
    if ! docker ps --format '{{.Names}}' | grep -qx "$CLAM"; then
      docker rm -f "$CLAM" >/dev/null 2>&1 || true
      docker run -d --name "$CLAM" --network "$NETWORK" --restart unless-stopped -m 2g --memory-swap 2g "$CLAM_IMAGE" >/dev/null
      echo "ClamAV starting (signatures load in 1-3 minutes)"
    fi
    for i in $(seq 1 90); do docker logs "$CLAM" 2>&1 | grep -q "socket found, clamd started" && break; sleep 4; done
    docker logs "$CLAM" 2>&1 | grep -q "socket found, clamd started" || { echo "FAIL: ClamAV did not start"; exit 1; }
    # 2. columns, 3. code
    psql_live < "$PKG/backend/$MIG" || { echo "migration failed, nothing else changed"; exit 1; }
    cp "$PKG/backend/$MIG" "$PKG/backend/$MIGDOWN" "$LIVE/migrations/"
    restore() { echo "ROLLING BACK"; cp -p "$BK/$F" "$LIVE/$F"; docker restart "$CT" >/dev/null; wait_up && echo "rolled back, backend up"; }
    cp "$PKG/backend/$F" "$LIVE/$F"; mkdir -p -m 700 "$LIVE/private-docs"
    docker run --rm --network none -v "$LIVE:/app:ro" -w /app --entrypoint node 2906-system-backend --check "$F" || { restore; exit 1; }
    docker restart "$CT" >/dev/null; wait_up || { restore; exit 1; }; sleep 5
    verify || { restore; exit 1; }
    # 4. encrypted backup + re-scan: key (root only), scripts, cron
    mkdir -p "$OPS"; cp "$PKG"/backup/private_docs_backup.sh "$PKG"/backup/restore.sh "$PKG"/backup/verify.py "$OPS/"; chmod 700 "$OPS"/*.sh
    [ -s "$KEY" ] || (umask 077; head -c 96 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 64 > "$KEY"; echo "new backup key created at $KEY (root only)")
    chmod 600 "$KEY"
    (crontab -l | grep -v 'private-docs-backup\|rescanPending'
     echo "45 2 * * * $OPS/private_docs_backup.sh >> /var/log/2906-private-docs-backup.log 2>&1 || docker exec 2906_backend node -e \"require('/app/telegram').sendAlert('PRIVATE DOCUMENTS BACKUP FAILED (see /var/log/2906-private-docs-backup.log)').then(()=>process.exit(0)).catch(()=>process.exit(0))\""
     echo "*/10 * * * * docker exec 2906_backend node -e \"require('/app/services/syncDocuments').rescanPending().then(r=>{if(r.checked)console.log(new Date().toISOString(),JSON.stringify(r));process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})\" >> /var/log/2906-docs-rescan.log 2>&1") | crontab -
    "$OPS/private_docs_backup.sh"
    echo "APPLIED AND VERIFIED (documents still switched off)"
    ;;
  enable)
    set_flag 1
    [ "$(docker exec "$CT" printenv SYNC_DOCUMENTS_ENABLED)" = 1 ] || { echo "FAIL: flag not active"; exit 1; }
    verify || { echo "switching off again"; set_flag remove; exit 1; }
    echo "DOCUMENTS ENABLED"
    ;;
  disable) set_flag remove; echo "documents switched off" ;;
  rollback)
    BK=$(cat "$BKROOT/sync-docs-security-latest"); grep -q '^SYNC_DOCUMENTS_ENABLED=' "$COMPOSE_DIR/.env" && set_flag remove
    cp -p "$BK/$F" "$LIVE/$F"; crontab -l | grep -v 'private-docs-backup\|rescanPending' | crontab -
    docker restart "$CT" >/dev/null; wait_up && echo "rolled back to $BK (columns, ClamAV container and backups kept)"
    ;;
  verify) verify ;;
  *) echo "usage: deploy.sh stage|apply|enable|disable|rollback|verify"; exit 2 ;;
esac
