'use strict'
// NEXUS Sync calendar 2.0 (2026-11-21, Kev "SYNC UX & Communications 2.0", milestone A).
// The owner's calendar, one home at a time (or all own homes together):
//   state                homes (slot length) + viewings: agency requests/bookings and the owner's own appointments
//   window add           viewing hours as a range ("Monday 14:00-17:00"), optionally every week for up to 12 weeks.
//                        Never replaces other hours (viewingWindows.addWindow supersedes same-day hours, which is
//                        right for chat statements but wrong for a calendar with several ranges per day).
//   window update        move / extend / shorten the owner's own hours; bookings that end up outside are flagged for
//                        the agency (board + calendar), never moved or cancelled
//   appointment          the owner's own viewing (a neighbour, someone outside NEXUS) or a reserved slot,
//                        confirmed at once; stored in property_viewings so agency bookings can never overlap it
//   appointment cancel   only the owner's own appointments; agency viewings are declined through owner/viewings/decide
//   slot length          15 / 30 / 60 minutes per home (account preference); a viewing inside a slot lasts 10 or 20 min
// Two viewings of one home never overlap: checked before writing and enforced by property_viewings_no_overlap.
const db = require('../db')
const log = require('../logger')
const L = require('./nexusOwnerLink')
const { LinkError } = L
const { audit } = L._internal
let W = () => require('./viewingWindows')
const err = (code, message, status = 400) => new LinkError(code, message, status)
const SLOTS = [15, 30, 60]
const LOCK = 290623 // same advisory lock as viewingWindows.addWindow: one writer per home

