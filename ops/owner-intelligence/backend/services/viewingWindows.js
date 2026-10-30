'use strict'
// ============================================================================
// services/viewingWindows.js — owner-confirmed viewing availability.
// ARGUS booking engine (Kev, 2026-09-23).
//
// A window ("Tuesday 4–6pm") is what makes a property bookable: slots only
// exist inside one. A from-date ("viewings from 15 October") makes it
// requestable from that day and stops the automatic re-asking until then.
//
// Truth: property_viewing_windows. properties.viewing_window_start/_end/
// viewings_from_date/viewing_date are the denormalised "next window" the board
// sorts and badges on — rewritten by refreshPropertyColumns() after every
// change, never written anywhere else.
//
// Newer owner evidence wins: an owner correcting the same day supersedes the
// older window; a statement older than what is already stored is ignored.
// ============================================================================
const db = require('../db')
const log = require('../logger')
const { maltaDateStr, maltaParts, maltaToUtc } = require('../lib/maltaTime')

function provenanceEntry({ value, sourceType, reference, observedAt, confidence, evidence, updatedBy }) {
  return {
    value, source_type: sourceType, source_reference: reference || null,
    observed_at: new Date(observedAt || Date.now()).toISOString(),
    confidence: confidence || 'explicit',
    explicit_or_inferred: confidence === 'approximate' ? 'inferred' : 'explicit',
    evidence: evidence ? String(evidence).slice(0, 200) : null,
    updated_by: updatedBy || 'owner',
  }
}

async function appendProvenance(client, propertyId, field, entry) {
  await client.query(
    `UPDATE properties
        SET field_provenance = jsonb_set(COALESCE(field_provenance, '{}'::jsonb), ARRAY[$2::text],
              COALESCE(field_provenance -> $2, '[]'::jsonb) || $3::jsonb, true)
      WHERE id = $1`,
    [propertyId, field, JSON.stringify([entry])])
}

async function listActiveWindows(propertyId, { includePast = false } = {}) {
  const r = await db.query(
    `SELECT id, kind, starts_at, ends_at, from_date, source_type, evidence, confidence, observed_at, created_by, confirmation
       FROM property_viewing_windows
      WHERE property_id = $1 AND status = 'active'
        AND ($2::boolean OR kind = 'from_date' OR ends_at > NOW())
      ORDER BY COALESCE(starts_at, from_date::timestamptz) ASC`,
    [propertyId, includePast])
  return r.rows
}

// Rewrite the property row's "next window" columns from the windows table.
async function refreshPropertyColumns(propertyId, client = db) {
  await client.query(
    `WITH nxt AS (
       SELECT starts_at, ends_at FROM property_viewing_windows
        WHERE property_id = $1 AND status = 'active' AND kind = 'window' AND ends_at > NOW()
        ORDER BY starts_at ASC LIMIT 1),
     fd AS (
       SELECT from_date FROM property_viewing_windows
        WHERE property_id = $1 AND status = 'active' AND kind = 'from_date'
          AND from_date >= CURRENT_DATE - 21
        ORDER BY observed_at DESC LIMIT 1)
     UPDATE properties p
        SET viewing_window_start = (SELECT starts_at FROM nxt),
            viewing_window_end   = (SELECT ends_at FROM nxt),
            viewings_from_date   = (SELECT from_date FROM fd),
            viewing_date         = COALESCE((SELECT starts_at AT TIME ZONE 'Europe/Malta' FROM nxt),
                                            (SELECT from_date::timestamp FROM fd), p.viewing_date),
            viewing_window_updated_at = NOW()
      WHERE p.id = $1`,
    [propertyId])
}

