#!/usr/bin/env bash
# Restore drill on the SYNC staging service (synthetic data): upload -> encrypted backup -> lose files AND rows -> restore -> compare.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; NET=argus-sync-e2e-net; DB=argus-sync-e2e-db
KEY=/root/sync-staging-docs.key
[ -s "$KEY" ] || (umask 077; head -c 96 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 64 > "$KEY")
client() { docker run --rm -i --network "$NET" -v /tmp/argus-sync-e2e:/app:ro -v "$HERE/drill-client.js:/drill.js:ro" -v /opt/2906-system/backend/node_modules:/app/node_modules:ro \
  -e BACKEND_DIR=/app -e STAGE=http://argus-sync-e2e-app:3901 -e SECRET="$(cat /root/sync-staging.secret)" --entrypoint node 2906-system-backend /drill.js "$@"; }
export DOCS_DIR=/tmp/argus-sync-e2e/private-docs OUT_DIR=/tmp/drill-backups KEY_FILE="$KEY" PG_CONTAINER="$DB" PSQL_CMD='psql -U postgres -d postgres -X -v ON_ERROR_STOP=1'
rm -rf /tmp/drill-backups
echo "1. upload three documents (scanned by ClamAV), share one"
client seed > /tmp/drill-seed.json; cat /tmp/drill-seed.json | tr ',' '\n' | grep -c '"id"' | sed 's/^/   documents: /'
echo "2. encrypted backup"
"$HERE/private_docs_backup.sh"
ARCH=$(ls -t /tmp/drill-backups/*.tar.gpg | head -1)
if grep -aq "%PDF" "$ARCH" || grep -aq "owner_contact_id" "$ARCH"; then echo "FAIL: plain content visible in the archive"; exit 1; else echo "   archive holds no readable content (encrypted)"; fi
echo "3. disaster: all files and all document rows gone"
rm -f "$DOCS_DIR"/*
docker exec "$DB" psql -U postgres -q -c "DELETE FROM owner_documents WHERE storage='sync_private'"
client verify < /tmp/drill-seed.json > /tmp/drill-before.txt 2>&1 || true; tail -1 /tmp/drill-before.txt | sed 's/^/   before restore: /'
echo "4. restore files + metadata"
"$HERE/restore.sh" "$ARCH" files+metadata
echo "5. compare through the API"
client verify < /tmp/drill-seed.json
rm -rf /tmp/drill-backups /tmp/drill-seed.json /tmp/drill-before.txt
echo "RESTORE DRILL PASSED"
