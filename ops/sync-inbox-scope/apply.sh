#!/usr/bin/env bash
# SYNC inbox scope. apply | rollback
set -euo pipefail
PKG="$(cd "$(dirname "$0")" && pwd)"; LIVE=/opt/2906-system/backend; CT=2906_backend; BKROOT=/opt/2906-system/backups
FILES="services/syncAccount.js routes/crmSyncInbox.js"
up() { for i in $(seq 1 45); do [ "$(curl -s -o /dev/null -m 10 -w '%{http_code}' http://127.0.0.1:3001/api/properties)" = 200 ] && return 0; sleep 2; done; return 1; }
if [ "${1:-}" = rollback ]; then BK=$(cat "$BKROOT/sync-inbox-scope-latest"); for f in $FILES; do cp -p "$BK/$f" "$LIVE/$f"; done; docker restart "$CT" >/dev/null; up && echo "ROLLED BACK, backend up"; exit 0; fi
[ "${1:-}" = apply ] || { echo "usage: apply.sh apply | rollback"; exit 1; }
python3 "$PKG/patch.py" "$LIVE" --check
TS=$(date -u +%Y%m%dT%H%M%SZ); BK="$BKROOT/sync-inbox-scope-$TS"; for f in $FILES; do mkdir -p "$BK/$(dirname "$f")"; cp -p "$LIVE/$f" "$BK/$f"; done
echo "$BK" > "$BKROOT/sync-inbox-scope-latest"; echo "backup: $BK"
restore() { echo "ROLLING BACK"; for f in $FILES; do cp -p "$BK/$f" "$LIVE/$f"; done; docker restart "$CT" >/dev/null; up && echo "rolled back, backend up" || echo "ROLLBACK: backend not answering"; }
python3 "$PKG/patch.py" "$LIVE" || { restore; exit 1; }
for f in $FILES; do docker run --rm --network none -v "$LIVE:/app:ro" -w /app --entrypoint node 2906-system-backend --check "$f" || { restore; exit 1; }; done
docker restart "$CT" >/dev/null
up || { echo "backend did not come up"; restore; exit 1; }
sleep 6
[ "$(curl -s -o /dev/null -m 10 -w '%{http_code}' http://127.0.0.1:3001/api/crm/sync-inbox/threads)" = 401 ] && echo "ok   inbox refuses a call without login" || { echo "FAIL inbox auth"; restore; exit 1; }
c=$(docker exec 2906_waha node -e "fetch('http://backend:3001/webhook/waha',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event:'security.probe',session:'x',payload:{}})}).then(r=>console.log(r.status)).catch(()=>console.log(0))" 2>/dev/null || echo 0)
[ "$c" = 200 ] && echo "ok   gateway reaches the backend" || { echo "FAIL gateway -> backend ($c)"; restore; exit 1; }
if docker logs --since 2m "$CT" 2>&1 | grep -E "Cannot find module|SyntaxError|ReferenceError" | head -3 | grep -q .; then restore; exit 1; fi
echo "APPLIED AND VERIFIED"
