#!/bin/bash
# Deploy ONE backend file with md5 guard, backup, syntax check and restart.
# Usage (on the VPS, file copied to /tmp/property-distribution-fix/<rel path>):
#   bash deploy-file.sh services/rentedDetector.js <expected-prod-md5>
set -euo pipefail
B=/opt/2906-system/backend
SRC=/tmp/property-distribution-fix
F=$1; EXPECTED=$2
BK=/opt/2906-system/backups/property-distribution-$(date -u +%Y%m%dT%H%M%SZ)

A=$(md5sum $B/$F | cut -d' ' -f1)
[ "$A" = "$EXPECTED" ] || { echo "ABORT: production $F changed ($A), rebase first"; exit 1; }
# A restart mid-distribution would cut a listing off half-posted.
if docker logs 2906_backend --since 3m 2>&1 | grep -qE "categoryPublisher|upload: (category|fb campaign)"; then echo "ABORT: a distribution ran in the last 3 min, retry later"; exit 1; fi
SQL="SELECT (SELECT count(*) FROM outreach_batches WHERE status = 'running') + (SELECT count(*) FROM outreach_runs WHERE status IN ('claimed','running'))"
RUNNING=$(docker exec -e SQL="$SQL" 2906_postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "$SQL"')
[ "$RUNNING" = "0" ] || { echo "ABORT: $RUNNING outreach batch/run(s) active"; exit 1; }

sed -i -e 's/\r$//' $SRC/$F
mkdir -p $BK/$(dirname $F) && cp -p $B/$F $BK/$F && echo "backup: $BK"
cp $SRC/$F $B/$F
docker exec 2906_backend node --check /app/$F || { cp -p $BK/$F $B/$F; echo "ABORT: syntax, restored"; exit 1; }
md5sum $B/$F
docker restart 2906_backend >/dev/null
for i in $(seq 1 30); do docker logs 2906_backend --since 60s 2>&1 | grep -q "HTTP server listening" && break; sleep 2; done
docker logs 2906_backend --since 90s 2>&1 | grep -E "HTTP server listening" | head -1
echo "rollback: cp -p $BK/$F $B/$F && docker restart 2906_backend"
