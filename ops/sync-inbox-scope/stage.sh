#!/usr/bin/env bash
# SYNC inbox scope: patched copy of the live backend + throwaway PostgreSQL (schema only). No live change.
set -euo pipefail
PKG="$(cd "$(dirname "$0")" && pwd)"; LIVE=/opt/2906-system/backend; PG=2906_postgres
STAGE=/tmp/argus-sync-scope-stage; TESTNET=argus-sync-scope-net; TESTDB=argus-sync-scope-db
TABLES="clients owner_contacts owner_phone_variants properties agents agent_activity_log owner_contact_log owner_availability_answers nexus_owner_links nexus_owner_invitations nexus_owner_property_claims nexus_property_links nexus_inbound_events nexus_owner_property_updates nexus_owner_viewing_schedules nexus_owner_answers nexus_distribution_grants nexus_distribution_routes nexus_sync_outbox property_viewing_windows property_viewings website_source_inventory sync_accounts sync_identities sync_sessions sync_checks"
cleanup() { docker rm -f "$TESTDB" >/dev/null 2>&1 || true; docker network rm "$TESTNET" >/dev/null 2>&1 || true; rm -rf "$STAGE"; }
cleanup; mkdir -p "$STAGE"
rsync -a --exclude node_modules --exclude uploads --exclude logs --exclude '.*' --exclude backups --exclude '*.log' --exclude exports "$LIVE/" "$STAGE/"
mkdir -p "$STAGE/test" "$STAGE/node_modules" "$STAGE/uploads"
if [ "${1:-patched}" = patched ]; then python3 "$PKG/patch.py" "$STAGE"; else echo "UNPATCHED live code"; fi
cp "$PKG/sync-inbox-roles.test.js" "$STAGE/test/"
for f in services/syncAccount.js routes/crmSyncInbox.js; do docker run --rm --network none -v "$STAGE:/app:ro" -w /app --entrypoint node 2906-system-backend --check "$f"; done
docker network create --internal "$TESTNET" >/dev/null
docker run -d --rm --name "$TESTDB" --network "$TESTNET" -e POSTGRES_PASSWORD=test pgvector/pgvector:pg16 >/dev/null
for i in $(seq 1 40); do docker exec "$TESTDB" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 2
T=""   # the whole live schema, no rows
docker exec "$PG" sh -c "pg_dump -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -s --no-owner --no-privileges $T" > "$STAGE/schema.sql"
docker exec "$TESTDB" psql -U postgres -q -c 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"'
docker exec -i "$TESTDB" psql -U postgres -q < "$STAGE/schema.sql" > /tmp/argus-sync-scope-schema.log 2>&1 || true
set +e
docker run --rm --network "$TESTNET" -v "$STAGE:/app:ro" -v "$LIVE/node_modules:/app/node_modules:ro" -w /app \
  -e BACKEND_DIR=/app -e NODE_ENV=test -e PGHOST="$TESTDB" --entrypoint timeout 2906-system-backend 240 node --test --test-force-exit --test-concurrency=1 test/sync-inbox-roles.test.js > /tmp/argus-sync-scope.out 2>&1
r=$?
set -e
grep -E "^(ok|not ok)|^# (pass|fail)" /tmp/argus-sync-scope.out
[ "$r" = 0 ] || grep -B2 -A24 "^not ok" /tmp/argus-sync-scope.out | cut -c1-260 | head -120
cleanup
[ "$r" = 0 ] && echo "STAGE TESTS PASSED" || { echo "STAGE TESTS FAILED"; exit 1; }
