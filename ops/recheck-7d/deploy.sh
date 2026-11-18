#!/usr/bin/env bash
# Weekly owner recheck (2026-11-18). deploy.sh apply | rollback <backupdir>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP=/opt/2906-system/backend
FILES="cron.js services/availability.js waha.js"
if [ "${1:-}" = "rollback" ]; then
  B="${2:?backup dir}"
  for f in $FILES; do cp -p "$B/$f" "$APP/$f"; done
  rm -f "$APP/services/ownerRecheck7d.js"
  docker restart 2906_backend >/dev/null; echo "rolled back from $B"; exit 0
fi
B="/opt/2906-system/backups/recheck7d-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$B/services"
for f in $FILES; do cp -p "$APP/$f" "$B/$f"; done
python3 "$HERE/apply_patches.py" "$APP" --check
python3 "$HERE/apply_patches.py" "$APP"
cp "$HERE/patched/services/ownerRecheck7d.js" "$APP/services/ownerRecheck7d.js"
for f in $FILES services/ownerRecheck7d.js; do
  docker exec 2906_backend node --check "/app/$f" < /dev/null || { echo "SYNTAX FAILURE in $f - restoring" >&2; for g in $FILES; do cp -p "$B/$g" "$APP/$g"; done; rm -f "$APP/services/ownerRecheck7d.js"; exit 1; }
done
docker restart 2906_backend >/dev/null
echo "deployed; backup: $B"
