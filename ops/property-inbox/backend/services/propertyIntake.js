'use strict'
// ============================================================================
// services/propertyIntake.js — Incoming Properties (2026-11-13)
//
// Every property that arrives through an intake channel (today: the WhatsApp
// divider upload) is a normal row in `properties` from the first second, with
// its own CONTENT verification state. That state is separate from the market
// status (available_status), from the publication state (published) and from
// the availability recheck (last_confirmed_available_at):
//
//   verification_status   unverified → needs_correction → verified
//
// Verifying confirms the extracted facts and makes the listing usable inside
// ARGUS (system_online). It never publishes, never posts and never messages
// anybody. Duplicates are archived (never deleted) and linked to the
// existing property. Upload packages that failed stay visible with a retry.
//
// Every decision writes property_activities (the property timeline) and
// agent_activity_log (action_type 'intake:<action>', the dashboard feed).
// ============================================================================
const db = require('../db')
const log = require('../logger')

const MALTA_TODAY = `(date_trunc('day', NOW() AT TIME ZONE 'Europe/Malta') AT TIME ZONE 'Europe/Malta')`

// ── pure helpers (unit tested) ───────────────────────────────────────────────
const CRITICAL = ['price', 'town', 'bedrooms', 'photos']
function missingFields(p) {
  const out = []
  const price = Number(p.longlet_price) > 0 || Number(p.sale_price) > 0
  if (!price) out.push({ field: 'price', label: 'Price', critical: true })
  if (!String(p.town || '').trim()) out.push({ field: 'town', label: 'Location', critical: true })
  if (!(Number(p.bedrooms) > 0) && !/studio|commercial|office|shop|garage/i.test(String(p.property_type || ''))) out.push({ field: 'bedrooms', label: 'Bedrooms', critical: true })
  if (!(imagesOf(p).length > 0)) out.push({ field: 'photos', label: 'Photos', critical: true })
  if (!(Number(p.bathrooms) > 0)) out.push({ field: 'bathrooms', label: 'Bathrooms', critical: false })
  if (!p.available_date) out.push({ field: 'available_date', label: 'Available from', critical: false })
  if (!p.owner_id) out.push({ field: 'owner', label: 'Owner contact', critical: false })
  return out
}
const hasCritical = missing => missing.some(m => m.critical)

function imagesOf(p) {
  const raw = Array.isArray(p.images) ? p.images : (typeof p.images === 'string' ? (() => { try { return JSON.parse(p.images) } catch { return [] } })() : [])
  return raw.map(i => (typeof i === 'string' ? i : i && i.url)).filter(Boolean)
}

// Only these columns can be corrected from the review card. Everything else
// (owner, agent, publication, market status) keeps its own workflow.
const TYPES = ['apartment', 'penthouse', 'maisonette', 'house', 'villa', 'studio', 'duplex', 'commercial', 'office', 'shop', 'garage', 'room']
function sanitizeEdits(input = {}) {
  const out = {}, errors = []
  const num = (k, col, { min = 0, max = 1e9, int = false } = {}) => {
    if (!(k in input)) return
    const v = input[k]
    if (v === null || v === '') { out[col] = null; return }
    const n = Number(String(v).replace(/[€,\s]/g, ''))
    if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) { errors.push(`${k} is not a valid number`); return }
    out[col] = n
  }
  num('bedrooms', 'bedrooms', { max: 30, int: true })
  num('bathrooms', 'bathrooms', { max: 30, int: true })
  num('longlet_price', 'longlet_price', { max: 1e6 })
  num('sale_price', 'sale_price', { max: 1e9 })
  num('size_sqm', 'size_sqm', { max: 1e5 })
  if ('town' in input) { const t = String(input.town || '').trim(); out.town = t ? t.slice(0, 80) : null }
  if ('property_type' in input) {
    const t = String(input.property_type || '').trim().toLowerCase()
    if (t && !TYPES.includes(t)) errors.push('property_type is not a known type'); else out.property_type = t || null
  }
  if ('available_date' in input) {
    const d = input.available_date
    if (d === null || d === '') out.available_date = null
    else if (/^\d{4}-\d{2}-\d{2}$/.test(String(d)) && !Number.isNaN(new Date(d).getTime())) out.available_date = String(d)
    else errors.push('available_date must be YYYY-MM-DD')
  }
  if ('description' in input) out.description = String(input.description || '').slice(0, 8000)
  return { edits: out, errors }
}

