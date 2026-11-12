'use strict'
// ============================================================================
// services/nexusOwnerInbound.js — the rest of the ARGUS receiver and the
// signed read API for NEXUS (Claude, 2026-11-12). Contract: CONTRACT.md §4, §4b.
//
// NEXUS pushes what the owner changed; ARGUS validates, persists and answers
// `applied`. Three more owner changes are handled here:
//   property.owner_updated   — Property Passport edits (the owner's statement)
//   viewing.schedule_updated — the owner's viewing preferences
//   qa.answer_approved / qa.answer_withdrawn — answers approved for sharing
//
// Rules:
//   • Only a verified owner with a confirmed claim on that listing is accepted.
//   • Unknown fields are refused. Nothing here writes to `properties`: an edit
//     is stored for staff review and never overwrites existing inventory.
//   • Each stream is versioned by NEXUS. An older version arriving late is
//     acknowledged as `applied: false, reason: STALE_VERSION` and changes nothing.
//   • Applying an inbound event never queues an outbound event (no feedback loop).
//
// The read API gives NEXUS the operational facts it needs over signed HTTP, so
// NEXUS needs no login on the ARGUS database. It returns no owner contact data.
// ============================================================================
const db = require('../db')
const freshness = require('./availabilityFreshness')
const L = require('./nexusOwnerLink')
const { LinkError } = L
const { audit, activeGrants, linkByPublicId, claimedProperty, AGENCY_KEY } = L._internal

const TEXT = { locality: 100, type: 80, description: 4000, restrictions: 1000, preferences: 1000 }
const NUMBERS = { bedrooms: [0, 100], bathrooms: [0, 100], rent: [1, 10000000], sale: [1, 1000000000] }
const AMENITIES = ['ac', 'balcony', 'terrace', 'lift', 'furnished', 'washing_machine', 'dishwasher', 'parking', 'storage', 'heating', 'internet', 'garden', 'pool', 'dryer', 'sea_view']
const INTENTS = ['rent', 'sale', 'both', '']
const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^([01]\d|2[0-4]):[0-5]\d$/

const version = v => { if (!Number.isInteger(v) || v < 1 || v > 2147483647) throw new LinkError('VERSION_REQUIRED', 'version must be a positive integer'); return v }

// Validated copy of the owner's passport fields. Unknown key or bad value → refused.
function passportFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || !Object.keys(fields).length) throw new LinkError('FIELDS_INVALID', 'fields must be a non-empty object')
  const out = {}
  for (const [key, value] of Object.entries(fields)) {
    if (key in TEXT) {
      if (typeof value !== 'string' || value.length > TEXT[key]) throw new LinkError('FIELD_INVALID', `Invalid value for ${key}`)
      out[key] = value.trim()
    } else if (key in NUMBERS) {
      const [low, high] = NUMBERS[key]
      if (value !== null && (!Number.isInteger(value) || value < low || value > high)) throw new LinkError('FIELD_INVALID', `Invalid value for ${key}`)
      out[key] = value
    } else if (key === 'intent') {
      if (!INTENTS.includes(value)) throw new LinkError('FIELD_INVALID', 'Invalid value for intent')
      out[key] = value
    } else if (key === 'availableFrom') {
      if (value !== null && (typeof value !== 'string' || !DATE.test(value) || Number.isNaN(Date.parse(value)))) throw new LinkError('FIELD_INVALID', 'Invalid value for availableFrom')
      out[key] = value
    } else if (key === 'amenities') {
      if (!Array.isArray(value) || value.some(a => !AMENITIES.includes(a))) throw new LinkError('FIELD_INVALID', 'Invalid value for amenities')
      out[key] = [...new Set(value)].sort()
    } else throw new LinkError('FIELD_UNKNOWN', `Unknown passport field: ${String(key).slice(0, 40)}`)
  }
  return out
}

