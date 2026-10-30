'use strict'
// ============================================================================
// services/locationRequest.js — "Ask for Location" as a persistent,
// traceable request (Kev, 2026-10-30).
//
// Before: POST /schedule-board/listings/:ref/request-location only relayed a
// WhatsApp line to the LISTING AGENT (listingAgentNotify) — in practice Kev's
// own account. Nothing was stored, the owner was never asked, the board showed
// a toast and the requesting agent could not see what happened, which account
// was used, whether the owner answered or where the address was.
//
// Now one row in property_location_requests carries the whole lifecycle:
//   preparing → queued → sent → awaiting_owner → location_received → agent_notified
//   (failed / cancelled at any point). See the migration for the meanings.
//   - The OWNER is asked, from the owner's own source account
//     (availability.pickSourceSession — the same rule every owner question uses).
//   - One open request per property (partial unique index): repeated clicks,
//     two agents or a retry never send a second message while one is open.
//   - "sent" only after WAHA accepted the message. Delivery/read are not
//     claimed: this flow has no provider receipts.
//   - DNC / automation blocks / dnc+angry labels refuse the request
//     (outreachEligibility, force mode = opt-outs only, no timing rules).
//   - A known street on file → no request; nothing is asked twice.
//   - The owner's reply is matched to the open request (pin, map link or a
//     street address); vague replies are recorded as "last owner reply" and
//     the request stays open. Nothing is inferred from vague descriptions.
//   - The canonical properties.street is NOT overwritten: the received
//     location lives on the request with its source message (provenance).
//   - Privacy (crmScheduleBoard header): the exact location is shown to the
//     listing agent, admins, and the requesting agent only when that agent
//     has a recorded viewing for the property. Everyone else sees the state.
// ============================================================================
const db = require('../db')
const log = require('../logger')
const waha = require('../waha')

const OPEN = ['preparing', 'queued', 'sent', 'awaiting_owner']
// A viewing within 4 h without an address is urgent: the agent still has time
// to reach the owner before leaving (the 19:30 case was noticed at ~16:00).
const URGENT_MINUTES = 240
const LABEL = {
  not_requested: 'Not requested',
  preparing: 'Preparing',
  queued: 'Queued',
  sent: 'Sent',
  awaiting_owner: 'Awaiting owner',
  location_received: 'Location received',
  agent_notified: 'Agent notified',
  failed: 'Failed',
  cancelled: 'Cancelled',
  location_available: 'Address on file',
}

const MAPS_LINK_RE = /\bhttps?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|(?:www\.)?google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|maps\.apple\.com|(?:www\.)?waze\.com)\/?[^\s]*/i

function chatIdFor(phone) {
  return `${String(phone || '').replace(/\D/g, '')}@c.us`
}

// ── message wording ─────────────────────────────────────────────────────────
// Greeting/closing follow the send time (waha.sendText → timeGreeting); the
// texts are Kev's examples. Viewing wording only when a viewing is recorded.
function composeMessage({ viewing = null, now = new Date() } = {}) {
  const h = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Europe/Malta' }).format(now))
  const greeting = h >= 5 && h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
  if (viewing) {
    const when = viewingWhen(viewing, now)
    return `${greeting}! Just following up regarding the viewing we've arranged${when ? ` ${when}` : ''}. Could you please share the exact address or location pin so I can make sure my client arrives at the correct place? Thank you!`
  }
  if (greeting === 'Good evening') {
    return 'Good evening! Could you please send me the exact location or a Google Maps pin for the property when you have a moment? I have clients interested and would like to provide them with accurate information. Many thanks!'
  }
  return `${greeting}! Just wanted to check if you could please share the exact address or location pin for the property. My clients have been asking for the location, and I'd like to make sure I have the correct details. Thank you!`
}

