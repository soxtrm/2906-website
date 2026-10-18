#!/bin/bash
# Deploy: auto-published listings get distributed (services/autoOwnerConversation.js).
# Usage (on the VPS, file copied to /tmp/property-distribution-fix/services/):
#   bash /tmp/property-distribution-fix/deploy-autopublish.sh
set -euo pipefail
B=/opt/2906-system/backend
SRC=/tmp/property-distribution-fix
BK=/opt/2906-system/backups/autopublish-distribution-$(date -u +%Y%m%dT%H%MZ)
F=services/autoOwnerConversation.js

A=$(md5sum $B/$F | cut -d' ' -f1)
[ "$A" = 33d3be5a4d625d0a1984d6d0f7873e8a ] || { echo "ABORT: production $F changed ($A), rebase first"; exit 1; }
# A restart mid-distribution would cut a listing off half-posted.
if docker logs 2906_backend --since 3m 2>&1 | grep -qE "categoryPublisher|upload: (category|fb campaign)"; then echo "ABORT: a distribution ran in the last 3 min, retry later"; exit 1; fi

sed -i -e 's/\r$//' $SRC/$F
mkdir -p $BK/services && cp -p $B/$F $BK/services/ && echo "backup: $BK"
cp $SRC/$F $B/$F
docker exec 2906_backend node -e "require('/app/$F')" || { cp -p $BK/$F $B/$F; echo "ABORT: load failed, restored"; exit 1; }
md5sum $B/$F
docker restart 2906_backend
for i in $(seq 1 30); do docker logs 2906_backend --since 60s 2>&1 | grep -q "HTTP server listening" && break; sleep 2; done
docker logs 2906_backend --since 90s 2>&1 | grep -E "HTTP server listening" | head -2
echo "rollback: cp -p $BK/$F $B/$F && docker restart 2906_backend"
