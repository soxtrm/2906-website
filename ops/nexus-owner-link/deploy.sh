#!/bin/bash
# ARGUS × NEXUS owner link — backend deploy (Claude, 2026-11-11).
# NOT RUN. Needs Kev's explicit OK. Same guarded VPS procedure as the other
# ops/*/deploy.sh scripts: exact-base md5 check, backup, additive migration,
# copy, syntax check, restart, unauthenticated probes, printed rollback.
# Usage on the VPS after copying ops/nexus-owner-link to /tmp/nol-deploy:
#   bash /tmp/nol-deploy/deploy.sh
#
# This deploy does not enable any NEXUS traffic: with NEXUS_LINK_INBOUND_SECRET
# and NEXUS_OWNER_LINK_URL unset the service surface answers 503 and nothing is
# sent outbound. It adds no cron job and sends no message to anyone.
# Delayed releases therefore only fire when an admin calls
# POST /api/crm/owner-nexus/routes/process-due; a cron tick is a separate, later change.
set -euo pipefail
B=/opt/2906-system/backend
SRC=/tmp/nol-deploy/backend
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BK=/opt/2906-system/backups/nexus-owner-link-$STAMP
q() { docker exec -e SQL="$1" 2906_postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "$SQL"'; }
NEW="services/nexusOwnerLink.js services/nexusLinkCrypto.js services/availabilityFreshness.js services/nexusDistributionRouting.js routes/crmOwnerNexus.js routes/nexusLinkService.js"

# 1. Production index.js must be exactly the base this release was built on
#    (Property Source Sync, live since 2026-11-09). If another release changed
#    it since, stop and rebuild the two mount lines on the new base.
A=$(md5sum "$B/index.js" | cut -d' ' -f1)
[ "$A" = "bc53d5881c943d8ce2eb06744d1a5d54" ] || { echo "ABORT: production index.js is $A, expected bc53d5881c943d8ce2eb06744d1a5d54"; exit 1; }
for f in $NEW; do [ ! -e "$B/$f" ] || { echo "ABORT: $f already exists in production"; exit 1; }; done
[ -e "$B/services/boardAction.js" ] || { echo "ABORT: services/boardAction.js missing"; exit 1; }
[ "$(q "SELECT to_regclass('nexus_owner_links') IS NULL")" = "t" ] || { echo "ABORT: nexus_owner_links already exists"; exit 1; }

# 2. Backup. The migration creates tables only, so the one replaced file is enough;
#    row counts of the tables the feature reads are recorded for the after-check.
mkdir -p "$BK"
cp -p "$B/index.js" "$BK/"
COUNTS="SELECT (SELECT COUNT(*) FROM properties)||'/'||(SELECT COUNT(*) FROM owner_contacts)||'/'||(SELECT COUNT(*) FROM swipe_links)"
q "$COUNTS" > "$BK/counts.txt"
echo "backup: $BK (properties/owner_contacts/swipe_links = $(cat "$BK/counts.txt"))"

# 3. Additive migration (single transaction, stops on first error).
for m in 20261111_nexus_owner_link.sql 20261111b_nexus_distribution_routes.sql; do
  docker exec -i 2906_postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q' < "$SRC/migrations/$m"
done
[ "$(q "$COUNTS")" = "$(cat "$BK/counts.txt")" ] || { echo "ABORT: existing row counts changed"; exit 1; }

# 4. Code.
for f in $NEW index.js; do cp "$SRC/$f" "$B/$f"; done
for f in $NEW index.js; do docker exec 2906_backend node --check "/app/$f"; done
docker restart 2906_backend >/dev/null
for i in $(seq 1 45); do docker logs 2906_backend --since 120s 2>&1 | grep -q "HTTP server listening" && break; sleep 2; done
docker logs 2906_backend --since 120s 2>&1 | grep -E "HTTP server listening|Fatal|Cannot find module" | head -5

# 5. Probes: staff surface closed without a session, service surface closed without a secret,
#    public inventory still answering.
C1=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3001/api/crm/owner-nexus/1)
C2=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:3001/api/nexus-link/v1/events)
C3=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3001/api/nexus/inventory)
echo "unauthenticated /api/crm/owner-nexus/1 -> $C1 (expected 401)"
echo "unsigned /api/nexus-link/v1/events -> $C2 (expected 503 while no secret is set, else 401)"
echo "public /api/nexus/inventory -> $C3 (expected 200, unchanged)"
{ [ "$C1" = "401" ] && { [ "$C2" = "503" ] || [ "$C2" = "401" ]; } && [ "$C3" = "200" ]; } || echo "WARNING: unexpected status; consider rollback"
echo "rollback: cp -p $BK/index.js $B/ && (cd $B && rm -f $NEW) && docker restart 2906_backend && docker exec -i 2906_postgres sh -c 'psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -v ON_ERROR_STOP=1' < $SRC/migrations/20261111b_nexus_distribution_routes.down.sql && docker exec -i 2906_postgres sh -c 'psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -v ON_ERROR_STOP=1' < $SRC/migrations/20261111_nexus_owner_link.down.sql"
