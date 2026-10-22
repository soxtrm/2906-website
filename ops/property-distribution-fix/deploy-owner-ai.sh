#!/bin/bash
# ARGUS owner-AI + permissions repair (2026-10-22). NOT run automatically —
# needs Kev's explicit go. One restart, md5 guard per file, NEW files must not
# exist yet, one backup folder, syntax check, container tests after restart.
# Usage (on the VPS, files copied to /tmp/property-distribution-fix/ first):
#   bash /tmp/property-distribution-fix/deploy-owner-ai.sh
set -euo pipefail
B=/opt/2906-system/backend
SRC=/tmp/property-distribution-fix
BK=/opt/2906-system/backups/owner-ai-repair-$(date -u +%Y%m%dT%H%M%SZ)

# relpath=expected production md5 (snapshot 2026-10-22) | NEW
FILES=(
  services/autoOwnerConversation.js=f2c8cac8a042f85592538cca8c2dc7de
  services/agentIdentityRegistry.js=9baa304764fb3f801946ac0845c67a71
  services/conversationPolicy.js=da55a63956d8e2a900fee42261dd9d77
  services/canonical2906Renderer.js=b3f184870720dc51cd0f713c5ccefcd6
  waha.js=0e892e9c97aa5012307891d00f346c04
  handlers/upload.js=eafeb4cc071673bf4f0c80f4d898b446
  services/sessionAlertState.js=NEW
  services/agentPermissions.js=NEW
  test/ownerAi.repair.test.js=NEW
  test/sessionAlert.episodes.test.js=NEW
  test/agentPermissions.commands.test.js=NEW
)

for pair in "${FILES[@]}"; do
  F=${pair%%=*}; E=${pair##*=}
  if [ "$E" = "NEW" ]; then
    [ ! -e "$B/$F" ] || { echo "ABORT: $F already exists in production"; exit 1; }
  else
    A=$(md5sum "$B/$F" | cut -d' ' -f1)
    [ "$A" = "$E" ] || { echo "ABORT: production $F changed ($A) — rebase first"; exit 1; }
  fi
done
if docker logs 2906_backend --since 3m 2>&1 | grep -qE "categoryPublisher|upload: (category|fb campaign)"; then echo "ABORT: a distribution ran in the last 3 min"; exit 1; fi
SQL="SELECT (SELECT count(*) FROM outreach_batches WHERE status = 'running') + (SELECT count(*) FROM outreach_runs WHERE status IN ('claimed','running'))"
RUNNING=$(docker exec -e SQL="$SQL" 2906_postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "$SQL"')
[ "$RUNNING" = "0" ] || { echo "ABORT: $RUNNING outreach batch/run(s) active"; exit 1; }

mkdir -p "$BK"
: > "$BK/NEW_FILES"
for pair in "${FILES[@]}"; do
  F=${pair%%=*}; E=${pair##*=}
  sed -i -e 's/\r$//' "$SRC/$F"
  if [ "$E" = "NEW" ]; then echo "$F" >> "$BK/NEW_FILES"; else mkdir -p "$BK/$(dirname "$F")"; cp -p "$B/$F" "$BK/$F"; fi
done
echo "backup: $BK"

rollback() {
  for pair in "${FILES[@]}"; do F=${pair%%=*}; E=${pair##*=}; if [ "$E" = "NEW" ]; then rm -f "$B/$F"; else cp -p "$BK/$F" "$B/$F"; fi; done
}
for pair in "${FILES[@]}"; do F=${pair%%=*}; mkdir -p "$B/$(dirname "$F")"; cp "$SRC/$F" "$B/$F"; done
for pair in "${FILES[@]}"; do
  F=${pair%%=*}
  docker exec 2906_backend node --check "/app/$F" || { rollback; echo "ABORT: syntax $F, all restored"; exit 1; }
done
for pair in "${FILES[@]}"; do F=${pair%%=*}; md5sum "$B/$F"; done

docker restart 2906_backend >/dev/null
for i in $(seq 1 30); do docker logs 2906_backend --since 60s 2>&1 | grep -q "HTTP server listening" && break; sleep 2; done
docker logs 2906_backend --since 90s 2>&1 | grep -E "HTTP server listening" | head -1

echo "--- container tests (real modules, external I/O stubbed)"
for T in test/ownerAi.repair.test.js test/sessionAlert.episodes.test.js test/agentPermissions.commands.test.js test/owner-context-firewall-20260926.test.js; do
  echo "== $T"; docker exec 2906_backend node "/app/$T" 2>&1 | tail -3 || true
done
echo "rollback: (cd $BK && find . -type f ! -name NEW_FILES -exec cp -p {} $B/{} \;) && xargs -a $BK/NEW_FILES -I{} rm -f $B/{} && docker restart 2906_backend"
