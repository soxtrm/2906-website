#!/usr/bin/env python3
"""NEXUS Deal Room (2026-11-21). Usage: patch.py <backend dir> [--check]
services/marketplaceConversations.js  hooks: a viewing request creates/links the Deal Room in the same transaction;
                                      booking/declining records it; both conversation views carry the room (visitor:
                                      parties-only timeline, staff: everything). A Deal Room failure never blocks a booking.
index.js                              mounts /api/crm/deal-rooms (staff).
Exact anchors, line-ending aware, already-applied spots skipped, nothing written unless every anchor matches."""
import sys, os
root = sys.argv[1]; check = '--check' in sys.argv
EDITS = {
    'services/marketplaceConversations.js': [
        ("    await addMessage(client, c.id, { sender: 'visitor', kind: 'viewing_request', body: `Viewing request: ${days}${text ? `. ${text}` : ''}`, meta: { requestId: Number(r.id) } })\n",
         "    await addMessage(client, c.id, { sender: 'visitor', kind: 'viewing_request', body: `Viewing request: ${days}${text ? `. ${text}` : ''}`, meta: { requestId: Number(r.id) } })\n"
         "    await require('./dealRooms').ensureForViewing(client, c, Number(r.id))   // NEXUS Deal Room: created or linked, same transaction\n"),
        ("  await db.query(`UPDATE mp_viewing_requests SET status='booked', property_viewing_id=$2, decided_by=$3, decided_at=now() WHERE id=$1`, [r.id, res.id, agent.id])\n",
         "  await db.query(`UPDATE mp_viewing_requests SET status='booked', property_viewing_id=$2, decided_by=$3, decided_at=now() WHERE id=$1`, [r.id, res.id, agent.id])\n"
         "  try { await require('./dealRooms').onViewingBooked(c, Number(r.id), agent.id, at.toISOString()) } catch (e) { log.warn('deal room: booking not recorded', { err: e.message }) }\n"),
        ("  if (!u.rows[0]) fail('REQUEST_DONE', 'This request was already handled.', 409)\n",
         "  if (!u.rows[0]) fail('REQUEST_DONE', 'This request was already handled.', 409)\n"
         "  try { await require('./dealRooms').onViewingDeclined(c, Number(requestId), agent.id) } catch (e) { log.warn('deal room: decline not recorded', { err: e.message }) }\n"),
        ("    messages: await messagesOf(id), requests: await requestsOf(id), unread: c.visitor_unread,\n",
         "    messages: await messagesOf(id), requests: await requestsOf(id), unread: c.visitor_unread,\n"
         "    deal: await require('./dealRooms').forConversation(c.id, 'visitor'),\n"),
        ("    agent: await agentCard(c.assigned_agent_id), messages: await messagesOf(c.id), requests: await requestsOf(c.id), createdAt: c.created_at,\n",
         "    agent: await agentCard(c.assigned_agent_id), messages: await messagesOf(c.id), requests: await requestsOf(c.id), createdAt: c.created_at,\n"
         "    deal: await require('./dealRooms').forConversation(c.id, 'staff'),\n"),
    ],
    'index.js': [
        ('app.use("/api/crm/marketplace-inbox", require("./routes/crmMarketplaceInbox"))\n',
         'app.use("/api/crm/marketplace-inbox", require("./routes/crmMarketplaceInbox"))\n'
         'app.use("/api/crm/deal-rooms", require("./routes/crmDealRooms"))\n'),
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
