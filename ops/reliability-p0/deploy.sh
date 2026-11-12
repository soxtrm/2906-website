#!/usr/bin/env bash
# Deploys ops/reliability-p0 (divider uploads, automation event log, worker heartbeats).
#   deploy.sh            verified backup -> migration -> files -> syntax check -> restart
#   deploy.sh rollback <backup dir>
# Run on the production host from the uploaded copy of this directory.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP=/opt/2906-system/backend
V2=/opt/2906-system/ops/backup-v2
NEW_FILES="services/dividerUpload.js services/automationEvents.js routes/crmAutomation.js scripts/divider_packages_scan.js scripts/divider_recover.js migrations/20261112_reliability_p0.sql migrations/20261112_reliability_p0.down.sql"
# file : md5 the production file must have before it is replaced
BASES="handlers/upload.js:87e91ebf51cc15c83a50c143bae85c64 handlers/uploadListing.js:b1c898f916a7e89a2cbc41b62a88cdb4 cron.js:82d18fe61c222f83db190e04a3802f4e index.js:bc53d5881c943d8ce2eb06744d1a5d54 services/availability.js:48fd1909bad11de80d0acda9a8964060 services/ownerScopeReply.js:f3a9486b0f0ef79d243ee18d905d794d"

if [ "${1:-}" = "rollback" ]; then
  B="${2:?backup dir}"; [ -d "$B" ] || { echo "no such backup: $B" >&2; exit 2; }
  for e in $BASES; do f="${e%%:*}"; cp -p "$B/$f" "$APP/$f"; done
  for f in services/dividerUpload.js routes/crmAutomation.js; do rm -f "$APP/$f"; done   # automationEvents stays: harmless, nothing requires it
  docker restart 2906_backend >/dev/null; echo "rolled back from $B (tables upload_packages / worker_heartbeats left in place; drop with the .down.sql)"; exit 0
fi

for e in $BASES; do
  f="${e%%:*}"; want="${e##*:}"; have="$(md5sum "$APP/$f" | cut -d' ' -f1)"; new="$(md5sum "$HERE/backend/$f" | cut -d' ' -f1)"
  [ "$have" = "$want" ] || [ "$have" = "$new" ] || { echo "ABORT: $f changed in production since this fix was built ($have)" >&2; exit 1; }
done
for f in $NEW_FILES handlers/upload.js handlers/uploadListing.js cron.js index.js services/availability.js services/ownerScopeReply.js; do [ -s "$HERE/backend/$f" ] || { echo "ABORT: missing $f" >&2; exit 2; }; done

"$V2/pre_migration_backup.sh"
ARGUS_MIGRATION_APPROVED=yes "$V2/run_migration.sh" "$HERE/backend/migrations/20261112_reliability_p0.sql"

B="/opt/2906-system/backups/reliability-p0b-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$B/handlers" "$B/services"
for e in $BASES; do f="${e%%:*}"; cp -p "$APP/$f" "$B/$f"; done
for f in $NEW_FILES; do mkdir -p "$APP/$(dirname "$f")"; cp "$HERE/backend/$f" "$APP/$f"; done
for e in $BASES; do f="${e%%:*}"; cp "$HERE/backend/$f" "$APP/$f"; done
for f in handlers/upload.js handlers/uploadListing.js cron.js index.js services/availability.js services/ownerScopeReply.js services/dividerUpload.js services/automationEvents.js routes/crmAutomation.js; do
  docker exec 2906_backend node --check "/app/$f" < /dev/null || { echo "SYNTAX FAILURE in $f - restoring" >&2; for e in $BASES; do g="${e%%:*}"; cp -p "$B/$g" "$APP/$g"; done; exit 1; }
done
docker restart 2906_backend >/dev/null
echo "deployed; backup of replaced files: $B"
