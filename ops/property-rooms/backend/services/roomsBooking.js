'use strict'
// NEXUS Rooms ↔ NEXUS Booking (2026-11-21). NEXUS Booking is the reservation engine: dates, holds, confirmations
// and the whole-apartment / single-room conflict rule (room_stays, atomic in Booking). ARGUS never stores stays.
// Calls are signed: HMAC-SHA256 over "ts.METHOD.path.sha256(body)" with NEXUS_ROOMS_SECRET (same value in
// /etc/nexus-booking.env, the ARGUS env and the website env). Base URL: NEXUS_BOOKING_ROOMS_URL.
const crypto = require('crypto')
const R = require('./propertyRooms')
const L = require('./nexusOwnerLink')
const { LinkError } = L
const { audit } = L._internal
const db = require('../db')
const err = (code, message, status = 400) => new LinkError(code, message, status)

let http = (url, init) => fetch(url, init)
function sign(secret, ts, method, path, body) {
  const h = crypto.createHash('sha256').update(body || '').digest('hex')
  return crypto.createHmac('sha256', secret).update(`${ts}.${method}.${path}.${h}`).digest('hex')
}
async function call(method, path, payload) {
  const secret = process.env.NEXUS_ROOMS_SECRET || ''
  const base = (process.env.NEXUS_BOOKING_ROOMS_URL || 'https://nexuslink.fit').replace(/\/+$/, '')
  if (secret.length < 32) throw err('BOOKING_NOT_CONFIGURED', 'Room bookings are not connected yet.', 503)
  const body = payload === undefined ? '' : JSON.stringify(payload)
  const ts = String(Math.floor(Date.now() / 1000))
  const pathOnly = path.split('?')[0]
  const r = await http(`${base}${path}`, { method, signal: AbortSignal.timeout(12000), headers: { 'content-type': 'application/json', 'X-Nexus-Rooms-Client': 'argus', 'X-Nexus-Rooms-Ts': ts, 'X-Nexus-Rooms-Sig': sign(secret, ts, method, pathOnly, body) }, body: body || undefined }).catch(() => null)
  if (!r) throw err('BOOKING_UNREACHABLE', 'NEXUS Booking is not reachable. Try again in a moment.', 503)
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw err(j.error || 'BOOKING_ERROR', j.message || 'NEXUS Booking refused the request.', r.status >= 400 && r.status < 500 ? r.status : 502)
  return j
}

// Owners see who asked and when; contact details only once they confirmed the stay (the agency mediates before that).
function forOwner(s) {
  const confirmed = s.status === 'confirmed'
  return { id: s.id, unitKey: s.unitKey, unitLabel: s.unitLabel, kind: s.kind, checkIn: s.checkIn, checkOut: s.checkOut, market: s.market, status: s.status,
    holdExpiresAt: s.holdExpiresAt || null, guest: { name: s.guest?.name || null, email: confirmed ? s.guest?.email || null : null, phone: confirmed ? s.guest?.phone || null : null },
    partySize: s.partySize || null, note: s.note || null, createdAt: s.createdAt, history: s.history || [] }
}

async function stays(actor, { propertyId }) {
  const p = await R.property(actor, propertyId, 'view')
  const j = await call('GET', `/api/nexus-booking/rooms/stays?property=${encodeURIComponent(p.ref)}`)
  return { stays: (j.stays || []).map(s => (actor.kind === 'owner' ? forOwner(s) : s)) }
}

const ACTIONS = ['hold', 'confirm', 'decline', 'cancel', 'release']
async function decide(actor, { propertyId, stayId, action, holdHours, note }) {
  const p = await R.property(actor, propertyId, 'edit')
  if (!ACTIONS.includes(action)) throw err('ACTION_INVALID', 'Unknown action.')
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(stayId || ''))) throw err('STAY_INVALID', 'Unknown request.')
  const j = await call('POST', `/api/nexus-booking/rooms/stays/${stayId}/decide`, { propertyRef: p.ref, action, holdHours: Number(holdHours) || undefined, note: String(note || '').slice(0, 300) || undefined, actor: R.actorRef(actor) })
  // a confirmed whole-apartment or room stay is mirrored as the room's status for listings (occupied), never the other way round
  if (action === 'confirm' && j.stay && j.stay.unitKey && j.stay.unitKey.startsWith('room:') && j.stay.checkIn <= new Date().toISOString().slice(0, 10)) {
    await db.query(`UPDATE property_units SET status='occupied', updated_at=now() WHERE id=$1 AND property_id=$2 AND status <> 'occupied'`, [Number(j.stay.unitKey.slice(5)), p.id])
  }
  await audit(db, actor.kind === 'staff' ? actor.agent : null, 'ROOMS_STAY_DECIDED', { by: R.actorRef(actor), stay: stayId, action, status: j.stay && j.stay.status }, { id: p.id, ref: p.ref })
  return { stay: actor.kind === 'owner' ? forOwner(j.stay) : j.stay }
}

module.exports = { stays, decide, sign, _test: { setHttp: fn => { http = fn }, forOwner } }
