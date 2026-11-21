'use strict'
// ============================================================================
// services/dealRooms.js — NEXUS Deal Room (Claude, 2026-11-21, Milestone 3)
//
// One persistent transaction workspace per qualifying Marketplace enquiry. It sits ON the existing conversation
// (mp_conversations / mp_messages / mp_viewing_requests -> property_viewings): no second chat backend.
//   created   automatically when the visitor asks for a viewing (same transaction as the request);
//             a second request on the same enquiry links to the same open room (unique index)
//   advanced  viewing booked (system, when the agency books the slot) -> viewing done -> offer -> terms agreed
//             -> contract -> completed, or cancelled; only the assigned agent (or an unassigned room's
//             staff, or an admin) of the listing agency may advance it, one step at a time
//   visible   the visitor sees the stage and the timeline entries meant for the parties; staff see everything
//             incl. internal notes. Owner identity / contact data never appear. No payment state exists here:
//             nothing can be marked "paid" (deposits and escrow are later milestones with separate approval).
// ============================================================================
const db = require('../db')
const log = require('../logger')

const AGENCY = () => process.env.ARGUS_AGENCY_KEY || '2906'
class DealError extends Error { constructor(code, message, status = 400) { super(message); this.code = code; this.status = status } }
const fail = (code, message, status) => { throw new DealError(code, message, status) }
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max)

const ORDER = ['viewing_requested', 'viewing_booked', 'viewing_done', 'offer', 'terms_agreed', 'contract', 'completed']
const LABEL = {
  viewing_requested: 'Viewing requested', viewing_booked: 'Viewing booked', viewing_done: 'Viewing done', offer: 'Offer',
  terms_agreed: 'Terms agreed', contract: 'Contract', completed: 'Completed', cancelled: 'Cancelled',
}
// what the agency does next at each stage (shown in the central panel)
const NEXT_ACTION = {
  viewing_requested: 'Book a time inside the owner\'s viewing hours (Marketplace inbox), or decline the days.',
  viewing_booked: 'Wait for the owner to confirm the time. After the viewing, mark it as done.',
  viewing_done: 'Ask the client for feedback. Record an offer when the client makes one.',
  offer: 'Discuss the offer with the owner. Mark the terms agreed once both sides accept.',
  terms_agreed: 'Prepare the contract. Mark the contract stage when the draft is with both parties.',
  contract: 'Mark completed once the contract is signed. Payments are not handled in NEXUS yet.',
  completed: 'Done.', cancelled: 'Closed without a deal.',
}
// staff may move one step forward or cancel an open room
// "Viewing booked" is set only by a real booking (booking engine), never by hand
const allowed = stage => stage === 'completed' || stage === 'cancelled' ? [] : stage === 'viewing_requested' ? ['cancelled'] : [ORDER[ORDER.indexOf(stage) + 1], 'cancelled'].filter(Boolean)

