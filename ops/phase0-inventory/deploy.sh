#!/usr/bin/env bash
# Phase 0 inventory: property type from evidence, website review route, legacy entries, type backfill.
#   deploy.sh stage           patched copy + throwaway PostgreSQL (full live schema, no rows), tests
#   deploy.sh apply           backup, patch, restart, verify, auto-rollback (code only)
#   deploy.sh legacy [apply]  older website entries nobody vouches for: report, or hide after a snapshot
#   deploy.sh types [apply]   stored kind vs the listing's own text: report, or correct the clear cases
#   deploy.sh rollback        restore the code of the newest backup and restart
set -euo pipefail
PKG="$(cd "$(dirname "$0")" && pwd)"
LIVE=/opt/2906-system/backend; CT=2906_backend; PG=2906_postgres; BKROOT=/opt/2906-system/backups
STAGE=/tmp/argus-phase0-stage; TESTNET=argus-phase0-net; TESTDB=argus-phase0-db
FILES="handlers/upload.js handlers/uploadListing.js index.js"
NEW="services/propertyTypeResolver.js routes/crmWebsiteReview.js"
up() { for i in $(seq 1 45); do [ "$(curl -s -o /dev/null -m 10 -w '%{http_code}' http://127.0.0.1:3001/api/properties)" = 200 ] && return 0; sleep 2; done; return 1; }
cleanup() { docker rm -f "$TESTDB" >/dev/null 2>&1 || true; docker network rm "$TESTNET" >/dev/null 2>&1 || true; rm -rf "$STAGE"; }
place() { cp "$PKG/propertyTypeResolver.js" "$1/services/propertyTypeResolver.js"; cp "$PKG/crmWebsiteReview.js" "$1/routes/crmWebsiteReview.js"; }
snapshot() { # $1 = name
  TS=$(date -u +%Y%m%dT%H%M%SZ); BK="$BKROOT/$1-$TS"; mkdir -p "$BK"
  docker exec "$PG" sh -c 'pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$BK/2906db_pre-$1.dump"; chmod 600 "$BK/2906db_pre-$1.dump"
  N=$(docker exec -i "$PG" pg_restore -l < "$BK/2906db_pre-$1.dump" | grep -c "TABLE DATA" || true); echo "snapshot: $BK ($N tables)"; [ "$N" -gt 50 ]
  echo "$BK" > "$BKROOT/$1-latest"
}
public_counts() { curl -s -m 30 "http://127.0.0.1:3001/api/properties?limit=1000" | docker exec -i "$CT" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);const m={};for(const p of a)m[p.category+"/"+p.status]=(m[p.category+"/"+p.status]||0)+1;console.log("public API:",a.length,"listings",JSON.stringify(m))})'; }
run() { docker cp "$PKG/$1" "$CT:/tmp/$1"; docker cp "$PKG/propertyTypeResolver.js" "$CT:/tmp/propertyTypeResolver.js"; docker exec -e APPLY="${2:-0}" -e OUT=/tmp "$CT" timeout 300 node "/tmp/$1" 2>&1 | grep -v '^\[20\|^{"level'; }