const FILTERS = ['new_today', 'needs_verification', 'missing_info', 'ready', 'approved', 'failed', 'duplicates', 'all']

// ── access ───────────────────────────────────────────────────────────────────
const isAdmin = a => a && a.role === 'admin'
function canReview(agent, row) {
  if (!agent || !['admin', 'agent'].includes(agent.role)) return false
  return isAdmin(agent) || Number(row.listed_by_agent_id) === Number(agent.id) || Number(row.package_agent_id) === Number(agent.id)
}

// ── reading ──────────────────────────────────────────────────────────────────
const ITEM_SELECT = `
  SELECT p.id, p.ref, p.property_type, p.town, p.bedrooms, p.bathrooms, p.size_sqm, p.longlet_price, p.sale_price,
         p.available_date, p.available_status, p.description, p.images, p.published, p.system_online, p.owner_id,
         p.listed_by_agent_id, p.archived_at, p.created_at, p.updated_at, p.internal_notes,
         p.verification_status, p.verification_note, p.verified_at, p.verified_by_agent_id,
         p.intake_source, p.intake_received_at, p.intake_package_id, p.intake_linked_property_id,
         la.name AS uploader_name, la.username AS uploader_username,
         va.name AS verifier_name, va.username AS verifier_username,
         lp.ref AS linked_ref,
         u.id AS package_id, u.state AS package_state, u.media_expected, u.media_imported, u.failure_reason AS package_reason,
         u.agent_id AS package_agent_id, u.session AS package_session
    FROM properties p
    LEFT JOIN agents la ON la.id = p.listed_by_agent_id
    LEFT JOIN agents va ON va.id = p.verified_by_agent_id
    LEFT JOIN properties lp ON lp.id = p.intake_linked_property_id
    LEFT JOIN upload_packages u ON u.id = p.intake_package_id`

function shapeItem(r, { full = false } = {}) {
  const images = imagesOf(r)
  const missing = missingFields(r)
  const pending = !r.archived_at && ['unverified', 'needs_correction'].includes(r.verification_status)
  const desc = String(r.description || '').replace(/[*_]{2,}/g, '').trim()
  return {
    kind: 'property', id: r.id, ref: r.ref, type: r.property_type, town: r.town,
    beds: r.bedrooms, baths: r.bathrooms, sizeSqm: r.size_sqm == null ? null : Number(r.size_sqm),
    rent: r.longlet_price == null ? null : Number(r.longlet_price), sale: r.sale_price == null ? null : Number(r.sale_price),
    availableDate: r.available_date, marketStatus: r.available_status,
    published: !!r.published, usable: !!r.system_online, archived: !!r.archived_at,
    cover: images[0] || null, images: full ? images : images.slice(0, 8), imageCount: images.length,
    mediaExpected: r.media_expected == null ? null : Number(r.media_expected),
    summary: desc.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 4).join(' · ').slice(0, 260),
    description: full ? desc : undefined,
    uploader: { id: r.listed_by_agent_id, name: r.uploader_name || r.uploader_username || null },
    uploadedAt: r.intake_received_at || r.created_at, createdAt: r.created_at, updatedAt: r.updated_at,
    source: r.intake_source,
    package: r.package_id ? { id: Number(r.package_id), state: r.package_state, reason: r.package_reason, mediaImported: r.media_imported == null ? null : Number(r.media_imported) } : null,
    hasOwner: !!r.owner_id,
    verification: {
      status: r.verification_status, note: r.verification_note || null, at: r.verified_at || null,
      by: r.verified_by_agent_id ? (r.verifier_name || r.verifier_username) : null,
    },
    linkedTo: r.intake_linked_property_id ? { id: r.intake_linked_property_id, ref: r.linked_ref } : null,
    missing, pending, ready: pending && r.verification_status === 'unverified' && !hasCritical(missing),
  }
}

