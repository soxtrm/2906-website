#!/usr/bin/env bash
# Facebook one-click publishing for every agent: backend part. Run on the VPS from the unpacked package.
#   deploy.sh stage | apply | rollback
set -euo pipefail
PKG="$(cd "$(dirname "$0")" && pwd)"
LIVE=/opt/2906-system/backend
CT=2906_backend
STAGE=/tmp/argus-fb-quick-stage
BKROOT=/opt/2906-system/backups
FILES="routes/crmFacebookPages.js services/facebookPages/property.js"
URL=http://127.0.0.1:3001
code() { curl -s -o /dev/null -m 10 -w '%{http_code}' "$@" || echo 000; }
wait_up() { for i in $(seq 1 45); do [ "$(code "$URL/api/properties")" = 200 ] && return 0; sleep 2; done; return 1; }

case "${1:-}" in
  stage)
    rm -rf "$STAGE"; mkdir -p "$STAGE"
    rsync -a --exclude node_modules --exclude uploads --exclude logs --exclude '.*' --exclude backups --exclude '*.log' --exclude exports "$LIVE/" "$STAGE/"
    mkdir -p "$STAGE/test" "$STAGE/node_modules" "$STAGE/uploads"
    cp "$PKG/backend/test/facebook-quick-publish.test.js" "$STAGE/test/"
    python3 "$PKG/backend/apply_overlay.py" "$STAGE"
    for f in $FILES; do docker run --rm --network none -v "$STAGE:/app:ro" -w /app --entrypoint node 2906-system-backend --check "$f"; done
    set +e
    docker run --rm --network none -v "$STAGE:/app:ro" -v "$LIVE/node_modules:/app/node_modules:ro" -w /app -e BACKEND_DIR=/app -e NODE_ENV=test \
      --entrypoint timeout 2906-system-backend 180 node --test --test-force-exit test/facebook-quick-publish.test.js > /tmp/argus-fb-quick.out 2>&1
    r=$?
    set -e
    grep -E "^(ok|not ok)|^# (pass|fail)" /tmp/argus-fb-quick.out
    [ "$r" = 0 ] || grep -A18 "^not ok" /tmp/argus-fb-quick.out | cut -c1-200 | head -60
    rm -rf "$STAGE"
    [ "$r" = 0 ] && echo "STAGE TESTS PASSED" || { echo "STAGE TESTS FAILED"; exit 1; }
    ;;
  apply)
    cd "$LIVE"
    sha256sum -c "$PKG/base.sha256" || { echo "REFUSE: live files changed since the patch was built"; exit 1; }
    python3 "$PKG/backend/apply_overlay.py" "$LIVE" --check
    TS=$(date -u +%Y%m%dT%H%M%SZ); BK="$BKROOT/facebook-quick-publish-$TS"; mkdir -p "$BK"
    for f in $FILES; do mkdir -p "$BK/$(dirname "$f")"; cp -p "$f" "$BK/$f"; done
    echo "$BK" > "$BKROOT/facebook-quick-publish-latest"; echo "backup: $BK"
    restore() { echo "ROLLING BACK"; for f in $FILES; do cp -p "$BK/$f" "$LIVE/$f"; done; docker restart "$CT" >/dev/null; wait_up && echo "rolled back, backend up"; }
    python3 "$PKG/backend/apply_overlay.py" "$LIVE" || { restore; exit 1; }
    docker restart "$CT" >/dev/null
    if ! wait_up; then echo "backend did not come up"; restore; exit 1; fi
    sleep 5
    [ "$(code "$URL/api/crm/facebook-pages/status")" = 401 ] && echo "ok   401 facebook-pages without login" || { echo "FAIL facebook-pages without login"; restore; exit 1; }
    if docker logs --since 2m "$CT" 2>&1 | grep -E "Cannot find module|SyntaxError|ReferenceError" | head -3 | grep -q .; then restore; exit 1; fi
    echo "APPLIED AND VERIFIED"
    ;;
  rollback)
    BK=$(cat "$BKROOT/facebook-quick-publish-latest")
    for f in $FILES; do cp -p "$BK/$f" "$LIVE/$f"; done
    docker restart "$CT" >/dev/null; wait_up && echo "rolled back to $BK, backend up"
    ;;
  *) echo "usage: deploy.sh stage|apply|rollback"; exit 2 ;;
esac
