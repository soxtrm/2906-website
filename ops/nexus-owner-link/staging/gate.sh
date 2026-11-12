#!/bin/bash
# Run the integration gate on hosted staging (Claude, 2026-11-13).
#   bash gate.sh
# Needs the full stack up (setup.sh --with-nexus). Touches only the compose
# project "argus-nexus-staging"; it records the state of the production
# containers before and after and fails if any of them changed.
set -uo pipefail
cd "$(dirname "$0")"
DC="docker compose --profile nexus --profile gate"
prod_state() { docker ps --filter name=2906_ --format '{{.Names}}' | sort | while read -r n; do echo "$n $(docker inspect -f '{{.State.StartedAt}} {{.Image}}' "$n")"; done; md5sum /opt/2906-system/backend/index.js /etc/caddy/Caddyfile | cut -d' ' -f1; systemctl show caddy -p ActiveEnterTimestamp --value; }
BEFORE=$(prod_state)

echo "== isolation =="
FAIL=0
note() { if [ "$2" = "ok" ]; then echo "PASS  $1"; else echo "FAIL  $1"; FAIL=1; fi; }
[ -z "$($DC exec -T nexus sh -c 'echo "$NEXUS_HOUSING_ARGUS_READ_DSN"')" ] && note "NEXUS has no ARGUS database login configured" ok || note "NEXUS has no ARGUS database login configured" no
[ "$($DC exec -T nexus sh -c 'echo "${NEXUS_HOUSING_LEGACY_LOCAL_READS:-0}"')" = "0" ] && note "NEXUS legacy local reads are off" ok || note "NEXUS legacy local reads are off" no
NETS=$(docker inspect argus-nexus-staging-nexus-1 --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}')
case "$NETS" in *argus_db*) note "NEXUS is not on the ARGUS database network ($NETS)" no ;; *) note "NEXUS is not on the ARGUS database network" ok ;; esac
$DC exec -T nexus python -c "import socket,sys
try:
    socket.create_connection(('argus_pg',5432),timeout=3); sys.exit(1)
except Exception: sys.exit(0)" && note "NEXUS cannot open a connection to the ARGUS database" ok || note "NEXUS cannot open a connection to the ARGUS database" no
NETS=$(docker inspect argus-nexus-staging-argus-1 --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}')
case "$NETS" in *2906*|*nexus_db*) note "ARGUS staging is on no production or NEXUS database network ($NETS)" no ;; *) note "ARGUS staging is on no production or NEXUS database network" ok ;; esac
[ "$($DC exec -T argus sh -c 'env | grep -ciE "waha|redis|telegram|stripe|smtp|openai|twilio" || true')" = "0" ] && note "ARGUS staging holds no messaging, queue or payment configuration" ok || note "ARGUS staging holds no messaging, queue or payment configuration" no
[ "$($DC exec -T nexus sh -c 'env | grep -ciE "stripe|smtp|twilio|waha|sendgrid" || true')" = "0" ] && note "NEXUS staging holds no payment or messaging configuration" ok || note "NEXUS staging holds no payment or messaging configuration" no
PUB=$(docker ps --filter label=com.docker.compose.project=argus-nexus-staging --format '{{.Ports}}' | tr ',' '\n' | grep -- '->' | grep -v '^ *127\.0\.0\.1:' | wc -l)
[ "$PUB" = "0" ] && note "staging publishes no port beyond the VPS loopback" ok || note "staging publishes no port beyond the VPS loopback" no

echo "== professional test accounts (synthetic) =="
mkdir -p gate-control && rm -f gate-control/request gate-control/done gate-control/result.json
RUN=$(openssl rand -hex 3)
ADMIN_ID=$($DC exec -T argus_pg psql -U argus_stg -d argus_staging -At -c "SELECT id FROM agents WHERE username='stg_admin'")
mkacct() { $DC exec -T -e E="$1" -e P="$2" nexus python -c "import os,sys; sys.path.insert(0,'/srv/nexus'); os.chdir('/srv/nexus'); import nexus_identity as i; i.ensure_identity(); print(i.create_account(os.environ['E'],'Gate Professional',os.environ['P']))"; }
psqln() { $DC exec -T nexus_pg psql -U nexus_stg -d nexus_staging -At -v ON_ERROR_STOP=1 "$@"; }
psqln -q -c "INSERT INTO public.nexus_organizations (slug,name) VALUES ('stg-agency-a','Staging Agency A'),('stg-agency-b','Staging Agency B') ON CONFLICT (slug) DO NOTHING" >/dev/null
J="{"
for spec in "own:2906-estate:2906:agency_manager:$ADMIN_ID" "agencyA:stg-agency-a:stg-agency-a:agent:" "agencyB:stg-agency-b:stg-agency-b:agent:"; do
  IFS=: read -r name slug key role agent <<< "$spec"
  email="gate-$name-$RUN@example.org"; pass="Gate-$(openssl rand -hex 9)!"
  acct=$(mkacct "$email" "$pass" | tr -d '\r')
  psqln -q -c "INSERT INTO nexus_private.housing_professionals (account_id, agency_id, agency_key, role, category, argus_agent_id, verified_at) SELECT '$acct', id, '$key', '$role', 'agency', NULLIF('$agent','')::int, now() FROM public.nexus_organizations WHERE slug='$slug'" >/dev/null
  J="$J\"$name\":{\"email\":\"$email\",\"password\":\"$pass\",\"agencyKey\":\"$key\"},"
done
echo "${J%,}}" > gate-control/professionals.json
chown -R 1000:1000 gate-control && chmod 700 gate-control
echo "3 verified professional memberships provisioned (own agency, agency A, agency B)"

# Control loop: the runner may ask for exactly these four actions, nothing else.
( while [ ! -f gate-control/stop ]; do
    if [ -f gate-control/request ]; then
      read -r id cmd < gate-control/request; rm -f gate-control/request
      case "$cmd" in "stop nexus"|"start nexus"|"stop argus"|"start argus") $DC ${cmd% *} ${cmd#* } >/dev/null 2>&1 ;; esac
      echo "$id" > gate-control/done; chown 1000:1000 gate-control/done
    fi; sleep 0.3
  done ) &
LOOP=$!
echo "== gate =="
$DC run --rm -T gate; RC=$?
touch gate-control/stop; wait $LOOP 2>/dev/null; rm -f gate-control/stop gate-control/professionals.json

echo "== production untouched =="
AFTER=$(prod_state)
if [ "$BEFORE" = "$AFTER" ]; then echo "PASS  production containers, backend code, proxy config and proxy start time are unchanged"; else echo "FAIL  production state changed during the run"; FAIL=1; fi
echo "== pinned =="; cat pins.env | grep COMMIT
$DC ps --format 'table {{.Service}}\t{{.Status}}'
[ "$RC" = "0" ] && [ "$FAIL" = "0" ] && echo "GATE RUN: PASS" || { echo "GATE RUN: FAIL (driver exit $RC, environment checks failed: $FAIL)"; exit 1; }
