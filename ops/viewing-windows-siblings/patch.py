#!/usr/bin/env python3
"""Viewing windows: an acceptance or a SYNC calendar action never wipes the owner's other hours (2026-11-21).
Usage: patch.py <backend dir> [--check]

services/viewingWindows.js  addWindow() replaces every other window of the same Malta day unless it came from the
                            same message. Right for a statement ("Tuesday now only 10-12"), wrong for:
                              - an owner saying yes to one viewing (windowFromConfirmedViewing, source booking_survey)
                              - hours opened, moved or proposed in the SYNC calendar (reference sync:<id>:cal|cal2|propose:...)
                            Those are now added next to the existing hours (no supersede, no stale check).
                            Chat statements, the owner portal, the agent board and SYNC day hours behave as before.
Exact anchors, line-ending aware, already-applied spots skipped, nothing written unless every anchor matches."""
import sys, os
root = sys.argv[1]; check = '--check' in sys.argv
OLD = """    // A newer statement for the same day (or a newer from-date) already exists → this one is stale.
    if (sameScope.rows.some(x => new Date(x.observed_at) > observedAt)) {
      await q.query('COMMIT')
      return { id: null, action: 'stale' }
    }
    // Windows from the SAME message ("Tuesday 10am and 4pm") are siblings, not
    // corrections; anything from an earlier (or a different) message is replaced.
    const ref = meta.reference || null
    const supersededIds = sameScope.rows
      .filter(x => w.kind === 'from_date' || !ref || x.source_reference !== ref)
      .map(x => x.id)
"""
NEW = """    // Additions, not statements (2026-11-21): an owner's yes to ONE viewing, and hours opened / proposed in the
    // SYNC calendar, sit next to the existing hours of that day. They never replace them and are never "stale".
    const additive = w.kind === 'window' && (meta.sourceType === 'booking_survey' || /^sync:[^:]+:(cal|cal2|propose)(:|$)/.test(String(meta.reference || '')))
    // a yes to one viewing inside hours that are already open adds nothing
    if (additive && meta.sourceType === 'booking_survey') {
      const cover = sameScope.rows.find(x => new Date(x.starts_at) <= new Date(w.start) && new Date(x.ends_at) >= new Date(w.end))
      if (cover) { await q.query('COMMIT'); return { id: cover.id, action: 'covered' } }
    }
    // A newer statement for the same day (or a newer from-date) already exists → this one is stale.
    if (!additive && sameScope.rows.some(x => new Date(x.observed_at) > observedAt)) {
      await q.query('COMMIT')
      return { id: null, action: 'stale' }
    }
    // Windows from the SAME message ("Tuesday 10am and 4pm") are siblings, not
    // corrections; anything from an earlier (or a different) message is replaced.
    const ref = meta.reference || null
    const supersededIds = additive ? [] : sameScope.rows
      .filter(x => w.kind === 'from_date' || !ref || x.source_reference !== ref)
      .map(x => x.id)
"""
PATCHES = {'services/viewingWindows.js': [(OLD, NEW)]}
out = {}
for rel, pairs in PATCHES.items():
    path = os.path.join(root, rel)
    text = open(path, encoding='utf-8', newline='').read()
    for old, new in pairs:
        if any(text.count(new.replace('\n', nl)) == 1 for nl in ('\n', '\r\n')): print(f'already applied in {rel}'); continue
        hit = False
        for nl in ('\n', '\r\n'):
            o = old.replace('\n', nl); c = text.count(o)
            if c == 1: text = text.replace(o, new.replace('\n', nl)); hit = True; break
            if c > 1: print(f'ANCHOR {c}x in {rel}: {old[:70]!r}'); sys.exit(1)
        if not hit: print(f'ANCHOR 0x in {rel}: {old[:70]!r}'); sys.exit(1)
    out[path] = text
if check: print('anchors ok'); sys.exit(0)
for path, text in out.items():
    open(path, 'w', encoding='utf-8', newline='').write(text); print(f'patched {path}')