function scheduleValue(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new LinkError('SCHEDULE_INVALID', 'schedule must be an object')
  const known = ['weekly', 'exceptions', 'duration', 'notice', 'buffer']
  if (Object.keys(s).some(k => !known.includes(k))) throw new LinkError('SCHEDULE_INVALID', 'Unknown schedule field')
  const int = (v, low, high) => Number.isInteger(v) && v >= low && v <= high
  if (!Array.isArray(s.weekly) || s.weekly.length > 70 || !Array.isArray(s.exceptions) || s.exceptions.length > 366) throw new LinkError('SCHEDULE_INVALID', 'weekly and exceptions must be lists')
  for (const w of s.weekly) {
    if (!w || !int(w.day, 0, 6) || !['available', 'blocked'].includes(w.kind) || !TIME.test(w.start || '') || !TIME.test(w.end || '') || w.start >= w.end) throw new LinkError('SCHEDULE_INVALID', 'Invalid weekly entry')
  }
  for (const e of s.exceptions) {
    if (!e || !DATE.test(e.date || '') || !TIME.test(e.start || '') || !TIME.test(e.end || '') || e.start >= e.end) throw new LinkError('SCHEDULE_INVALID', 'Invalid exception entry')
  }
  if (![15, 30, 60].includes(s.duration) || !int(s.notice, 0, 720) || !int(s.buffer, 0, 240)) throw new LinkError('SCHEDULE_INVALID', 'Invalid duration, notice or buffer')
  return {
    weekly: s.weekly.map(w => ({ day: w.day, kind: w.kind, start: w.start, end: w.end })),
    exceptions: s.exceptions.map(e => ({ date: e.date, start: e.start, end: e.end })),
    duration: s.duration, notice: s.notice, buffer: s.buffer,
  }
}

async function verifiedClaim(q, agency, data) {
  const link = await linkByPublicId(q, agency, data.linkId)
  if (link.link_state !== 'verified') throw new LinkError('OWNER_LINK_NOT_VERIFIED', 'Only a verified owner can change this listing.', 409)
  const p = await claimedProperty(q, link, data.externalId)
  if (!['confirmed', 'corrected'].includes(p.claim_state)) throw new LinkError('OWNER_CLAIM_NOT_CONFIRMED', 'The owner has not confirmed this property.', 409)
  return { link, p }
}

