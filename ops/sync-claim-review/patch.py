#!/usr/bin/env python3
"""NEXUS SYNC ownership review (2026-11-21). Usage: patch.py <backend dir> [--check]

services/syncAccount.js       staffNotice(text): internal WhatsApp to SYNC_STAFF_NOTIFY_TO (staff only, off without it);
                              after a staff decision the owner gets a message in their SYNC chat
routes/syncAccountService.js  after the owner confirms homes: review requested (audit) + staff notice
routes/crmSyncInbox.js        GET /claims: the review queue with claimed homes and listing agents
Exact anchors, line-ending aware, already-applied spots skipped, nothing written unless every anchor matches."""
import sys, os
root = sys.argv[1]; check = '--check' in sys.argv
CR = "require('./syncClaimReview')"
EDITS = {
    'services/syncAccount.js': [
        ("    const r = await L.verifyOwner(oid, agent, { method: `sync_phone_${a.phone_verified_via || 'confirmed'}_staff_approved` })\n    return { ...r, ownerId: oid }\n",
         "    const r = await L.verifyOwner(oid, agent, { method: `sync_phone_${a.phone_verified_via || 'confirmed'}_staff_approved` })\n"
         f"    await {CR}.ownerNotice(a, oid, 'approve', agent).catch(e => log.warn(`[sync] owner notice: ${{e.message}}`))\n"
         "    return { ...r, ownerId: oid }\n"),
        ("    return { linkState: 'not_invited', ownerId: oid }\n",
         f"    await {CR}.ownerNotice(a, oid, 'reject', agent).catch(e => log.warn(`[sync] owner notice: ${{e.message}}`))\n"
         "    return { linkState: 'not_invited', ownerId: oid }\n"),
        ("module.exports = {\n",
         "// Internal heads-up to the staff number (never to an owner). Off until SYNC_STAFF_NOTIFY_TO is set (2026-11-21).\n"
         "async function staffNotice(text) {\n"
         "  const to = String(process.env.SYNC_STAFF_NOTIFY_TO || '').replace(/\\D/g, '')\n"
         "  if (!to) return false\n"
         "  await sender(argusMainSession(), `${to}@c.us`, String(text).slice(0, 900))\n"
         "  return true\n"
         "}\n\n"
         "module.exports = {\n  staffNotice,\n"),
    ],
    'routes/syncAccountService.js': [
        ("router.post('/claims/decide', send(async req => S.decideClaims(await me(req), req.body?.decisions)))\n",
         "router.post('/claims/decide', send(async req => {\n"
         "  const a = await me(req)\n"
         "  const r = await S.decideClaims(a, req.body?.decisions)\n"
         "  // the ownership review is requested from staff (CRM queue + optional staff WhatsApp), 2026-11-21\n"
         "  const review = await require('../services/syncClaimReview').afterOwnerDecision(S, a, r).catch(e => { log.warn(`[sync] review request: ${e.message}`); return null })\n"
         "  return { ...r, reviewRequested: !!review && (review.notified || review.queued || review.reason === 'already requested') }\n"
         "}))\n"),
    ],
    'routes/crmSyncInbox.js': [
        ("router.get('/summary', send(req => S.staffSummary(req.agent)))\n",
         "router.get('/summary', send(req => S.staffSummary(req.agent)))\n"
         "// ownership review queue (2026-11-21): who waits, which homes, which listing agent\n"
         "router.get('/claims', send(req => require('../services/syncClaimReview').pending(S, req.agent)))\n"),
    ],
}
plan = []
for rel, edits in EDITS.items():
    path = os.path.join(root, rel)
    text = open(path, 'rb').read().decode('utf-8')
    for old, new in edits:
        if any(text.count(new.replace('\n', nl)) == 1 for nl in ('\n', '\r\n')): print(f'already applied in {rel}: {old[:50]!r}'); continue
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
