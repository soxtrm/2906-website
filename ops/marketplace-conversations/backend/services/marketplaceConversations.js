'use strict'
// ============================================================================
// services/marketplaceConversations.js — NEXUS Marketplace conversations (Claude, 2026-11-21)
//
// Visitor side (public, no account): start a conversation about one listing, write, ask for a viewing.
//   Access = a random token returned once; only its SHA-256 is stored. Every read/write checks it.
// Agency side (CRM staff): inbox grouped by property, reply, book a requested viewing through the real
//   booking engine (owner hours, clash checks -> property_viewings -> the owner's SYNC calendar), decline.
// Rules: the listing agent is assigned; admins see every conversation of the agency, staff their own and
//   unassigned ones. Owner identity and contact data never appear here. A viewing shows as booked only
//   after ARGUS created it, and as confirmed only when property_viewings says so.
// ============================================================================
const crypto = require('crypto')
const db = require('../db')
const log = require('../logger')

const AGENCY = () => process.env.ARGUS_AGENCY_KEY || '2906'
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex')
class MpError extends Error { constructor(code, message, status = 400) { super(message); this.code = code; this.status = status } }
const fail = (code, message, status) => { throw new MpError(code, message, status) }
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max)

// small in-memory rate limits (per process): enough against casual abuse of a public form
const buckets = new Map()
function limit(key, max, windowMs) {
  const now = Date.now(), b = (buckets.get(key) || []).filter(t => now - t < windowMs)
  if (b.length >= max) fail('RATE_LIMITED', 'Too many messages in a short time. Please wait a moment.', 429)
  b.push(now); buckets.set(key, b)
  if (buckets.size > 5000) for (const [k, v] of buckets) if (!v.some(t => now - t < 3600e3)) buckets.delete(k)
}

async function listingFor(ref) {
  const raw = clean(ref, 40)
  if (!/^[A-Za-z0-9-]{2,40}$/.test(raw)) fail('LISTING_INVALID', 'Unknown listing.', 404)
  const prefix = `${AGENCY()}-`
  if (!raw.startsWith(prefix)) fail('LISTING_NOT_AGENCY', 'This listing has no confirmed agency to message yet.', 404)
  const short = raw.slice(prefix.length)
  const { rows: [p] } = await db.query(
    `SELECT id, ref, town, property_type, bedrooms, listed_by_agent_id FROM properties WHERE ref::text = $1 LIMIT 1`, [short])
  if (!p) fail('LISTING_NOT_FOUND', 'This listing is no longer available.', 404)
  return { ...p, publicRef: raw }
}
const titleOf = p => {
  const t = p.property_type ? String(p.property_type).replace(/\b\w/g, c => c.toUpperCase()) : 'Home'
  return `${Number(p.bedrooms) > 0 && !/studio/i.test(t) ? `${p.bedrooms}-Bedroom ` : ''}${t} in ${p.town || 'Malta'}`
}

async function agentCard(id) {
  if (!id) return null
  const { rows: [a] } = await db.query(`SELECT id, COALESCE(NULLIF(alias,''), NULLIF(display_name,''), name, username) AS name, profile_image_url, languages FROM agents WHERE id=$1 AND active`, [id])
  return a ? { id: a.id, name: a.name, photo: a.profile_image_url || null, languages: a.languages || null } : null
}

async function conversationFor(id, token) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) fail('CONVERSATION_NOT_FOUND', 'Conversation not found.', 404)
  const { rows: [c] } = await db.query(`SELECT * FROM mp_conversations WHERE id=$1`, [id])
  if (!c || !token || !crypto.timingSafeEqual(Buffer.from(c.token_hash), Buffer.from(sha(token)))) fail('CONVERSATION_NOT_FOUND', 'Conversation not found.', 404)
  return c
}

