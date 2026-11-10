#!/bin/bash
# ARGUS Property Source Sync — backend deploy (Claude, 2026-11-09).
# Established VPS procedure: copy files into /opt/2906-system/backend (bind-
# mounted at /app), run the additive migration, restart 2906_backend.
# Usage on the VPS after copying this mirror to /tmp/pss-deploy:
#   bash /tmp/pss-deploy/deploy.sh
set -euo pipefail
B=/opt/2906-system/backend
SRC=/tmp/pss-deploy/backend
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BK=/opt/2906-system/backups/property-source-sync-$STAMP
q() { docker exec -e SQL="$1" 2906_postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "$SQL"'; }

# 1. Production must be exactly the base this release was built on.
declare -A EXPECTED=( [index.js]=6f013cea671449bad0863028d4cdc3d7 [cron.js]=4d54178f54635f62dcb659432c3959cb [routes/crmBaseInventory.js]=72203fadf5af58075a6ceeb9f41ae4ec )
for f in "${!EXPECTED[@]}"; do
  A=$(md5sum "$B/$f" | cut -d' ' -f1)
  [ "$A" = "${EXPECTED[$f]}" ] || { echo "ABORT: production $f is $A, expected ${EXPECTED[$f]}"; exit 1; }
done
for f in services/propertySourceSync.js services/propertySourceAdapters.js services/propertySourceFetch.js routes/crmPropertySources.js; do
  [ ! -e "$B/$f" ] || { echo "ABORT: $f already exists in production"; exit 1; }
done
[ "$(q "SELECT to_regclass('property_sources') IS NULL")" = "t" ] || { echo "ABORT: property_sources already exists"; exit 1; }

# 2. Backup: replaced files + the one existing table the migration alters.
mkdir -p "$BK/routes"
cp -p "$B/index.js" "$B/cron.js" "$BK/"; cp -p "$B/routes/crmBaseInventory.js" "$BK/routes/"
docker exec 2906_postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t website_source_inventory' > "$BK/website_source_inventory.sql"
q "SELECT COUNT(*) FROM website_source_inventory" > "$BK/wsi_count.txt"
[ -s "$BK/website_source_inventory.sql" ] || { echo "ABORT: backup empty"; exit 1; }
echo "backup: $BK ($(cat "$BK/wsi_count.txt") website_source_inventory rows)"

# 3. Additive migration (single transaction, stops on first error).
docker exec -i 2906_postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q' < "$SRC/migrations/20261109_property_source_sync.sql"
[ "$(q "SELECT COUNT(*) FROM website_source_inventory")" = "$(cat "$BK/wsi_count.txt")" ] || { echo "ABORT: row count changed"; exit 1; }

# 4. Code.
for f in services/propertySourceSync.js services/propertySourceAdapters.js services/propertySourceFetch.js routes/crmPropertySources.js routes/crmBaseInventory.js index.js cron.js; do
  cp "$SRC/$f" "$B/$f"
done
for f in services/propertySourceSync.js services/propertySourceAdapters.js services/propertySourceFetch.js routes/crmPropertySources.js routes/crmBaseInventory.js index.js cron.js; do
  docker exec 2906_backend node --check "/app/$f"
done
docker exec 2906_backend node -e "require('/app/services/propertySourceAdapters'); require('/app/services/propertySourceFetch')"
docker restart 2906_backend >/dev/null
for i in $(seq 1 45); do docker logs 2906_backend --since 120s 2>&1 | grep -q "HTTP server listening" && break; sleep 2; done
docker logs 2906_backend --since 120s 2>&1 | grep -E "HTTP server listening|Fatal|Cannot find module" | head -5
CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3001/api/crm/property-sources/summary)
echo "unauthenticated /api/crm/property-sources/summary -> $CODE (expected 401)"
[ "$CODE" = "401" ] || { echo "WARNING: unexpected status; consider rollback"; }
q "SELECT id, label, read_permission, sync_enabled FROM property_sources ORDER BY id"
echo "rollback: cp -p $BK/index.js $BK/cron.js $B/ && cp -p $BK/routes/crmBaseInventory.js $B/routes/ && rm -f $B/services/propertySource*.js $B/routes/crmPropertySources.js && docker restart 2906_backend && docker exec -i 2906_postgres sh -c 'psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -v ON_ERROR_STOP=1' < $SRC/migrations/20261109_property_source_sync.down.sql"
