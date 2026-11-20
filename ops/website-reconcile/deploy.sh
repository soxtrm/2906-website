#!/usr/bin/env bash
# Website reconcile: the public copy follows ARGUS. Run on the VPS from the unpacked package directory.
#   deploy.sh stage       patched copy + throwaway PostgreSQL (full live schema, no rows), tests; no live change
#   deploy.sh report      READ-ONLY against live: what a run would change
#   deploy.sh repair      full snapshot, additive log table, ONE reviewed run without the change limit, before/after
#   deploy.sh schedule    install the service + the 10-minute cron, restart, verify
#   deploy.sh rollback    remove service + cron entry, restart (website rows are restored with undo.sql of the repair)
set -euo pipefail
PKG="$(cd "$(dirname "$0")" && pwd)"
LIVE=/opt/2906-system/backend; CT=2906_backend; PG=2906_postgres; BKROOT=/opt/2906-system/backups
STAGE=/tmp/argus-web-reconcile-stage; TESTNET=argus-web-reconcile-net; TESTDB=argus-web-reconcile-db
MIG=20261120_website_reconcile_log
up() { for i in $(seq 1 45); do [ "$(curl -s -o /dev/null -m 10 -w '%{http_code}' http://127.0.0.1:3001/api/properties)" = 200 ] && return 0; sleep 2; done; return 1; }
cleanup() { docker rm -f "$TESTDB" >/dev/null 2>&1 || true; docker network rm "$TESTNET" >/dev/null 2>&1 || true; rm -rf "$STAGE"; }
psql_live() { docker exec -i "$PG" sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' sh "$@"; }
run_module() { # $1 = APPLY (0/1), $2 = MAX ('' = default, null = no limit)
  docker cp "$PKG/websiteReconcile.js" "$CT:/tmp/websiteReconcile.js"; docker cp "$PKG/run.js" "$CT:/tmp/wr-run.js"
  docker exec -e APPLY="$1" -e MAX="${2:-}" "$CT" timeout 300 node /tmp/wr-run.js 2>&1 | grep -v '^\[20\|^{"level'
}
public_counts() { curl -s -m 30 "http://127.0.0.1:3001/api/properties?limit=1000" | docker exec -i "$CT" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);const m={};for(const p of a)m[p.status]=(m[p.status]||0)+1;console.log("public API:",a.length,"listings",JSON.stringify(m))})'; }

