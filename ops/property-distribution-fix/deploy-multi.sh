#!/bin/bash
# Deploy several backend files with ONE restart: md5 guard for every file,
# one backup folder, syntax check, restart.
# Usage: bash deploy-multi.sh <relpath>=<expected-prod-md5> [...]
set -euo pipefail
B=/opt/2906-system/backend
SRC=/tmp/property-distribution-fix
BK=/opt/2906-system/backups/property-distribution-$(date -u +%Y%m%dT%H%M%SZ)
for pair in "$@"; do F=${pair%%=*}; E=${pair##*=}; A=$(md5sum $B/$F | cut -d' ' -f1); [ "$A" = "$E" ] || { echo "ABORT: production $F changed ($A)"; exit 1; }; done
if docker logs 2906_backend --since 3m 2>&1 | grep -qE "categoryPublisher|upload: (category|fb campaign)"; then echo "ABORT: a distribution ran in the last 3 min"; exit 1; fi
SQL="SELECT (SELECT count(*) FROM outreach_batches WHERE status = 'running') + (SELECT count(*) FROM outreach_runs WHERE status IN ('claimed','running'))"
RUNNING=$(docker exec -e SQL="$SQL" 2906_postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "$SQL"')
[ "$RUNNING" = "0" ] || { echo "ABORT: $RUNNING outreach batch/run(s) active"; exit 1; }
for pair in "$@"; do F=${pair%%=*}; sed -i -e 's/\r$//' $SRC/$F; mkdir -p $BK/$(dirname $F); cp -p $B/$F $BK/$F; done
echo "backup: $BK"
for pair in "$@"; do F=${pair%%=*}; cp $SRC/$F $B/$F; done
for pair in "$@"; do F=${pair%%=*}; docker exec 2906_backend node --check /app/$F || { for p in "$@"; do f=${p%%=*}; cp -p $BK/$f $B/$f; done; echo "ABORT: syntax $F, all restored"; exit 1; }; done
for pair in "$@"; do F=${pair%%=*}; md5sum $B/$F; done
docker restart 2906_backend >/dev/null
for i in $(seq 1 30); do docker logs 2906_backend --since 60s 2>&1 | grep -q "HTTP server listening" && break; sleep 2; done
docker logs 2906_backend --since 90s 2>&1 | grep -E "HTTP server listening" | head -1
echo "rollback: cp -rp $BK/* $B/ && docker restart 2906_backend"
