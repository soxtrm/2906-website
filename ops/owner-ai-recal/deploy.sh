#!/bin/bash
# ARGUS Owner AI recalibration — guarded backend deploy (Claude, 2026-11-10).
# Runs AFTER the Outreach P0 release (crm.js/cron.js baselines are the P0 files).
# Established VPS procedure: copy into /opt/2906-system/backend (bind-mounted at
# /app), additive migration, restart 2906_backend. Sends nothing, enables
# nothing, approves no template, changes no Auto/pace setting.
#   bash /tmp/owner-ai-recal-deploy/deploy.sh
set -euo pipefail
B=/opt/2906-system/backend
SRC=/tmp/owner-ai-recal-deploy/backend
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BK=/opt/2906-system/backups/owner-ai-recal-$STAMP
q() { docker exec -e SQL="$1" 2906_postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "$SQL"'; }
FILES="services/autoOwnerConversation.js services/agentIdentityRegistry.js routes/crm.js cron.js"
NEW="services/ownerDecision.js services/ownerDecisionRuntime.js services/ownerQualityReport.js services/ownerTurnRouter.js services/timeGreeting.js"
# timeGreeting.js: required by availability.js since the 14:20 UTC deploy but never installed (Cannot find module)

# 1. Production must be exactly the base this release was built and tested on.
declare -A EXPECTED=(
  [services/autoOwnerConversation.js]=0134df180530a9b92aae30663ed504d7
  [services/agentIdentityRegistry.js]=5a1b64afc1020ad1f6ab493e7120fcf9
  [routes/crm.js]=d2ea21a68dc7d87c41fa6885ca0b0694
  [cron.js]=7fa1080e52a96d34ac973fdc9cc339cd
  # read, not replaced — must be the versions the tests ran with
  [services/conversationPolicy.js]=8a89f714286e07bf606244435c97f91f
  [services/conversationIntelligence.js]=cfc4803161433f4d016cc8404ca1d6aa
  [services/ownerSendGate.js]=a659363c06b5c86c06b819d10a8f03f5
  [services/ownerOptOut.js]=de962cf9c5ef860647f9da79d276c3e4
)
for f in "${!EXPECTED[@]}"; do
  A=$(md5sum "$B/$f" | cut -d' ' -f1); [ "$A" = "${EXPECTED[$f]}" ] || { echo "ABORT: production $f is $A, expected ${EXPECTED[$f]}"; exit 1; }
done
for f in $NEW; do [ ! -e "$B/$f" ] || { echo "ABORT: $f already exists"; exit 1; }; done
[ -e "$B/services/outreachAutomation.js" ] || { echo "ABORT: Outreach P0 must be deployed first"; exit 1; }

# 2. Never interrupt a send in progress (run 50 is a stale October claim).
ACTIVE=$(q "SELECT (SELECT count(*) FROM outreach_runs WHERE status IN ('claimed','running') AND id <> 50) + (SELECT count(*) FROM outreach_plan_entries WHERE send_status='sending')")
[ "$ACTIVE" = "0" ] || { echo "ABORT: $ACTIVE active outreach send(s); deploy after they finish"; exit 1; }

# 3. Backup + settings snapshot.
mkdir -p "$BK/services" "$BK/routes"
for f in $FILES; do cp -p "$B/$f" "$BK/$f"; done
cp "$SRC"/migrations/20261110_owner_ai_recal*.sql "$BK/"
SNAP="SELECT string_agg(id||':'||COALESCE(outreach_auto_enabled::text,'')||':'||COALESCE(outreach_enabled::text,'')||':'||COALESCE(outreach_daily_target_min::text,'')||'-'||COALESCE(outreach_daily_target_max::text,''), ',' ORDER BY id) FROM whatsapp_accounts"
q "$SNAP" > "$BK/accounts_before.txt"
q "SELECT persona||'/'||slot||'/'||period FROM outreach_persona_templates WHERE active AND status='approved' ORDER BY 1" > "$BK/live_templates_before.txt"
q "SELECT count(*) FROM owner_auto_conversations WHERE status='active_collecting'" > "$BK/active_conversations_before.txt"
echo "backup: $BK"

# 4. Migration (single transaction, additive).
docker exec -i 2906_postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q' < "$SRC/migrations/20261110_owner_ai_recal.sql"
[ "$(q "$SNAP")" = "$(cat "$BK/accounts_before.txt")" ] || { echo "ABORT: account settings changed by migration"; exit 1; }

# 5. Code, syntax check, restart.
for f in $FILES $NEW; do cp "$SRC/$f" "$B/$f"; done
for f in $FILES $NEW; do docker exec 2906_backend node --check "/app/$f"; done
docker restart 2906_backend >/dev/null
for i in $(seq 1 45); do docker logs 2906_backend --since 120s 2>&1 | grep -q "HTTP server listening" && break; sleep 2; done
docker logs 2906_backend --since 120s 2>&1 | grep -E "HTTP server listening|Fatal|Cannot find module|SyntaxError" | head -5

# 6. Record the regression results this release was verified with.
if [ -s /tmp/owner-ai-recal-deploy/regression.sql ]; then
  HASH=$(cat "$B/services/ownerDecision.js" "$B/services/ownerDecisionRuntime.js" "$B/services/ownerTurnRouter.js" | sha256sum | cut -c1-16)
  sed "s/__HASH__/$HASH/" /tmp/owner-ai-recal-deploy/regression.sql | docker exec -i 2906_postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q'
  echo "regression run recorded (code $HASH)"
fi

# 7. Verify: settings untouched, modules load, facts engine import repaired, routes guarded.
[ "$(q "$SNAP")" = "$(cat "$BK/accounts_before.txt")" ] || echo "WARNING: account settings differ after restart"
q "SELECT persona||'/'||slot||'/'||period FROM outreach_persona_templates WHERE active AND status='approved' ORDER BY 1" > "$BK/live_templates_after.txt"
diff -q "$BK/live_templates_before.txt" "$BK/live_templates_after.txt" && echo "live templates unchanged"
docker exec 2906_backend node -e "
const d=require('/app/services/ownerDecision');const p=require('/app/services/conversationPolicy');
const r=d.decide({messages:['Valletta studio, 1100e.'],context:{now:new Date('2026-11-10T10:00:00Z'),identity:{persona:'kev',name:'Kevin',agency:'2906 Estate',affiliationVerified:true}}});
const i=p.interpretInbound({text:'what is your email?',context:{}});
console.log('decision smoke:',r.next_action,r.reason_code,'| policy import ok:',Array.isArray(i.questions));
require('/app/services/ownerQualityReport');require('/app/services/autoOwnerConversation');console.log('modules load ok')"
echo "floor_level column: $(q "SELECT count(*) FROM information_schema.columns WHERE table_name='properties' AND column_name='floor_level'")"
echo "weekly schedule: $(q "SELECT next_run_at FROM owner_ai_quality_schedule WHERE id='weekly_owner_ai'")"
echo "unauthenticated quality route -> $(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3001/api/crm/owner-quality/reports) (expected 401)"
echo "rollback: for f in $FILES; do cp -p $BK/\$f $B/\$f; done; rm -f $(for f in $NEW; do printf '%s ' "$B/$f"; done); docker restart 2906_backend; then psql < $BK/20261110_owner_ai_recal.down.sql"
