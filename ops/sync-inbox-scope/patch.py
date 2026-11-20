#!/usr/bin/env python3
"""SYNC inbox: an agent sees only the owner conversations they are responsible for. Usage: patch.py <backend dir> [--check]

Before: every CRM staff account could list every owner account of the agency, with e-mail and phone number,
read every thread and answer in it. Now admins and agents with NEXUS owner controls keep the full inbox; any
other agent gets only owners with a verified link and a confirmed listing of their own, without the owner's
e-mail or number, and an account outside that set answers 404. Exact anchors, nothing written on a miss."""
import sys, os

root = sys.argv[1]; check = '--check' in sys.argv
EDITS = {
    'services/syncAccount.js': [
        ("// ── staff side (CRM) ────────────────────────────────────────────────────────\nasync function staffThreads() {\n",
         """// ── staff side (CRM) ────────────────────────────────────────────────────────
// Who may see which owner threads (2026-11-20). Admins and agents with NEXUS owner controls see all of the
// agency's threads. Any other agent sees only owners with a verified link and a confirmed listing they are
// responsible for (properties.listed_by_agent_id), and never the owner's e-mail or number.
const seesAll = agent => agent?.role === 'admin' || agent?.nexusOwnerLink === true
async function accessibleAccountIds(agent) {
  if (!agent?.id) return []
  const { rows } = await db.query(
    `SELECT DISTINCT a.id FROM sync_accounts a
       JOIN nexus_owner_links l ON l.agency_key=$1 AND l.nexus_account_ref = 'sync:' || a.public_id AND l.link_state='verified'
       JOIN nexus_owner_property_claims c ON c.owner_link_id=l.id AND c.claim_state IN ('confirmed','corrected')
       JOIN properties p ON p.id=c.property_id AND p.listed_by_agent_id=$2
      WHERE a.disabled_at IS NULL`, [AGENCY_KEY(), agent.id])
  return rows.map(r => String(r.id))
}
async function staffAccountFor(publicId, agent) {
  const a = await staffAccount(publicId)
  if (seesAll(agent)) return a
  if (!(await accessibleAccountIds(agent)).includes(String(a.id))) throw err('ACCOUNT_NOT_FOUND', 'Account not found', 404)
  return a
}
const staffAccountView = (a, agent) => (seesAll(agent) ? accountView(a) : { ...accountView(a), email: null, emailVerified: null, phone: null, prefs: {} })

async function staffThreads(agent) {
  const only = seesAll(agent) ? null : await accessibleAccountIds(agent)
"""),
        ("      WHERE a.disabled_at IS NULL\n      ORDER BY m.last_at DESC NULLS LAST, a.created_at DESC LIMIT 200`, [AGENCY_KEY()])\n"
         "  return { threads: rows.map(r => ({ accountId: r.public_id, name: r.display_name, email: r.email, phone: r.phone_e164 ? `+${r.phone_e164}` : null, phoneVerified: !!r.phone_verified_at,\n",
         "      WHERE a.disabled_at IS NULL AND ($2::bigint[] IS NULL OR a.id = ANY($2::bigint[]))\n      ORDER BY m.last_at DESC NULLS LAST, a.created_at DESC LIMIT 200`, [AGENCY_KEY(), only])\n"
         "  return { threads: rows.map(r => ({ accountId: r.public_id, name: r.display_name, email: only ? null : r.email, phone: only ? null : (r.phone_e164 ? `+${r.phone_e164}` : null), phoneVerified: !!r.phone_verified_at,\n"),
        ("async function staffSummary() {\n  const agency = AGENCY_KEY()\n",
         "async function staffSummary(agent) {\n  const agency = AGENCY_KEY()\n"
         "  if (!seesAll(agent)) {\n"
         "    const only = await accessibleAccountIds(agent)\n"
         "    const { rows: [m] } = await db.query(`SELECT COUNT(*)::int AS n FROM nexus_owner_messages WHERE agency_key=$1 AND direction='in' AND read_by_staff_at IS NULL AND account_id = ANY($2::bigint[])`, [agency, only])\n"
         "    return { unread: m.n, pendingClaims: 0 }\n"
         "  }\n"),
        ("async function staffContext(publicId) {\n  const a = await staffAccount(publicId)\n",
         "async function staffContext(publicId, agent) {\n  const a = await staffAccountFor(publicId, agent)\n  const all = seesAll(agent)\n"),
        ("        WHERE c.owner_link_id=$1 ORDER BY p.id`, [l.id])\n",
         "        WHERE c.owner_link_id=$1 AND ($2::int IS NULL OR p.listed_by_agent_id=$2::int) ORDER BY p.id`, [l.id, all ? null : agent.id])\n"
         "    if (!all && !rows.length) continue\n"),
        ("  return { account: accountView(a), links: out }\n}\n",
         "  return { account: staffAccountView(a, agent), links: out }\n}\n"),
        ("async function staffMessages(publicId) {\n  const a = await staffAccount(publicId)\n",
         "async function staffMessages(publicId, agent) {\n  const a = await staffAccountFor(publicId, agent)\n"),
        ("  return { account: accountView(a), messages: rows.map(messageView) }\n}\n\nasync function staffReply(publicId, agent, { text, propertyId }) {\n  const a = await staffAccount(publicId)\n",
         "  return { account: staffAccountView(a, agent), messages: rows.map(messageView) }\n}\n\nasync function staffReply(publicId, agent, { text, propertyId }) {\n  const a = await staffAccountFor(publicId, agent)\n"),
    ],
    'routes/crmSyncInbox.js': [
        ("router.get('/summary', send(() => S.staffSummary()))\n"
         "router.get('/threads', send(() => S.staffThreads()))\n"
         "router.get('/threads/:accountId/context', send(req => S.staffContext(req.params.accountId)))\n",
         "// every route needs to know whether this agent has the full inbox (services/syncAccount.js: seesAll)\n"
         "router.use(entitled)\n"
         "router.get('/summary', send(req => S.staffSummary(req.agent)))\n"
         "router.get('/threads', send(req => S.staffThreads(req.agent)))\n"
         "router.get('/threads/:accountId/context', send(req => S.staffContext(req.params.accountId, req.agent)))\n"),
        ("router.get('/threads/:accountId', send(req => S.staffMessages(req.params.accountId)))\n",
         "router.get('/threads/:accountId', send(req => S.staffMessages(req.params.accountId, req.agent)))\n"),
    ],
}
out = {}
for rel, edits in EDITS.items():
    raw = open(os.path.join(root, rel), 'rb').read()
    if b'\r\n' in raw: print('REFUSE: %s has CRLF' % rel); sys.exit(1)
    s = raw.decode('utf-8')
    if 'seesAll' in s and rel.startswith('services'): print('REFUSE: already applied'); sys.exit(1)
    for i, (a, b) in enumerate(edits):
        if s.count(a) != 1: print('REFUSE: %s edit %d anchor found %dx' % (rel, i + 1, s.count(a))); sys.exit(1)
        s = s.replace(a, b)
    out[rel] = s
if check: print('check ok'); sys.exit(0)
for rel, s in out.items(): open(os.path.join(root, rel), 'wb').write(s.encode('utf-8'))
print('patched: ' + ', '.join(sorted(out)))
