#!/usr/bin/env bash
# NEXUS Booking: room reservations (nexus-rooms-v1, 2026-11-21). A new release next to the live one:
# copy of the current release + nexus_rooms_http.py + three anchored lines in server.py. The SQLite table
# room_stays is created on first use (additive). Switch = symlink + service restart; rollback = symlink back.
#   deploy.sh test        unit tests (throwaway SQLite) inside a copy of the live release
#   deploy.sh apply       build release, compile, switch, verify (rolls back by itself on failure)
#   deploy.sh rollback    back to the previous release
#   deploy.sh secret      create NEXUS_ROOMS_SECRET once and share it with ARGUS (/opt/2906-system/.env); prints nothing secret
set -euo pipefail
PKG="$(cd "$(dirname "$0")" && pwd)"; BASE=/opt/nexusbooking; CUR="$(readlink -f "$BASE/current")"
NEW="$BASE/releases/20261121-rooms-v120"; ENVF=/etc/nexus-booking.env; ARGUS_ENV=/opt/2906-system/.env
URL=http://127.0.0.1:4174
die() { echo "error: $*" >&2; exit 1; }
patch_server() {
  python3 - "$1/server.py" <<'PY'
import sys
p = sys.argv[1]; s = open(p, encoding='utf-8').read()
if 'nexus-rooms-v1' in s: print('server.py already patched'); sys.exit(0)
pairs = [
  ("import nexus_place_profiles_http as place_profiles  # nexus-place-profiles-v1\n",
   "import nexus_place_profiles_http as place_profiles  # nexus-place-profiles-v1\nimport nexus_rooms_http as rooms_http  # nexus-rooms-v1\n"),
  ("        if place_profiles.handle(self, 'GET', path):  # nexus-place-profiles-v1\n",
   "        if rooms_http.handle(self, 'GET', path):  # nexus-rooms-v1\n            return\n        if place_profiles.handle(self, 'GET', path):  # nexus-place-profiles-v1\n"),
  ("    def do_POST(self):\n        path = urlparse(self.path).path\n",
   "    def do_POST(self):\n        path = urlparse(self.path).path\n        if rooms_http.handle(self, 'POST', path):  # nexus-rooms-v1\n            return\n"),
]
for a, b in pairs:
    if s.count(a) != 1: print(f'ANCHOR {s.count(a)}x: {a[:60]!r}'); sys.exit(1)
    s = s.replace(a, b)
open(p, 'w', encoding='utf-8').write(s); print('server.py patched')
PY
}
signed_get() {  # signed GET as the website client; prints the HTTP status
  python3 - "$1" <<'PY'
import os, sys, time, urllib.request, urllib.error
sys.path.insert(0, os.environ['REL']); import nexus_rooms_http as R
path = sys.argv[1]; ts = str(int(time.time())); sec = os.environ['NEXUS_ROOMS_SECRET']
req = urllib.request.Request('http://127.0.0.1:4174' + path, headers={'X-Nexus-Rooms-Client': 'web', 'X-Nexus-Rooms-Ts': ts, 'X-Nexus-Rooms-Sig': R.signature(sec, ts, 'GET', path.split('?')[0], b'')})
try: print(urllib.request.urlopen(req, timeout=10).status)
except urllib.error.HTTPError as e: print(e.code)
PY
}
case "${1:-}" in
  test)
    T=/tmp/nexus-rooms-test; rm -rf "$T"; mkdir -p "$T"; cp "$CUR/nexus_booking_db.py" "$PKG/nexus_rooms_http.py" "$PKG/test_nexus_rooms.py" "$T/"
    cd "$T" && NEXUS_BOOKING_DB="$T/unused.sqlite" python3 -m unittest test_nexus_rooms -v 2>&1 | tail -12
    rm -rf "$T"
    ;;
  secret)
    if grep -q '^NEXUS_ROOMS_SECRET=' "$ENVF"; then echo "secret already set in $ENVF"; else
      S="$(openssl rand -hex 32)"; cp -p "$ENVF" "$ENVF.bak.$(date +%Y%m%d%H%M%S)"; printf 'NEXUS_ROOMS_SECRET=%s\n' "$S" >> "$ENVF"; echo "secret added to $ENVF"; fi
    S="$(sed -n 's/^NEXUS_ROOMS_SECRET=//p' "$ENVF" | tail -1)"
    if grep -q '^NEXUS_ROOMS_SECRET=' "$ARGUS_ENV"; then echo "ARGUS already has it"; else
      cp -p "$ARGUS_ENV" "$ARGUS_ENV.bak.$(date +%Y%m%d%H%M%S)"; printf 'NEXUS_ROOMS_SECRET=%s\nNEXUS_BOOKING_ROOMS_URL=https://nexuslink.fit\n' "$S" >> "$ARGUS_ENV"; echo "secret shared with ARGUS ($ARGUS_ENV); recreate the backend container to load it"; fi
    unset S
    ;;
  apply)
    [ "$CUR" != "$NEW" ] || die "already live"
    grep -q '^NEXUS_ROOMS_SECRET=' "$ENVF" || die "run: deploy.sh secret"
    rm -rf "$NEW"; cp -a "$CUR" "$NEW"; cp "$PKG/nexus_rooms_http.py" "$NEW/"; patch_server "$NEW"
    python3 -m py_compile "$NEW/server.py" "$NEW/nexus_rooms_http.py" || die "compile failed"
    echo "$CUR" > "$BASE/.previous-rooms"
    before="$(curl -s -o /dev/null -w '%{http_code}' "$URL/api/nexus-booking/catalogue")"
    ln -sfn "$NEW" "$BASE/current.new" && mv -T "$BASE/current.new" "$BASE/current"
    systemctl restart nexus-booking
    ok=0; for i in $(seq 1 30); do [ "$(curl -s -o /dev/null -w '%{http_code}' "$URL/api/nexus-booking/catalogue")" = "$before" ] && { ok=1; break; }; sleep 1; done
    unsigned="$(curl -s -o /dev/null -w '%{http_code}' "$URL/api/nexus-booking/rooms/availability?property=2906-1")"
    set -a; . "$ENVF"; set +a; signed="$(REL="$NEW" signed_get '/api/nexus-booking/rooms/availability?property=2906-1')"
    echo "catalogue $before → $(curl -s -o /dev/null -w '%{http_code}' "$URL/api/nexus-booking/catalogue"), rooms unsigned $unsigned, signed $signed"
    if [ "$ok" = 1 ] && [ "$unsigned" = 401 ] && [ "$signed" = 200 ]; then echo "APPLIED AND VERIFIED ($NEW, previous $CUR)"; else echo "verification failed: rolling back"; "$0" rollback; exit 1; fi
    ;;
  rollback)
    P="$(cat "$BASE/.previous-rooms")"; [ -d "$P" ] || die "no previous release recorded"
    ln -sfn "$P" "$BASE/current.new" && mv -T "$BASE/current.new" "$BASE/current"; systemctl restart nexus-booking; echo "ROLLED BACK to $P (room_stays table kept)"
    ;;
  *) echo "usage: deploy.sh test|secret|apply|rollback"; exit 2 ;;
esac
