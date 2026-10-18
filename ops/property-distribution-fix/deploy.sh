#!/bin/bash
# Deploy the #2906-9481 category formatter fix (sanitizer + categoryFormatter).
# Usage (on the VPS, files copied to /tmp/property-distribution-fix/services/):
#   bash /tmp/property-distribution-fix/deploy.sh
set -euo pipefail
B=/opt/2906-system/backend
SRC=/tmp/property-distribution-fix
STAMP=$(date -u +%Y%m%dT%H%MZ)
BK=/opt/2906-system/backups/property-distribution-$STAMP

# Refuse if production changed since snapshot 995ce72.
check() { local a; a=$(md5sum "$B/services/$1" | cut -d' ' -f1); [ "$a" = "$2" ] || { echo "ABORT: production $1 changed ($a), rebase the fix first"; exit 1; }; }
check sanitizer.js 0b5320fb512d8162bfc52e771257d769
check categoryFormatter.js b8bbb6c779e292de6bff0d6bec5eae0e

SQL="SELECT (SELECT count(*) FROM outreach_batches WHERE status = 'running') + (SELECT count(*) FROM outreach_runs WHERE status IN ('claimed','running'))"
RUNNING=$(docker exec -e SQL="$SQL" 2906_postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "$SQL"')
[ "$RUNNING" = "0" ] || { echo "ABORT: $RUNNING outreach batch/run(s) active"; exit 1; }

sed -i 's/\r$//' $SRC/services/*.js
mkdir -p $BK/services
cp -p $B/services/sanitizer.js $B/services/categoryFormatter.js $BK/services/
echo "backup: $BK"
cp $SRC/services/sanitizer.js $SRC/services/categoryFormatter.js $B/services/
docker exec 2906_backend node -e "require('/app/services/categoryFormatter'); require('/app/services/sanitizer')" || { cp -p $BK/services/*.js $B/services/; echo "ABORT: load failed, restored"; exit 1; }
md5sum $B/services/sanitizer.js $B/services/categoryFormatter.js
docker restart 2906_backend
for i in $(seq 1 30); do docker logs 2906_backend --since 60s 2>&1 | grep -q "HTTP server listening" && break; sleep 2; done
docker logs 2906_backend --since 90s 2>&1 | grep -E "HTTP server listening|ERROR" | head -5
echo "rollback: cp -p $BK/services/*.js $B/services/ && docker restart 2906_backend"