async function ownerUpdated(q, agency, data, eventId) {
  const { link, p } = await verifiedClaim(q, agency, data)
  const v = version(data.version)
  const fields = passportFields(data.fields)
  const { rows: [{ current }] } = await q.query(`SELECT COALESCE(MAX(version), 0)::int AS current FROM nexus_owner_property_updates WHERE agency_key=$1 AND property_id=$2`, [agency, p.id])
  if (v <= current) return { applied: false, reason: 'STALE_VERSION', currentVersion: current }
  await q.query(`UPDATE nexus_owner_property_updates SET review_state='superseded' WHERE agency_key=$1 AND property_id=$2 AND review_state='pending'`, [agency, p.id])
  await q.query(`INSERT INTO nexus_owner_property_updates (agency_key, property_id, owner_link_id, version, fields, source_event_id) VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
    [agency, p.id, link.id, v, JSON.stringify(fields), eventId])
  await audit(q, null, 'NEXUS_OWNER_PASSPORT_UPDATE', { version: v, fields: Object.keys(fields).sort() }, p)
  return { applied: true, version: v, reviewState: 'pending', fields: Object.keys(fields).sort() }
}

async function scheduleUpdated(q, agency, data, eventId) {
  const { link, p } = await verifiedClaim(q, agency, data)
  const v = version(data.version)
  const schedule = scheduleValue(data.schedule)
  const { rowCount } = await q.query(
    `INSERT INTO nexus_owner_viewing_schedules (agency_key, property_id, owner_link_id, version, schedule, source_event_id) VALUES ($1,$2,$3,$4,$5::jsonb,$6)
     ON CONFLICT (agency_key, property_id) DO UPDATE SET owner_link_id=EXCLUDED.owner_link_id, version=EXCLUDED.version, schedule=EXCLUDED.schedule, source_event_id=EXCLUDED.source_event_id, updated_at=NOW()
       WHERE nexus_owner_viewing_schedules.version < EXCLUDED.version`, [agency, p.id, link.id, v, JSON.stringify(schedule), eventId])
  if (!rowCount) {
    const { rows: [cur] } = await q.query(`SELECT version FROM nexus_owner_viewing_schedules WHERE agency_key=$1 AND property_id=$2`, [agency, p.id])
    return { applied: false, reason: 'STALE_VERSION', currentVersion: cur.version }
  }
  await audit(q, null, 'NEXUS_OWNER_SCHEDULE_UPDATE', { version: v }, p)
  return { applied: true, version: v }
}

const QUESTION_KEY = /^[a-z0-9][a-z0-9_.-]{1,79}$/
async function answer(q, agency, data, eventId, withdrawn) {
  const { link, p } = await verifiedClaim(q, agency, data)
  const v = version(data.version)
  if (typeof data.questionKey !== 'string' || !QUESTION_KEY.test(data.questionKey)) throw new LinkError('QUESTION_KEY_INVALID', 'questionKey is required')
  let question = null, text = null
  if (!withdrawn) {
    question = typeof data.question === 'string' ? data.question.trim() : ''
    text = typeof data.answer === 'string' ? data.answer.trim() : ''
    if (!question || question.length > 300 || !text || text.length > 2000) throw new LinkError('ANSWER_INVALID', 'question and answer are required')
  }
  const { rowCount } = await q.query(
    `INSERT INTO nexus_owner_answers (agency_key, property_id, owner_link_id, question_key, question, answer, version, approved_at, withdrawn_at, source_event_id)
     VALUES ($1,$2,$3,$4,COALESCE($5,''),$6,$7, CASE WHEN $8 THEN NULL ELSE NOW() END, CASE WHEN $8 THEN NOW() ELSE NULL END, $9)
     ON CONFLICT (agency_key, property_id, question_key) DO UPDATE SET owner_link_id=EXCLUDED.owner_link_id,
       question = CASE WHEN $8 THEN nexus_owner_answers.question ELSE EXCLUDED.question END, answer=EXCLUDED.answer, version=EXCLUDED.version,
       approved_at=EXCLUDED.approved_at, withdrawn_at=EXCLUDED.withdrawn_at, source_event_id=EXCLUDED.source_event_id, updated_at=NOW()
       WHERE nexus_owner_answers.version < EXCLUDED.version`, [agency, p.id, link.id, data.questionKey, question, text, v, withdrawn, eventId])
  if (!rowCount) {
    const { rows: [cur] } = await q.query(`SELECT version FROM nexus_owner_answers WHERE agency_key=$1 AND property_id=$2 AND question_key=$3`, [agency, p.id, data.questionKey])
    return { applied: false, reason: 'STALE_VERSION', currentVersion: cur.version }
  }
  await audit(q, null, withdrawn ? 'NEXUS_OWNER_ANSWER_WITHDRAWN' : 'NEXUS_OWNER_ANSWER_APPROVED', { question_key: data.questionKey, version: v }, p)
  return { applied: true, version: v, questionKey: data.questionKey, state: withdrawn ? 'withdrawn' : 'approved' }
}

const HANDLERS = {
  'property.owner_updated': ownerUpdated,
  'viewing.schedule_updated': scheduleUpdated,
  'qa.answer_approved': (q, agency, data, eventId) => answer(q, agency, data, eventId, false),
  'qa.answer_withdrawn': (q, agency, data, eventId) => answer(q, agency, data, eventId, true),
}

// What staff see on the owner profile for one listing.
async function ownerInputSummary(q, agency, propertyIds) {
  const [u, s, a] = await Promise.all([
    q.query(`SELECT DISTINCT ON (property_id) property_id, version, review_state, fields, created_at FROM nexus_owner_property_updates WHERE agency_key=$1 AND property_id = ANY($2::int[]) ORDER BY property_id, version DESC`, [agency, propertyIds]),
    q.query(`SELECT property_id, version, updated_at FROM nexus_owner_viewing_schedules WHERE agency_key=$1 AND property_id = ANY($2::int[])`, [agency, propertyIds]),
    q.query(`SELECT property_id, COUNT(*)::int AS n FROM nexus_owner_answers WHERE agency_key=$1 AND property_id = ANY($2::int[]) AND withdrawn_at IS NULL GROUP BY property_id`, [agency, propertyIds]),
  ])
  return id => {
    const up = u.rows.find(r => r.property_id === id), sc = s.rows.find(r => r.property_id === id), an = a.rows.find(r => r.property_id === id)
    return {
      passportUpdate: up ? { version: up.version, reviewState: up.review_state, fields: up.fields, receivedAt: up.created_at } : null,
      viewingSchedule: sc ? { version: sc.version, updatedAt: sc.updated_at } : null,
      approvedAnswers: an ? an.n : 0,
    }
  }
}

// ── signed read API (NEXUS server → ARGUS) ──────────────────────────────────
const ACTIVE_LISTING = `p.archived_at IS NULL AND NOT COALESCE(p.is_staging, false) AND NOT COALESCE(p.duplicate_flagged, false)`
const ext = (agency, ref) => `${agency}:${ref}`
const day = L._internal.date
const money = v => { const n = v == null ? null : Number(v); return Number.isFinite(n) && n > 0 ? n : null }
function photos(...sources) {
  const out = []
  for (const src of sources) for (const item of Array.isArray(src) ? src : []) {
    const url = typeof item === 'string' ? item : item?.url || item?.secure_url
    if (typeof url === 'string' && /^https:\/\/res\.cloudinary\.com\/[^\s"'<>\\]{1,2000}$/.test(url) && !out.includes(url)) out.push(url)
  }
  return out.slice(0, 20)
}

async function readLink(linkId, { account } = {}) {
  const link = await linkByPublicId(db, AGENCY_KEY(), linkId, { lock: false })
  // An account that is not the one that claimed the link learns nothing, not even that it exists.
  if (account !== undefined && link.nexus_account_ref !== account) throw new LinkError('LINK_NOT_FOUND', 'Owner link not found', 404)
  return link
}

// The verified owner's confirmed listings, with the facts the Owner Portal shows the owner.
async function readOwnerLink(body) {
  const link = await readLink(body?.linkId, { account: String(body?.nexusAccountRef || '') })
  const verified = link.link_state === 'verified'
  const { rows } = verified ? await db.query(
    `SELECT p.id, p.ref, p.town, p.property_type, p.bedrooms, p.bathrooms, p.longlet_price, p.sale_price, p.available_date, p.feature_tags, p.images,
            p.public_payload -> 'images' AS public_images, c.claim_state
       FROM nexus_owner_property_claims c JOIN properties p ON p.id=c.property_id AND p.owner_id=$2
      WHERE c.owner_link_id=$1 AND c.claim_state IN ('confirmed','corrected') AND ${ACTIVE_LISTING} ORDER BY p.id LIMIT 200`, [link.id, link.owner_contact_id]) : { rows: [] }
  return {
    contractVersion: L.CONTRACT_VERSION, agencyKey: link.agency_key, linkId: link.public_id, linkState: link.link_state, verified,
    properties: rows.map(p => ({
      externalId: ext(link.agency_key, p.ref), sourcePropertyId: p.id, ref: p.ref, claimState: p.claim_state,
      facts: { locality: p.town, type: p.property_type, bedrooms: p.bedrooms, bathrooms: p.bathrooms, rent: money(p.longlet_price), sale: money(p.sale_price),
        availableFrom: day(p.available_date), amenities: (p.feature_tags || []).filter(t => AMENITIES.includes(t)).sort(), photos: photos(p.public_images, p.images) },
    })),
  }
}

// Current access, availability and owner grants for listings of one link.
async function readProperties(body) {
  const link = await readLink(body?.linkId)
  const ids = [...new Set(Array.isArray(body?.externalIds) ? body.externalIds.map(String) : [])]
  if (!ids.length || ids.length > 100) throw new LinkError('EXTERNAL_IDS_INVALID', 'externalIds must name 1–100 listings')
  const { rows } = await db.query(
    `SELECT l.external_id, p.id, p.available_status, p.available_date, p.available_until, p.last_confirmed_available_at, c.claim_state, (${ACTIVE_LISTING}) AS active,
            (SELECT a.outcome FROM owner_availability_answers a WHERE a.agency_key=l.agency_key AND a.property_id=p.id ORDER BY a.created_at DESC, a.id DESC LIMIT 1) AS last_outcome
       FROM nexus_property_links l JOIN properties p ON p.id=l.property_id AND p.owner_id=$3
       JOIN nexus_owner_property_claims c ON c.property_id=p.id AND c.owner_link_id=$1
      WHERE l.agency_key=$2 AND l.external_id = ANY($4::text[])`, [link.id, link.agency_key, link.owner_contact_id, ids])
  const properties = []
  for (const r of rows) {
    const accessValid = link.link_state === 'verified' && ['confirmed', 'corrected'].includes(r.claim_state) && r.active
    const grants = accessValid ? await activeGrants(db, link.agency_key, r.id) : []
    properties.push({
      externalId: r.external_id, accessValid,
      // The one authoritative confirmation time. NEXUS may cache it for display, never replace it.
      availability: accessValid ? { status: r.available_status, availableFrom: day(r.available_date), availableUntil: day(r.available_until),
        availability_last_confirmed_at: r.last_confirmed_available_at ? new Date(r.last_confirmed_available_at).toISOString() : null,
        freshness: freshness.classify(r.last_confirmed_available_at).state, consumerDiscoverable: freshness.classify(r.last_confirmed_available_at).consumerDiscoverable,
        lastOwnerOutcome: r.last_outcome || null } : null,
      grants: grants.map(g => ({ channel: g.channel, audienceRef: g.audience_ref || null, scopes: g.scopes, grantedAt: new Date(g.granted_at).toISOString() })),
    })
  }
  // A listing that is not part of this link is simply absent from the answer.
  return { contractVersion: L.CONTRACT_VERSION, agencyKey: link.agency_key, linkState: link.link_state, properties }
}

async function ownedListing(link, externalId) {
  const { rows: [p] } = await db.query(
    `SELECT p.id FROM nexus_property_links l JOIN properties p ON p.id=l.property_id AND p.owner_id=$3
       JOIN nexus_owner_property_claims c ON c.property_id=p.id AND c.owner_link_id=$1 AND c.claim_state IN ('confirmed','corrected')
      WHERE l.agency_key=$2 AND l.external_id=$4 AND ${ACTIVE_LISTING}`, [link.id, link.agency_key, link.owner_contact_id, String(externalId || '')])
  if (link.link_state !== 'verified' || !p) throw new LinkError('PROPERTY_NOT_IN_LINK', 'Property is not part of this owner link', 404)
  return p
}

// Existing appointments of a listing: timing only, no client, agent or note.
async function readViewingBusy(body) {
  const link = await readLink(body?.linkId)
  const p = await ownedListing(link, body?.externalId)
  const days = Number(body?.days)
  if (!DATE.test(String(body?.from || '')) || !Number.isInteger(days) || days < 1 || days > 31) throw new LinkError('RANGE_INVALID', 'from (YYYY-MM-DD) and days (1–31) are required')
  const { rows } = await db.query(
    `SELECT viewing_date, viewing_time, starts_at, duration_min FROM property_viewings
      WHERE property_id=$1 AND status IN ('pending','confirmed') AND viewing_date BETWEEN ($2::date - 1) AND ($2::date + $3::int) ORDER BY viewing_date, starts_at NULLS LAST LIMIT 500`, [p.id, body.from, days])
  return { externalId: String(body.externalId), busy: rows.map(r => ({ date: day(r.viewing_date), time: r.viewing_time || null, startsAt: r.starts_at ? new Date(r.starts_at).toISOString() : null, durationMin: r.duration_min || 20 })) }
}

// A reviewed source link for the owner's own listing (the existing source inventory; nothing is fetched).
async function readSourceMatch(body) {
  const link = await readLink(body?.linkId)
  const p = await ownedListing(link, body?.externalId)
  const url = String(body?.url || '')
  if (!/^https:\/\/[^\s]{1,2040}$/.test(url)) throw new LinkError('URL_INVALID', 'An https link is required')
  const { rows } = await db.query(
    `SELECT parsed_locality, parsed_property_type, parsed_bedrooms, parsed_bathrooms, parsed_price, parsed_price_unit, price_confidence, parsed_available_date, last_checked_at
       FROM website_source_inventory WHERE canonical_property_id=$1 AND source_url=$2 AND import_status='ACTIVE' AND last_checked_at IS NOT NULL LIMIT 2`, [p.id, url])
  if (rows.length !== 1) throw new LinkError('SOURCE_NOT_REVIEWED', 'There is no reviewed match for this link and listing', 404)
  const r = rows[0]
  const facts = { locality: r.parsed_locality || null, type: r.parsed_property_type || null, bedrooms: r.parsed_bedrooms, bathrooms: r.parsed_bathrooms, availableFrom: day(r.parsed_available_date) }
  // A price is only passed on as a monthly rent when the source said so and it was confirmed.
  if (r.parsed_price_unit === 'month' && r.price_confidence === 'CONFIRMED') facts.rent = money(r.parsed_price)
  return { externalId: String(body.externalId), checkedAt: new Date(r.last_checked_at).toISOString(), facts: Object.fromEntries(Object.entries(facts).filter(([, v]) => v !== null && v !== '')) }
}

// Agency-wide read for the professional workspace in NEXUS: is a listing
// currently shareable, and under which owner grants and agency releases?
// Fail closed: a listing that is not eligible comes back as
// { externalId, eligible: false, reason } and nothing else.
const ON_MARKET = ['available', 'available_confirmed', 'upcoming']
const HOLDING = ['temporarily_held', 'reserved', 'rented']
async function readMarket(body) {
  const agency = AGENCY_KEY()
  const ids = [...new Set(Array.isArray(body?.externalIds) ? body.externalIds.map(String) : [])]
  if (!ids.length || ids.length > 100) throw new LinkError('EXTERNAL_IDS_INVALID', 'externalIds must name 1–100 listings')
  const { rows } = await db.query(
    `SELECT l.external_id, p.id, p.ref, p.feature_tags, p.available_status, p.available_date, p.available_until, p.last_confirmed_available_at,
            p.longlet_price, p.sale_price, COALESCE(p.lifecycle_state, 'active') AS lifecycle, (${ACTIVE_LISTING}) AS active,
            o.link_state, c.claim_state,
            (SELECT a.outcome FROM owner_availability_answers a WHERE a.agency_key=l.agency_key AND a.property_id=p.id
                AND a.outcome IN ('temporarily_held','reserved','rented','available','available_from')
                AND a.created_at >= COALESCE(p.last_confirmed_available_at, '-infinity') ORDER BY a.created_at DESC, a.id DESC LIMIT 1) AS last_outcome
       FROM nexus_property_links l JOIN properties p ON p.id=l.property_id
       LEFT JOIN nexus_owner_links o ON o.agency_key=l.agency_key AND o.owner_contact_id=p.owner_id
       LEFT JOIN nexus_owner_property_claims c ON c.owner_link_id=o.id AND c.property_id=p.id
      WHERE l.agency_key=$1 AND l.external_id = ANY($2::text[])`, [agency, ids])
  const out = []
  for (const id of ids) {
    const r = rows.find(x => x.external_id === id)
    const no = reason => out.push({ externalId: id, eligible: false, reason })
    if (!r) { no('UNKNOWN_LISTING'); continue }
    if (r.link_state !== 'verified' || !['confirmed', 'corrected'].includes(r.claim_state)) { no('OWNER_NOT_VERIFIED'); continue }
    if (!r.active || r.lifecycle !== 'active') { no('LISTING_NOT_ACTIVE'); continue }
    if (L.transactionType(r).type === null) { no('PRICE_UNCLEAR'); continue }
    if (!ON_MARKET.includes(r.available_status)) { no('OFF_MARKET'); continue }
    if (HOLDING.includes(r.last_outcome)) { no('HELD_BY_OWNER'); continue }
    const grants = await activeGrants(db, agency, r.id)
    if (!grants.length) { no('NO_DISTRIBUTION_AUTHORIZATION'); continue }
    const scopes = new Set(grants.flatMap(g => g.scopes))
    const fresh = freshness.classify(r.last_confirmed_available_at)
    const { rows: releases } = await db.query(
      `SELECT id, audience_type, audience_refs, commercial_terms_ref, released_at FROM nexus_distribution_routes
        WHERE agency_key=$1 AND property_id=$2 AND release_state='released' AND scheduled_release_at <= NOW() ORDER BY id`, [agency, r.id])
    let viewingWindow = null
    if (scopes.has('viewing_schedule')) {
      const { rows: [w] } = await db.query(
        `SELECT starts_at, ends_at FROM property_viewing_windows WHERE property_id=$1 AND status='active' AND kind='window' AND confirmation='full_window' AND ends_at > NOW() ORDER BY starts_at LIMIT 1`, [r.id])
      if (w) viewingWindow = { startsAt: new Date(w.starts_at).toISOString(), endsAt: new Date(w.ends_at).toISOString() }
    }
    out.push({
      externalId: id, eligible: true, ref: r.ref,
      features: (r.feature_tags || []).filter(t => AMENITIES.includes(t)).sort(),
      // On-market state is part of eligibility. Exact timing and confirmation history need the owner's `availability` scope.
      availability: scopes.has('availability')
        ? { status: r.available_status, availableFrom: day(r.available_date), availableUntil: day(r.available_until),
            availability_last_confirmed_at: fresh.lastConfirmedAt, freshness: fresh.state, consumerDiscoverable: fresh.consumerDiscoverable }
        : { status: r.available_status, consumerDiscoverable: fresh.consumerDiscoverable },
      grants: grants.map(g => ({ channel: g.channel, audienceRef: g.audience_ref || null, scopes: g.scopes })),
      releases: releases.map(x => ({ routeId: Number(x.id), audienceType: x.audience_type, audienceRefs: x.audience_refs, commercialTermsRef: x.commercial_terms_ref, releasedAt: new Date(x.released_at).toISOString() })),
      viewingWindow,
    })
  }
  return { contractVersion: L.CONTRACT_VERSION, agencyKey: agency, properties: out }
}

module.exports = { HANDLERS, ownerInputSummary, passportFields, scheduleValue, readOwnerLink, readProperties, readViewingBusy, readSourceMatch, readMarket, AMENITIES }
