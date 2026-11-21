#!/usr/bin/env bash
# Facebook browser profile lock + backlog watchdog (2026-11-21). Two patched files, no migration, no data change.
#   deploy.sh stage | apply | rollback | verify
set -euo pipefail
PKG="$(cd "$(dirname "$0")" && pwd)"; LIVE=/opt/2906-system/backend; CT=2906_backend; BKROOT=/opt/2906-system/backups
FILES="services/fbBrowser.js services/fbShareBacklog.js"; URL=http://127.0.0.1:3001
code() { curl -s -o /dev/null -m 15 -w '%{http_code}' "$@" || echo 000; }
wait_up() { for i in $(seq 1 45); do [ "$(code "$URL/api/properties")" = 200 ] && return 0; sleep 2; done; return 1; }
fb_busy() { # 1 when a Facebook job is running right now (never restart under it)
  docker exec "$CT" sh -c 'cat > /tmp/fbbusy.js <<"EOF"
const { QUEUES } = require("/app/queues"); (async () => { let n = 0; for (const k of Object.keys(QUEUES)) if (/fb/i.test(k)) n += (await QUEUES[k].getActive()).length; console.log(n); process.exit(0) })().catch(() => { console.log(0); process.exit(0) })
EOF
node /tmp/fbbusy.js 2>/dev/null | tail -1; rm -f /tmp/fbbusy.js'
}
verify() {
  local fail=0
  [ "$(code "$URL/api/properties")" = 200 ] && echo "ok   properties 200" || { echo "FAIL properties"; fail=1; }
  [ "$(code "$URL/api/nexus/features")" = 200 ] && echo "ok   nexus bridge" || { echo "FAIL nexus"; fail=1; }
  if docker logs --since 2m "$CT" 2>&1 | grep -E "Cannot find module|SyntaxError|ReferenceError" | head -1 | grep -q .; then echo "FAIL boot errors"; fail=1; else echo "ok   no boot errors"; fi
  [ "$fail" = 0 ] && echo "VERIFY OK" || { echo "VERIFY FAILED"; return 1; }
}
case "${1:-}" in
  stage)
    S=/tmp/fb-lock-stage; rm -rf "$S"; mkdir -p "$S"
    rsync -a --exclude node_modules --exclude uploads --exclude logs --exclude backups --exclude '.fb-profile' --exclude '.*' --exclude '*.log' --exclude exports --exclude private-docs "$LIVE/" "$S/"
    python3 "$PKG/patch.py" "$S"; python3 "$PKG/patch.py" "$S"
    for f in $FILES; do docker run --rm --network none -v "$S:/app:ro" -w /app --entrypoint node 2906-system-backend --check "$f"; done
    cp "$PKG/lock.test.js" "$S/lock.test.js"
    docker run --rm --network none -v "$S:/app" -v "$LIVE/node_modules:/app/node_modules:ro" -w /app -e NODE_ENV=test -e FB_PROFILE_DIR=/tmp/fbprof-test \
      -e FB_PROXY_HOST= -e FB_PROXY_PORT= -e FB_PROXY_PORTS= --entrypoint node 2906-system-backend lock.test.js
    rm -rf "$S"; echo "STAGE OK"
    ;;
  apply)
    python3 "$PKG/patch.py" "$LIVE" --check
    [ "$(fb_busy)" = 0 ] || { echo "REFUSE: a Facebook job is running right now, try again later"; exit 1; }
    TS=$(date -u +%Y%m%dT%H%M%SZ); BK="$BKROOT/fb-profile-lock-$TS"; mkdir -p "$BK/services"
    for f in $FILES; do cp -p "$LIVE/$f" "$BK/$f"; done; echo "$BK" > "$BKROOT/fb-profile-lock-latest"; echo "backup: $BK"
    restore() { echo "ROLLING BACK"; for f in $FILES; do cp -p "$BK/$f" "$LIVE/$f"; done; docker restart "$CT" >/dev/null; wait_up && echo "rolled back, backend up"; }
    python3 "$PKG/patch.py" "$LIVE" || { restore; exit 1; }
    for f in $FILES; do docker run --rm --network none -v "$LIVE:/app:ro" -w /app --entrypoint node 2906-system-backend --check "$f" || { restore; exit 1; }; done
    docker restart "$CT" >/dev/null; wait_up || { restore; exit 1; }; sleep 8
    verify || { restore; exit 1; }
    echo "APPLIED AND VERIFIED"
    ;;
  rollback)
    BK=$(cat "$BKROOT/fb-profile-lock-latest"); for f in $FILES; do cp -p "$BK/$f" "$LIVE/$f"; done; docker restart "$CT" >/dev/null; wait_up && echo "rolled back to $BK"
    ;;
  verify) verify ;;
  *) echo "usage: deploy.sh stage|apply|rollback|verify"; exit 2 ;;
esac
