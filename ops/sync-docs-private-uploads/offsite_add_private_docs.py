#!/usr/bin/env python3
"""Adds the newest encrypted private-documents archive to the (still locked) restic offsite sync, and to its
restore test. Usage: offsite_add_private_docs.py /opt/2906-system/ops/backup-v2/offsite_sync.sh [--check]"""
import sys
p = sys.argv[1]; check = '--check' in sys.argv
s = open(p, encoding='utf-8').read()
E = [
    ('    PATHS="/data/$DB_REL"; [ -n "$WAHA" ] && PATHS="$PATHS /data/waha/$(basename "$WAHA")"\n',
     '    PATHS="/data/$DB_REL"; [ -n "$WAHA" ] && PATHS="$PATHS /data/waha/$(basename "$WAHA")"\n'
     '    # NEXUS SYNC private documents (2026-11-21): the newest archive, already AES-256 encrypted with its own key\n'
     '    PD=$(ls -1t "$DATA"/private-docs/private-docs_*.tar.gpg 2>/dev/null | head -1 || true)\n'
     '    [ -n "$PD" ] && PATHS="$PATHS /data/private-docs/$(basename "$PD")"\n'),
]
for a, b in E:
    if s.count(b) == 1: print('already applied'); continue
    assert s.count(a) == 1, 'anchor not found once'
    s = s.replace(a, b)
if check: print('anchor ok'); sys.exit(0)
open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('offsite sync now includes the private-documents archive (still locked until OFFSITE_APPROVED)')
