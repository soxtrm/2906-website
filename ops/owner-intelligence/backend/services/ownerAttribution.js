'use strict'
// ============================================================================
// services/ownerAttribution.js — WHO is talking to an owner, under which
// WhatsApp account, and what state the chat is in (Kev, 2026-10-31).
//
// Production (2026-10-31): 3,537 owners have been written to by two or more
// accounts, but the owner list showed only who CREATED the record. Here every
// answer comes from metadata, never from message text ("My name is Cedric"):
//   - account / session: owner_account_labels (one row per account that has a
//     conversation with the owner: first seen, last sent, last reply, counts)
//   - person behind an account: agents.whatsapp_session when an agent is
//     bound to it, else the account's persona (whatsapp_accounts.account_persona
//     → Kevin / Cedric / Gabriela / Olga / Jasmine). Neither → 'UNKNOWN'.
//   - initiator: the account whose conversation started first (label created_at)
//   - assigned handler: owner_contacts.assigned_* — set ONLY by an explicit
//     assignment (audited in owner_assignment_events), never derived
//   - "actively handling": only a real stand-down (ownerSendGate: board relay,
//     typed human message, owner-assistant HUMAN_ACTIVE — all with a TTL), never
//     merely an old outgoing message
//   - identity conflict: two different personas wrote to the owner within 30 days
// ============================================================================
const db = require('../db')

const PERSONA_NAME = { kev: 'Kevin', cedric: 'Cedric', gabriela: 'Gabriela', olga: 'Olga', jasmine: 'Jasmine' }
const NO_RESPONSE_DAYS = 7
const CONFLICT_DAYS = 30
const STATUS_LABEL = {
  agent_action_needed: 'Agent action needed', human_takeover: 'Human takeover', bot_responding: 'Bot responding',
  awaiting_owner: 'Awaiting owner', no_response: 'No response', resolved: 'Resolved', unknown: 'Unknown',
}

const ts = d => (d ? new Date(d).getTime() : 0)
const latest = (...ds) => ds.filter(Boolean).sort((a, b) => ts(b) - ts(a))[0] || null

function personFor(session, persona, boundAgents) {
  const bound = boundAgents.get(String(session || '').toLowerCase())
  if (bound) return { name: bound, source: 'agent_bound_to_account' }
  const p = String(persona || '').toLowerCase()
  if (PERSONA_NAME[p]) return { name: PERSONA_NAME[p], source: 'account_persona' }
  return { name: 'UNKNOWN', source: 'none' }
}

async function boundAgentMap() {
  const r = await db.query(
    `SELECT lower(whatsapp_session) AS s, string_agg(DISTINCT COALESCE(name, username), ' / ') AS names
       FROM agents WHERE whatsapp_session IS NOT NULL AND btrim(whatsapp_session) <> '' AND active IS DISTINCT FROM FALSE GROUP BY 1`)
  return new Map(r.rows.map(x => [x.s, x.names]))
}

// Pure: one owner's facts → attribution. `standDown` is ownerSendGate's
// reason (or null); `relay` the latest board relay thread; `autoConvo` the
// latest owner_auto_conversations row.
function compute({ sessions, assigned, standDown, relay, autoConvo, now = new Date() }) {
  const withOut = sessions.filter(s => s.lastOutboundAt)
  const initiator = [...sessions].filter(s => s.firstSeenAt).sort((a, b) => ts(a.firstSeenAt) - ts(b.firstSeenAt))[0] || null
  const lastOut = [...withOut].sort((a, b) => ts(b.lastOutboundAt) - ts(a.lastOutboundAt))[0] || null
  const lastIn = [...sessions].filter(s => s.lastInboundAt).sort((a, b) => ts(b.lastInboundAt) - ts(a.lastInboundAt))[0] || null
  const lastOutAt = lastOut?.lastOutboundAt || null
  const lastInAt = lastIn?.lastInboundAt || null

  let status = 'unknown'
  if (standDown === 'human_active') status = 'human_takeover'
  else if (lastInAt && ts(lastInAt) > ts(lastOutAt)) status = 'agent_action_needed'
  else if (autoConvo && autoConvo.status === 'active_collecting' && !autoConvo.automation_disabled && !standDown) status = 'bot_responding'
  else if (lastOutAt && ts(lastOutAt) >= ts(lastInAt)) {
    status = now - ts(lastOutAt) > NO_RESPONSE_DAYS * 86400000 ? 'no_response' : 'awaiting_owner'
    if (autoConvo && ['completed', 'published', 'done', 'needs_human_contact'].includes(autoConvo.status) && lastInAt) status = 'resolved'
  }

  const recentPersonas = new Set(withOut.filter(s => now - ts(s.lastOutboundAt) <= CONFLICT_DAYS * 86400000).map(s => s.person.name))
  const handling = standDown === 'human_active'
    ? (relay && relay.status === 'relaying' ? { name: relay.agent_name || 'UNKNOWN', via: 'board relay', since: relay.updated_at } : { name: 'UNKNOWN', via: 'human message on the account', since: null })
    : null

  return {
    status, statusLabel: STATUS_LABEL[status],
    replyNeeded: status === 'agent_action_needed',
    contactedBy: initiator ? { person: initiator.person.name, account: initiator.session, at: initiator.firstSeenAt, source: initiator.source } : null,
    lastMessageBy: lastOut ? { person: lastOut.person.name, account: lastOut.session, at: lastOutAt } : null,
    lastOwnerReply: lastIn ? { account: lastIn.session, at: lastInAt } : null,
    assignedTo: assigned && (assigned.agentName || assigned.session)
      ? { person: assigned.agentName || personFor(assigned.session, assigned.persona, new Map()).name, account: assigned.session || null, at: assigned.at, by: assigned.by }
      : null,
    handlingNow: handling,
    identityConflict: recentPersonas.size > 1 ? [...recentPersonas] : null,
    accounts: sessions.map(s => ({
      account: s.session, person: s.person.name, personSource: s.person.sourceKind,
      firstSeenAt: s.firstSeenAt, lastOutboundAt: s.lastOutboundAt, lastInboundAt: s.lastInboundAt,
      messagesOut: s.messagesOut, messagesIn: s.messagesIn,
    })),
  }
}

