#!/usr/bin/env bash
# Weekly recheck end-to-end test on a THROW-AWAY copy of the newest ARGUS backup.
# Internal Docker network (no internet, no production DB/Redis/WAHA), no .env.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
NET=r7d-test-net; DB=r7d-testdb; RD=r7d-testredis; PW="t$(date +%s)"; APP=/root/r7d-app
DUMP="$(ls -t /var/backups/2906/postgres/2906db_*.dump | head -1)"
cleanup() { docker rm -f "$DB" "$RD" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; rm -rf "$APP"; }
trap cleanup EXIT
cleanup
mkdir -p "$APP"
rsync -a --exclude node_modules --exclude .env --exclude 'uploads' --exclude '.fb-profile' --exclude logs --exclude '.rollback' \
  --exclude '.nexus-stage-*' --exclude '.claude-backup-*' --exclude '*.bak*' /opt/2906-system/backend/ "$APP/"
ln -s /base/node_modules "$APP/node_modules"
cp "$HERE/patched/cron.js" "$APP/cron.js"; cp "$HERE/patched/waha.js" "$APP/waha.js"
cp "$HERE/patched/services/availability.js" "$HERE/patched/services/ownerRecheck7d.js" "$APP/services/"
mkdir -p "$APP/test"; cp "$HERE/test/recheck7d.integration.js" "$APP/test/"
docker network create --internal "$NET" >/dev/null
docker run -d --name "$DB" --network "$NET" -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB=argus_test pgvector/pgvector:pg16 >/dev/null
docker run -d --name "$RD" --network "$NET" redis:7-alpine >/dev/null
for i in $(seq 1 60); do docker exec "$DB" pg_isready -U postgres -d argus_test >/dev/null 2>&1 && break; sleep 1; done; sleep 2
echo "restoring $(basename "$DUMP")"
docker cp "$DUMP" "$DB:/tmp/db.dump"
docker exec "$DB" pg_restore -U postgres -d argus_test --no-owner --no-acl -j 4 /tmp/db.dump > /tmp/r7d-restore.log 2>&1 || true
docker exec "$DB" psql -U postgres -d argus_test -Atc "select count(*) from properties" | sed 's/^/properties in copy: /'
docker run --rm --network "$NET" -v /opt/2906-system/backend:/base:ro -v "$APP":/app \
  -e POSTGRES_HOST="$DB" -e POSTGRES_DB=argus_test -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD="$PW" \
  -e REDIS_HOST="$RD" -e WAHA_URL=http://127.0.0.1:3999 -e WAHA_API_KEY=test -e AVAILABILITY_AUTO_REACHOUT=1 -e NODE_ENV=test \
  -w /app 2906-system-backend node test/recheck7d.integration.js