function maltaDay(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Malta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

function viewingWhen(viewing, now = new Date()) {
  const at = viewing.starts_at ? new Date(viewing.starts_at) : null
  if (!at) return null
  const day = maltaDay(at)
  const today = maltaDay(now)
  const tomorrow = maltaDay(new Date(now.getTime() + 86400000))
  const h = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Europe/Malta' }).format(at))
  const part = h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'
  if (day === today) return `for this ${part}`
  if (day === tomorrow) return `for tomorrow ${part}`
  return null
}

// ── lookups ─────────────────────────────────────────────────────────────────
async function propertyByRef(ref) {
  const r = await db.query(
    `SELECT p.id, p.ref, p.owner_id, p.street, p.town, p.listed_by_agent_id
       FROM properties p WHERE LOWER(p.ref) = LOWER($1) LIMIT 1`, [String(ref || '').trim()])
  return r.rows[0] || null
}

// The nearest recorded viewing: confirmed or pending, not cancelled, from two
// hours ago up to 7 days ahead. Never invented: no row → no viewing wording.
async function upcomingViewing(propertyId, now = new Date()) {
  const r = await db.query(
    `SELECT id, starts_at, status, viewing_agent_id, viewing_agent_name
       FROM property_viewings
      WHERE property_id = $1 AND status IN ('confirmed','pending') AND starts_at IS NOT NULL
        AND starts_at BETWEEN $2::timestamptz - INTERVAL '2 hours' AND $2::timestamptz + INTERVAL '7 days'
      ORDER BY (status = 'confirmed') DESC, starts_at ASC LIMIT 1`, [propertyId, now.toISOString()])
  return r.rows[0] || null
}

async function latestRequest(propertyId) {
  const r = await db.query(
    `SELECT * FROM property_location_requests WHERE property_id = $1 ORDER BY requested_at DESC, id DESC LIMIT 1`, [propertyId])
  return r.rows[0] || null
}

async function setStatus(id, status, fields = {}) {
  const keys = Object.keys(fields)
  const sets = keys.map((k, i) => `${k} = $${i + 3}`)
  const r = await db.query(
    `UPDATE property_location_requests SET status = $2, updated_at = NOW()${sets.length ? ', ' + sets.join(', ') : ''}
      WHERE id = $1 RETURNING *`, [id, status, ...keys.map(k => fields[k])])
  return r.rows[0]
}

async function logActivity(propertyId, agentId, type, details) {
  await db.query(
    `INSERT INTO property_activities (property_id, agent_id, activity_type, details, is_significant, created_at)
     VALUES ($1, $2, $3, $4, TRUE, NOW())`, [propertyId, agentId || null, type, JSON.stringify(details || {})])
    .catch(err => log.warn('locationRequest: activity write failed', { propertyId, type, err: err.message }))
}

async function notifyAgent(agentId, propertyId, kind, statusLabel, detail) {
  if (!agentId) return
  await db.query(
    `INSERT INTO agent_listing_notifications (agent_id, property_id, kind, status_label, detail, notified_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`, [agentId, propertyId, kind, statusLabel, detail])
    .catch(err => log.warn('locationRequest: notification write failed', { agentId, propertyId, err: err.message }))
}

// ── what a viewer may see ───────────────────────────────────────────────────
async function canSeeLocation(row, viewer, prop) {
  if (!viewer) return false
  if (viewer.role === 'admin') return true
  if (prop && prop.listed_by_agent_id && Number(prop.listed_by_agent_id) === Number(viewer.id)) return true
  const r = await db.query(
    `SELECT 1 FROM property_viewings WHERE property_id = $1 AND viewing_agent_id = $2 AND status IN ('confirmed','pending') LIMIT 1`,
    [row.property_id, viewer.id])
  return r.rows.length > 0
}

async function shape(row, viewer, prop, extra = {}) {
  if (!row) return { status: 'not_requested', label: LABEL.not_requested, ...extra }
  const received = ['location_received', 'agent_notified'].includes(row.status)
  const visible = received && await canSeeLocation(row, viewer, prop)
  return {
    id: row.id, ref: row.ref, status: row.status, label: LABEL[row.status] || row.status,
    open: OPEN.includes(row.status),
    requestedAt: row.requested_at, requestedBy: row.requested_by_name, requestedByAgentId: row.requested_by_agent_id,
    account: row.session_name, sentAt: row.sent_at, error: row.error,
    viewingId: row.viewing_id,
    lastOwnerReplyAt: row.last_owner_reply_at,
    lastOwnerReply: visible || row.requested_by_agent_id === viewer?.id ? (row.last_owner_reply_text || null) : null,
    answeredAt: row.answered_at, answerKind: row.answer_kind,
    location: visible ? {
      mapsUrl: row.maps_url || (row.latitude != null ? `https://www.google.com/maps?q=${row.latitude},${row.longitude}` : null),
      address: row.address_text, latitude: row.latitude, longitude: row.longitude,
      source: 'owner_whatsapp', sourceMessageId: row.answer_message_id, receivedAt: row.answered_at, verified: false,
    } : null,
    locationHidden: received && !visible,
    notifiedAt: row.notified_at,
    ...extra,
  }
}

// ── request ─────────────────────────────────────────────────────────────────
async function requestLocation({ ref, agent, now = new Date() }) {
  const prop = await propertyByRef(ref)
  if (!prop) return { ok: false, httpStatus: 404, error: `#${ref} not found` }

  if (prop.street && String(prop.street).trim()) {
    return { ok: true, request: await shape(null, agent, prop, { status: 'location_available', label: LABEL.location_available }) }
  }
  const last = await latestRequest(prop.id)
  if (last && OPEN.includes(last.status)) return { ok: true, existing: true, request: await shape(last, agent, prop) }
  if (last && ['location_received', 'agent_notified'].includes(last.status)) {
    return { ok: true, existing: true, request: await shape(last, agent, prop) }
  }

  const owner = prop.owner_id ? (await db.query(
    `SELECT id, phone_normalized FROM owner_contacts WHERE id = $1`, [prop.owner_id])).rows[0] : null
  const viewing = await upcomingViewing(prop.id, now)

  let row
  try {
    row = (await db.query(
      `INSERT INTO property_location_requests (property_id, ref, owner_contact_id, requested_by_agent_id, requested_by_name, viewing_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'preparing') RETURNING *`,
      [prop.id, prop.ref, owner?.id || null, agent.id, agent.name || agent.username || null, viewing?.id || null])).rows[0]
  } catch (err) {
    if (err.code === '23505') {   // a concurrent click won the open slot
      return { ok: true, existing: true, request: await shape(await latestRequest(prop.id), agent, prop) }
    }
    throw err
  }
  await logActivity(prop.id, agent.id, 'location_requested', { ref: prop.ref, requestId: row.id, viewingId: viewing?.id || null })

  const fail = async (error, httpStatus = 200) => {
    const failed = await setStatus(row.id, 'failed', { error })
    await logActivity(prop.id, agent.id, 'location_request_failed', { ref: prop.ref, requestId: row.id, error })
    return { ok: false, httpStatus, request: await shape(failed, agent, prop) }
  }

  if (!owner || !owner.phone_normalized) return fail('no_owner_contact')
  const gate = await require('./outreachEligibility').checkBeforeSend({ phone: owner.phone_normalized, force: true, now })
  if (!gate.allowed) return fail(`owner_${gate.reason}`)

  let picked
  try { picked = await require('./availability').pickSourceSession(owner.id) } catch (err) { picked = { session: null, reason: err.message } }
  if (!picked || !picked.session) {
    return fail(picked?.waiting ? `owner_account_offline:${picked.dbSession}` : 'no_working_account')
  }

  const text = composeMessage({ viewing, now })
  const chatId = chatIdFor(owner.phone_normalized)
  row = await setStatus(row.id, 'queued', { session_name: picked.dbSession || picked.session, owner_chat_id: chatId, message_text: text })
  let result
  try {
    result = await waha.sendText(picked.session, chatId, text)
  } catch (err) {
    log.warn('locationRequest: send failed', { ref: prop.ref, session: picked.session, err: err.message })
    return fail(`send_failed:${String(err.message || err).slice(0, 160)}`)
  }
  const sent = await setStatus(row.id, 'awaiting_owner', {
    sent_at: new Date().toISOString(), provider_message_id: result?.key?.id || result?.id || null, error: null,
  })
  await logActivity(prop.id, agent.id, 'location_request_sent', { ref: prop.ref, requestId: row.id, account: sent.session_name })
  if (prop.listed_by_agent_id && Number(prop.listed_by_agent_id) !== Number(agent.id)) {
    await notifyAgent(prop.listed_by_agent_id, prop.id, 'location_requested', 'Location requested',
      `${agent.name || agent.username || 'An agent'} asked the owner of #${prop.ref} for the exact location.`)
  }
  return { ok: true, request: await shape(sent, agent, prop) }
}

async function getStatus({ ref, agent }) {
  const prop = await propertyByRef(ref)
  if (!prop) return { ok: false, httpStatus: 404, error: `#${ref} not found` }
  const request = await shape(await latestRequest(prop.id), agent, prop)
  if (request.status === 'not_requested' && prop.street && String(prop.street).trim()) {
    return { ok: true, request: { ...request, status: 'location_available', label: LABEL.location_available } }
  }
  return { ok: true, request }
}

async function cancelRequest({ ref, agent, reason = 'cancelled_by_agent' }) {
  const prop = await propertyByRef(ref)
  if (!prop) return { ok: false, httpStatus: 404, error: `#${ref} not found` }
  const last = await latestRequest(prop.id)
  if (!last || !OPEN.includes(last.status)) return { ok: true, request: await shape(last, agent, prop) }
  if (agent.role !== 'admin' && Number(last.requested_by_agent_id) !== Number(agent.id)) {
    return { ok: false, httpStatus: 403, error: 'Only the requesting agent can cancel this request.' }
  }
  const row = await setStatus(last.id, 'cancelled', { cancelled_at: new Date().toISOString(), cancel_reason: reason })
  await logActivity(prop.id, agent.id, 'location_request_cancelled', { ref: prop.ref, requestId: last.id })
  return { ok: true, request: await shape(row, agent, prop) }
}

// ── owner reply ─────────────────────────────────────────────────────────────
function pinFrom(payload) {
  const loc = payload?.location
    || payload?._data?.Message?.locationMessage
    || payload?._data?.message?.locationMessage
    || null
  if (!loc) return null
  const lat = Number(loc.latitude ?? loc.degreesLatitude)
  const lng = Number(loc.longitude ?? loc.degreesLongitude)
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
  return { lat, lng, label: loc.address || loc.name || loc.description || null }
}

function locationFrom(text, payload) {
  const pin = pinFrom(payload)
  if (pin) return { kind: 'pin', latitude: pin.lat, longitude: pin.lng, address: pin.label }
  const link = String(text || '').match(MAPS_LINK_RE)
  if (link) return { kind: 'maps_link', mapsUrl: link[0].replace(/[).,]+$/, '') }
  const address = require('./conversationPolicy').extractAddress(text)
  if (address) return { kind: 'address', address }
  return null
}

