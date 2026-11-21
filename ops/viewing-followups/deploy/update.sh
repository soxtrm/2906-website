#!/usr/bin/env bash
# Viewing follow-up, update 2 (2026-11-21): requests from the old /book flow (viewing_date + viewing_time,
# no starts_at) are tracked too. Replaces services/viewingFollowups.js only (compare-and-swap on the live hash).
#   update.sh apply | rollback
set -euo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"; LIVE=/opt/2906-system/backend; CT=2906_backend; BKROOT=/opt/2906-system/backups
F=services/viewingFollowups.js; BASE=9c87c439523feeb6c1f44b3ee8202de5d32c113eab9f4e36681421d10268e8ee
code() { curl -s -o /dev/null -m 10 -w '%{http_code}' "$@" || echo 000; }
wait_up() { for i in $(seq 1 45); do [ "$(code http://127.0.0.1:3001/api/properties)" = 200 ] && return 0; sleep 2; done; return 1; }
case "${1:-}" in
  apply)
    [ "$(sha256sum "$LIVE/$F" | cut -c1-64)" = "$BASE" ] || { echo "REFUSE: live $F changed"; exit 1; }
    TS=$(date -u +%Y%m%dT%H%M%SZ); BK="$BKROOT/viewing-followups-u2-$TS"; mkdir -p "$BK/services"; cp -p "$LIVE/$F" "$BK/$F"; echo "$BK" > "$BKROOT/viewing-followups-u2-latest"
    docker run --rm --network none -v "$PKG/backend:/p:ro" --entrypoint node 2906-system-backend --check /p/$F
    cp "$PKG/backend/$F" "$LIVE/$F"; docker restart "$CT" >/dev/null
    if ! wait_up || [ "$(code http://127.0.0.1:3001/api/crm/viewing-followups)" != 401 ]; then cp -p "$BK/$F" "$LIVE/$F"; docker restart "$CT" >/dev/null; wait_up; echo "ROLLED BACK"; exit 1; fi
    sleep 30
    docker logs --since 1m "$CT" 2>&1 | grep -E "viewingFollowups|Cannot find module|SyntaxError" | head -3
    echo "APPLIED (backup $BK)"
    ;;
  rollback) BK=$(cat "$BKROOT/viewing-followups-u2-latest"); cp -p "$BK/$F" "$LIVE/$F"; docker restart "$CT" >/dev/null; wait_up && echo "rolled back to $BK" ;;
  *) echo "usage: update.sh apply|rollback"; exit 2 ;;
esac
