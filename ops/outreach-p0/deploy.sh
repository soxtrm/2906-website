#!/bin/bash
# ARGUS Outreach P0 backend deploy (Claude, 2026-11-10).
# Established VPS procedure: copy into /opt/2906-system/backend (bind-mounted
# at /app), additive migrations, restart 2906_backend. Guards: exact production
# baseline, no active send, Auto flags/targets snapshot before == after.
#   bash /tmp/outreach-p0-deploy/deploy.sh
set -euo pipefail
B=/opt/2906-system/backend
SRC=/tmp/outreach-p0-deploy/backend
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BK=/opt/2906-system/backups/outreach-p0-$STAMP
q() { docker exec -e SQL="$1" 2906_postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "$SQL"'; }
FILES="services/outreachPlanner.js services/outreachTemplates.js services/outreachQuota.js routes/crm.js cron.js"
NEW="services/outreachAutomation.js services/outreachStatus.js"

# 1. Production must be exactly the base this release was built on.
declare -A EXPECTED=( [services/outreachPlanner.js]=8ab96c4dafcb0d841a4956ab1681703c [services/outreachTemplates.js]=5c09dcc678b51afd6e142d1c9b5c80d3
  [services/outreachQuota.js]=ce9161a12f8509df0f96ce9ed903c43d [services/outreachSchedule.js]=33e297c56bf8728783cf5efbc2bdeb10
  [routes/crm.js]=dcd5f9d62580c6c86560d01ae58d5df2 [cron.js]=e4273168403f28f812bada4e5119769c )
for f in "${!EXPECTED[@]}"; do
  A=$(md5sum "$B/$f" | cut -d' ' -f1); [ "$A" = "${EXPECTED[$f]}" ] || { echo "ABORT: production $f is $A, expected ${EXPECTED[$f]}"; exit 1; }
done
for f in $NEW; do [ ! -e "$B/$f" ] || { echo "ABORT: $f already exists"; exit 1; }; done
[ "$(q "SELECT to_regclass('outreach_template_usage') IS NOT NULL")" = "t" ] || { echo "ABORT: 20261029 outreach migration missing"; exit 1; }

# 2. Never interrupt a send in progress (run 50 is a stale October claim).
ACTIVE=$(q "SELECT (SELECT count(*) FROM outreach_runs WHERE status IN ('claimed','running') AND id <> 50) + (SELECT count(*) FROM outreach_plan_entries WHERE send_status='sending')")
[ "$ACTIVE" = "0" ] || { echo "ABORT: $ACTIVE active outreach send(s); deploy after they finish"; exit 1; }

# 3. Backup + snapshot of every account's Auto/target/pace settings.
mkdir -p "$BK/services" "$BK/routes"
for f in $FILES; do cp -p "$B/$f" "$BK/$f"; done
docker exec 2906_postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t outreach_persona_templates -t whatsapp_accounts -t outreach_plans' > "$BK/outreach_tables.sql"
[ -s "$BK/outreach_tables.sql" ] || { echo "ABORT: empty backup"; exit 1; }
SNAP="SELECT string_agg(id||':'||COALESCE(outreach_auto_enabled::text,'')||':'||COALESCE(outreach_enabled::text,'')||':'||COALESCE(outreach_daily_target_min::text,'')||'-'||COALESCE(outreach_daily_target_max::text,'')||':'||COALESCE(outreach_pace_min::text,'')||'-'||COALESCE(outreach_pace_max::text,''), ',' ORDER BY id) FROM whatsapp_accounts"
q "$SNAP" > "$BK/accounts_before.txt"
# Before planner_v2 there is no status column: every active row is live.
if [ "$(q "SELECT count(*) FROM information_schema.columns WHERE table_name='outreach_persona_templates' AND column_name='status'")" = "1" ]; then
  q "SELECT persona||'/'||slot||'/'||period FROM outreach_persona_templates WHERE active AND status='approved' ORDER BY 1" > "$BK/live_templates_before.txt"
else
  q "SELECT persona||'/'||slot||'/'||period FROM outreach_persona_templates WHERE active ORDER BY 1" > "$BK/live_templates_before.txt"
fi
cp "$SRC"/migrations/20261109_outreach_planner_v2*.sql "$SRC"/migrations/20261110_outreach_p0*.sql "$BK/"
echo "backup: $BK"

# 4. Migrations (each in one transaction, stop on error).
docker exec -i 2906_postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q' < "$SRC/migrations/20261109_outreach_planner_v2.sql"
docker exec -i 2906_postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q' < "$SRC/migrations/20261110_outreach_p0.sql"
[ "$(q "$SNAP")" = "$(cat "$BK/accounts_before.txt")" ] || { echo "ABORT: account settings changed by migration"; exit 1; }

# 5. Code, syntax check, restart.
for f in $FILES $NEW; do cp "$SRC/$f" "$B/$f"; done
for f in $FILES $NEW; do docker exec 2906_backend node --check "/app/$f"; done
docker restart 2906_backend >/dev/null
for i in $(seq 1 45); do docker logs 2906_backend --since 120s 2>&1 | grep -q "HTTP server listening" && break; sleep 2; done
docker logs 2906_backend --since 120s 2>&1 | grep -E "HTTP server listening|Fatal|Cannot find module" | head -5

# 6. Verify: nothing enabled, Auto flags untouched, live rotation untouched except the rejected wording.
[ "$(q "$SNAP")" = "$(cat "$BK/accounts_before.txt")" ] || { echo "WARNING: account settings differ after restart"; }
echo "V2 configs enabled: $(q "SELECT count(*) FROM outreach_automation_configs WHERE enabled")  paused: $(q "SELECT count(*) FROM outreach_automation_configs WHERE manual_paused_at IS NOT NULL")"
echo "draft introductions: $(q "SELECT count(*) FROM outreach_persona_templates WHERE status='draft'")"
q "SELECT persona||'/'||slot||'/'||period FROM outreach_persona_templates WHERE active AND status='approved' ORDER BY 1" > "$BK/live_templates_after.txt"
echo "live template rows before/after: $(wc -l < "$BK/live_templates_before.txt")/$(wc -l < "$BK/live_templates_after.txt")"
diff "$BK/live_templates_before.txt" "$BK/live_templates_after.txt" || true
echo "unauthenticated pace route -> $(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3001/api/crm/outreach/pace/1) (expected 401)"
echo "rollback: for f in $FILES; do cp -p $BK/\$f $B/\$f; done; rm -f $B/services/outreachAutomation.js $B/services/outreachStatus.js; docker restart 2906_backend; then psql < $BK/20261110_outreach_p0.down.sql and $BK/20261109_outreach_planner_v2.down.sql"