async function loadFor(contactIds, { withStandDown = true, now = new Date() } = {}) {
  const ids = [...new Set(contactIds.map(Number).filter(Boolean))]
  if (!ids.length) return new Map()
  const bound = await boundAgentMap()
  const [labels, owners, relays, convos] = await Promise.all([
    db.query(
      `SELECT oal.contact_id, oal.account_session, oal.source, oal.created_at, oal.last_we_sent_at, oal.last_outreach_at,
              oal.last_reply_at, oal.total_msgs_in, oal.total_msgs_out, wa.account_persona
         FROM owner_account_labels oal
         LEFT JOIN whatsapp_accounts wa ON lower(wa.session_name) = lower(oal.account_session)
        WHERE oal.contact_id = ANY($1::int[])`, [ids]),
    db.query(
      `SELECT oc.id, oc.phone_normalized, oc.assigned_agent_id, oc.assigned_session, oc.assigned_at, oc.assigned_by,
              COALESCE(a.name, a.username) AS assigned_agent_name, wa.account_persona AS assigned_persona
         FROM owner_contacts oc
         LEFT JOIN agents a ON a.id = oc.assigned_agent_id
         LEFT JOIN whatsapp_accounts wa ON lower(wa.session_name) = lower(oc.assigned_session)
        WHERE oc.id = ANY($1::int[])`, [ids]),
    db.query(
      `SELECT DISTINCT ON (owner_id) owner_id, agent_name, status, updated_at
         FROM book_relay_threads WHERE owner_id = ANY($1::int[]) ORDER BY owner_id, updated_at DESC NULLS LAST`, [ids]),
    db.query(
      `SELECT DISTINCT ON (oc.id) oc.id AS contact_id, c.status, c.automation_disabled, c.updated_at
         FROM owner_contacts oc JOIN owner_auto_conversations c ON c.phone = oc.phone_normalized
        WHERE oc.id = ANY($1::int[]) ORDER BY oc.id, c.updated_at DESC NULLS LAST`, [ids]),
  ])
  const relayBy = new Map(relays.rows.map(r => [r.owner_id, r]))
  const convoBy = new Map(convos.rows.map(r => [r.contact_id, r]))
  const sessionsBy = new Map()
  for (const l of labels.rows) {
    const p = personFor(l.account_session, l.account_persona, bound)
    const list = sessionsBy.get(l.contact_id) || []
    list.push({
      session: l.account_session, person: { name: p.name, sourceKind: p.source }, source: l.source,
      firstSeenAt: l.created_at, lastOutboundAt: latest(l.last_we_sent_at, l.last_outreach_at),
      lastInboundAt: l.last_reply_at, messagesOut: l.total_msgs_out, messagesIn: l.total_msgs_in,
    })
    sessionsBy.set(l.contact_id, list)
  }
  const gate = withStandDown ? require('./ownerSendGate') : null
  const out = new Map()
  await Promise.all(owners.rows.map(async o => {
    const sessions = sessionsBy.get(o.id) || []
    const recent = sessions.some(s => now - ts(latest(s.lastOutboundAt, s.lastInboundAt)) < 14 * 86400000)
    const standDown = gate && o.phone_normalized && recent ? await gate.getStandDownReason(o.phone_normalized) : null
    out.set(o.id, compute({
      sessions, standDown, relay: relayBy.get(o.id), autoConvo: convoBy.get(o.id), now,
      assigned: { agentName: o.assigned_agent_name, session: o.assigned_session, persona: o.assigned_persona, at: o.assigned_at, by: o.assigned_by },
    }))
  }))
  return out
}

// Explicit (re)assignment — audited; the previous handler is kept in history.
async function assign(contactId, { agentId = null, session = null, reason = null, actor }) {
  if (!agentId && !session) throw Object.assign(new Error('agentId or session required'), { code: 'invalid_assignment' })
  const before = (await db.query(`SELECT assigned_agent_id, assigned_session FROM owner_contacts WHERE id = $1`, [contactId])).rows[0]
  if (!before) throw Object.assign(new Error('owner not found'), { code: 'not_found' })
  await db.query(
    `UPDATE owner_contacts SET assigned_agent_id = $2, assigned_session = $3, assigned_at = NOW(), assigned_by = $4 WHERE id = $1`,
    [contactId, agentId, session, actor?.name || actor?.username || null])
  await db.query(
    `INSERT INTO owner_assignment_events (contact_id, from_agent_id, from_session, to_agent_id, to_session, reason, actor_agent_id, actor_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [contactId, before.assigned_agent_id, before.assigned_session, agentId, session, reason, actor?.id || null, actor?.name || actor?.username || null])
  return (await loadFor([contactId])).get(contactId)
}

module.exports = { STATUS_LABEL, PERSONA_NAME, compute, loadFor, assign, personFor }
