#!/usr/bin/env bash
# Viewing follow-up staging (2026-11-21): up | down | logs. Reachable only on the server's 127.0.0.1:3902.
# Base: the live backend code and full schema; this package's newer service file is layered on top.
set -euo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"; LIVE=/opt/2906-system/backend; PG=2906_postgres
CODE=/tmp/argus-viewing-e2e; NET=argus-viewing-e2e-net; DB=argus-viewing-e2e-db; APP=argus-viewing-e2e-app
case "${1:-}" in
  up)
    "$0" down >/dev/null 2>&1 || true
    rm -rf "$CODE"; mkdir -p "$CODE"
    rsync -a --exclude node_modules --exclude uploads --exclude logs --exclude '.*' --exclude backups --exclude '*.log' --exclude exports --exclude private-docs "$LIVE/" "$CODE/"
    cp "$PKG/backend/services/viewingFollowups.js" "$CODE/services/"
    cp "$PKG/backend/routes/crmViewingFollowups.js" "$CODE/routes/"
    cp "$PKG/staging/server.js" "$CODE/stage-server.js"
    docker network create "$NET" >/dev/null
    docker run -d --rm --name "$DB" --network "$NET" -e POSTGRES_PASSWORD=test pgvector/pgvector:pg16 >/dev/null
    for i in $(seq 1 40); do docker exec "$DB" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 2
    docker exec "$PG" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -s --no-owner --no-privileges' > "$CODE/schema.sql"
    docker exec "$DB" psql -U postgres -q -c 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"' -c 'CREATE EXTENSION IF NOT EXISTS btree_gist' >/dev/null 2>&1 || true
    docker exec -i "$DB" psql -U postgres -q < "$CODE/schema.sql" > "$CODE/schema.log" 2>&1 || true
    docker exec "$PG" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --data-only -t areas -t villages --no-owner --no-privileges' | docker exec -i "$DB" psql -U postgres -q >/dev/null 2>&1 || true
    docker run -d --rm --name "$APP" --network "$NET" -p 127.0.0.1:3902:3902 -v "$CODE:/app" -v "$LIVE/node_modules:/app/node_modules:ro" -w /app \
      -e NODE_ENV=staging -e PGHOST="$DB" -e JWT_SECRET=staging-jwt-secret-not-production-000 -e VIEWING_FOLLOWUPS=0 -e PUBLIC_CRM_URL=http://localhost:3080/crm \
      --entrypoint node 2906-system-backend stage-server.js >/dev/null
    for i in $(seq 1 40); do curl -s -m 2 -o /dev/null http://127.0.0.1:3902/stage/outbox && break; sleep 1; done
    docker logs "$APP" 2>&1 | grep -E "seeded|staging on|failed|Error" | head -5
    ;;
  down) docker rm -f "$APP" "$DB" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; rm -rf "$CODE"; echo "staging removed" ;;
  logs) docker logs --tail 60 "$APP" 2>&1 ;;
  *) echo "usage: stage.sh up|down|logs"; exit 2 ;;
esac