// ── Malta wall time (DST-safe) ───────────────────────────────────────────────
const PARTS = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
function malta(d) { const p = Object.fromEntries(PARTS.formatToParts(d).map(x => [x.type, x.value])); return { key: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) } }
function maltaDate(key, min) {
  const [y, m, d] = key.split('-').map(Number); const want = Date.UTC(y, m - 1, d, Math.floor(min / 60), min % 60); let t = want
  for (let i = 0; i < 3; i++) { const w = malta(new Date(t)); const [wy, wm, wd] = w.key.split('-').map(Number); t += want - Date.UTC(wy, wm - 1, wd, Math.floor(w.min / 60), w.min % 60) }
  return new Date(t)
}
const dayNo = key => { const [y, m, d] = key.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400e3 }
const hm = min => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
const addDays = (key, n) => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10) }
const label = d => d.toLocaleString('en-GB', { timeZone: 'Europe/Malta', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n)

async function home(S, account, propertyId, perm) {
  const p = (await S.ownedProperties(account, perm)).find(x => x.id === Number(propertyId))
  if (!p) throw err('PROPERTY_NOT_IN_LINK', 'This home is not confirmed for your account.', 404)
  return p
}
function range(start, end, { minMin = 15, maxH = 14 } = {}) {
  const a = new Date(start), b = new Date(end), now = Date.now()
  if (!Number.isFinite(a.getTime()) || !Number.isFinite(b.getTime()) || b <= a || b - a < minMin * 60e3 || b - a > maxH * 3600e3 || a.getTime() < now - 5 * 60e3 || a.getTime() > now + 92 * 86400e3)
    throw err('RANGE_INVALID', `Choose between ${minMin} minutes and ${maxH} hours, within the next three months.`)
  return [a, b]
}
async function overlapping(q, propertyId, a, b, exceptId = null) {
  const { rows: [w] } = await q.query(
    `SELECT id, starts_at, ends_at, source_type FROM property_viewing_windows
      WHERE property_id=$1 AND status='active' AND kind='window' AND id <> COALESCE($4::int, 0)
        AND starts_at < $3::timestamptz AND ends_at > $2::timestamptz
        -- a proposed time or the hour around an accepted viewing never blocks the owner's own hours
        AND COALESCE(source_reference, '') NOT LIKE '%:propose:%' AND source_type <> 'booking_survey'
      ORDER BY starts_at LIMIT 1`, [propertyId, a.toISOString(), b.toISOString(), exceptId])
  return w || null
}
async function provenance(q, propertyId, a, b, reference, evidence) {
  const V = W()
  await V.appendProvenance(q, propertyId, 'viewing_window', V.provenanceEntry({
    value: { start: a.toISOString(), end: b.toISOString() }, sourceType: 'owner_sync', reference, observedAt: new Date(), confidence: 'explicit', evidence, updatedBy: 'owner',
  }))
  await V.refreshPropertyColumns(propertyId, q)
}
async function inTx(propertyId, fn) {
  const q = await db.connect()
  try {
    await q.query('BEGIN'); await q.query('SELECT pg_advisory_xact_lock($1, $2)', [LOCK, propertyId])
    const out = await fn(q); await q.query('COMMIT'); return out
  } catch (e) { await q.query('ROLLBACK').catch(() => {}); throw e } finally { q.release() }
}

// ── read ─────────────────────────────────────────────────────────────────────
async function state(S, account) {
  const props = await S.ownedProperties(account, 'view')
  if (!props.length) return { homes: [], viewings: [] }
  const slot = (account.prefs && account.prefs.slotMinutes) || {}
  const { rows } = await db.query(
    `SELECT pv.id, pv.property_id, p.ref, pv.starts_at, pv.duration_min, pv.status, pv.source, pv.confirmation_method, pv.requester_name,
            pv.owner_survey_status, pv.request_round, pv.agent_justification, pv.owner_decline_text, pv.party_size, pv.viewing_agent_name,
            pv.attention_reason, c.group_type, c.profession
       FROM property_viewings pv JOIN properties p ON p.id=pv.property_id LEFT JOIN clients c ON c.id=pv.client_id
      WHERE pv.property_id = ANY($1::int[]) AND pv.starts_at >= NOW() - INTERVAL '30 days' AND pv.starts_at < NOW() + INTERVAL '120 days'
      ORDER BY pv.starts_at LIMIT 600`, [props.map(p => p.id)])
  return {
    homes: props.map(p => ({ id: p.id, ref: p.ref, role: p.role || 'owner', slotMinutes: SLOTS.includes(Number(slot[String(p.id)])) ? Number(slot[String(p.id)]) : 30 })),
    viewings: rows.map(v => {
      const own = v.source === 'owner_sync'
      return {
        id: v.id, propertyId: v.property_id, ref: v.ref, startsAt: v.starts_at, durationMin: v.duration_min || 20,
        status: v.status, decision: v.owner_survey_status || 'pending', round: v.request_round || 1,
        kind: own ? (v.confirmation_method === 'owner_reserved' ? 'reserved' : 'manual') : 'agency',
        label: own ? (v.requester_name || null) : null, // typed by the owner; agency clients' names are never returned
        note: own ? null : (v.agent_justification || null), declineText: v.owner_decline_text || null,
        party: own ? { size: null, type: null, job: null } : { size: v.party_size || null, type: v.group_type || null, job: v.profession || null },
        agent: own ? null : (v.viewing_agent_name || null),
        attention: v.attention_reason ? 'The agency was told these hours changed; they will re-arrange this viewing.' : null,
      }
    }),
  }
}

// ── viewing hours ────────────────────────────────────────────────────────────
async function addWindows(S, account, { propertyId, start, end, repeatWeeks }) {
  const p = await home(S, account, propertyId, 'schedule')
  const [a, b] = range(start, end)
  const weeks = Math.max(0, Math.min(12, Math.floor(Number(repeatWeeks) || 0)))
  const sa = malta(a), sb = malta(b), dayGap = Math.round((dayNo(sb.key) - dayNo(sa.key)))
  const reference = `sync:${account.public_id}:cal2:${Date.now()}`
  const out = await inTx(p.id, async q => {
    const created = [], skipped = []
    for (let k = 0; k <= weeks; k++) {
      const ka = addDays(sa.key, 7 * k), wa = maltaDate(ka, sa.min), wb = maltaDate(addDays(ka, dayGap), sb.min) // same wall times every week, across DST
      if (wa.getTime() > Date.now() + 92 * 86400e3) break
      if (await overlapping(q, p.id, wa, wb)) { skipped.push(ka); continue }
      const { rows: [w] } = await q.query(
        `INSERT INTO property_viewing_windows (property_id, kind, starts_at, ends_at, source_type, evidence, confidence, observed_at, created_by, source_reference, confirmation)
         VALUES ($1,'window',$2,$3,'owner_sync',$4,'explicit',NOW(),'owner',$5,'full_window') RETURNING id`,
        [p.id, wa.toISOString(), wb.toISOString(), weeks ? `Owner opened weekly viewing hours in the SYNC calendar (${weeks + 1} weeks)` : 'Owner opened viewing hours in the SYNC calendar', reference])
      created.push({ id: w.id, start: wa.toISOString(), end: wb.toISOString(), own: true, proposedFor: null })
    }
    if (!created.length) throw err('WINDOW_OVERLAP', 'You already have viewing hours at this time.', 409)
    await provenance(q, p.id, a, b, reference, 'SYNC calendar 2.0')
    return { created, skipped }
  })
  await audit(db, null, 'SYNC_VIEWING_WINDOW_ADDED', { account: account.public_id, windows: out.created.map(w => w.id), weeks: weeks + 1, skipped: out.skipped.length }, { id: p.id, ref: p.ref })
  return out
}

async function updateWindow(S, account, { propertyId, windowId, start, end }) {
  const p = await home(S, account, propertyId, 'schedule')
  const [a, b] = range(start, end)
  const out = await inTx(p.id, async q => {
    const { rows: [w] } = await q.query(`SELECT id, source_type FROM property_viewing_windows WHERE id=$1 AND property_id=$2 AND status='active' AND kind='window' FOR UPDATE`, [Number(windowId) || 0, p.id])
    if (!w) throw err('WINDOW_NOT_FOUND', 'These viewing hours were not found.', 404)
    if (w.source_type !== 'owner_sync') throw err('WINDOW_NOT_OWN', 'The agency set these hours. Ask them in the chat to change them.', 403)
    if (await overlapping(q, p.id, a, b, w.id)) throw err('WINDOW_OVERLAP', 'Other viewing hours already cover part of this time.', 409)
    await q.query(`UPDATE property_viewing_windows SET starts_at=$2, ends_at=$3, observed_at=NOW(), updated_at=NOW() WHERE id=$1`, [w.id, a.toISOString(), b.toISOString()])
    const flagged = await W().flagBookings(q, `window_id = $1 AND (starts_at < $2::timestamptz OR starts_at + make_interval(mins => COALESCE(duration_min, 20)) > $3::timestamptz)`,
      [w.id, a.toISOString(), b.toISOString()], `Owner changed the viewing hours to ${label(a)}–${hm(malta(b).min)} — this booking is no longer inside them. Not moved; please re-arrange.`)
    await provenance(q, p.id, a, b, `sync:${account.public_id}:cal2:update:${w.id}`, 'Owner moved or resized viewing hours in the SYNC calendar')
    return { window: { id: w.id, start: a.toISOString(), end: b.toISOString(), own: true, proposedFor: null }, flagged: flagged.length }
  })
  await audit(db, null, 'SYNC_VIEWING_WINDOW_CHANGED', { account: account.public_id, window: out.window.id, start: out.window.start, end: out.window.end, flagged: out.flagged }, { id: p.id, ref: p.ref })
  return out
}

// ── the owner's own appointments ─────────────────────────────────────────────
async function appointment(S, account, { propertyId, start, minutes, kind, label: who }) {
  const p = await home(S, account, propertyId, 'schedule')
  const a = new Date(start)
  if (!Number.isFinite(a.getTime()) || a.getTime() < Date.now() - 5 * 60e3 || a.getTime() > Date.now() + 92 * 86400e3) throw err('TIME_INVALID', 'Choose a time within the next three months.')
  const dur = Number(minutes) === 10 ? 10 : 20 // the database allows 10- and 20-minute viewings
  const k = kind === 'reserved' ? 'reserved' : 'manual'
  const name = clean(who, 60) || (k === 'reserved' ? 'Reserved' : 'Own viewing')
  const clash = await S.viewingClash(p.id, a.toISOString(), dur)
  if (clash) throw err('SLOT_TAKEN', `Another viewing is already booked at ${clash}. Choose a free time.`, 409)
  let row
  try {
    ({ rows: [row] } = await db.query(
      `INSERT INTO property_viewings (property_id, viewing_date, starts_at, duration_min, status, source, confirmation_method, requester_name,
                                      viewing_agent_name, owner_survey_status, confirmed_at, owner_decision_at, window_id)
       VALUES ($1, ($2::timestamptz AT TIME ZONE 'Europe/Malta')::date, $2::timestamptz, $3, 'confirmed', 'owner_sync', $4, $5, 'Owner', 'confirmed', NOW(), NOW(),
               (SELECT id FROM property_viewing_windows WHERE property_id=$1 AND status='active' AND kind='window'
                   AND starts_at <= $2::timestamptz AND ends_at >= $2::timestamptz + make_interval(mins => $3::int) ORDER BY id DESC LIMIT 1))
       RETURNING id, starts_at`, [p.id, a.toISOString(), dur, k === 'reserved' ? 'owner_reserved' : 'owner_manual', name]))
  } catch (e) {
    if (e.code === '23P01') throw err('SLOT_TAKEN', 'Another viewing is already booked at this time. Choose a free time.', 409)
    throw e
  }
  await audit(db, null, 'SYNC_OWNER_APPOINTMENT', { account: account.public_id, viewing: row.id, kind: k, start: a.toISOString(), minutes: dur }, { id: p.id, ref: p.ref })
  return { viewing: { id: row.id, propertyId: p.id, startsAt: row.starts_at, durationMin: dur, status: 'confirmed', kind: k, label: name } }
}

async function cancelAppointment(S, account, { viewingId }) {
  const ids = (await S.ownedProperties(account, 'schedule')).map(p => p.id)
  const { rows: [v] } = await db.query(
    `UPDATE property_viewings SET status='cancelled', cancelled_at=NOW(), cancel_reason='owner removed own appointment in SYNC', updated_at=NOW()
      WHERE id=$1 AND source='owner_sync' AND property_id = ANY($2::int[]) AND status IN ('pending','confirmed') RETURNING id, property_id`, [Number(viewingId) || 0, ids])
  if (!v) throw err('APPOINTMENT_NOT_FOUND', 'Only your own appointments can be removed here. Agency viewings are declined from the request.', 404)
  await audit(db, null, 'SYNC_OWNER_APPOINTMENT_REMOVED', { account: account.public_id, viewing: v.id }, { id: v.property_id })
  return { removed: true }
}

// ── slot length per home ─────────────────────────────────────────────────────
async function setSlot(S, account, { propertyId, minutes }) {
  const p = await home(S, account, propertyId, 'view')
  const m = Number(minutes)
  if (!SLOTS.includes(m)) throw err('SLOT_INVALID', 'Choose 15, 30 or 60 minutes.')
  const { rows: [a] } = await db.query(
    `UPDATE sync_accounts SET prefs = jsonb_set(COALESCE(prefs, '{}'::jsonb), '{slotMinutes}', COALESCE(prefs->'slotMinutes', '{}'::jsonb) || jsonb_build_object($2::text, $3::int)), updated_at=NOW()
      WHERE id=$1 RETURNING prefs`, [account.id, String(p.id), m])
  return { slotMinutes: a.prefs.slotMinutes[String(p.id)] }
}

module.exports = { state, addWindows, updateWindow, appointment, cancelAppointment, setSlot, _test: { malta, maltaDate, setWindows: fn => { W = () => fn } } }