// Add an owner-confirmed window / from-date. Returns { id, action } where
// action is 'created' | 'unchanged' | 'stale'.
//   w = { kind: 'window', start, end } | { kind: 'from_date', fromDate }
//   meta = { sourceType, evidence, confidence, observedAt, createdBy, reference }
async function addWindow(propertyId, w, meta = {}) {
  const observedAt = new Date(meta.observedAt || Date.now())
  const client = await db.connect()
  const q = client
  try {
    await q.query('BEGIN')
    // one writer per property at a time
    await q.query('SELECT pg_advisory_xact_lock(290623, $1)', [propertyId])

    let sameScope
    if (w.kind === 'window') {
      const day = maltaDateStr(new Date(w.start))
      sameScope = await q.query(
        `SELECT id, starts_at, ends_at, observed_at, source_reference FROM property_viewing_windows
          WHERE property_id = $1 AND status = 'active' AND kind = 'window'
            AND (starts_at AT TIME ZONE 'Europe/Malta')::date = $2::date`,
        [propertyId, day])
      const same = sameScope.rows.find(x =>
        new Date(x.starts_at).getTime() === new Date(w.start).getTime() &&
        new Date(x.ends_at).getTime() === new Date(w.end).getTime())
      if (same) { await q.query('COMMIT'); return { id: same.id, action: 'unchanged' } }
    } else {
      sameScope = await q.query(
        `SELECT id, from_date, observed_at, source_reference FROM property_viewing_windows
          WHERE property_id = $1 AND status = 'active' AND kind = 'from_date'`, [propertyId])
      const same = sameScope.rows.find(x => String(x.from_date instanceof Date ? x.from_date.toISOString() : x.from_date).slice(0, 10) === w.fromDate)
      if (same) { await q.query('COMMIT'); return { id: same.id, action: 'unchanged' } }
    }
    // A newer statement for the same day (or a newer from-date) already exists → this one is stale.
    if (sameScope.rows.some(x => new Date(x.observed_at) > observedAt)) {
      await q.query('COMMIT')
      return { id: null, action: 'stale' }
    }
    // Windows from the SAME message ("Tuesday 10am and 4pm") are siblings, not
    // corrections; anything from an earlier (or a different) message is replaced.
    const ref = meta.reference || null
    const supersededIds = sameScope.rows
      .filter(x => w.kind === 'from_date' || !ref || x.source_reference !== ref)
      .map(x => x.id)
    if (supersededIds.length) {
      await q.query(
        `UPDATE property_viewing_windows SET status = 'superseded', updated_at = NOW() WHERE id = ANY($1::int[])`,
        [supersededIds])
    }
    const ins = await q.query(
      `INSERT INTO property_viewing_windows
         (property_id, kind, starts_at, ends_at, from_date, source_type, evidence, confidence, observed_at, created_by, source_reference, confirmation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [propertyId, w.kind, w.kind === 'window' ? w.start : null, w.kind === 'window' ? w.end : null,
       w.kind === 'from_date' ? w.fromDate : null, meta.sourceType || 'owner_chat',
       meta.evidence ? String(meta.evidence).slice(0, 500) : null, meta.confidence || 'explicit',
       observedAt.toISOString(), meta.createdBy || null, meta.reference || null,
       w.kind === 'window' ? (w.confirmation || 'full_window') : 'full_window'])
    // Bookings on a superseded window are NEVER moved. One that still sits in
    // owner-confirmed time of the new window is simply re-pointed; every other
    // one is FLAGGED for its agents (board notification + ⚠ calendar update).
    let flagged = []
    if (supersededIds.length && w.kind === 'window') {
      const conf = w.confirmation || 'full_window'
      await q.query(
        `UPDATE property_viewings SET window_id = $2, updated_at = NOW()
          WHERE window_id = ANY($1::int[]) AND status IN ('pending','confirmed')
            AND starts_at >= $3 AND starts_at + make_interval(mins => duration_min) <= $4
            AND ($5 = 'full_window' OR starts_at = $3)`,
        [supersededIds, ins.rows[0].id, w.start, w.end, conf])
      flagged = await flagBookings(q, `window_id = ANY($1::int[])`, [supersededIds],
        `Owner changed the viewing time to ${windowLabel({ kind: 'window', starts_at: w.start, ends_at: w.end })} — this booking is no longer inside owner-confirmed time. Not moved; please re-arrange.`)
    }
    await appendProvenance(q, propertyId, w.kind === 'window' ? 'viewing_window' : 'viewings_from', provenanceEntry({
      value: w.kind === 'window' ? { start: w.start, end: w.end } : w.fromDate,
      sourceType: meta.sourceType || 'owner_chat', reference: meta.reference,
      observedAt, confidence: meta.confidence, evidence: meta.evidence, updatedBy: meta.createdBy,
    }))
    await refreshPropertyColumns(propertyId, q)
    await q.query('COMMIT')
    log.info('[viewingWindows] window stored', { propertyId, kind: w.kind, id: ins.rows[0].id, superseded: supersededIds.length, flagged: flagged.length, source: meta.sourceType })
    return { id: ins.rows[0].id, action: 'created', superseded: supersededIds, flagged }
  } catch (err) {
    await q.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

// Flag live bookings matching `where` (params start at $1) that are not yet
// flagged: attention_reason is shown on the board, in /bookings, in the board
// notifications and — via the calendar trigger + a SEQUENCE bump — in every
// subscribed calendar. Time and status are left exactly as they were.
async function flagBookings(client, where, params, reason) {
  const r = await client.query(
    `UPDATE property_viewings
        SET attention_reason = $${params.length + 1}, attention_at = NOW(), attention_seen_at = NULL,
            calendar_sequence = calendar_sequence + 1, updated_at = NOW()
      WHERE ${where} AND status IN ('pending','confirmed') AND attention_reason IS NULL
        AND COALESCE(starts_at, NOW()) > NOW() - INTERVAL '1 hour'
      RETURNING id`, [...params, reason])
  return r.rows.map(x => x.id)
}

// Human override: cancel one window, or all of them (e.g. "owner withdrew").
// Its slots stop being offered at once; bookings in it are flagged, not moved.
async function cancelWindow(propertyId, windowId, by) {
  const r = await db.query(
    `UPDATE property_viewing_windows SET status = 'cancelled', updated_at = NOW()
      WHERE property_id = $1 AND status = 'active' AND ($2::int IS NULL OR id = $2)
      RETURNING id`, [propertyId, windowId || null])
  const flagged = r.rows.length
    ? await flagBookings(db, `window_id = ANY($1::int[])`, [r.rows.map(x => x.id)],
        'Owner withdrew this viewing window — the booking is kept but no longer owner-confirmed. Please re-confirm with the owner.')
    : []
  await appendProvenance(db, propertyId, 'viewing_window', provenanceEntry({
    value: null, sourceType: 'human_override', reference: by, confidence: 'explicit',
    evidence: windowId ? `window ${windowId} cancelled` : 'all windows cancelled', updatedBy: by,
  }))
  await refreshPropertyColumns(propertyId)
  return { cancelled: r.rows.map(x => x.id), flagged }
}

// An owner said yes to a /book request ("Kalender wird darum gebaut"): open a
// default-length window starting at the confirmed time, so colleagues can book
// back-to-back slots around it, and place the confirmed viewing in it.
function confirmedWindowEnd(start, ownerText = '') {
  const text = String(ownerText || '')
  const until = text.match(/\b(?:until|till)\s+(\d{1,2})(?::|\.)(\d{2})\b/i)
  if (until) {
    const p = maltaParts(start)
    const end = maltaToUtc(p.y, p.m, p.d, Number(until[1]), Number(until[2]))
    if (end > start && end - start <= 4 * 3600000) return end
  }
  const mins = text.match(/\b(?:only|just)(?:\s+[a-z]+){0,3}\s+(10|20|30|40|45|60)\s*(?:minutes?|mins?|min)\b/i)
  if (mins) return new Date(start.getTime() + Number(mins[1]) * 60000)
  const short = /\b(?:only briefly|just briefly|short on time|only a short time)\b/i.test(text)
  return new Date(start.getTime() + (short ? 30 : 60) * 60000)
}

async function windowFromConfirmedViewing(viewingId, { ownerText = '' } = {}) {
  const r = await db.query(
    `SELECT id, property_id, viewing_date, viewing_time, starts_at, duration_min, status
       FROM property_viewings WHERE id = $1`, [viewingId])
  const v = r.rows[0]
  if (!v || v.status !== 'confirmed') return { skipped: 'not_confirmed' }
  let start = v.starts_at ? new Date(v.starts_at) : null
  if (!start) {
    const tm = String(v.viewing_time || '').match(/^(\d{1,2})[:.](\d{2})$/)
    if (!tm || !v.viewing_date) return { skipped: 'no_time' }
    const d = v.viewing_date instanceof Date ? v.viewing_date.toISOString().slice(0, 10) : String(v.viewing_date).slice(0, 10)
    const [y, m, dd] = d.split('-').map(Number)
    start = maltaToUtc(y, m, dd, Number(tm[1]), Number(tm[2]))
  }
  if (start.getTime() < Date.now()) return { skipped: 'past' }
  // A direct acceptance maps one hour around the accepted start. If the owner
  // explicitly limits the visit, honour the stated end or use a 30-minute
  // short window. We never infer a longer range from a bare "yes".
  const end = confirmedWindowEnd(start, ownerText)
  // The owner said yes to ONE time — that start is confirmed, the planning
  // block after it is only proposed.
  const res = await addWindow(v.property_id, { kind: 'window', start: start.toISOString(), end: end.toISOString(), confirmation: 'start_only' }, {
    sourceType: 'booking_survey', evidence: `owner confirmed viewing #${v.id}`, reference: `viewing:${v.id}`,
    confidence: 'explicit', createdBy: 'owner',
  })
  if (!v.starts_at) {
    try {
      await db.query(
        `UPDATE property_viewings SET starts_at = $2, duration_min = COALESCE(duration_min, 20),
                appointment_type = COALESCE(appointment_type, 'general'), window_id = $3, updated_at = NOW()
          WHERE id = $1`, [v.id, start.toISOString(), res.id])
    } catch (err) {
      // an agent already took that exact slot through the board — keep both, log it
      log.warn('[viewingWindows] confirmed viewing overlaps an existing slot', { viewingId, err: err.message })
    }
  }
  return res
}

// Board projection for one or many properties: windows + upcoming bookings.
function isoOrNull(d) { return d ? new Date(d).toISOString() : null }
function windowLabel(w) {
  if (w.kind === 'from_date') return `from ${String(w.from_date instanceof Date ? w.from_date.toISOString() : w.from_date).slice(0, 10)}`
  const s = maltaParts(new Date(w.starts_at)), e = maltaParts(new Date(w.ends_at))
  return `${s.y}-${String(s.m).padStart(2, '0')}-${String(s.d).padStart(2, '0')} ${String(s.h).padStart(2, '0')}:${String(s.mi).padStart(2, '0')}–${String(e.h).padStart(2, '0')}:${String(e.mi).padStart(2, '0')}`
}

module.exports = {
  addWindow, cancelWindow, flagBookings, listActiveWindows, refreshPropertyColumns, windowFromConfirmedViewing,
  confirmedWindowEnd, appendProvenance, provenanceEntry, windowLabel, isoOrNull,
}
