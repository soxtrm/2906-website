#!/usr/bin/env python3
"""2026-11-18 (9747): reactivate must not downgrade an active listing; a fresh upload
counts as confirmed for the 30h still-available lock. Usage: apply_patches_2.py <root> [--check]"""
import sys, os
ROOT = sys.argv[1]; CHECK = '--check' in sys.argv; MARK = 'fresh-lock-20261118'
P = {
 'services/boardAction.js': [
  ("           WHERE id = $1\n             AND COALESCE(available_status, 'available') IS DISTINCT FROM 'available'\n           RETURNING id, ref, available_status, lifecycle_state, recently_rented_at, published`,",
   "           WHERE id = $1\n             -- " + MARK + ": never downgrade a listing that is on the market (confirmed/upcoming)\n"
   "             AND COALESCE(available_status, 'available') NOT IN ('available', 'available_confirmed', 'upcoming')\n"
   "           RETURNING id, ref, available_status, lifecycle_state, recently_rented_at, published`,"),
 ],
 'services/availability.js': [
  ("            last_confirmed_available_at, available_date, longlet_price\n       FROM properties WHERE LOWER(ref) = LOWER($1) LIMIT 1`, [ref])",
   "            last_confirmed_available_at, available_date, longlet_price, created_at\n       FROM properties WHERE LOWER(ref) = LOWER($1) LIMIT 1`, [ref])"),
  ("            last_confirmed_available_at, available_date, longlet_price\n         FROM properties\n        WHERE ref ILIKE",
   "            last_confirmed_available_at, available_date, longlet_price, created_at\n         FROM properties\n        WHERE ref ILIKE"),
  ("  if (prop.last_confirmed_available_at\n      && !['rented', 'archived'].includes(prop.available_status)\n",
   "  // " + MARK + ": a listing uploaded inside the window is as fresh as a confirmation (Kev)\n"
   "  if (!prop.last_confirmed_available_at && prop.created_at\n"
   "      && (Date.now() - new Date(prop.created_at).getTime()) <= FRESH_CONFIRM_HOURS * 3600_000) {\n"
   "    prop.last_confirmed_available_at = prop.created_at\n"
   "  }\n"
   "  if (prop.last_confirmed_available_at\n      && !['rented', 'archived'].includes(prop.available_status)\n"),
 ],
}
ok = True; out = {}
for rel, reps in P.items():
    path = os.path.join(ROOT, rel); s = open(path, encoding='utf-8', newline='').read()
    if MARK in s: print(f'{rel}: already patched'); continue
    nl = '\r\n' if '\r\n' in s else '\n'
    for a, b in reps:
        a2, b2 = a.replace('\n', nl), b.replace('\n', nl); n = s.count(a2)
        if n != 1: print(f'ANCHOR MISMATCH {rel}: {n}x {a[:60]!r}'); ok = False; continue
        s = s.replace(a2, b2)
    out[path] = s
if not ok: sys.exit(1)
for path, s in out.items():
    if CHECK: print('check ok:', path)
    else: open(path, 'w', encoding='utf-8', newline='').write(s); print('patched:', path)