function scopeClause(agent, params, alias = 'p') {
  if (isAdmin(agent)) return 'TRUE'
  params.push(agent.id)
  return `(${alias}.listed_by_agent_id = $${params.length})`
}

function filterClause(filter) {
  switch (filter) {
    case 'new_today': return `p.intake_received_at >= ${MALTA_TODAY}`
    case 'needs_verification': return `p.archived_at IS NULL AND p.verification_status IN ('unverified','needs_correction')`
    case 'missing_info': case 'ready': return `p.archived_at IS NULL AND p.verification_status IN ('unverified','needs_correction')` // refined after shaping
    case 'approved': return `p.verification_status = 'verified' AND p.archived_at IS NULL`
    case 'duplicates': return `p.archived_at IS NOT NULL`
    default: return 'TRUE'
  }
}

async function listItems(agent, { filter = 'needs_verification', limit = 60 } = {}) {
  if (!FILTERS.includes(filter)) filter = 'needs_verification'
  const lim = Math.min(Number(limit) || 60, 200)
  const items = []
  if (filter !== 'failed') {
    const params = []
    const where = ['p.intake_source IS NOT NULL', scopeClause(agent, params), filterClause(filter)]
    const order = filter === 'approved' ? 'p.verified_at DESC NULLS LAST' : 'COALESCE(p.intake_received_at, p.created_at) DESC'
    params.push(lim)
    const r = await db.query(`${ITEM_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT $${params.length}`, params)
    let shaped = r.rows.map(row => shapeItem(row))
    if (filter === 'missing_info') shaped = shaped.filter(i => hasCritical(i.missing))
    if (filter === 'ready') shaped = shaped.filter(i => i.ready)
    items.push(...shaped)
  }
  if (filter === 'failed' || filter === 'duplicates' || filter === 'new_today' || filter === 'all') {
    items.push(...await listPackages(agent, filter === 'duplicates' ? ['DUPLICATE'] : filter === 'failed' ? ['FAILED'] : ['FAILED', 'DUPLICATE'],
      { todayOnly: filter === 'new_today', limit: lim }))
    items.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime())
  }
  return items
}