// requests with the live ARGUS state of a booked viewing
async function requestsOf(conversationId) {
  const { rows } = await db.query(
    `SELECT r.id, r.preferred, r.note, r.status, r.created_at, r.decided_at, pv.starts_at, pv.status AS viewing_status
       FROM mp_viewing_requests r LEFT JOIN property_viewings pv ON pv.id = r.property_viewing_id
      WHERE r.conversation_id=$1 ORDER BY r.id`, [conversationId])
  return rows.map(r => ({
    id: Number(r.id), preferred: r.preferred, note: r.note, createdAt: r.created_at,
    // requested -> booked (waiting for the owner) -> confirmed by the owner / not possible
    state: r.status === 'booked' ? (r.viewing_status === 'confirmed' || r.viewing_status === 'done' ? 'confirmed' : r.viewing_status === 'cancelled' ? 'not_possible' : 'waiting_owner') : r.status,
    startsAt: r.starts_at || null,
  }))
}
const messagesOf = async conversationId => (await db.query(
  `SELECT id, sender, kind, body, meta, created_at FROM mp_messages WHERE conversation_id=$1 ORDER BY id LIMIT 500`, [conversationId])).rows
  .map(m => ({ id: Number(m.id), from: m.sender, kind: m.kind, text: m.body, meta: m.meta, at: m.created_at }))

async function addMessage(q, conversationId, { sender, agentId = null, kind = 'text', body, meta = {} }) {
  const { rows: [m] } = await q.query(
    `INSERT INTO mp_messages (conversation_id, sender, agent_id, kind, body, meta) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING id, created_at`,
    [conversationId, sender, agentId, kind, body, JSON.stringify(meta)])
  await q.query(
    `UPDATE mp_conversations SET last_message_at=now(),
            staff_unread = staff_unread + CASE WHEN $2 = 'visitor' THEN 1 ELSE 0 END,
            visitor_unread = visitor_unread + CASE WHEN $2 <> 'visitor' THEN 1 ELSE 0 END
      WHERE id=$1`, [conversationId, sender])
  return m
}

