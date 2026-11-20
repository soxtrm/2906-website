#!/usr/bin/env bash
# Website review route v2 (source, ARGUS state, history). apply | rollback
set -euo pipefail
PKG="$(cd "$(dirname "$0")" && pwd)"; LIVE=/opt/2906-system/backend; CT=2906_backend; BKROOT=/opt/2906-system/backups; F=routes/crmWebsiteReview.js
up() { for i in $(seq 1 45); do [ "$(curl -s -o /dev/null -m 10 -w '%{http_code}' http://127.0.0.1:3001/api/properties)" = 200 ] && return 0; sleep 2; done; return 1; }
if [ "${1:-}" = rollback ]; then BK=$(cat "$BKROOT/website-review-ui-latest"); cp -p "$BK/crmWebsiteReview.js" "$LIVE/$F"; docker restart "$CT" >/dev/null; up && echo "ROLLED BACK"; exit 0; fi
[ "${1:-}" = apply ] || { echo "usage: apply.sh apply | rollback"; exit 1; }
echo "$(cat "$PKG/base.sha256")  $LIVE/$F" | sha256sum -c - >/dev/null || { echo "REFUSE: the live route file is not the version this was built on"; exit 1; }
TS=$(date -u +%Y%m%dT%H%M%SZ); BK="$BKROOT/website-review-ui-$TS"; mkdir -p "$BK"; cp -p "$LIVE/$F" "$BK/crmWebsiteReview.js"; echo "$BK" > "$BKROOT/website-review-ui-latest"; echo "backup: $BK"
restore() { echo "ROLLING BACK"; cp -p "$BK/crmWebsiteReview.js" "$LIVE/$F"; docker restart "$CT" >/dev/null; up && echo "rolled back" || echo "ROLLBACK: backend not answering"; }
cp "$PKG/crmWebsiteReview.js" "$LIVE/$F"
docker run --rm --network none -v "$LIVE:/app:ro" -w /app --entrypoint node 2906-system-backend --check "$F" || { restore; exit 1; }
docker restart "$CT" >/dev/null; up || { restore; exit 1; }; sleep 5
[ "$(curl -s -o /dev/null -m 10 -w '%{http_code}' http://127.0.0.1:3001/api/crm/website-review)" = 401 ] || { echo "FAIL route"; restore; exit 1; }
[ "$(curl -s -o /dev/null -m 10 -w '%{http_code}' http://127.0.0.1:3001/api/crm/website-review/x/history)" = 401 ] || { echo "FAIL history route"; restore; exit 1; }
if docker logs --since 2m "$CT" 2>&1 | grep -E "Cannot find module|SyntaxError|ReferenceError" | head -3 | grep -q .; then restore; exit 1; fi
echo "APPLIED AND VERIFIED"
