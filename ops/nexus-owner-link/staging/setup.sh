#!/bin/bash
# ARGUS × NEXUS integration-gate staging — bring-up on the VPS (Claude, 2026-11-13).
# Run from /opt/argus-nexus-staging after unpacking the bundle made by package.sh.
#
#   bash setup.sh                     ARGUS side (proxy, database, service)
#   bash setup.sh --with-nexus        also NEXUS (needs nexus-src/ of a pinned commit and NEXUS_COMMIT in pins.env)
#
# What it touches: only this directory and Docker objects of the compose
# project "argus-nexus-staging". What it reads from production: two source
# files (db.js, services/boardAction.js, checksum-verified) and, once, the
# database SCHEMA (no rows). It never writes to, restarts or reconfigures
# anything of the production stack, and it never copies a production secret.
set -euo pipefail
cd "$(dirname "$0")"
umask 077
PROD=/opt/2906-system/backend
WITH_NEXUS=0; [ "${1:-}" = "--with-nexus" ] && WITH_NEXUS=1
. ./pins.env   # ARGUS_COMMIT, NEXUS_COMMIT (may be empty), DB_JS_MD5, BOARD_ACTION_MD5

# 1. Secrets: generated here, kept here (0600), never printed, never committed.
if [ ! -f .env ]; then
  { for k in ARGUS_DB_PASSWORD NEXUS_DB_PASSWORD ARGUS_JWT_SECRET ARGUS_INVITE_SECRET SECRET_NEXUS_TO_ARGUS SECRET_ARGUS_TO_NEXUS; do echo "$k=$(openssl rand -hex 32)"; done; } > .env
  echo "generated staging secrets in $(pwd)/.env"
fi
grep -q '^ARGUS_COMMIT=' .env && sed -i '/^ARGUS_COMMIT=/d;/^NEXUS_COMMIT=/d' .env
echo "ARGUS_COMMIT=$ARGUS_COMMIT" >> .env
echo "NEXUS_COMMIT=${NEXUS_COMMIT:-unpinned}" >> .env

# 2. Build context for ARGUS: staging entry files + pinned owner-link code + two unmodified production files.
rm -rf build/argus && mkdir -p build/argus/services build/argus/routes
cp argus/* build/argus/
cp backend/services/*.js build/argus/services/
cp backend/routes/*.js build/argus/routes/
for pair in "db.js:$DB_JS_MD5" "services/boardAction.js:$BOARD_ACTION_MD5"; do
  f=${pair%%:*}; want=${pair##*:}; got=$(md5sum "$PROD/$f" | cut -d' ' -f1)
  [ "$got" = "$want" ] || { echo "ABORT: production $f is $got, the pinned code was tested with $want"; exit 1; }
  cp "$PROD/$f" "build/argus/$f"
done
chmod -R a+rX build

# 3. Schema snapshot of production: structure only, no rows. Taken once.
if [ ! -s schema.sql ]; then
  docker exec 2906_postgres sh -c 'pg_dump --schema-only --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > schema.sql
  echo "schema snapshot: $(grep -c '^CREATE TABLE' schema.sql) tables, $(grep -c '^COPY \|^INSERT ' schema.sql) data statements"
fi
[ "$(grep -c '^COPY \|^INSERT ' schema.sql)" = "0" ] || { echo "ABORT: schema.sql contains data"; exit 1; }

# 4. Proxy, CA export, ARGUS database.
docker compose build -q argus
docker compose up -d proxy ca argus_pg
for i in $(seq 1 60); do [ "$(docker inspect -f '{{.State.Health.Status}}' argus-nexus-staging-argus_pg-1 2>/dev/null)" = "healthy" ] && break; sleep 2; done
psql_argus() { docker compose exec -T argus_pg psql -U argus_stg -d argus_staging "$@"; }
if [ "$(psql_argus -At -c "SELECT to_regclass('public.properties') IS NULL")" = "t" ]; then
  psql_argus -q -v ON_ERROR_STOP=1 < schema.sql >/dev/null
  echo "schema loaded: $(psql_argus -At -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public'") tables, $(psql_argus -At -c "SELECT COUNT(*) FROM properties") property rows"
fi
for m in 20261111_nexus_owner_link.sql 20261111b_nexus_distribution_routes.sql 20261112_nexus_owner_updates.sql; do
  psql_argus -q -v ON_ERROR_STOP=1 < "backend/migrations/$m" >/dev/null
done
docker compose up -d argus

# 5. NEXUS (optional): one pinned commit, its own database, no ARGUS database login.
if [ "$WITH_NEXUS" = "1" ]; then
  [ -d nexus-src ] && [ -n "${NEXUS_COMMIT:-}" ] || { echo "ABORT: nexus-src/ and NEXUS_COMMIT are required for --with-nexus"; exit 1; }
  rm -rf build/nexus && mkdir -p build/nexus && cp -r nexus-src build/nexus/src && cp nexus/entry.py nexus/Dockerfile build/nexus/ && chmod -R a+rX build
  docker compose --profile nexus build -q nexus
  docker compose --profile nexus up -d nexus_pg
  for i in $(seq 1 60); do [ "$(docker inspect -f '{{.State.Health.Status}}' argus-nexus-staging-nexus_pg-1 2>/dev/null)" = "healthy" ] && break; sleep 2; done
  psql_nexus() { docker compose --profile nexus exec -T nexus_pg psql -U nexus_stg -d nexus_staging "$@"; }
  if [ "$(psql_nexus -At -c "SELECT to_regnamespace('nexus_private') IS NULL")" = "t" ]; then
    psql_nexus -q -v ON_ERROR_STOP=1 < nexus-src/tests/fixtures/nexus_housing_vanilla_pg.sql >/dev/null
    for m in $(ls nexus-src/supabase/migrations/*.sql | sort); do psql_nexus -q -v ON_ERROR_STOP=1 < "$m" >/dev/null; done
    echo "NEXUS schema loaded"
  fi
  docker compose --profile nexus up -d nexus
fi

# 6. Checks from the VPS loopback, verifying the staging certificate.
docker compose cp ca:/out/root.crt ./staging-root-ca.crt >/dev/null 2>&1 || docker run --rm -v argus-nexus-staging_ca_pub:/ca:ro alpine cat /ca/root.crt > staging-root-ca.crt
chmod 644 staging-root-ca.crt
probe() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 --cacert staging-root-ca.crt --resolve "$1:8443:127.0.0.1" "$2" "${@:3}"; }
for i in $(seq 1 30); do [ "$(probe argus.staging.test https://argus.staging.test:8443/healthz)" = "200" ] && break; sleep 2; done
echo "ARGUS staging /healthz          -> $(probe argus.staging.test https://argus.staging.test:8443/healthz) (expected 200)"
echo "staff API without a session     -> $(probe argus.staging.test https://argus.staging.test:8443/api/crm/owner-nexus/1) (expected 401)"
echo "service API without a signature -> $(probe argus.staging.test https://argus.staging.test:8443/api/nexus-link/v1/events -X POST -H 'content-type: application/json' -d '{}') (expected 401)"
echo "anything else                   -> $(probe argus.staging.test https://argus.staging.test:8443/api/crm/properties) (expected 404)"
[ "$WITH_NEXUS" = "1" ] && echo "NEXUS staging owner page        -> $(probe nexus.staging.test https://nexus.staging.test:8443/housing/owner) (expected 200)"
docker compose ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'
