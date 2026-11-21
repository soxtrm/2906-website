#!/usr/bin/env bash
# NEXUS inventory publishes `confirmedAt` (last explicit availability confirmation) for available_confirmed listings.
# One patched file, no migration, no data change.   deploy.sh stage | apply | rollback | verify
set -euo pipefail
PKG="$(cd "$(dirname "$0")" && pwd)"; LIVE=/opt/2906-system/backend; CT=2906_backend; BKROOT=/opt/2906-system/backups
F=services/nexusBridge.js; URL=http://127.0.0.1:3001
code() { curl -s -o /dev/null -m 15 -w '%{http_code}' "$@" || echo 000; }
wait_up() { for i in $(seq 1 45); do [ "$(code "$URL/api/properties")" = 200 ] && return 0; sleep 2; done; return 1; }
verify() {
  local fail=0
  [ "$(code "$URL/api/properties")" = 200 ] && echo "ok   properties 200" || { echo "FAIL properties"; fail=1; }
  curl -s -m 30 "$URL/api/nexus/inventory" > /tmp/nx-inv.json || true
  python3 - <<'PY' || fail=1
import json
d = json.load(open('/tmp/nx-inv.json')); ps = d.get('properties') or []
assert len(ps) > 100, f'only {len(ps)} properties'
assert all('confirmedAt' in p for p in ps), 'confirmedAt missing'
bad = [p['id'] for p in ps if p.get('confirmedAt') and p.get('status') != 'available_confirmed']
assert not bad, f'confirmedAt on non-confirmed listings: {bad[:5]}'
n = sum(1 for p in ps if p.get('confirmedAt'))
print(f"ok   inventory {len(ps)} listings, {n} with a confirmation time, none on unconfirmed listings")
PY
  [ "$(code "$URL/api/nexus/features")" = 200 ] && echo "ok   nexus features" || { echo "FAIL features"; fail=1; }
  [ "$fail" = 0 ] && echo "VERIFY OK" || { echo "VERIFY FAILED"; return 1; }
}
case "${1:-}" in
  stage)
    S=/tmp/nx-inv-stage; rm -rf "$S"; mkdir -p "$S/services"; cp "$LIVE/$F" "$S/$F"
    python3 "$PKG/patch.py" "$S"; python3 "$PKG/patch.py" "$S"   # second run must be a no-op
    docker run --rm --network none -v "$S:/app:ro" -w /app --entrypoint node 2906-system-backend --check "$F"
    diff <(sed 's/,/,\n/g' "$LIVE/$F") <(sed 's/,/,\n/g' "$S/$F") || true
    rm -rf "$S"; echo "STAGE OK"
    ;;
  apply)
    python3 "$PKG/patch.py" "$LIVE" --check
    TS=$(date -u +%Y%m%dT%H%M%SZ); BK="$BKROOT/nexus-inventory-confirmed-$TS"; mkdir -p "$BK/services"; cp -p "$LIVE/$F" "$BK/$F"
    echo "$BK" > "$BKROOT/nexus-inventory-confirmed-latest"; echo "backup: $BK"
    restore() { echo "ROLLING BACK"; cp -p "$BK/$F" "$LIVE/$F"; docker restart "$CT" >/dev/null; wait_up && echo "rolled back, backend up"; }
    python3 "$PKG/patch.py" "$LIVE" || { restore; exit 1; }
    docker run --rm --network none -v "$LIVE:/app:ro" -w /app --entrypoint node 2906-system-backend --check "$F" || { restore; exit 1; }
    docker restart "$CT" >/dev/null; wait_up || { restore; exit 1; }; sleep 5
    verify || { restore; exit 1; }
    if docker logs --since 2m "$CT" 2>&1 | grep -E "Cannot find module|SyntaxError|ReferenceError|column .* does not exist" | head -3 | grep -q .; then restore; exit 1; fi
    echo "APPLIED AND VERIFIED"
    ;;
  rollback)
    BK=$(cat "$BKROOT/nexus-inventory-confirmed-latest"); cp -p "$BK/$F" "$LIVE/$F"; docker restart "$CT" >/dev/null; wait_up && echo "rolled back to $BK"
    ;;
  verify) verify ;;
  *) echo "usage: deploy.sh stage|apply|rollback|verify"; exit 2 ;;
esac
