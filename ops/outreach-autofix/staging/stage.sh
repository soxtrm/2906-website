#!/usr/bin/env bash
# Outreach Auto fix staging: up | down | logs. Reachable only on the server's 127.0.0.1:3903.
set -euo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"; LIVE=/opt/2906-system/backend; PG=2906_postgres
CODE=/tmp/argus-outreach-e2e; NET=argus-outreach-e2e-net; DB=argus-outreach-e2e-db; APP=argus-outreach-e2e-app
case "${1:-}" in
  up)
    "$0" down >/dev/null 2>&1 || true
    rm -rf "$CODE"; mkdir -p "$CODE"
    rsync -a --exclude node_modules --exclude uploads --exclude logs --exclude '.*' --exclude backups --exclude '*.log' --exclude exports --exclude private-docs "$LIVE/" "$CODE/"
    if [ ! -e "$LIVE/services/outreachLibrary.js" ]; then
      for f in services/outreachLibrary.js services/outreachLibrarySeed.js services/outreachAutoStatus.js; do cp "$PKG/backend/$f" "$CODE/$f"; done
      python3 "$PKG/deploy/patch_autofix.py" "$CODE"
    fi
    mkdir -p "$CODE/node_modules"; cp "$PKG/staging/server.js" "$CODE/stage-server.js"
    docker network create "$NET" >/dev/null
    docker run -d --rm --name "$DB" --network "$NET" -e POSTGRES_PASSWORD=test pgvector/pgvector:pg16 >/dev/null
    for i in $(seq 1 40); do docker exec "$DB" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 2
    docker exec "$PG" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -s --no-owner --no-privileges' > "$CODE/schema.sql"
    docker exec "$DB" psql -U postgres -q -c 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"' -c 'CREATE EXTENSION IF NOT EXISTS btree_gist' >/dev/null 2>&1 || true
    docker exec -i "$DB" psql -U postgres -q < "$CODE/schema.sql" > "$CODE/schema.log" 2>&1 || true
    docker exec -i "$DB" psql -U postgres -q < "$PKG/backend/migrations/20261121g_outreach_autofix.sql" >/dev/null 2>&1 || true
    docker run -d --rm --name "$APP" --network "$NET" -p 127.0.0.1:3903:3903 -v "$CODE:/app" -v "$LIVE/node_modules:/app/node_modules:ro" -w /app \
      -e NODE_ENV=staging -e PGHOST="$DB" -e JWT_SECRET=staging-jwt-secret-not-production-000 --entrypoint node 2906-system-backend stage-server.js >/dev/null
    for i in $(seq 1 60); do curl -s -m 2 -o /dev/null http://127.0.0.1:3903/stage/outbox && break; sleep 1; done
    docker logs "$APP" 2>&1 | grep -E "seeded|library|staging on|failed|Error" | head -5
    ;;
  down) docker rm -f "$APP" "$DB" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; rm -rf "$CODE"; echo "staging removed" ;;
  logs) docker logs --tail 60 "$APP" 2>&1 ;;
  *) echo "usage: stage.sh up|down|logs"; exit 2 ;;
esac