case "${1:-}" in
  stage)
    cleanup; mkdir -p "$STAGE"
    rsync -a --exclude node_modules --exclude uploads --exclude logs --exclude '.*' --exclude backups --exclude '*.log' --exclude exports "$LIVE/" "$STAGE/"
    mkdir -p "$STAGE/test" "$STAGE/node_modules"
    python3 "$PKG/patch.py" "$STAGE"; place "$STAGE"; cp "$PKG/phase0-inventory.test.js" "$STAGE/test/"
    for f in $FILES $NEW; do docker run --rm --network none -v "$STAGE:/app:ro" -w /app --entrypoint node 2906-system-backend --check "$f"; done; echo "syntax ok"
    docker network create --internal "$TESTNET" >/dev/null
    docker run -d --rm --name "$TESTDB" --network "$TESTNET" -e POSTGRES_PASSWORD=test pgvector/pgvector:pg16 >/dev/null
    for i in $(seq 1 40); do docker exec "$TESTDB" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 2
    docker exec "$PG" sh -c 'pg_dump -s --no-owner --no-privileges -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$STAGE/schema.sql"
    docker exec -i "$TESTDB" psql -q -U postgres -d postgres < "$STAGE/schema.sql" > /tmp/argus-phase0-schema.log 2>&1 || true
    set +e
    docker run --rm --network "$TESTNET" -v "$STAGE:/app:ro" -v "$LIVE/node_modules:/app/node_modules:ro" -w /app -e BACKEND_DIR=/app -e NODE_ENV=test -e PGHOST="$TESTDB" \
      --entrypoint timeout 2906-system-backend 200 node --test --test-force-exit --test-concurrency=1 test/phase0-inventory.test.js > /tmp/argus-phase0.out 2>&1
    r=$?
    set -e
    grep -E "^(ok|not ok)|^# (pass|fail)" /tmp/argus-phase0.out
    [ "$r" = 0 ] || grep -B2 -A24 "^not ok" /tmp/argus-phase0.out | cut -c1-260 | head -100
    cleanup
    [ "$r" = 0 ] && echo "STAGE TESTS PASSED" || { echo "STAGE TESTS FAILED"; exit 1; }
    ;;
  apply)
    for f in $NEW; do [ -e "$LIVE/$f" ] && { echo "REFUSE: $f already exists"; exit 1; }; done
    python3 "$PKG/patch.py" "$LIVE" --check
    TS=$(date -u +%Y%m%dT%H%M%SZ); BK="$BKROOT/phase0-inventory-$TS"; for f in $FILES; do mkdir -p "$BK/$(dirname "$f")"; cp -p "$LIVE/$f" "$BK/$f"; done
    echo "$BK" > "$BKROOT/phase0-inventory-latest"; echo "backup: $BK"
    restore() { echo "ROLLING BACK"; for f in $FILES; do cp -p "$BK/$f" "$LIVE/$f"; done; for f in $NEW; do rm -f "$LIVE/$f"; done; docker restart "$CT" >/dev/null; up && echo "rolled back, backend up" || echo "ROLLBACK: backend not answering"; }
    place "$LIVE"; python3 "$PKG/patch.py" "$LIVE" || { restore; exit 1; }
    for f in $FILES $NEW; do docker run --rm --network none -v "$LIVE:/app:ro" -w /app --entrypoint node 2906-system-backend --check "$f" || { restore; exit 1; }; done
    docker restart "$CT" >/dev/null
    up || { echo "backend did not come up"; docker logs --tail 20 "$CT" 2>&1 | cut -c1-200; restore; exit 1; }
    sleep 6
    [ "$(curl -s -o /dev/null -m 10 -w '%{http_code}' http://127.0.0.1:3001/api/crm/website-review)" = 401 ] && echo "ok   review route refuses a call without login" || { echo "FAIL review route"; restore; exit 1; }
    docker exec "$CT" node -e "const r=require('/app/services/propertyTypeResolver');if(r.resolve('apartment','STUDIO IN GZIRA').type!=='studio'||r.resolve('apartment','nice place').type!==null)process.exit(1);console.log('ok   type resolver loads')" || { restore; exit 1; }
    c=$(docker exec 2906_waha node -e "fetch('http://backend:3001/webhook/waha',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event:'security.probe',session:'x',payload:{}})}).then(r=>console.log(r.status)).catch(()=>console.log(0))" 2>/dev/null || echo 0)
    [ "$c" = 200 ] && echo "ok   gateway reaches the backend" || { echo "FAIL gateway -> backend ($c)"; restore; exit 1; }
    if docker logs --since 2m "$CT" 2>&1 | grep -E "Cannot find module|SyntaxError|ReferenceError" | head -3 | grep -q .; then restore; exit 1; fi
    echo "APPLIED AND VERIFIED"
    ;;
  legacy)
    if [ "${2:-}" = apply ]; then snapshot legacy-hide; echo "--- before ---"; public_counts; run legacy-hide.js 1; echo "--- after ---"; public_counts; else run legacy-hide.js 0; fi
    ;;
  types)
    if [ "${2:-}" = apply ]; then snapshot type-backfill; run type-backfill.js 1; BK=$(cat "$BKROOT/type-backfill-latest"); for f in $(docker exec "$CT" sh -c 'ls /tmp/type-backfill-2* 2>/dev/null'); do docker cp "$CT:$f" "$BK/"; done; ls "$BK"; else run type-backfill.js 0; fi
    ;;
  rollback)
    BK=$(cat "$BKROOT/phase0-inventory-latest"); for f in $FILES; do cp -p "$BK/$f" "$LIVE/$f"; done; for f in $NEW; do rm -f "$LIVE/$f"; done
    docker restart "$CT" >/dev/null; up && echo "ROLLED BACK, backend up"
    ;;
  *) echo "usage: deploy.sh stage | apply | legacy [apply] | types [apply] | rollback"; exit 1;;
esac
