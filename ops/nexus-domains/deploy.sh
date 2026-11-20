#!/usr/bin/env bash
# NEXUS Booking + NEXUS App on their own domains (2026-11-20). Run on the VPS from the package directory.
#   deploy.sh stage     patch a copy of the live release, compile, unit-test valid_origin; no live change
#   deploy.sh app       patch the live release + env (extra origins), restart nexus-booking, verify
#   deploy.sh caddy     add nexusbooking.one + nexusapp.one to the nexuslink.fit site, www -> apex, validate, reload
#   deploy.sh verify    public checks on the new domains
#   deploy.sh rollback  restore release files, env and Caddyfile from the newest backup, restart, reload
# nexuslink.fit keeps working exactly as before throughout.
set -euo pipefail
PKG="$(cd "$(dirname "$0")" && pwd)"
REL="$(readlink -f /opt/nexusbooking/current)"
ENVF=/etc/nexus-booking.env
CADDY=/etc/caddy/Caddyfile
BKROOT=/opt/2906-system/backups
ORIGINS="https://nexusbooking.one,https://nexusapp.one"
code() { curl -s -o /dev/null -m 15 -w '%{http_code}' "$@" || echo 000; }
booking_up() { for i in $(seq 1 30); do [ "$(code http://127.0.0.1:4174/NexusBooking/)" = 200 ] && return 0; sleep 1; done; return 1; }

case "${1:-}" in
  stage)
    rm -rf /tmp/nexus-domains-stage; cp -a "$REL" /tmp/nexus-domains-stage
    python3 "$PKG/patch.py" /tmp/nexus-domains-stage
    python3 -m py_compile /tmp/nexus-domains-stage/nexus_identity.py /tmp/nexus-domains-stage/server.py && echo "compile ok"
    python3 "$PKG/origin_test.py" /tmp/nexus-domains-stage
    rm -rf /tmp/nexus-domains-stage
    ;;
  app)
    python3 "$PKG/patch.py" "$REL" --check
    TS=$(date -u +%Y%m%dT%H%M%SZ); BK="$BKROOT/nexus-domains-$TS"; mkdir -p "$BK"
    cp -p "$REL/nexus_identity.py" "$REL/server.py" "$BK/"; cp -p "$ENVF" "$BK/nexus-booking.env"; cp -p "$CADDY" "$BK/Caddyfile"
    echo "$REL" > "$BK/release"; echo "$BK" > "$BKROOT/nexus-domains-latest"; echo "backup: $BK"
    restore() { echo "ROLLING BACK"; cp -p "$BK/nexus_identity.py" "$BK/server.py" "$REL/"; cp -p "$BK/nexus-booking.env" "$ENVF"; systemctl restart nexus-booking; booking_up && echo "rolled back, booking up" || echo "ROLLBACK: booking not answering"; }
    python3 "$PKG/patch.py" "$REL" || { restore; exit 1; }
    python3 -m py_compile "$REL/nexus_identity.py" "$REL/server.py" || { restore; exit 1; }
    grep -q '^NEXUS_EXTRA_PUBLIC_ORIGINS=' "$ENVF" && sed -i "s#^NEXUS_EXTRA_PUBLIC_ORIGINS=.*#NEXUS_EXTRA_PUBLIC_ORIGINS=$ORIGINS#" "$ENVF" || echo "NEXUS_EXTRA_PUBLIC_ORIGINS=$ORIGINS" >> "$ENVF"
    systemctl restart nexus-booking
    booking_up || { echo "booking did not come up"; restore; exit 1; }
    for u in https://nexuslink.fit/ https://nexuslink.fit/NexusBooking/ https://nexuslink.fit/venues; do c=$(code "$u"); echo "$u $c"; [ "$c" = 200 ] || { restore; exit 1; }; done
    # the auth boundary: nexuslink.fit and the new origins pass the origin check, anything else is refused before any account logic
    t() { curl -s -m 15 -X POST -H 'content-type: application/json' -H "Origin: $1" -d '{"email":"origin-check@invalid.example","password":"x"}' http://127.0.0.1:4174/api/nexus/auth/login | head -c 120; }
    for o in https://nexuslink.fit https://nexusbooking.one https://nexusapp.one https://evil.example; do echo "login origin $o -> $(t "$o")"; done
    [ "$(t https://evil.example | grep -c FORBIDDEN)" = 1 ] || { echo "FAIL: a foreign origin was not refused"; restore; exit 1; }
    [ "$(t https://nexusbooking.one | grep -c FORBIDDEN)" = 0 ] || { echo "FAIL: nexusbooking.one still refused"; restore; exit 1; }
    echo "APP APPLIED AND VERIFIED"
    ;;
  caddy)
    BK=$(cat "$BKROOT/nexus-domains-latest"); [ -f "$BK/Caddyfile" ] || { echo "run app first"; exit 1; }
    grep -q 'nexusbooking.one' "$CADDY" && { echo "REFUSE: Caddyfile already has nexusbooking.one"; exit 1; }
    OLD='nexuslink.fit, www.nexuslink.fit, nexusbooking.178.104.162.193.sslip.io {'
    [ "$(grep -cF "$OLD" "$CADDY")" = 1 ] || { echo "REFUSE: site address line not found once"; exit 1; }
    cp -p "$CADDY" /tmp/Caddyfile.new
    python3 - "$OLD" <<'PY'
