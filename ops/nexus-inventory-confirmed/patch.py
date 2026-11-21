#!/usr/bin/env python3
"""NEXUS inventory: availability confirmation time (2026-11-21). Usage: patch.py <backend dir> [--check]
services/nexusBridge.js  selects properties.last_confirmed_available_at and publishes it as `confirmedAt`, only while the
listing is `available_confirmed`. ARGUS sets that column only on an explicit confirmation (owner recheck / portfolio
answer, agent "Available Confirmed" on the board), never on an ordinary edit, so the Marketplace can say
"Confirmed today" truthfully and "Updated 2h ago" otherwise.
Exact anchors, line-ending aware, already-applied spots skipped, nothing written unless every anchor matches."""
import sys, os
root = sys.argv[1]; check = '--check' in sys.argv
EDITS = {
    'services/nexusBridge.js': [
        ('p.rental_modes,p.available_status,p.available_date,',
         'p.rental_modes,p.available_status,p.last_confirmed_available_at,p.available_date,'),
        ("updatedAt:row.updated_at,\n    listedBy:",
         "updatedAt:row.updated_at,confirmedAt:row.available_status==='available_confirmed'&&row.last_confirmed_available_at?row.last_confirmed_available_at:null,\n    listedBy:"),
    ],
}
plan = []
for rel, edits in EDITS.items():
    path = os.path.join(root, rel)
    text = open(path, 'rb').read().decode('utf-8')
    for old, new in edits:
        if any(text.count(new.replace('\n', nl)) == 1 for nl in ('\n', '\r\n')): print(f'already applied in {rel}'); continue
        hit = None
        for nl in ('\n', '\r\n'):
            o, n = old.replace('\n', nl), new.replace('\n', nl)
            c = text.count(o)
            if c == 1: hit = (o, n); break
            if c > 1: print(f'ANCHOR {c}x in {rel}: {old[:70]!r}'); sys.exit(1)
        if not hit: print(f'ANCHOR 0x in {rel}: {old[:70]!r}'); sys.exit(1)
        text = text.replace(hit[0], hit[1])
    plan.append((path, text))
if check: print('anchors ok'); sys.exit(0)
for path, text in plan:
    open(path, 'wb').write(text.encode('utf-8')); print('patched', path)
