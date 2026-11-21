#!/usr/bin/env python3
"""Checks a private-documents snapshot: every document row that is not deleted (and not infected) must have its
file, with the same SHA-256. Usage: verify.py <owner_documents.csv> <files dir>. Exit 1 on any mismatch."""
import csv, hashlib, os, sys

rows = list(csv.DictReader(open(sys.argv[1], newline='', encoding='utf-8')))
files = sys.argv[2]
live = [r for r in rows if not r.get('deleted_at') and r.get('scan_state') != 'infected' and r.get('storage_key')]
bad = []
for r in live:
    p = os.path.join(files, r['storage_key'])
    if not os.path.isfile(p):
        bad.append(f"missing file for document {r['id']}"); continue
    h = hashlib.sha256(open(p, 'rb').read()).hexdigest()
    if r.get('sha256') and h != r['sha256']:
        bad.append(f"checksum differs for document {r['id']}")
known = {r['storage_key'] for r in rows if r.get('storage_key')}
extra = [f for f in os.listdir(files) if f not in known] if os.path.isdir(files) else []
print(f"rows {len(rows)} (live {len(live)}), files {len(os.listdir(files)) if os.path.isdir(files) else 0}, orphan files {len(extra)}, problems {len(bad)}")
for b in bad[:20]: print('  ' + b)
sys.exit(1 if bad else 0)