async function listPackages(agent, states, { todayOnly = false, limit = 60 } = {}) {
  const params = [states]
  const where = ['u.state = ANY($1)', `u.resolved_at IS NULL OR u.state = 'DUPLICATE'`]
  if (!isAdmin(agent)) { params.push(agent.id); where.push(`u.agent_id = $${params.length}`) }
  if (todayOnly) where.push(`to_timestamp(COALESCE(u.first_message_ts, u.divider_ts)) >= ${MALTA_TODAY}`)
  params.push(limit)
  const r = await db.query(
    `SELECT u.*, a.name AS agent_name, a.username AS agent_username
       FROM upload_packages u LEFT JOIN agents a ON a.id = u.agent_id
      WHERE ${where.map(w => `(${w})`).join(' AND ')} ORDER BY u.id DESC LIMIT $${params.length}`, params)
  return r.rows.map(u => ({
    kind: 'package', packageId: Number(u.id), state: u.state, reason: u.failure_reason, attempts: u.attempts,
    summary: String(u.summary || '').replace(/[*_]{2,}/g, ''), mediaExpected: u.media_expected,
    uploader: { id: u.agent_id, name: u.agent_name || u.agent_username || null },
    uploadedAt: new Date(Number(u.first_message_ts || u.divider_ts) * 1000).toISOString(),
    duplicateOf: (String(u.failure_reason || '').match(/#(\d{4}-\d+)/) || [])[1] || null,
  }))
}

async function getItem(agent, id) {
  const r = await db.query(`${ITEM_SELECT} WHERE p.id = $1`, [Number(id)])
  const row = r.rows[0]
  if (!row || !row.intake_source) return null
  if (!canReview(agent, row) && !isAdmin(agent)) return { forbidden: true }
  const item = shapeItem(row, { full: true })
  item.canReview = canReview(agent, row)
  item.suggestions = item.pending ? await matchSuggestions(row) : []
  return item
}

// Existing properties that may be the same flat: same locality and bedrooms,
// price within 10 % when both are known. Never decided automatically.
async function matchSuggestions(row) {
  if (!row.town) return []
  const price = Number(row.longlet_price) || Number(row.sale_price) || null
  const r = await db.query(
    `SELECT p.id, p.ref, p.town, p.bedrooms, p.longlet_price, p.sale_price, p.published, p.images, p.available_status,
            COALESCE(p.updated_at, p.created_at) AS changed_at
       FROM properties p
      WHERE p.id <> $1 AND p.archived_at IS NULL
        AND lower(p.town) = lower($2)
        AND ($3::int IS NULL OR p.bedrooms = $3)
        AND ($4::numeric IS NULL OR COALESCE(p.longlet_price, p.sale_price) IS NULL
             OR COALESCE(p.longlet_price, p.sale_price) BETWEEN $4 * 0.9 AND $4 * 1.1)
        AND COALESCE(p.updated_at, p.created_at) > NOW() - INTERVAL '365 days'
      ORDER BY (COALESCE(p.longlet_price, p.sale_price) = $4) DESC NULLS LAST, p.published DESC, changed_at DESC
      LIMIT 4`, [row.id, row.town, row.bedrooms || null, price])
  return r.rows.map(x => ({
    id: x.id, ref: x.ref, town: x.town, beds: x.bedrooms, price: x.longlet_price == null ? (x.sale_price == null ? null : Number(x.sale_price)) : Number(x.longlet_price),
    published: !!x.published, imageCount: imagesOf(x).length, cover: imagesOf(x)[0] || null, marketStatus: x.available_status,
    reason: [`same locality`, row.bedrooms ? `${row.bedrooms} bedrooms` : null, price && Number(x.longlet_price || x.sale_price) === price ? 'same price' : (price ? 'price within 10 %' : null)].filter(Boolean).join(' · '),
  }))
}

async function summary(agent) {
  const params = []
  const scope = scopeClause(agent, params)
  const r = (await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE p.archived_at IS NULL AND p.verification_status IN ('unverified','needs_correction'))::int AS needs_verification,
       COUNT(*) FILTER (WHERE p.archived_at IS NULL AND p.verification_status = 'needs_correction')::int AS needs_correction,
       COUNT(*) FILTER (WHERE p.intake_received_at >= ${MALTA_TODAY})::int AS new_today,
       COUNT(*) FILTER (WHERE p.verification_status = 'verified' AND p.archived_at IS NULL)::int AS approved,
       COUNT(*) FILTER (WHERE p.verification_status = 'verified' AND p.verified_at >= ${MALTA_TODAY})::int AS approved_today,
       COUNT(*) FILTER (WHERE p.archived_at IS NOT NULL)::int AS linked
     FROM properties p WHERE p.intake_source IS NOT NULL AND ${scope}`, params)).rows[0]
  // missing/ready need the same rules the cards use
  const pend = await listItems(agent, { filter: 'needs_verification', limit: 200 })
  const pkParams = []
  const pkScope = isAdmin(agent) ? 'TRUE' : (pkParams.push(agent.id), `u.agent_id = $${pkParams.length}`)
  const pk = (await db.query(
    `SELECT COUNT(*) FILTER (WHERE u.state = 'FAILED' AND u.resolved_at IS NULL)::int AS failed,
            COUNT(*) FILTER (WHERE u.state = 'DUPLICATE')::int AS duplicate_packages
       FROM upload_packages u WHERE ${pkScope}`, pkParams)).rows[0]
  const upParams = []
  const upScope = scopeClause(agent, upParams)
  const uploadsToday = (await db.query(
    `SELECT COALESCE(a.name, a.username, 'Unknown agent') AS agent, COUNT(*)::int AS n
       FROM properties p LEFT JOIN agents a ON a.id = p.listed_by_agent_id
      WHERE p.intake_source IS NOT NULL AND p.intake_received_at >= ${MALTA_TODAY} AND ${upScope}
      GROUP BY 1 ORDER BY 2 DESC`, upParams)).rows
  return {
    counts: {
      new_today: r.new_today, needs_verification: r.needs_verification, needs_correction: r.needs_correction,
      missing_info: pend.filter(i => hasCritical(i.missing)).length, ready: pend.filter(i => i.ready).length,
      approved: r.approved, approved_today: r.approved_today, failed: pk.failed,
      duplicates: r.linked + pk.duplicate_packages,
      missing_price: pend.filter(i => i.missing.some(m => m.field === 'price')).length,
    },
    uploadsToday,
  }
}

// Dashboard feed: what actually happened, from the persisted event log.
async function feed(agent, { limit = 30 } = {}) {
  const params = []
  let scope = 'TRUE'
  if (!isAdmin(agent)) { params.push(agent.id); scope = `(l.actor_agent_id = $${params.length} OR p.listed_by_agent_id = $${params.length})` }
  params.push(Math.min(Number(limit) || 30, 100))
  const r = await db.query(
    `SELECT l.id, l.created_at, l.action_type, l.target_property_id, l.target_ref, l.details,
            COALESCE(a.name, a.username) AS actor
       FROM agent_activity_log l
       LEFT JOIN agents a ON a.id = l.actor_agent_id
       LEFT JOIN properties p ON p.id = l.target_property_id
      WHERE (l.action_type LIKE 'intake:%' OR l.action_type IN ('auto:divider_upload:IMPORTED','auto:divider_upload:REVIEW_REQUIRED','auto:divider_upload:FAILED','auto:divider_upload:DUPLICATE'))
        AND l.created_at > NOW() - INTERVAL '14 days' AND ${scope}
      ORDER BY l.id DESC LIMIT $${params.length}`, params)
  return r.rows.map(x => {
    const d = x.details || {}
    const [kind, , action] = String(x.action_type).split(':')
    const act = kind === 'intake' ? String(x.action_type).split(':')[1] : `upload_${action.toLowerCase()}`
    return { id: Number(x.id), at: x.created_at, action: act, actor: x.actor || null, propertyId: x.target_property_id == null ? null : Number(x.target_property_id), ref: x.target_ref,
      packageId: d.package_id || null, note: d.note || d.reason || null, media: d.media_imported ?? null }
  })
}

// ── decisions ────────────────────────────────────────────────────────────────
async function loadForAction(client, agent, id) {
  const r = await client.query(`${ITEM_SELECT} WHERE p.id = $1 FOR UPDATE OF p`, [Number(id)])
  const row = r.rows[0]
  if (!row || !row.intake_source) throw httpError(404, 'This property is not in Incoming Properties')
  if (!canReview(agent, row)) throw httpError(403, 'Only the uploading agent or an administrator can review this property')
  return row
}
function httpError(status, message, extra = {}) { const e = new Error(message); e.status = status; Object.assign(e, extra); return e }

async function record(client, { agent, action, row, details = {}, significant = true }) {
  await client.query(
    `INSERT INTO property_activities (property_id, agent_id, activity_type, details, is_significant) VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [row.id, agent.id, `intake_${action}`, JSON.stringify(details), significant])
  await client.query(
    `INSERT INTO agent_activity_log (actor_agent_id, actor_role, actor_display_name, action_type, target_property_id, target_ref, details, is_kev)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, FALSE)`,
    [agent.id, agent.role, agent.name || agent.username || null, `intake:${action}`, row.id, row.ref, JSON.stringify({ ...details, package_id: row.package_id || null })])
}

async function inTx(fn) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* gone */ }
    throw err
  } finally { client.release() }
}

