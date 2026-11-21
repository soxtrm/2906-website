#!/usr/bin/env bash
# NEXUS SYNC staging (2026-11-21): up | down | logs. Reachable only on the server's 127.0.0.1:3901.
# Uses the staged package in /root/sync-delegates-docs (patched SYNC code + new services + migration).
set -euo pipefail
PKG="$(cd "$(dirname "$0")" && pwd)"; LIVE=/opt/2906-system/backend; PG=2906_postgres; DD=/root/sync-delegates-docs
CODE=/tmp/argus-sync-e2e; NET=argus-sync-e2e-net; DB=argus-sync-e2e-db; APP=argus-sync-e2e-app
SECRET_FILE=/root/sync-staging.secret
case "${1:-}" in
  up)
    "$0" down >/dev/null 2>&1 || true
    rm -rf "$CODE"; mkdir -p "$CODE"
    rsync -a --exclude node_modules --exclude uploads --exclude logs --exclude '.*' --exclude backups --exclude '*.log' --exclude exports --exclude private-docs "$LIVE/" "$CODE/"
    python3 "$DD/patch.py" "$CODE" >/dev/null
    for f in services/syncDelegates.js services/syncDocuments.js services/syncPropertyConditions.js; do cp "$DD/backend/$f" "$CODE/$f"; done
    cp "$PKG/server.js" "$CODE/stage-server.js"
    [ -s "$SECRET_FILE" ] || (umask 077; head -c 96 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 48 > "$SECRET_FILE")
    docker network create "$NET" >/dev/null
    docker run -d --rm --name "$DB" --network "$NET" -e POSTGRES_PASSWORD=test pgvector/pgvector:pg16 >/dev/null
    for i in $(seq 1 40); do docker exec "$DB" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 2
    docker exec "$PG" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -s --no-owner --no-privileges' > "$CODE/schema.sql"
    docker exec "$DB" psql -U postgres -q -c 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"'
    docker exec -i "$DB" psql -U postgres -q < "$CODE/schema.sql" > /dev/null 2>&1 || true
    docker exec -i "$DB" psql -U postgres -v ON_ERROR_STOP=1 -q < "$DD/backend/migrations/20261121b_sync_delegates_documents.sql"
    docker run -d --rm --name "$APP" --network "$NET" -p 127.0.0.1:3901:3901 -v "$CODE:/app" -v "$LIVE/node_modules:/app/node_modules:ro" -w /app \
      -e NODE_ENV=staging -e PGHOST="$DB" -e ARGUS_AGENCY_KEY=2906 -e JWT_SECRET=staging-jwt-secret-not-production-000 \
      -e NEXUS_LINK_INBOUND_SECRET="$(cat "$SECRET_FILE")" -e SYNC_PRIVATE_DOCS_DIR=/app/private-docs -e SYNC_STAFF_FILE_ORIGIN=http://127.0.0.1:3901 \
      -e SYNC_PUBLIC_ORIGIN=http://localhost:3080 --entrypoint node 2906-system-backend stage-server.js >/dev/null
    for i in $(seq 1 40); do curl -s -m 2 -o /dev/null http://127.0.0.1:3901/stage/outbox && break; sleep 1; done
    docker logs "$APP" 2>&1 | grep -E "seeded|staging on|failed|Error" | head -5
    ;;
  down) docker rm -f "$APP" "$DB" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; rm -rf "$CODE"; echo "staging removed" ;;
  logs) docker logs --tail 60 "$APP" 2>&1 ;;
  *) echo "usage: staging.sh up|down|logs"; exit 2 ;;
esac
