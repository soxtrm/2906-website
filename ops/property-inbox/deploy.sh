#!/usr/bin/env bash
# Deploys ops/property-inbox (Incoming Properties: verification columns, intake API).
#   deploy.sh                   verified backup -> migration -> files -> syntax check -> restart
#   deploy.sh rollback <dir>    restores the replaced files (columns stay; drop with the .down.sql)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP=/opt/2906-system/backend
V2=/opt/2906-system/ops/backup-v2
NEW_FILES="services/propertyIntake.js routes/crmIntake.js migrations/20261113_property_intake.sql migrations/20261113_property_intake.down.sql"
BASES="routes/crm.js:28454a7207635debd06de3e9022b84b6 index.js:a0554a14ed56aa812f94a1d22b4d1804 services/dividerUpload.js:ced948c2fbfbe14832e9c0b0b498ace6"

if [ "${1:-}" = "rollback" ]; then
  B="${2:?backup dir}"; [ -d "$B" ] || { echo "no such backup: $B" >&2; exit 2; }
  for e in $BASES; do f="${e%%:*}"; cp -p "$B/$f" "$APP/$f"; done
  rm -f "$APP/routes/crmIntake.js"
  docker restart 2906_backend >/dev/null; echo "rolled back from $B"; exit 0
fi

for e in $BASES; do
  f="${e%%:*}"; want="${e##*:}"; have="$(md5sum "$APP/$f" | cut -d' ' -f1)"; new="$(md5sum "$HERE/backend/$f" | cut -d' ' -f1)"
  [ "$have" = "$want" ] || [ "$have" = "$new" ] || { echo "ABORT: $f changed in production since this release was built ($have)" >&2; exit 1; }
done
for f in $NEW_FILES routes/crm.js index.js services/dividerUpload.js; do [ -s "$HERE/backend/$f" ] || { echo "ABORT: missing $f" >&2; exit 2; }; done

"$V2/pre_migration_backup.sh"
ARGUS_MIGRATION_APPROVED=yes "$V2/run_migration.sh" "$HERE/backend/migrations/20261113_property_intake.sql"

B="/opt/2906-system/backups/property-inbox-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$B/routes" "$B/services"
for e in $BASES; do f="${e%%:*}"; cp -p "$APP/$f" "$B/$f"; done
for f in $NEW_FILES routes/crm.js index.js services/dividerUpload.js; do mkdir -p "$APP/$(dirname "$f")"; cp "$HERE/backend/$f" "$APP/$f"; done
for f in routes/crm.js index.js services/dividerUpload.js services/propertyIntake.js routes/crmIntake.js; do
  docker exec 2906_backend node --check "/app/$f" < /dev/null || { echo "SYNTAX FAILURE in $f - restoring" >&2; for e in $BASES; do g="${e%%:*}"; cp -p "$B/$g" "$APP/$g"; done; rm -f "$APP/routes/crmIntake.js"; exit 1; }
done
docker restart 2906_backend >/dev/null
echo "deployed; backup of replaced files: $B"
