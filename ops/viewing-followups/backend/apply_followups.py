#!/usr/bin/env python3
"""Viewing request follow-up (2026-11-21): mount /api/crm/viewing-followups before the /api/crm catch-all.
New files are copied by deploy.sh. One anchor edit, line endings kept.
  apply_followups.py <backend_dir> [--check]
"""
import sys, os
ANCHOR = 'app.use("/api/crm/sync-inbox", require("./routes/crmSyncInbox"))'
ADD = ('\n// Viewing request follow-up (Claude, 2026-11-21): tracking, agent question the day after, logged owner contact.\n'
       'app.use("/api/crm/viewing-followups", require("./routes/crmViewingFollowups"))')
def main():
    root = sys.argv[1]; check = '--check' in sys.argv[2:]
    path = os.path.join(root, 'index.js')
    raw = open(path, 'rb').read(); crlf = b'\r\n' in raw; s = raw.decode('utf-8')
    if 'routes/crmViewingFollowups' in s: print('REFUSE index.js: already applied'); return 1
    n = s.count(ANCHOR)
    if n != 1: print(f'REFUSE index.js: anchor found {n}x'); return 1
    add = ADD.replace('\n', '\r\n') if crlf else ADD
    s = s.replace(ANCHOR, ANCHOR + add)
    print(f'ok   index.js: +{len(add)} bytes, {"CRLF" if crlf else "LF"}')
    if check: print('CHECK ONLY'); return 0
    open(path, 'wb').write(s.encode('utf-8')); print('APPLIED'); return 0
if __name__ == '__main__':
    sys.exit(main())
