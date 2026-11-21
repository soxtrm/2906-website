#!/usr/bin/env python3
"""NEXUS Sync calendar 2.0 (2026-11-21). Usage: patch.py <backend dir> [--check]

routes/syncAccountService.js  POST /owner/cal, /owner/cal/window/add, /owner/cal/window/update,
                              /owner/cal/appointment, /owner/cal/appointment/cancel, /owner/cal/slot
                              (signed SYNC service, owner session) -> services/syncCalendar2.js (new file)
Exact anchors, line-ending aware, already-applied spots skipped, nothing written unless every anchor matches."""
import sys, os
root = sys.argv[1]; check = '--check' in sys.argv
ANCHOR = "router.post('/owner/window/remove', send(async req => S.ownerRemoveWindow(await me(req), { propertyId: req.body?.propertyId, windowId: req.body?.windowId })))\n"
ADD = ANCHOR + """// SYNC calendar 2.0 (2026-11-21): hours as ranges (move / resize / weekly), the owner's own appointments, slot length per home
const C2 = require('../services/syncCalendar2')
router.post('/owner/cal', send(async req => C2.state(S, await me(req))))
router.post('/owner/cal/window/add', send(async req => C2.addWindows(S, await me(req), { propertyId: req.body?.propertyId, start: req.body?.start, end: req.body?.end, repeatWeeks: req.body?.repeatWeeks })))
router.post('/owner/cal/window/update', send(async req => C2.updateWindow(S, await me(req), { propertyId: req.body?.propertyId, windowId: req.body?.windowId, start: req.body?.start, end: req.body?.end })))
router.post('/owner/cal/appointment', send(async req => C2.appointment(S, await me(req), { propertyId: req.body?.propertyId, start: req.body?.start, minutes: req.body?.minutes, kind: req.body?.kind, label: req.body?.label })))
router.post('/owner/cal/appointment/cancel', send(async req => C2.cancelAppointment(S, await me(req), { viewingId: req.body?.viewingId })))
router.post('/owner/cal/slot', send(async req => C2.setSlot(S, await me(req), { propertyId: req.body?.propertyId, minutes: req.body?.minutes })))
"""
PATCHES = {'routes/syncAccountService.js': [(ANCHOR, ADD)]}
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
