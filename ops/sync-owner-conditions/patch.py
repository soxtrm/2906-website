#!/usr/bin/env python3
"""SYNC owner conditions + owner activity (2026-11-21). Usage: patch.py <backend dir> [--check]

Adds four signed SYNC routes (owner/conditions, owner/conditions/set, owner/conditions/decide, owner/activity)
backed by the new services/syncPropertyConditions.js, and records each owner change made through
owner/event in the shared activity log (SYNC_OWNER_EVENT) so the owner's history shows it.
Exact anchors, line-ending aware, nothing written unless every anchor matches exactly once."""
import sys, os

root = sys.argv[1]; check = '--check' in sys.argv
EDITS = {
    'routes/syncAccountService.js': [
        ("router.post('/owner/hours', send(async req => S.ownerSetDays(await me(req), { propertyId: req.body?.propertyId, days: req.body?.days })))\n",
         """router.post('/owner/hours', send(async req => S.ownerSetDays(await me(req), { propertyId: req.body?.propertyId, days: req.body?.days })))
// Owner conditions per property (Property Passport) and the owner's own activity (2026-11-21)
const PC = require('../services/syncPropertyConditions')
router.post('/owner/conditions', send(async req => PC.get(S, await me(req), { propertyId: req.body?.propertyId })))
router.post('/owner/conditions/set', send(async req => PC.set(S, await me(req), { propertyId: req.body?.propertyId, key: req.body?.key, status: req.body?.status, details: req.body?.details, note: req.body?.note, baseVersion: req.body?.baseVersion })))
router.post('/owner/conditions/decide', send(async req => PC.decide(S, await me(req), { propertyId: req.body?.propertyId, proposalId: req.body?.proposalId, decision: req.body?.decision })))
router.post('/owner/activity', send(async req => PC.activity(S, await me(req), { before: req.body?.before })))
"""),
    ],
    'services/syncAccount.js': [
        ("  return L.applyInboundEvent({\n    contractVersion: L.CONTRACT_VERSION, agencyKey: link.agency_key, eventType,\n",
         "  const result = await L.applyInboundEvent({\n    contractVersion: L.CONTRACT_VERSION, agencyKey: link.agency_key, eventType,\n"),
        ("    data: { ...(data || {}), linkId: link.public_id },\n  })\n}\n",
         """    data: { ...(data || {}), linkId: link.public_id },
  })
  // the owner's activity history (read by syncPropertyConditions.activity); a log failure never undoes the change
  try {
    const { rows: [pp] } = await db.query(`SELECT p.id, p.ref FROM nexus_property_links pl JOIN properties p ON p.id=pl.property_id WHERE pl.agency_key=$1 AND pl.external_id=$2`, [link.agency_key, ext])
    await audit(db, null, 'SYNC_OWNER_EVENT', { account: account.public_id, eventType }, pp || null)
  } catch (e) { log.warn(`[sync] activity log: ${e.message}`) }
  return result
}
"""),
    ],
}

plan = []
for rel, edits in EDITS.items():
    path = os.path.join(root, rel)
    raw = open(path, 'rb').read().decode('utf-8')
    nl = '\r\n' if '\r\n' in raw else '\n'
    text = raw.replace('\r\n', '\n') if nl == '\r\n' else raw
    for old, new in edits:
        n = text.count(old)
        if n != 1:
            if text.count(new) == 1: print(f'already applied: {rel}'); continue
            print(f'ANCHOR {n}x in {rel}: {old[:70]!r}'); sys.exit(1)
        text = text.replace(old, new)
    plan.append((path, text.replace('\n', nl) if nl == '\r\n' else text))
if check: print('anchors ok'); sys.exit(0)
for path, text in plan:
    open(path, 'wb').write(text.encode('utf-8'))
    print('patched', path)