const PARTS = ['morning', 'afternoon', 'evening']
function preferredOf(list) {
  const out = []
  for (const p of Array.isArray(list) ? list.slice(0, 3) : []) {
    const date = String(p?.date || '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const t = new Date(`${date}T12:00:00Z`).getTime()
    if (!Number.isFinite(t) || t < Date.now() - 86400e3 || t > Date.now() + 92 * 86400e3) continue
    out.push({ date, part: PARTS.includes(p?.part) ? p.part : 'any' })
  }
  return out
}

async function notifyStaff(text) {
  try { await require('./syncAccount').staffNotice(text) } catch (e) { log.warn('marketplace staff notice failed', { err: e.message }) }
}

// ── visitor ──────────────────────────────────────────────────────────────────
async function start({ ref, name, email, phone, role, message, ip }) {
  const ipHash = sha(`mp:${ip || ''}`).slice(0, 32)
  limit(`start:${ipHash}`, 6, 3600e3)
  const p = await listingFor(ref)
  const visitorName = clean(name, 120), body = clean(message, 2000)
  const mail = clean(email, 254).toLowerCase(), tel = clean(phone, 32).replace(/[^\d+ ]/g, '')
  if (!visitorName) fail('NAME_REQUIRED', 'Please add your name.')
  if (!body) fail('MESSAGE_REQUIRED', 'Please write a message.')
  if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) fail('EMAIL_INVALID', 'This e-mail address looks wrong.')
  if (!mail && tel.replace(/\D/g, '').length < 7) fail('CONTACT_REQUIRED', 'Add an e-mail or a phone number so the agency can answer you.')
  const token = crypto.randomBytes(24).toString('base64url')
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { rows: [c] } = await client.query(
      `INSERT INTO mp_conversations (agency_key, property_id, listing_ref, assigned_agent_id, visitor_name, visitor_email, visitor_phone, visitor_role, token_hash, created_ip_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [AGENCY(), p.id, p.publicRef, p.listed_by_agent_id || null, visitorName, mail || null, tel || null, role === 'agent' ? 'agent' : 'home-seeker', sha(token), ipHash])
    await addMessage(client, c.id, { sender: 'visitor', body })
    await client.query('COMMIT')
    notifyStaff(`New Marketplace message about Ref ${p.publicRef} (${titleOf(p)}). Open CRM > Marketplace inbox.`)
    return { conversation: await visitorView(c.id), token }
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
}

async function visitorView(id) {
  const { rows: [c] } = await db.query(
    `SELECT c.*, p.ref AS pref, p.town, p.property_type, p.bedrooms FROM mp_conversations c LEFT JOIN properties p ON p.id=c.property_id WHERE c.id=$1`, [id])
  return {
    id: c.id, ref: c.listing_ref, title: c.pref ? titleOf(c) : `Ref ${c.listing_ref}`, status: c.status, role: c.visitor_role,
    agent: await agentCard(c.assigned_agent_id), agency: { key: c.agency_key },
    messages: await messagesOf(id), requests: await requestsOf(id), unread: c.visitor_unread,
  }
}

async function read({ id, token }) {
  const c = await conversationFor(id, token)
  const view = await visitorView(c.id)            // shows how many were new, then marks them read
  await db.query(`UPDATE mp_conversations SET visitor_unread=0 WHERE id=$1`, [c.id])
  return { conversation: view }
}

async function visitorSend({ id, token, body }) {
  const c = await conversationFor(id, token)
  if (c.status !== 'open') fail('CONVERSATION_CLOSED', 'This conversation was closed by the agency.', 409)
  limit(`msg:${c.id}`, 20, 600e3)
  const text = clean(body, 2000)
  if (!text) fail('MESSAGE_REQUIRED', 'Please write a message.')
  await addMessage(db, c.id, { sender: 'visitor', body: text })
  return { conversation: await visitorView(c.id) }
}

async function requestViewing({ id, token, preferred, note }) {
  const c = await conversationFor(id, token)
  if (c.status !== 'open') fail('CONVERSATION_CLOSED', 'This conversation was closed by the agency.', 409)
  limit(`req:${c.id}`, 4, 3600e3)
  const pref = preferredOf(preferred)
  if (!pref.length) fail('PREFERRED_REQUIRED', 'Choose at least one day within the next three months.')
  const { rows: [open] } = await db.query(`SELECT id FROM mp_viewing_requests WHERE conversation_id=$1 AND status='requested' LIMIT 1`, [c.id])
  if (open) fail('REQUEST_OPEN', 'Your viewing request is already with the agency.', 409)
  const text = clean(note, 700) || null
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { rows: [r] } = await client.query(
      `INSERT INTO mp_viewing_requests (conversation_id, property_id, listing_ref, preferred, note) VALUES ($1,$2,$3,$4::jsonb,$5) RETURNING id`,
      [c.id, c.property_id, c.listing_ref, JSON.stringify(pref), text])
    const days = pref.map(x => `${new Date(`${x.date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}${x.part !== 'any' ? ` (${x.part})` : ''}`).join(', ')
    await addMessage(client, c.id, { sender: 'visitor', kind: 'viewing_request', body: `Viewing request: ${days}${text ? `. ${text}` : ''}`, meta: { requestId: Number(r.id) } })
    await client.query('COMMIT')
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
  notifyStaff(`Viewing request on the Marketplace for Ref ${c.listing_ref}. Open CRM > Marketplace inbox.`)
  return { conversation: await visitorView(c.id) }
}

// ── agency staff ─────────────────────────────────────────────────────────────
const canSee = (agent, c) => c.agency_key === AGENCY() && (agent.role === 'admin' || c.assigned_agent_id === agent.id || c.assigned_agent_id == null)
async function staffConversation(agent, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) fail('CONVERSATION_NOT_FOUND', 'Conversation not found.', 404)
  const { rows: [c] } = await db.query(`SELECT * FROM mp_conversations WHERE id=$1`, [id])
  if (!c || !canSee(agent, c)) fail('CONVERSATION_NOT_FOUND', 'Conversation not found.', 404)
  return c
}

async function inbox(agent, { q = '', filter = 'all' } = {}) {
  const vals = [AGENCY()]; let where = 'c.agency_key=$1'
  if (agent.role !== 'admin') { vals.push(agent.id); where += ` AND (c.assigned_agent_id=$${vals.length} OR c.assigned_agent_id IS NULL)` }
  if (filter === 'unread') where += ' AND c.staff_unread > 0'
  if (filter === 'requests') where += ` AND EXISTS (SELECT 1 FROM mp_viewing_requests r WHERE r.conversation_id=c.id AND r.status='requested')`
  if (filter === 'closed') where += ` AND c.status='closed'`; else where += ` AND c.status='open'`
  const term = clean(q, 80)
  if (term) { vals.push(`%${term.toLowerCase()}%`); where += ` AND (lower(c.visitor_name) LIKE $${vals.length} OR lower(c.listing_ref) LIKE $${vals.length} OR lower(coalesce(p.town,'')) LIKE $${vals.length})` }
  const { rows } = await db.query(
    `SELECT c.id, c.listing_ref, c.property_id, c.visitor_name, c.visitor_role, c.staff_unread, c.status, c.last_message_at, c.assigned_agent_id,
            p.town, p.property_type, p.bedrooms, p.ref AS pref,
            (SELECT body FROM mp_messages m WHERE m.conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_text,
            (SELECT sender FROM mp_messages m WHERE m.conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_from,
            (SELECT count(*)::int FROM mp_viewing_requests r WHERE r.conversation_id=c.id AND r.status='requested') AS open_requests,
            COALESCE(NULLIF(a.alias,''), NULLIF(a.display_name,''), a.name) AS agent_name
       FROM mp_conversations c LEFT JOIN properties p ON p.id=c.property_id LEFT JOIN agents a ON a.id=c.assigned_agent_id
      WHERE ${where} ORDER BY c.last_message_at DESC LIMIT 300`, vals)
  const groups = new Map()
  for (const r of rows) {
    const g = groups.get(r.listing_ref) || { ref: r.listing_ref, propertyId: r.property_id, title: r.pref ? titleOf(r) : `Ref ${r.listing_ref}`, unread: 0, openRequests: 0, lastAt: r.last_message_at, conversations: [] }
    g.unread += r.staff_unread; g.openRequests += r.open_requests
    g.conversations.push({ id: r.id, visitor: r.visitor_name, role: r.visitor_role, unread: r.staff_unread, status: r.status, lastAt: r.last_message_at,
      lastText: r.last_text ? String(r.last_text).slice(0, 140) : '', lastFrom: r.last_from, openRequests: r.open_requests, agent: r.agent_name || null })
    groups.set(r.listing_ref, g)
  }
  const list = [...groups.values()]
  return { groups: list, totals: { conversations: rows.length, unread: list.reduce((n, g) => n + g.unread, 0), openRequests: list.reduce((n, g) => n + g.openRequests, 0) } }
}

async function unreadCount(agent) {
  const vals = [AGENCY()]; let where = `agency_key=$1 AND status='open'`
  if (agent.role !== 'admin') { vals.push(agent.id); where += ` AND (assigned_agent_id=$2 OR assigned_agent_id IS NULL)` }
  const { rows: [r] } = await db.query(`SELECT COALESCE(sum(staff_unread),0)::int AS n FROM mp_conversations WHERE ${where}`, vals)
  return { unread: r.n }
}

async function staffView(agent, id) {
  const c = await staffConversation(agent, id)
  await db.query(`UPDATE mp_conversations SET staff_unread=0 WHERE id=$1`, [c.id])
  const { rows: [p] } = c.property_id ? await db.query(`SELECT id, ref, town, property_type, bedrooms FROM properties WHERE id=$1`, [c.property_id]) : { rows: [] }
  return { conversation: {
    id: c.id, ref: c.listing_ref, propertyId: c.property_id, title: p ? titleOf(p) : `Ref ${c.listing_ref}`, status: c.status,
    visitor: { name: c.visitor_name, email: c.visitor_email, phone: c.visitor_phone, role: c.visitor_role },
    agent: await agentCard(c.assigned_agent_id), messages: await messagesOf(c.id), requests: await requestsOf(c.id), createdAt: c.created_at,
  } }
}

async function staffSend(agent, id, body) {
  const c = await staffConversation(agent, id)
  const text = clean(body, 2000)
  if (!text) fail('MESSAGE_REQUIRED', 'Please write a message.')
  await addMessage(db, c.id, { sender: 'staff', agentId: agent.id, body: text })
  if (c.assigned_agent_id == null) await db.query(`UPDATE mp_conversations SET assigned_agent_id=$2 WHERE id=$1 AND assigned_agent_id IS NULL`, [c.id, agent.id])
  return staffView(agent, id)
}

async function staffBook(agent, id, requestId, { startsAt, durationMin }) {
  const c = await staffConversation(agent, id)
  const { rows: [r] } = await db.query(`SELECT * FROM mp_viewing_requests WHERE id=$1 AND conversation_id=$2`, [Number(requestId) || 0, c.id])
  if (!r) fail('REQUEST_NOT_FOUND', 'Request not found.', 404)
  if (r.status !== 'requested') fail('REQUEST_DONE', 'This request was already handled.', 409)
  if (!c.property_id) fail('LISTING_NOT_FOUND', 'The listing is no longer linked.', 409)
  const at = new Date(startsAt)
  if (!Number.isFinite(at.getTime()) || at.getTime() < Date.now()) fail('TIME_INVALID', 'Choose a time in the future.')
  const { rows: [prop] } = await db.query(`SELECT * FROM properties WHERE id=$1`, [c.property_id])
  const { rows: [me] } = await db.query(`SELECT id, username, name, alias FROM agents WHERE id=$1`, [agent.id])
  const engine = require('./bookingEngine')
  const res = await engine.createSlotBooking({
    prop, me, bookingAgent: null, startsAt: at.toISOString(), durationMin: [10, 20].includes(Number(durationMin)) ? Number(durationMin) : 20,
    appointmentType: 'first_view', partyLabel: c.visitor_name, partySize: null,
    notes: `NEXUS Marketplace enquiry (${c.visitor_role === 'agent' ? 'agent for a client' : 'home seeker'}), conversation ${c.id}`,
  })
  if (!res || res.error) fail('BOOKING_REFUSED', (res && res.message) || 'This time cannot be booked.', 409)
  await db.query(`UPDATE mp_viewing_requests SET status='booked', property_viewing_id=$2, decided_by=$3, decided_at=now() WHERE id=$1`, [r.id, res.id, agent.id])
  const label = at.toLocaleString('en-GB', { timeZone: 'Europe/Malta', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  await addMessage(db, c.id, { sender: 'system', kind: 'viewing_update', agentId: agent.id, body: `Viewing requested for ${label}. The owner confirms it; you will see the answer here.`, meta: { requestId: Number(r.id), state: 'waiting_owner', startsAt: at.toISOString() } })
  return staffView(agent, id)
}

async function staffDecline(agent, id, requestId, note) {
  const c = await staffConversation(agent, id)
  const u = await db.query(`UPDATE mp_viewing_requests SET status='declined', decided_by=$3, decided_at=now() WHERE id=$1 AND conversation_id=$2 AND status='requested' RETURNING id`, [Number(requestId) || 0, c.id, agent.id])
  if (!u.rows[0]) fail('REQUEST_DONE', 'This request was already handled.', 409)
  await addMessage(db, c.id, { sender: 'system', kind: 'viewing_update', agentId: agent.id, body: `The agency could not offer a viewing for these days.${clean(note, 400) ? ` ${clean(note, 400)}` : ''}`, meta: { requestId: Number(requestId), state: 'declined' } })
  return staffView(agent, id)
}

async function staffClose(agent, id, closed = true) {
  const c = await staffConversation(agent, id)
  await db.query(`UPDATE mp_conversations SET status=$2 WHERE id=$1`, [c.id, closed ? 'closed' : 'open'])
  return staffView(agent, id)
}

module.exports = { MpError, start, read, visitorSend, requestViewing, inbox, unreadCount, staffView, staffSend, staffBook, staffDecline, staffClose, _test: { buckets } }
