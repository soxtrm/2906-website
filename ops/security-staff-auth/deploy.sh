#!/usr/bin/env bash
# Staff-audience guard for routes/crm.js (owner-upload tokens must not act as staff sessions).
#   deploy.sh probe              show production behaviour only (expect 401 once fixed, 200 = vulnerable)
#   deploy.sh                    backup -> dry run -> patch -> syntax check -> restart -> probes
#   deploy.sh rollback <dir>     restore routes/crm.js from that backup and restart
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="${APP:-/opt/2906-system/backend}"
C=2906_backend
probe() { cp "$HERE/probe.js" "$APP/.staff-audience-probe.js"; docker exec "$C" node /app/.staff-audience-probe.js < /dev/null || true; rm -f "$APP/.staff-audience-probe.js"; }
if [ "${1:-}" = "probe" ]; then probe; exit 0; fi
if [ "${1:-}" = "rollback" ]; then
  B="${2:?backup dir}"; [ -f "$B/routes/crm.js" ] || { echo "no backup in $B" >&2; exit 2; }
  cp -p "$B/routes/crm.js" "$APP/routes/crm.js"; docker restart "$C" >/dev/null; echo "rolled back from $B"; exit 0
fi
echo "== before"; probe
B="${BACKUPS:-/opt/2906-system/backups}/staff-audience-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$B/routes"; cp -p "$APP/routes/crm.js" "$B/routes/crm.js"
echo "backup: $B ($(md5sum "$B/routes/crm.js" | cut -d' ' -f1))"
cp "$HERE/apply-crm-auth-fix.js" "$APP/.staff-audience-fix.js"
trap 'rm -f "$APP/.staff-audience-fix.js"' EXIT
docker exec "$C" node /app/.staff-audience-fix.js /app/routes/crm.js < /dev/null
docker exec "$C" node /app/.staff-audience-fix.js /app/routes/crm.js --write < /dev/null || { cp -p "$B/routes/crm.js" "$APP/routes/crm.js"; echo "ABORT: patch failed, original restored" >&2; exit 1; }
mv "$APP"/routes/crm.js.bak-staff-audience-* "$B/" 2>/dev/null || true
docker exec "$C" node --check /app/routes/crm.js < /dev/null || { cp -p "$B/routes/crm.js" "$APP/routes/crm.js"; echo "ABORT: syntax check failed, restored" >&2; exit 1; }
echo "patched md5: $(md5sum "$APP/routes/crm.js" | cut -d' ' -f1)"
docker restart "$C" >/dev/null
for i in $(seq 1 "${WAIT:-30}"); do s=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/api/crm/owners || true); [ "$s" = "401" ] && break; sleep 2; done
echo "anonymous /api/crm/owners -> $s (expect 401)"
echo "== after"; probe
echo "rollback: $0 rollback $B"
