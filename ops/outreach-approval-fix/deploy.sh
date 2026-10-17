#!/bin/bash
# Deploy the outreach approval fix. NOT run automatically — needs explicit go.
# Usage (on the VPS, files already copied to /tmp/outreach-approval-fix/):
#   bash /tmp/outreach-approval-fix/deploy.sh
set -euo pipefail
B=/opt/2906-system/backend
SRC=/tmp/outreach-approval-fix
STAMP=$(date -u +%Y%m%dT%H%MZ)
BK=/opt/2906-system/backups/outreach-approval-$STAMP

# Refuse if production changed since the snapshot this fix is based on.
EXPECTED=c66237e945d9d1daa39000b48715d275
ACTUAL=$(md5sum $B/services/adminCommands.js | cut -d' ' -f1)
[ "$ACTUAL" = "$EXPECTED" ] || { echo "ABORT: production adminCommands.js changed ($ACTUAL), rebase the fix first"; exit 1; }

# Do not interrupt a batch that is sending right now.
RUNNING=$(docker exec 2906_postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "SELECT count(*) FROM outreach_batches WHERE status=$$running$$"')
[ "$RUNNING" = "0" ] || { echo "ABORT: $RUNNING outreach batch(es) running — deploy after they finish"; exit 1; }

mkdir -p $BK/services
cp -p $B/services/adminCommands.js $BK/services/
echo "backup: $BK"
cp $SRC/services/adminCommands.js $B/services/adminCommands.js
cp $SRC/services/outreachApproval.js $B/services/outreachApproval.js
docker exec 2906_backend node --check services/adminCommands.js
docker exec 2906_backend node --check services/outreachApproval.js
docker restart 2906_backend
for i in $(seq 1 30); do docker logs 2906_backend --since 60s 2>&1 | grep -q "HTTP server listening" && break; sleep 2; done
docker logs 2906_backend --since 90s 2>&1 | grep -E "HTTP server listening|ERROR" | head -5
echo "rollback: cp $BK/services/adminCommands.js $B/services/ && rm $B/services/outreachApproval.js && docker restart 2906_backend"