// Called for every inbound owner DM. Never sends anything to the owner.
async function handleOwnerMessage({ phone, chatId, text, payload = {}, messageId = null, now = new Date() }) {
  const digits = String(phone || '').replace(/\D/g, '')
  if (!digits) return { matched: false }
  const open = (await db.query(
    `SELECT r.* FROM property_location_requests r
       JOIN owner_contacts oc ON oc.id = r.owner_contact_id
      WHERE r.status IN ('sent','awaiting_owner')
        AND right(regexp_replace(COALESCE(oc.phone_normalized,''), '\\D', '', 'g'), 8) = right($1, 8)
      ORDER BY r.sent_at DESC NULLS LAST LIMIT 1`, [digits])).rows[0]
  if (!open) return { matched: false }
  const found = locationFrom(text, payload)
  if (!found) {
    await setStatus(open.id, open.status, { last_owner_reply_at: now.toISOString(), last_owner_reply_text: String(text || '').slice(0, 500) })
    return { matched: true, received: false, requestId: open.id }
  }
  const row = await setStatus(open.id, 'location_received', {
    last_owner_reply_at: now.toISOString(), last_owner_reply_text: String(text || '').slice(0, 500),
    answered_at: now.toISOString(), answer_kind: found.kind, answer_text: String(text || '').slice(0, 1000),
    answer_message_id: messageId, maps_url: found.mapsUrl || null,
    latitude: found.latitude ?? null, longitude: found.longitude ?? null, address_text: found.address || null,
  })
  await logActivity(row.property_id, null, 'location_received', {
    ref: row.ref, requestId: row.id, kind: found.kind, sourceMessageId: messageId,
  })
  await notifyAgent(row.requested_by_agent_id, row.property_id, 'location_received', 'Location received',
    `The owner of #${row.ref} sent the ${found.kind === 'pin' ? 'location pin' : found.kind === 'maps_link' ? 'map link' : 'address'}. Open the listing to view it.`)
  const notified = await setStatus(row.id, 'agent_notified', { notified_at: new Date().toISOString() })
  return { matched: true, received: true, requestId: notified.id, kind: found.kind }
}