async function event(q, roomId, { kind, actor, agentId = null, visibility = 'parties', data = {} }) {
  await q.query(`INSERT INTO deal_room_events (deal_room_id, kind, actor, agent_id, visibility, data) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [roomId, kind, actor, agentId, visibility, JSON.stringify(data)])
}

// ── hooks from services/marketplaceConversations.js ─────────────────────────────
// Inside the visitor's viewing-request transaction: create or link the room, never twice for one enquiry.
async function ensureForViewing(q, conv, requestId) {
  const ins = await q.query(
    `INSERT INTO deal_rooms (agency_key, property_id, listing_ref, conversation_id, agent_id, created_from)
     VALUES ($1,$2,$3,$4,$5,'viewing_request')
     ON CONFLICT (conversation_id) WHERE stage NOT IN ('completed','cancelled') DO NOTHING RETURNING id`,
    [conv.agency_key, conv.property_id, conv.listing_ref, conv.id, conv.assigned_agent_id])
  let id = ins.rows[0] && ins.rows[0].id
  if (id) await event(q, id, { kind: 'created', actor: 'system', data: { from: 'viewing_request', requestId } })
  else id = (await q.query(`SELECT id FROM deal_rooms WHERE conversation_id=$1 AND stage NOT IN ('completed','cancelled')`, [conv.id])).rows[0].id
  await event(q, id, { kind: 'viewing_requested', actor: 'visitor', data: { requestId } })
  return id
}
const openRoomOf = async convId => (await db.query(`SELECT * FROM deal_rooms WHERE conversation_id=$1 AND stage NOT IN ('completed','cancelled')`, [convId])).rows[0] || null

async function onViewingBooked(conv, requestId, agentId, startsAt) {
  const room = await openRoomOf(conv.id); if (!room) return null
  await event(db, room.id, { kind: 'viewing_booked', actor: 'system', agentId, data: { requestId, startsAt } })
  if (room.stage === 'viewing_requested') {   // never moves a room backwards
    await db.query(`UPDATE deal_rooms SET stage='viewing_booked', stage_changed_at=now(), agent_id=COALESCE(agent_id,$2) WHERE id=$1`, [room.id, agentId])
  }
  return room.id
}
async function onViewingDeclined(conv, requestId, agentId) {
  const room = await openRoomOf(conv.id); if (!room) return null
  await event(db, room.id, { kind: 'viewing_declined', actor: 'staff', agentId, data: { requestId } })
  return room.id
}

// ── read models ─────────────────────────────────────────────────────────────────
const eventsOf = async (roomId, audience) => (await db.query(
  `SELECT e.id, e.kind, e.actor, e.visibility, e.data, e.created_at, a.name AS agent_name, a.alias AS agent_alias
     FROM deal_room_events e LEFT JOIN agents a ON a.id = e.agent_id
    WHERE e.deal_room_id=$1 ${audience === 'staff' ? '' : `AND e.visibility='parties'`} ORDER BY e.id`, [roomId])).rows
  .map(e => ({ id: Number(e.id), kind: e.kind, actor: e.actor, internal: e.visibility === 'staff', data: e.data, at: e.created_at,
    by: e.actor === 'staff' || e.actor === 'system' ? (e.agent_alias || e.agent_name || null) : null }))

const stagesOf = stage => ORDER.map(s => ({ key: s, label: LABEL[s], state: stage === 'cancelled' ? 'off' : ORDER.indexOf(s) < ORDER.indexOf(stage) ? 'done' : s === stage ? 'now' : 'next' }))

// For the conversation views (visitor: parties-only timeline; staff: everything). null when no room exists yet.
async function forConversation(convId, audience) {
  const { rows: [room] } = await db.query(`SELECT * FROM deal_rooms WHERE conversation_id=$1 ORDER BY (stage IN ('completed','cancelled')), created_at DESC LIMIT 1`, [convId])
  if (!room) return null
  return { id: room.id, stage: room.stage, label: LABEL[room.stage], stages: stagesOf(room.stage), createdAt: room.created_at,
    timeline: await eventsOf(room.id, audience), documents: await require('./dealRoomDocs').documentsOf(room.id, audience), payments: await require('./dealRoomDocs').paymentsOf(room.id),
    ...(audience === 'staff' ? { nextAction: NEXT_ACTION[room.stage], allowed: allowed(room.stage) } : {}) }
}

// ── agency staff ───────────────────────────────────────────────────────────────
const canSee = (agent, room, conv) => room.agency_key === AGENCY() && (agent.role === 'admin' || room.agent_id === agent.id || conv.assigned_agent_id === agent.id || (room.agent_id == null && conv.assigned_agent_id == null))
async function roomFor(agent, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) fail('DEAL_NOT_FOUND', 'Deal Room not found.', 404)
  const { rows: [room] } = await db.query(`SELECT * FROM deal_rooms WHERE id=$1`, [id])
  if (!room) fail('DEAL_NOT_FOUND', 'Deal Room not found.', 404)
  const { rows: [conv] } = await db.query(`SELECT * FROM mp_conversations WHERE id=$1`, [room.conversation_id])
  if (!conv || !canSee(agent, room, conv)) fail('DEAL_NOT_FOUND', 'Deal Room not found.', 404)   // no hint that it exists
  return { room, conv }
}

async function list(agent, { stage = 'open' } = {}) {
  const where = [`d.agency_key=$1`]; const args = [AGENCY()]
  if (agent.role !== 'admin') { args.push(agent.id); where.push(`(d.agent_id=$${args.length} OR c.assigned_agent_id=$${args.length} OR (d.agent_id IS NULL AND c.assigned_agent_id IS NULL))`) }
  if (stage === 'open') where.push(`d.stage NOT IN ('completed','cancelled')`)
  else if (stage === 'closed') where.push(`d.stage IN ('completed','cancelled')`)
  const { rows } = await db.query(
    `SELECT d.id, d.stage, d.stage_changed_at, d.listing_ref, d.created_at, c.visitor_name, c.visitor_role, c.staff_unread, c.last_message_at,
            p.town, p.property_type, p.bedrooms, a.name AS agent_name, a.alias AS agent_alias
       FROM deal_rooms d JOIN mp_conversations c ON c.id = d.conversation_id
       LEFT JOIN properties p ON p.id = d.property_id LEFT JOIN agents a ON a.id = d.agent_id
      WHERE ${where.join(' AND ')} ORDER BY d.stage_changed_at DESC LIMIT 200`, args)
  return { deals: rows.map(r => ({
    id: r.id, stage: r.stage, label: LABEL[r.stage], ref: r.listing_ref, client: r.visitor_name, clientRole: r.visitor_role,
    home: [r.bedrooms ? `${r.bedrooms}-Bedroom` : null, r.property_type ? r.property_type[0].toUpperCase() + r.property_type.slice(1) : 'Home', r.town ? `in ${r.town}` : null].filter(Boolean).join(' '),
    unread: r.staff_unread, agent: r.agent_alias || r.agent_name || null, changedAt: r.stage_changed_at, lastMessageAt: r.last_message_at,
  })) }
}

async function view(agent, id) {
  const { room, conv } = await roomFor(agent, id)
  const { rows: [p] } = room.property_id ? await db.query(
    `SELECT id, ref, town, property_type, bedrooms, bathrooms, longlet_price, available_status, images FROM properties WHERE id=$1`, [room.property_id]) : { rows: [] }
  const { rows: requests } = await db.query(
    `SELECT r.id, r.preferred, r.note, r.status, r.created_at, pv.starts_at, pv.status AS viewing_status
       FROM mp_viewing_requests r LEFT JOIN property_viewings pv ON pv.id = r.property_viewing_id
      WHERE r.conversation_id=$1 ORDER BY r.id`, [conv.id])
  const { rows: msgs } = await db.query(`SELECT id, sender, kind, body, created_at FROM mp_messages WHERE conversation_id=$1 ORDER BY id DESC LIMIT 60`, [conv.id])
  const { rows: [ag] } = room.agent_id ? await db.query(`SELECT id, name, alias FROM agents WHERE id=$1`, [room.agent_id]) : { rows: [] }
  const img = p && Array.isArray(p.images) ? p.images.map(i => (typeof i === 'string' ? i : i && (i.url || i.secure_url))).find(Boolean) : null
  return { deal: {
    id: room.id, stage: room.stage, label: LABEL[room.stage], stages: stagesOf(room.stage), nextAction: NEXT_ACTION[room.stage], allowed: allowed(room.stage),
    relationship: room.relationship, createdAt: room.created_at, conversationId: conv.id,
    property: p ? { id: p.id, ref: p.ref, town: p.town, type: p.property_type, bedrooms: p.bedrooms, bathrooms: p.bathrooms, price: p.longlet_price == null ? null : Number(p.longlet_price), status: p.available_status, photo: img || null } : { ref: room.listing_ref },
    client: { name: conv.visitor_name, role: conv.visitor_role, email: conv.visitor_email, phone: conv.visitor_phone },   // staff only, as in the inbox
    agent: ag ? { id: ag.id, name: ag.alias || ag.name } : null,
    // the owner side: only what ARGUS knows about the viewing confirmation; no owner identity or contact
    owner: { viewing: requests.filter(r => r.status === 'booked').map(r => ({ requestId: Number(r.id), startsAt: r.starts_at, state: r.viewing_status === 'confirmed' || r.viewing_status === 'done' ? 'confirmed' : r.viewing_status === 'cancelled' ? 'not_possible' : 'waiting_owner' })) },
    requests: requests.map(r => ({ id: Number(r.id), status: r.status, preferred: r.preferred, note: r.note, startsAt: r.starts_at || null, createdAt: r.created_at })),
    messages: msgs.reverse().map(m => ({ id: Number(m.id), from: m.sender, kind: m.kind, text: m.body, at: m.created_at })),
    timeline: await eventsOf(room.id, 'staff'),
    documents: await require('./dealRoomDocs').documentsOf(room.id, 'staff'),
    paymentRequests: await require('./dealRoomDocs').paymentsOf(room.id),
    payments: { status: 'coordination_only', note: 'NEXUS holds no money. A payment request is only a request; "verified" needs a provider event or an administrator reconciliation with a reference.' },
  } }
}

async function setStage(agent, id, { stage, note }) {
  const { room } = await roomFor(agent, id)
  if (!allowed(room.stage).includes(stage)) fail('STAGE_NOT_ALLOWED', `From "${LABEL[room.stage]}" the next step is ${allowed(room.stage).map(s => `"${LABEL[s]}"`).join(' or ') || 'none'}.`, 409)
  const text = clean(note, 600) || null
  const u = await db.query(
    `UPDATE deal_rooms SET stage=$2, stage_changed_at=now(), agent_id=COALESCE(agent_id,$4),
            closed_at = CASE WHEN $2 IN ('completed','cancelled') THEN now() ELSE NULL END
      WHERE id=$1 AND stage=$3 RETURNING id`, [room.id, stage, room.stage, agent.id])
  if (!u.rows[0]) fail('STAGE_CHANGED', 'Someone else changed this Deal Room a moment ago. Reload it.', 409)   // optimistic lock
  await event(db, room.id, { kind: 'stage', actor: 'staff', agentId: agent.id, data: { from: room.stage, to: stage } })   // the parties see the step
  if (text) await event(db, room.id, { kind: 'note', actor: 'staff', agentId: agent.id, visibility: 'staff', data: { text, stage } })   // the reason stays internal
  log.info('deal room stage', { id: room.id, from: room.stage, to: stage, by: agent.id })
  return view(agent, id)
}

async function addNote(agent, id, text) {
  const { room } = await roomFor(agent, id)
  const body = clean(text, 1000); if (!body) fail('NOTE_REQUIRED', 'Write a note.')
  await event(db, room.id, { kind: 'note', actor: 'staff', agentId: agent.id, visibility: 'staff', data: { text: body } })
  return view(agent, id)
}

module.exports = { DealError, ensureForViewing, onViewingBooked, onViewingDeclined, forConversation, list, view, setStage, addNote, roomFor, event, LABEL, _test: { allowed, ORDER } }