import sys
old = sys.argv[1]
p = '/tmp/Caddyfile.new'; s = open(p).read()
s = s.replace(old, 'nexuslink.fit, www.nexuslink.fit, nexusbooking.178.104.162.193.sslip.io, nexusbooking.one, nexusapp.one {', 1)
s = s.rstrip('\n') + '''

# BEGIN NEXUS PRODUCT DOMAINS (2026-11-20): www -> apex. The apex hosts are served by the nexuslink.fit site above.
www.nexusbooking.one {
\tredir https://nexusbooking.one{uri} permanent
}
www.nexusapp.one {
\tredir https://nexusapp.one{uri} permanent
}
# END NEXUS PRODUCT DOMAINS
'''
open(p, 'w').write(s)
PY
    caddy validate --config /tmp/Caddyfile.new --adapter caddyfile >/tmp/caddy-validate.log 2>&1 || { tail -5 /tmp/caddy-validate.log; echo "REFUSE: new Caddyfile does not validate"; exit 1; }
    cp /tmp/Caddyfile.new "$CADDY"
    systemctl reload caddy || { cp -p "$BK/Caddyfile" "$CADDY"; systemctl reload caddy; echo "reload failed, restored"; exit 1; }
    sleep 3
    for u in https://nexuslink.fit/ https://crm.2906.estate/ https://api.2906.estate/api/properties; do c=$(code "$u"); echo "$u $c"; done
    [ "$(code https://nexuslink.fit/)" = 200 ] || { cp -p "$BK/Caddyfile" "$CADDY"; systemctl reload caddy; echo "nexuslink.fit broke, restored"; exit 1; }
    echo "CADDY APPLIED (certificates for the new hosts are issued once DNS points here)"
    ;;
  verify)
    for h in nexusbooking.one nexusapp.one; do
      for p in / /NexusBooking/ /venues /places; do echo "https://$h$p $(code https://$h$p)"; done
      echo "http://$h -> $(curl -s -o /dev/null -m 15 -w '%{http_code} %{redirect_url}' http://$h/)"
      echo "https://www.$h -> $(curl -s -o /dev/null -m 15 -w '%{http_code} %{redirect_url}' https://www.$h/NexusBooking/?x=1)"
      echo "login origin check via https://$h: $(curl -s -m 15 -X POST -H 'content-type: application/json' -H "Origin: https://$h" -d '{"email":"origin-check@invalid.example","password":"x"}' https://$h/api/nexus/auth/login | head -c 120)"
    done
    ;;
  rollback)
    BK=$(cat "$BKROOT/nexus-domains-latest"); REL=$(cat "$BK/release")
    cp -p "$BK/nexus_identity.py" "$BK/server.py" "$REL/"; cp -p "$BK/nexus-booking.env" "$ENVF"; systemctl restart nexus-booking
    cp -p "$BK/Caddyfile" "$CADDY"; systemctl reload caddy
    booking_up && echo "ROLLED BACK (release files, env, Caddyfile)"
    ;;
  *) echo "usage: deploy.sh stage | app | caddy | verify | rollback"; exit 1;;
esac
