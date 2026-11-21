#!/usr/bin/env python3
"""NEXUS Rooms (2026-11-21). Usage: patch.py <backend dir> [--check]

routes/syncAccountService.js  owner routes /owner/rooms, /owner/rooms/save|mode|photo|layout|stays|decide (signed SYNC service, owner session)
index.js                      /api/crm/property-rooms (staff) and /api/nexus/rooms (public) next to the marketplace mounts
New files (copied by deploy.sh): services/propertyRooms.js, services/roomsBooking.js, routes/crmPropertyRooms.js, routes/nexusRooms.js
Exact anchors, line-ending aware, already-applied spots skipped, nothing written unless every anchor matches."""
import sys, os
root = sys.argv[1]; check = '--check' in sys.argv
A1 = "router.post('/owner/cal/slot', send(async req => C2.setSlot(S, await me(req), { propertyId: req.body?.propertyId, minutes: req.body?.minutes })))\n"
N1 = A1 + """// NEXUS Rooms (2026-11-21): rooms and shared spaces of one home, letting mode, photos, layout; stays live in NEXUS Booking
const PR = require('../services/propertyRooms'), RB = require('../services/roomsBooking')
const ownerActor = async req => ({ kind: 'owner', S, account: await me(req) })
router.post('/owner/rooms', send(async req => PR.rooms(await ownerActor(req), { propertyId: req.body?.propertyId })))
router.post('/owner/rooms/save', send(async req => PR.saveUnits(await ownerActor(req), { propertyId: req.body?.propertyId, rooms: req.body?.rooms, shared: req.body?.shared })))
router.post('/owner/rooms/mode', send(async req => PR.setMode(await ownerActor(req), { propertyId: req.body?.propertyId, mode: req.body?.mode, markets: req.body?.markets })))
router.post('/owner/rooms/photo', send(async req => PR.photo(await ownerActor(req), { propertyId: req.body?.propertyId, unitId: req.body?.unitId, dataBase64: req.body?.dataBase64, url: req.body?.url, remove: req.body?.remove })))
router.post('/owner/rooms/layout', send(async req => PR.saveLayout(await ownerActor(req), { propertyId: req.body?.propertyId, layout: req.body?.layout, confirm: req.body?.confirm === true })))
router.post('/owner/rooms/stays', send(async req => RB.stays(await ownerActor(req), { propertyId: req.body?.propertyId })))
router.post('/owner/rooms/decide', send(async req => RB.decide(await ownerActor(req), { propertyId: req.body?.propertyId, stayId: req.body?.stayId, action: req.body?.action, holdHours: req.body?.holdHours, note: req.body?.note })))
"""
A2 = 'app.use("/api/nexus/mp", require("./routes/marketplaceConversations"))\n'
N2 = 'app.use("/api/crm/property-rooms", require("./routes/crmPropertyRooms"))\napp.use("/api/nexus/rooms", require("./routes/nexusRooms"))\n' + A2
PATCHES = {'routes/syncAccountService.js': [(A1, N1)], 'index.js': [(A2, N2)]}
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
