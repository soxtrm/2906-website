#!/usr/bin/env bash
# ARGUS Facebook Pages — backend deploy (prepared 2026-11-14, NOT run without Kevin's approval).
#   deploy.sh --check            rehearsal: hashes, anchors, syntax in a scratch copy; changes nothing
#   deploy.sh                    verified backup -> migration -> new files -> index.js anchor patch -> syntax -> restart -> smoke
#   deploy.sh rollback <dir>     restores index.js and removes the new files (tables stay; drop with the .down.sql)
# Additive only: new files, new agent_facebook_* tables, 6 lines in index.js. Without META_* /
# ARGUS_FB_TOKEN_KEY in the backend environment the feature stays in "setup pending" and calls nothing.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP=/opt/2906-system/backend
V2=/opt/2906-system/ops/backup-v2
INDEX_BASE=67aa1e645a44d8b2e8893359ce63d236          # live index.js when this release was built
NEW_FILES="routes/crmFacebookPages.js routes/facebookPagesMeta.js services/facebookPages/settings.js services/facebookPages/secrets.js services/facebookPages/graph.js services/facebookPages/store.js services/facebookPages/connect.js services/facebookPages/property.js services/facebookPages/content.js services/facebookPages/publisher.js services/facebookPages/autoPublish.js services/facebookPages/jobs.js"
MIGRATION="$HERE/backend/migrations/20261114_facebook_pages.sql"

remove_new() { for f in $NEW_FILES; do rm -f "$APP/$f"; done; rmdir "$APP/services/facebookPages" 2>/dev/null || true; }

if [ "${1:-}" = "rollback" ]; then
  B="${2:?backup dir}"; [ -f "$B/index.js" ] || { echo "no such backup: $B" >&2; exit 2; }
  cp -p "$B/index.js" "$APP/index.js"; remove_new
  docker restart 2906_backend >/dev/null; echo "rolled back from $B (tables kept; see migrations/*.down.sql)"; exit 0
fi

have="$(md5sum "$APP/index.js" | cut -d' ' -f1)"
if [ "$have" != "$INDEX_BASE" ] && ! grep -q "ARGUS Facebook Pages (Claude, 2026-11-14)" "$APP/index.js"; then
  echo "ABORT: index.js changed in production since this release was built ($have). Rebuild the patch on the live file." >&2; exit 1
fi
for f in $NEW_FILES; do
  [ -s "$HERE/backend/$f" ] || { echo "ABORT: missing $f" >&2; exit 2; }
  if [ -e "$APP/$f" ] && ! cmp -s "$APP/$f" "$HERE/backend/$f"; then echo "ABORT: $APP/$f exists and differs" >&2; exit 1; fi
done
python3 "$HERE/backend/apply_index_patch.py" "$APP/index.js" --check

if [ "${1:-}" = "--check" ]; then
  T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
  python3 "$HERE/backend/apply_index_patch.py" "$APP/index.js" --out "$T/index.js" >/dev/null
  docker run --rm -v "$T":/t:ro -v "$HERE/backend":/s:ro 2906-system-backend sh -c 'node --check /t/index.js && for f in /s/routes/*.js /s/services/facebookPages/*.js; do node --check "$f" || exit 1; done' < /dev/null
  echo "check ok: base hash matches, anchors found, all files parse. Nothing was changed."; exit 0
fi

"$V2/pre_migration_backup.sh"
ARGUS_MIGRATION_APPROVED=yes "$V2/run_migration.sh" "$MIGRATION"

B="/opt/2906-system/backups/facebook-pages-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$B"; cp -p "$APP/index.js" "$B/index.js"
mkdir -p "$APP/services/facebookPages"
for f in $NEW_FILES; do cp "$HERE/backend/$f" "$APP/$f"; sed -i 's/\r$//' "$APP/$f"; done
python3 "$HERE/backend/apply_index_patch.py" "$APP/index.js"
for f in index.js $NEW_FILES; do
  docker exec 2906_backend node --check "/app/$f" < /dev/null || { echo "SYNTAX FAILURE in $f - restoring" >&2; cp -p "$B/index.js" "$APP/index.js"; remove_new; exit 1; }
done
docker restart 2906_backend >/dev/null
s=000
for i in $(seq 1 30); do s=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/api/crm/facebook-pages/status || true); [ "$s" = "401" ] && break; sleep 2; done
[ "$s" = "401" ] || { echo "SMOKE FAILURE: /api/crm/facebook-pages/status answered $s (expected 401 without a session) - rolling back" >&2; cp -p "$B/index.js" "$APP/index.js"; remove_new; docker restart 2906_backend >/dev/null; exit 1; }
m=$(curl -s -o /dev/null -w '%{http_code}' -X POST -d 'signed_request=bad.sig' http://127.0.0.1:3001/api/facebook-pages-meta/data-deletion || true)
[ "$m" = "400" ] || echo "WARNING: data-deletion callback answered $m (expected 400 for a forged request)"
echo "deployed; backup of index.js: $B"
