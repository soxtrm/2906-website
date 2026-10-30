#!/bin/bash
# Deploy the owner-intelligence repair (2026-10-30). NOT run automatically —
# needs the operator's explicit OK in chat (AGENTS.md).
# Usage (on the VPS, mirror copied to /tmp/owner-intelligence/backend/):
#   bash /tmp/owner-intelligence/deploy.sh
# Order matters: the board listing query reads property_location_requests, so
# both migrations run BEFORE the new code is copied and the backend restarts.
set -euo pipefail
B=/opt/2906-system/backend
SRC=/tmp/owner-intelligence/backend
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BK=/opt/2906-system/backups/owner-intelligence-$STAMP
q() { docker exec -e SQL="$1" 2906_postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "$SQL"'; }

# 1. Production must still be the snapshot this change is based on.
declare -A EXPECTED=(
  [waha.js]=a52a8861d95136d3c4701a0fd6b2e5a3
  [routes/webhook.js]=9588c2fc74fbfe02661f4d40e2f22202
  [routes/crmScheduleBoard.js]=bc0a1459a648b093d6cb691f02320e83
  [services/agentIdentityRegistry.js]=5a1b64afc1020ad1f6ab493e7120fcf9
  [services/autoOwnerConversation.js]=0134df180530a9b92aae30663ed504d7
  [services/availability.js]=22f2dbb339e779e3ba577225aff87343
  [services/conversationIntelligence.js]=00f842df9d7d78518a18ef66f71299c6
  [services/conversationPolicy.js]=0a6d683a43c892fec978bec7758aa605
  [services/ownerSendGate.js]=a659363c06b5c86c06b819d10a8f03f5
  [services/reminderDetector.js]=1b1774c8c4170412c130f7b133474593
  [services/reminderFromMessage.js]=2510673b413ea565358fda8b6e88e6ee
)
for f in "${!EXPECTED[@]}"; do
  A=$(md5sum $B/$f | cut -d' ' -f1)
  [ "$A" = "${EXPECTED[$f]}" ] || { echo "ABORT: production $f changed ($A) — rebase first"; exit 1; }
done
NEW=(services/timeGreeting.js services/locationRequest.js)
for f in "${NEW[@]}"; do [ ! -e $B/$f ] || { echo "ABORT: $f already exists in production"; exit 1; }; done
# timeGreeting needs the outreach automation's central time module.
[ -e $B/services/outreachSchedule.js ] || { echo "ABORT: services/outreachSchedule.js missing (deploy outreach automation first)"; exit 1; }

# 2. Never interrupt a send in progress.
RUNNING=$(q "SELECT (SELECT count(*) FROM outreach_batches WHERE status = 'running' AND updated_at > NOW() - INTERVAL '2 hours') + (SELECT count(*) FROM outreach_runs WHERE status IN ('claimed','running'))")
[ "$RUNNING" = "0" ] || { echo "ABORT: $RUNNING outreach batch/run(s) active — deploy after they finish"; exit 1; }

# 3. Backup.
mkdir -p $BK/services $BK/routes
for f in "${!EXPECTED[@]}"; do cp -p $B/$f $BK/$f; done
docker exec 2906_postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t reminders --schema-only' > $BK/reminders_schema.sql
echo "backup: $BK"

# 4. Migrations (each one transaction, idempotent), then code.
for m in 20261030_location_requests.sql 20261030_reminder_context.sql; do
  docker exec -i 2906_postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q' < $SRC/migrations/$m
done
for f in "${!EXPECTED[@]}" "${NEW[@]}"; do cp $SRC/$f $B/$f; done
for f in "${!EXPECTED[@]}" "${NEW[@]}"; do
  [ "$(md5sum < $B/$f | cut -d' ' -f1)" = "$(md5sum < $SRC/$f | cut -d' ' -f1)" ] || { echo "ABORT: copy mismatch $f"; exit 1; }
  docker exec 2906_backend node --check $f
done
docker restart 2906_backend
for i in $(seq 1 30); do docker logs 2906_backend --since 60s 2>&1 | grep -q "HTTP server listening" && break; sleep 2; done
docker logs 2906_backend --since 90s 2>&1 | grep -E "HTTP server listening|ERROR" | grep -v Classifier | head -5
q "SELECT COUNT(*) FROM property_location_requests"
md5sum $B/waha.js $B/routes/crmScheduleBoard.js $B/services/locationRequest.js

echo "rollback: for f in ${!EXPECTED[*]}; do cp -p $BK/\$f $B/\$f; done; rm -f ${NEW[*]/#/$B/}; docker restart 2906_backend; then (optional) psql < $SRC/migrations/20261030_reminder_context.down.sql and 20261030_location_requests.down.sql"
