'use strict'
// ============================================================================
// services/listingAgentNotify.js — Schedule-board WhatsApp fan-out
//
// PURPOSE
//   When a board operator clicks "Request Availability" / "Request
//   Viewing-Location" / "Comment" on a card that belongs to ANOTHER
//   agent's listing (listed_by_agent_id IS NOT NULL), the system
//   routes a WhatsApp message to that listing agent. This module owns
//   the template text + WA send + agent-session resolution.
//
//   The opposite case (operator's own listing → Fall A) is a Copy-`!av`
//   button that does NOT call any backend. The clipboard copy happens
//   client-side in handlers/contactBoards.js.
//
// INPUTS
//   - operator: { email, name? } — the JWT/cookie holder
//   - ref: '2906-045' — the @2906-XXX card ref
//   - note?: string — up to 1000 chars
//   - agentRow: { id, username, name, whatsapp_phones[], whatsapp_session, ... }
//     from the `agents` table. Resolved by the route handler via
//     `properties.listed_by_agent_id` → `agents.id`.
//
// OUTPUTS
//   - { ok, sentMessageId, channel, session } on success
//   - throws on failure (route handler catches and writes audit row
//     with status='failed')
//
// NEVER
//   - never sends to Kev's own number (listed_by_agent_id must be
//     someone else's row)
//   - never sends to a LKD/disabled session
//   - never blocks the HTTP response (the route handler runs this
//     in a fire-and-forget IIFE)
// ============================================================================

const db   = require('../db')
const log  = require('../logger')
const crypto = require('crypto')
const sessionRouter = require('../lib/sessionRouter')

const MAX_NOTE_LEN = 1000

// ── Template text builders ───────────────────────────────────────────────────
// Each is a pure function so the operator can read them in isolation.

function availabilityTemplate(operator, ref, note) {
  const op = operator.name || operator.email?.split('@')[0] || 'an operator'
  return `Hi — ${op} requested availability for #${ref}.` +
         (note ? `
Note: ${note}` : '') +
         `
Reply here with the next available viewing slot.`
}

function locationTemplate(operator, ref) {
  const op = operator.name || operator.email?.split('@')[0] || 'an operator'
  return `Hi — ${op} requested the viewing location for #${ref}. ` +
         `Could you share the exact address? We'll only use it 1:1.`
}

function commentTemplate(operator, ref, note) {
  const op = operator.name || operator.email?.split('@')[0] || 'an operator'
  return `Hi — ${op} commented on #${ref}:
"${note}"`
}

// ── Agent session resolution ───────────────────────────────────────────────
// An internal agent notification must leave through an ARGUS bridge session.
// The old code selected the recipient agent's own WAHA session and sent to
// that same agent's phone. That self-send is why ASK could preview correctly
// for every account and still fail at delivery. The central router owns live
// bridge selection, sequential failover, queuing and idempotency.
async function resolveAgentSession() {
  const working = await sessionRouter.getWorkingSessionNames()
  return sessionRouter.SESSIONS_PRIORITY.find(name => working.includes(name)) || null
}

// ── JID builder ─────────────────────────────────────────────────────────────
// Plain phone → E.164 → '<digits>@c.us'. Self-prefix only if the phone
// passes the 8-digit Malta check; otherwise leave it as-is and let WAHA
// resolve.
function phoneToJid(phone) {
  if (!phone) return null
  const digits = String(phone).replace(/[^0-9]/g, '')
  if (!digits || digits.length < 7) return null
  return `${digits}@c.us`
}

// ── Audit row writer ───────────────────────────────────────────────────────
// Called AFTER the WA send succeeds. Lives in this file so the route
// handler doesn't need to know the table schema.
async function writeAuditRow({ ref, requestedBy, note, source, status, sentMessageId, error }) {
  try {
    await db.query(
      `INSERT INTO availability_requests
         (listing_id, requested_by, note, status, source, error_message, sent_message_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
       RETURNING id, listing_id, requested_by, note, status, source, created_at`,
      [ref, requestedBy, String(note || '').slice(0, MAX_NOTE_LEN), status, source,
       error ? String(error).slice(0, 500) : null, sentMessageId || null]
    )
  } catch (e) {
    log.warn('listingAgentNotify: writeAuditRow failed', { ref, err: e.message })
  }
}

// ── Common send path ───────────────────────────────────────────────────────
async function sendToAgent({ agentRow, text, ref, requestedBy, source, note }) {
  const phones = agentRow.whatsapp_phones || []
  const jid = phoneToJid(phones[0])
  if (!jid) {
    throw new Error(`Agent ${agentRow.username} has no whatsapp phone on file`)
  }
  const preferredSession = await resolveAgentSession()
  let delivery
  try {
    delivery = await sessionRouter.sendWhatsApp({
      destination: jid,
      payload: text,
      context: { source, ref, recipientAgentId: agentRow.id },
      preferredSession,
      idempotencyKey: `listing-agent:${crypto.randomUUID()}`,
      conversationId: `agent:${agentRow.id}`,
      affinityKind: 'internal-agent',
      messageType: source || 'schedule-board-agent',
    })
  } catch (e) {
    log.warn('listingAgentNotify: routed send failed', { ref, err: e.message })
    await writeAuditRow({ ref, requestedBy, note, source, status: 'failed', error: e.message })
    throw e
  }
  const delivered = delivery.state === 'DELIVERED'
  const queued = delivery.state === 'WAITING_FOR_WHATSAPP'
  if (!delivered && !queued) {
    const error = `Internal agent delivery ended in ${delivery.state || 'an unknown state'}`
    await writeAuditRow({ ref, requestedBy, note, source, status: 'failed', error })
    throw new Error(error)
  }
  const sentMessageId = delivery.deliveredMessageId || null
  const session = delivery.deliveredSession || preferredSession || null
  await writeAuditRow({ ref, requestedBy, note, source, status: delivered ? 'sent' : 'queued', sentMessageId })
  log.info('listingAgentNotify: routed', { ref, state: delivery.state, session, agent: agentRow.username, source })
  return { ok: true, queued, state: delivery.state, sentMessageId, channel: 'whatsapp', session }
}

// ── Public API: 3 functions ────────────────────────────────────────────────
async function requestAvailability({ operator, ref, note, agentRow }) {
  const text = availabilityTemplate(operator, ref, note)
  return sendToAgent({
    agentRow, text, ref,
    requestedBy: operator.email || 'schedule-board',
    source: 'schedule-board-availability',
    note,
  })
}

async function requestLocation({ operator, ref, agentRow }) {
  const text = locationTemplate(operator, ref)
  return sendToAgent({
    agentRow, text, ref,
    requestedBy: operator.email || 'schedule-board',
    source: 'schedule-board-location',
    note: null,
  })
}

async function sendComment({ operator, ref, note, agentRow }) {
  if (!note || !note.trim()) {
    throw new Error('comment requires a non-empty note')
  }
  const text = commentTemplate(operator, ref, note.trim().slice(0, MAX_NOTE_LEN))
  return sendToAgent({
    agentRow, text, ref,
    requestedBy: operator.email || 'schedule-board',
    source: 'schedule-board-comment',
    note: note.trim().slice(0, MAX_NOTE_LEN),
  })
}

module.exports = {
  resolveAgentSession,
  availabilityTemplate,
  locationTemplate,
  commentTemplate,
  requestAvailability,
  requestLocation,
  sendComment,
  // exports for unit testing
  _internal: { phoneToJid, writeAuditRow },
}