case "${1:-}" in
  stage)
    cleanup; mkdir -p "$STAGE"
    rsync -a --exclude node_modules --exclude uploads --exclude logs --exclude '.*' --exclude backups --exclude '*.log' --exclude exports "$LIVE/" "$STAGE/"
    mkdir -p "$STAGE/test" "$STAGE/node_modules"
    cp "$PKG/websiteReconcile.js" "$STAGE/services/"; cp "$PKG/website-reconcile.test.js" "$STAGE/test/"
    python3 "$PKG/cron_patch.py" "$STAGE"
    for f in services/websiteReconcile.js cron.js; do docker run --rm --network none -v "$STAGE:/app:ro" -w /app --entrypoint node 2906-system-backend --check "$f"; done
    docker network create --internal "$TESTNET" >/dev/null
    docker run -d --rm --name "$TESTDB" --network "$TESTNET" -e POSTGRES_PASSWORD=test pgvector/pgvector:pg16 >/dev/null
    for i in $(seq 1 40); do docker exec "$TESTDB" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 2
    docker exec "$PG" sh -c 'pg_dump -s --no-owner --no-privileges -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$STAGE/schema.sql"
    docker exec -i "$TESTDB" psql -q -U postgres -d postgres < "$STAGE/schema.sql" > /tmp/argus-web-reconcile-schema.log 2>&1 || true
    for m in "$MIG.sql" "$MIG.down.sql" "$MIG.sql"; do docker exec -i "$TESTDB" psql -v ON_ERROR_STOP=1 -q -U postgres -d postgres < "$PKG/$m"; done
    echo "migration up/down/up ok"
    set +e
    docker run --rm --network "$TESTNET" -v "$STAGE:/app:ro" -v "$LIVE/node_modules:/app/node_modules:ro" -w /app -e BACKEND_DIR=/app -e NODE_ENV=test -e PGHOST="$TESTDB" \
      --entrypoint timeout 2906-system-backend 200 node --test --test-force-exit --test-concurrency=1 test/website-reconcile.test.js > /tmp/argus-web-reconcile.out 2>&1
    r=$?
    set -e
    grep -E "^(ok|not ok)|^# (pass|fail)" /tmp/argus-web-reconcile.out
    [ "$r" = 0 ] || grep -B2 -A24 "^not ok" /tmp/argus-web-reconcile.out | cut -c1-260 | head -120
    cleanup
    [ "$r" = 0 ] && echo "STAGE TESTS PASSED" || { echo "STAGE TESTS FAILED"; exit 1; }
    ;;
  report)
    psql_live -c "SELECT to_regclass('website_reconcile_log') IS NOT NULL AS log_table_exists" | tail -3
    run_module 0
    ;;
  repair)
    TS=$(date -u +%Y%m%dT%H%M%SZ); BK="$BKROOT/website-reconcile-$TS"; mkdir -p "$BK"
    docker exec "$PG" sh -c 'pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$BK/2906db_pre-website-reconcile.dump"; chmod 600 "$BK/2906db_pre-website-reconcile.dump"
    N=$(docker exec -i "$PG" pg_restore -l < "$BK/2906db_pre-website-reconcile.dump" | grep -c "TABLE DATA"); echo "snapshot: $BK ($N tables)"; [ "$N" -gt 50 ]
    C=$(docker exec -i "$PG" pg_restore -l < "$BK/2906db_pre-website-reconcile.dump" | grep -c "TABLE DATA public website_properties" || true)
    [ "$C" -ge 1 ] || { echo "snapshot has no website_properties"; exit 1; }
    # the website rows as they are now, as plain SQL, so exactly these can be put back without a full restore
    psql_live -At -c "SELECT format('UPDATE website_properties SET status = %L, is_published = %L, price = %L, updated_at = %L WHERE id::text = %L;', status, is_published, price, updated_at, id::text) FROM website_properties" > "$BK/undo.sql"
    echo "undo file: $(wc -l < "$BK/undo.sql") website rows"
    echo "$BK" > "$BKROOT/website-reconcile-latest"
    psql_live < "$PKG/$MIG.sql"
    echo "--- before ---"; public_counts
    run_module 0 | tr -d '\n' | cut -c1-400; echo
    echo "--- applying ---"
    run_module 1 null
    echo "--- after ---"; public_counts
    echo "--- second run (must find nothing) ---"
    run_module 0 | tr -d '\n' | cut -c1-400; echo
    psql_live -c "SELECT action, reason, count(*) FROM website_reconcile_log GROUP BY 1,2 ORDER BY 1,3 DESC"
    ;;
  schedule)
    [ -e "$LIVE/services/websiteReconcile.js" ] && { echo "REFUSE: already installed"; exit 1; }
    python3 "$PKG/cron_patch.py" "$LIVE" --check
    TS=$(date -u +%Y%m%dT%H%M%SZ); BK="$BKROOT/website-reconcile-cron-$TS"; mkdir -p "$BK"; cp -p "$LIVE/cron.js" "$BK/cron.js"; echo "$BK" > "$BKROOT/website-reconcile-cron-latest"; echo "backup: $BK"
    restore() { echo "ROLLING BACK"; cp -p "$BK/cron.js" "$LIVE/cron.js"; rm -f "$LIVE/services/websiteReconcile.js"; docker restart "$CT" >/dev/null; up && echo "rolled back, backend up" || echo "ROLLBACK: backend not answering"; }
    cp "$PKG/websiteReconcile.js" "$LIVE/services/websiteReconcile.js"; cp "$PKG/$MIG.sql" "$PKG/$MIG.down.sql" "$LIVE/migrations/"
    python3 "$PKG/cron_patch.py" "$LIVE" || { restore; exit 1; }
    for f in services/websiteReconcile.js cron.js; do docker run --rm --network none -v "$LIVE:/app:ro" -w /app --entrypoint node 2906-system-backend --check "$f" || { restore; exit 1; }; done
    docker restart "$CT" >/dev/null
    up || { echo "backend did not come up"; restore; exit 1; }
    sleep 6
    docker exec "$CT" node -e "require('/app/services/websiteReconcile').reconcile({apply:false}).then(s=>{console.log('ok   service loads; pending changes:',s.refresh+s.markRented+s.hide+s.show);process.exit(0)}).catch(e=>{console.log(e.message);process.exit(1)})" 2>&1 | grep -v '^\[20' || { restore; exit 1; }
    c=$(docker exec 2906_waha node -e "fetch('http://backend:3001/webhook/waha',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event:'security.probe',session:'x',payload:{}})}).then(r=>console.log(r.status)).catch(()=>console.log(0))" 2>/dev/null || echo 0)
    [ "$c" = 200 ] && echo "ok   gateway reaches the backend" || { echo "FAIL gateway -> backend ($c)"; restore; exit 1; }
    if docker logs --since 2m "$CT" 2>&1 | grep -E "Cannot find module|SyntaxError|ReferenceError" | head -3 | grep -q .; then restore; exit 1; fi
    echo "SCHEDULED AND VERIFIED"
    ;;
  rollback)
    BK=$(cat "$BKROOT/website-reconcile-cron-latest"); cp -p "$BK/cron.js" "$LIVE/cron.js"; rm -f "$LIVE/services/websiteReconcile.js"
    docker restart "$CT" >/dev/null; up && echo "ROLLED BACK (cron + service removed), backend up"
    echo "website rows: psql < $(cat "$BKROOT/website-reconcile-latest")/undo.sql puts every row back to its state before the repair"
    ;;
  *) echo "usage: deploy.sh stage | report | repair | schedule | rollback"; exit 1;;
esac