function applyEditsSql(edits, params) {
  const sets = []
  for (const [col, val] of Object.entries(edits)) { params.push(val); sets.push(`${col} = $${params.length}`) }
  return sets
}
function diff(row, edits) {
  const out = {}
  for (const [k, v] of Object.entries(edits)) {
    const before = row[k] instanceof Date ? row[k].toISOString().slice(0, 10) : row[k]
    if (String(before ?? '') !== String(v ?? '')) out[k] = { before: before ?? null, after: v ?? null }
  }
  return out
}

// Save corrections without changing the verification state.
async function saveEdits(agent, id, input) {
  const { edits, errors } = sanitizeEdits(input)
  if (errors.length) throw httpError(422, errors.join('; '))
  return inTx(async client => {
    const row = await loadForAction(client, agent, id)
    if (row.archived_at) throw httpError(409, 'This draft was archived as a duplicate')
    const changes = diff(row, edits)
    if (!Object.keys(changes).length) return { ok: true, changed: {} }
    const params = [row.id]
    const sets = applyEditsSql(edits, params)
    await client.query(`UPDATE properties SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, params)
    await record(client, { agent, action: 'edited', row, details: { changes }, significant: false })
    return { ok: true, changed: changes }
  })
}

async function verify(agent, id, { edits: input = {}, note = null } = {}) {
  const { edits, errors } = sanitizeEdits(input)
  if (errors.length) throw httpError(422, errors.join('; '))
  return inTx(async client => {
    const row = await loadForAction(client, agent, id)
    if (row.archived_at) throw httpError(409, 'This draft was archived as a duplicate')
    if (row.verification_status === 'verified') return { ok: true, already: true }
    const after = { ...row, ...edits }
    const missing = missingFields(after).filter(m => m.critical)
    if (missing.length) throw httpError(422, `Add ${missing.map(m => m.label.toLowerCase()).join(', ')} before verifying`, { missing })
    const changes = diff(row, edits)
    const params = [row.id, agent.id, note ? String(note).slice(0, 1000) : null]
    const sets = applyEditsSql(edits, params)
    await client.query(
      `UPDATE properties SET ${[...sets, `verification_status = 'verified'`, `verified_by_agent_id = $2`, `verified_at = NOW()`,
        `verification_note = $3`, `system_online = TRUE`, `updated_at = NOW()`].join(', ')} WHERE id = $1`, params)
    await record(client, { agent, action: 'verified', row, details: { changes, note, published: !!row.published, note_publication: 'verification does not publish' } })
    return { ok: true, changed: changes }
  })
}

async function requestCorrection(agent, id, { note } = {}) {
  const text = String(note || '').trim()
  if (text.length < 3) throw httpError(422, 'Say what needs to be corrected')
  return inTx(async client => {
    const row = await loadForAction(client, agent, id)
    if (row.archived_at) throw httpError(409, 'This draft was archived as a duplicate')
    await client.query(`UPDATE properties SET verification_status = 'needs_correction', verification_note = $2, updated_at = NOW() WHERE id = $1`, [row.id, text.slice(0, 1000)])
    await record(client, { agent, action: 'needs_correction', row, details: { note: text } })
    return { ok: true }
  })
}

async function archiveDraft(client, agent, row, reason) {
  const { archive } = require('./boardAction')
  const plan = await archive({ propertyId: row.id, agentId: agent.id, reason, changedBy: 'agent' })
  if (!plan.ok) throw httpError(409, plan.reason || 'Could not archive the draft')
  const upd = await client.query(plan.update.sql, plan.update.params)
  if (!upd.rows.length) throw httpError(409, 'Already archived')
  await client.query(plan.activity.sql, plan.activity.params)
}

async function resolveTarget(client, target) {
  const t = String(target || '').trim().replace(/^#/, '')
  if (!t) return null
  const r = await client.query(
    `SELECT id, ref, published, images, archived_at FROM properties
      WHERE ref = $1 OR ref = '2906-' || $1 OR id::text = $1
      ORDER BY (ref = $1 OR ref = '2906-' || $1) DESC LIMIT 1`, [t])
  return r.rows[0] || null
}

// Same flat as an existing property: archive this draft, link it, and give the
// existing (unpublished) record any photos it does not have yet.
async function linkExisting(agent, id, { target, copyPhotos = true } = {}) {
  return inTx(async client => {
    const row = await loadForAction(client, agent, id)
    if (row.archived_at) throw httpError(409, 'Already archived')
    const t = await resolveTarget(client, target)
    if (!t) throw httpError(404, 'Existing property not found')
    if (t.id === row.id) throw httpError(422, 'Choose a different property')
    if (t.archived_at) throw httpError(409, `#${t.ref} is archived`)
    let added = 0, photoNote = null
    if (copyPhotos) {
      if (t.published) photoNote = `#${t.ref} is published: photos were not changed (add them on the property page if wanted)`
      else {
        const have = new Set(imagesOf(t))
        const extra = imagesOf(row).filter(u => !have.has(u))
        if (extra.length) {
          await client.query(`UPDATE properties SET images = COALESCE(images, '[]'::jsonb) || $2::jsonb, updated_at = NOW() WHERE id = $1`,
            [t.id, JSON.stringify(extra.map(url => ({ url })))])
          added = extra.length
        }
      }
    }
    await archiveDraft(client, agent, row, `Duplicate of #${t.ref}: linked from Incoming Properties`)
    await client.query(`UPDATE properties SET intake_linked_property_id = $2 WHERE id = $1`, [row.id, t.id])
    await record(client, { agent, action: 'linked', row, details: { target_id: t.id, target_ref: t.ref, photos_added: added, photo_note: photoNote } })
    await client.query(`INSERT INTO property_activities (property_id, agent_id, activity_type, details, is_significant) VALUES ($1, $2, 'intake_linked_from', $3::jsonb, TRUE)`,
      [t.id, agent.id, JSON.stringify({ from_id: row.id, from_ref: row.ref, photos_added: added })])
    return { ok: true, target: { id: t.id, ref: t.ref }, photosAdded: added, photoNote }
  })
}

async function rejectDuplicate(agent, id, { target = null, note = null } = {}) {
  return inTx(async client => {
    const row = await loadForAction(client, agent, id)
    if (row.archived_at) throw httpError(409, 'Already archived')
    const t = target ? await resolveTarget(client, target) : null
    if (target && !t) throw httpError(404, 'Existing property not found')
    await archiveDraft(client, agent, row, t ? `Rejected as duplicate of #${t.ref}` : `Rejected as duplicate${note ? `: ${String(note).slice(0, 200)}` : ''}`)
    if (t) await client.query(`UPDATE properties SET intake_linked_property_id = $2 WHERE id = $1`, [row.id, t.id])
    await record(client, { agent, action: 'rejected_duplicate', row, details: { target_id: t?.id || null, target_ref: t?.ref || null, note } })
    return { ok: true }
  })
}

async function dismissPackage(agent, packageId, { note } = {}) {
  if (!isAdmin(agent)) throw httpError(403, 'Only an administrator can dismiss a failed upload')
  const r = await db.query(
    `UPDATE upload_packages SET resolution = 'dismissed', resolved_by_agent_id = $2, resolved_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND state = 'FAILED' AND resolved_at IS NULL RETURNING id`, [Number(packageId), agent.id])
  if (!r.rows.length) throw httpError(409, 'Not a failed, open upload')
  await db.query(
    `INSERT INTO agent_activity_log (actor_agent_id, actor_role, actor_display_name, action_type, details, is_kev)
     VALUES ($1, $2, $3, 'intake:package_dismissed', $4::jsonb, FALSE)`,
    [agent.id, agent.role, agent.name || agent.username || null, JSON.stringify({ package_id: Number(packageId), note: note || null })])
  return { ok: true }
}

async function packageAccess(agent, packageId) {
  const r = await db.query(`SELECT * FROM upload_packages WHERE id = $1`, [Number(packageId)])
  const u = r.rows[0]
  if (!u) throw httpError(404, 'Upload not found')
  if (!isAdmin(agent) && Number(u.agent_id) !== Number(agent.id)) throw httpError(403, 'Not your upload')
  return u
}

module.exports = {
  FILTERS, missingFields, sanitizeEdits, imagesOf, canReview, shapeItem,
  listItems, getItem, summary, feed, saveEdits, verify, requestCorrection, linkExisting, rejectDuplicate, dismissPackage, packageAccess,
}
