#!/bin/bash
# Deploy the outreach automation rebuild (2026-10-29). NOT run automatically —
# needs the operator's explicit OK in chat (AGENTS.md).
# Usage (on the VPS, mirror copied to /tmp/outreach-automation/backend/):
#   bash /tmp/outreach-automation/deploy.sh
#
# Safe defaults after deploy: outreach_auto_enabled is FALSE for every account,
# so nothing is prepared or scheduled by the new Auto mode until an operator
# switches it on per account. Existing armed plans keep their jobs.
set -euo pipefail
B=/opt/2906-system/backend
SRC=/tmp/outreach-automation/backend
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BK=/opt/2906-system/backups/outreach-automation-$STAMP
q() { docker exec -e SQL="$1" 2906_postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "$SQL"'; }

# 1. Production must still be the snapshot this change is based on (eab7791/8086b6a).
declare -A EXPECTED=(
  [services/outreachPlanner.js]=4c8eee232849436706175d4c82d5c050
  [services/adminCommands.js]=200cf7cdee940f4bf29b5cf0b9b2ba1a
  [services/outreachRunEngine.js]=d2a66bfda3e8f4648373458d121ec951
  [services/cooldownRules.js]=76f4594fe53bdf1b09740d40ffc8a575
  [services/listBuilder.js]=a3509f626a4b15b289f29b6c59c2a3e8
  [routes/crm.js]=39f36c24ee50e0b8c0840c1a40a56014
)
for f in "${!EXPECTED[@]}"; do
  A=$(md5sum $B/$f | cut -d' ' -f1)
  [ "$A" = "${EXPECTED[$f]}" ] || { echo "ABORT: production $f changed ($A) — rebase first"; exit 1; }
done
NEW=(services/outreachSchedule.js services/outreachPace.js services/outreachQuota.js services/outreachTemplates.js
     services/outreachTemplateSeed.js services/outreachEligibility.js services/outreachEngagement.js)
for f in "${NEW[@]}"; do [ ! -e $B/$f ] || { echo "ABORT: $f already exists in production"; exit 1; }; done

# 2. Never interrupt a send in progress.
RUNNING=$(q "SELECT (SELECT count(*) FROM outreach_batches WHERE status = 'running' AND updated_at > NOW() - INTERVAL '2 hours') + (SELECT count(*) FROM outreach_runs WHERE status IN ('claimed','running'))")
[ "$RUNNING" = "0" ] || { echo "ABORT: $RUNNING outreach batch/run(s) active — deploy after they finish"; exit 1; }

# 3. Backup files + the tables the migration touches.
mkdir -p $BK/services $BK/routes
for f in "${!EXPECTED[@]}"; do cp -p $B/$f $BK/$f; done
docker exec 2906_postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t whatsapp_accounts -t outreach_plans --data-only' > $BK/accounts_plans_data.sql
echo "backup: $BK"

# 4. Migration (single transaction, idempotent), then code.
docker exec -i 2906_postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' < $SRC/migrations/20261029_outreach_automation.sql
for f in "${!EXPECTED[@]}" "${NEW[@]}"; do cp $SRC/$f $B/$f; done
for f in "${!EXPECTED[@]}" "${NEW[@]}"; do
  [ "$(md5sum < $B/$f | cut -d' ' -f1)" = "$(md5sum < $SRC/$f | cut -d' ' -f1)" ] || { echo "ABORT: copy mismatch $f"; exit 1; }
  docker exec 2906_backend node --check $f
done
docker restart 2906_backend
for i in $(seq 1 30); do docker logs 2906_backend --since 60s 2>&1 | grep -q "HTTP server listening" && break; sleep 2; done
docker logs 2906_backend --since 90s 2>&1 | grep -E "HTTP server listening|ERROR" | head -5
q "SELECT session_name, outreach_volume_percent, outreach_pace_min, outreach_pace_max, outreach_auto_enabled FROM whatsapp_accounts ORDER BY id"
q "SELECT persona, COUNT(*) FROM outreach_persona_templates GROUP BY 1 ORDER BY 1"
md5sum $B/services/outreachPlanner.js $B/services/adminCommands.js $B/routes/crm.js

echo "rollback: for f in ${!EXPECTED[*]}; do cp -p $BK/\$f $B/\$f; done; rm -f ${NEW[*]/#/$B/}; docker restart 2906_backend; then (optional) psql < $SRC/migrations/20261029_outreach_automation.down.sql"