// ── viewing urgency ─────────────────────────────────────────────────────────
// "Viewing scheduled — exact location missing": recorded viewings in the next
// 48 h on a property without a street and without a received location. For
// the viewing agent (or all, for an admin), most urgent first.
async function viewingLocationWarnings({ agent, now = new Date() }) {
  const r = await db.query(
    `SELECT v.id AS viewing_id, v.starts_at, v.status AS viewing_status, v.viewing_agent_id, v.viewing_agent_name,
            p.id AS property_id, p.ref,
            lr.id AS request_id, lr.status AS request_status, lr.requested_at, lr.session_name
       FROM property_viewings v
       JOIN properties p ON p.id = v.property_id
       LEFT JOIN LATERAL (
         SELECT * FROM property_location_requests x WHERE x.property_id = p.id ORDER BY x.requested_at DESC LIMIT 1
       ) lr ON TRUE
      WHERE v.status IN ('confirmed','pending') AND v.starts_at IS NOT NULL
        AND v.starts_at BETWEEN $1::timestamptz - INTERVAL '1 hour' AND $1::timestamptz + INTERVAL '48 hours'
        AND (p.street IS NULL OR btrim(p.street) = '')
        AND (lr.status IS NULL OR lr.status NOT IN ('location_received','agent_notified'))
        AND ($2::boolean OR v.viewing_agent_id = $3)
      ORDER BY v.starts_at ASC`, [now.toISOString(), agent.role === 'admin', agent.id])
  return r.rows.map(x => {
    const minutes = Math.round((new Date(x.starts_at) - now) / 60000)
    return {
      viewingId: x.viewing_id, ref: x.ref, startsAt: x.starts_at, viewingStatus: x.viewing_status,
      agentId: x.viewing_agent_id, agentName: x.viewing_agent_name,
      minutesUntil: minutes, urgency: minutes <= URGENT_MINUTES ? 'urgent' : 'soon',
      warning: 'Viewing scheduled — exact location missing',
      request: x.request_id ? { id: x.request_id, status: x.request_status, label: LABEL[x.request_status], requestedAt: x.requested_at, account: x.session_name } : null,
    }
  })
}

module.exports = {
  LABEL, OPEN, composeMessage, locationFrom, requestLocation, getStatus, cancelRequest,
  handleOwnerMessage, viewingLocationWarnings,
}
