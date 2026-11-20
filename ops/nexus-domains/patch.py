#!/usr/bin/env python3
"""NEXUS Booking on more than one domain (2026-11-20). Usage: patch.py <release dir> [--check]

nexus_identity.valid_origin accepted exactly one origin (NEXUS_PUBLIC_ORIGIN). Logins, bookings and other
protected actions from nexusbooking.one / nexusapp.one would be refused. Now NEXUS_EXTRA_PUBLIC_ORIGINS
(comma-separated, https only, exact match) is accepted too. NEXUS_PUBLIC_ORIGIN behaves exactly as before.
server.py: the friendly 404 page also on the new hosts. Exact anchors; nothing written on a miss."""
import sys, os
root = sys.argv[1]; check = '--check' in sys.argv
EDITS = {
  'nexus_identity.py': [(
"""    return bool(configured and configured.startswith('https://') and origin == configured)
""",
"""    if configured and configured.startswith('https://') and origin == configured:
        return True
    # 2026-11-20: the same app answers on more domains (nexusbooking.one, nexusapp.one). Exact https origins
    # only; the CSRF token is still required where it was. Sessions stay per domain (host-only cookie).
    extra = {o.strip().rstrip('/') for o in os.getenv('NEXUS_EXTRA_PUBLIC_ORIGINS', '').split(',') if o.strip().startswith('https://')}
    return bool(origin) and origin.rstrip('/') == origin and origin in extra
""")],
  'server.py': [(
"""host in ('nexuslink.fit','www.nexuslink.fit')) and not path.startswith('/api/'):""",
"""host in ('nexuslink.fit','www.nexuslink.fit','nexusbooking.one','www.nexusbooking.one','nexusapp.one','www.nexusapp.one')) and not path.startswith('/api/'):""")],
}
out = {}
for rel, edits in EDITS.items():
    s = open(os.path.join(root, rel), encoding='utf-8', newline='').read()
    if 'NEXUS_EXTRA_PUBLIC_ORIGINS' in s or 'nexusbooking.one' in s: print('REFUSE: %s already patched' % rel); sys.exit(1)
    eol = '\r\n' if '\r\n' in s else '\n'
    for a, b in edits:
        a, b = a.replace('\n', eol), b.replace('\n', eol)
        if s.count(a) != 1: print('REFUSE: %s anchor found %dx' % (rel, s.count(a))); sys.exit(1)
        s = s.replace(a, b)
    out[rel] = s
if check: print('check ok'); sys.exit(0)
for rel, s in out.items(): open(os.path.join(root, rel), 'w', encoding='utf-8', newline='').write(s)
print('patched: ' + ', '.join(sorted(out)))
