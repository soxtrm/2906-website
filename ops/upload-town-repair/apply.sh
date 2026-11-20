#!/usr/bin/env bash
# Emergency reader keeps the town. apply | rollback
set -euo pipefail
PKG="$(cd "$(dirname "$0")" && pwd)"; LIVE=/opt/2906-system/backend; CT=2906_backend; BKROOT=/opt/2906-system/backups; F=handlers/uploadListing.js
up() { for i in $(seq 1 45); do [ "$(curl -s -o /dev/null -m 10 -w '%{http_code}' http://127.0.0.1:3001/api/properties)" = 200 ] && return 0; sleep 2; done; return 1; }
if [ "${1:-}" = rollback ]; then BK=$(cat "$BKROOT/upload-town-reader-latest"); cp -p "$BK/uploadListing.js" "$LIVE/$F"; docker restart "$CT" >/dev/null; up && echo "ROLLED BACK, backend up"; exit 0; fi
[ "${1:-}" = apply ] || { echo "usage: apply.sh apply | rollback"; exit 1; }
python3 "$PKG/patch.py" "$LIVE" --check
TS=$(date -u +%Y%m%dT%H%M%SZ); BK="$BKROOT/upload-town-reader-$TS"; mkdir -p "$BK"; cp -p "$LIVE/$F" "$BK/uploadListing.js"; echo "$BK" > "$BKROOT/upload-town-reader-latest"; echo "backup: $BK"
restore() { echo "ROLLING BACK"; cp -p "$BK/uploadListing.js" "$LIVE/$F"; docker restart "$CT" >/dev/null; up && echo "rolled back, backend up" || echo "ROLLBACK: backend not answering"; }
python3 "$PKG/patch.py" "$LIVE" || { restore; exit 1; }
docker run --rm --network none -v "$LIVE:/app:ro" -w /app --entrypoint node 2906-system-backend --check "$F" || { restore; exit 1; }
docker restart "$CT" >/dev/null
up || { echo "backend did not come up"; restore; exit 1; }
sleep 6
docker exec "$CT" node -e "const u=require('/app/handlers/uploadListing');if(typeof u.extractListing!=='function'||typeof u.matchLocation!=='function')process.exit(1);console.log('ok   reader loads')" || { restore; exit 1; }
c=$(docker exec 2906_waha node -e "fetch('http://backend:3001/webhook/waha',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event:'security.probe',session:'x',payload:{}})}).then(r=>console.log(r.status)).catch(()=>console.log(0))" 2>/dev/null || echo 0)
[ "$c" = 200 ] && echo "ok   gateway reaches the backend" || { echo "FAIL gateway -> backend ($c)"; restore; exit 1; }
if docker logs --since 2m "$CT" 2>&1 | grep -E "Cannot find module|SyntaxError|ReferenceError" | head -3 | grep -q .; then restore; exit 1; fi
echo "APPLIED AND VERIFIED"
