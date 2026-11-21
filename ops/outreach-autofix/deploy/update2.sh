#!/usr/bin/env bash
# Auto Outreach fix, update 2 (2026-11-21): the 5-minute refresh of prepared Auto days no longer crashes
# (pre-existing: getPlanWithEntries has no stats), and the status counts a running run from its recipients.
#   update2.sh apply | rollback      (compare-and-swap on the live hashes after update 1)
set -euo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"; LIVE=/opt/2906-system/backend; CT=2906_backend; BKROOT=/opt/2906-system/backups
code() { curl -s -o /dev/null -m 10 -w '%{http_code}' "$@" || echo 000; }
wait_up() { for i in $(seq 1 45); do [ "$(code http://127.0.0.1:3001/api/properties)" = 200 ] && return 0; sleep 2; done; return 1; }
case "${1:-}" in
  apply)
    cd "$LIVE"; sha256sum -c "$PKG/deploy/update2.base.sha256" || { echo "REFUSE: live files changed"; exit 1; }
    TS=$(date -u +%Y%m%dT%H%M%SZ); BK="$BKROOT/outreach-autofix-u2-$TS"; mkdir -p "$BK/services"
    cp -p services/outreachPlanner.js services/outreachAutoStatus.js "$BK/services/"; echo "$BK" > "$BKROOT/outreach-autofix-u2-latest"
    python3 - "$LIVE/services/outreachPlanner.js" <<'PY'
import sys
p=sys.argv[1]; t=open(p,encoding='utf-8',newline='').read()
o="        const refreshed = await getPlanWithEntries(plan.id)"; n="        const refreshed = { ...(await getPlanWithEntries(plan.id)), stats: await computeStats(plan.id) }"
assert t.count(o)==1, 'anchor'
open(p,'w',encoding='utf-8',newline='').write(t.replace(o,n))
PY
    cp "$PKG/backend/services/outreachAutoStatus.js" services/outreachAutoStatus.js
    for f in services/outreachPlanner.js services/outreachAutoStatus.js; do docker run --rm --network none -v "$LIVE:/app:ro" -w /app --entrypoint node 2906-system-backend --check "$f" || { cp -p "$BK"/services/* services/; exit 1; }; done
    docker restart "$CT" >/dev/null
    if ! wait_up || [ "$(code http://127.0.0.1:3001/api/crm/outreach/accounts/3/auto-status)" != 401 ]; then cp -p "$BK"/services/* services/; docker restart "$CT" >/dev/null; wait_up; echo "ROLLED BACK"; exit 1; fi
    echo "APPLIED (backup $BK)"
    ;;
  rollback) BK=$(cat "$BKROOT/outreach-autofix-u2-latest"); cp -p "$BK"/services/* "$LIVE/services/"; docker restart "$CT" >/dev/null; wait_up && echo "rolled back to $BK" ;;
  *) echo "usage: update2.sh apply|rollback"; exit 2 ;;
esac
