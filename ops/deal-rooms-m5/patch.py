#!/usr/bin/env python3
"""NEXUS Deal Room M5 (2026-11-21). Usage: patch.py <backend dir> [--check]
index.js  mounts /api/nexus/mp-deal (client side of the Deal Room, conversation token) before /api/nexus/mp.
Exact anchors, line-ending aware, already-applied spots skipped, nothing written unless every anchor matches."""
import sys, os
root = sys.argv[1]; check = '--check' in sys.argv
EDITS = {
    'index.js': [
        ('app.use("/api/nexus/mp", require("./routes/marketplaceConversations"))\n',
         'app.use("/api/nexus/mp-deal", require("./routes/marketplaceDealRoom"))\n'
         'app.use("/api/nexus/mp", require("./routes/marketplaceConversations"))\n'),
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
