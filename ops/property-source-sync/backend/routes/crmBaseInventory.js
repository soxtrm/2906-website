'use strict'
// ============================================================================
// routes/crmBaseInventory.js — Base Inventory Review screen (Kev, 2026-09-17).
// Reads/writes website_source_inventory ONLY. Promotion creates a real
// `properties` row and is the ONE place a scraped record can ever reach the
// Agent Board — every other action here stays inside website_source_inventory.
// ============================================================================
const express = require('express')
const router = express.Router()
const jwt = require('jsonwebtoken')
const db = require('../db')
const log = require('../logger')
const learningLedger = require('../services/learningLedger')

const JWT_SECRET = process.env.JWT_SECRET

async function auth(req, res, next) {
  const h = req.headers.authorization
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' })
  let payload
  try { payload = jwt.verify(h.slice(7), JWT_SECRET) } catch { return res.status(401).json({ error: 'Session invalid or expired' }) }
  try {
    const r = await db.query(`SELECT id, role, active FROM agents WHERE id = $1`, [payload.id])
    const row = r.rows[0]
    if (!row || !row.active) return res.status(401).json({ error: 'Account inactive' })
    req.agent = { id: row.id, role: row.role }
  } catch (e) {
    return res.status(500).json({ error: 'Auth check failed' })
  }
  next()
}

// Single source of truth for the display status shown in the UI — computed
// from real fields every time, never a second stored copy that can drift
// from the data it describes. Ordered so a blocking data gap always wins
// over a softer classification label.
function computeDisplayStatus(row) {
  // Property Sources (2026-11-09): reviewed in /crm/property-sources.
  if (row.import_status === 'SOURCE_DRAFT') return 'SOURCE_DRAFT'
  if (row.import_status === 'REJECTED') return 'SOURCE_REJECTED'
  if (row.import_status === 'MERGED') return 'DUPLICATE_MERGED'
  if (row.import_status === 'REMOVED') return 'SOURCE_REMOVED'
  if (row.import_status === 'ACTIVE') return 'PROMOTED'
  if (row.parsed_price == null) return 'MISSING_PRICE'
  if (!row.parsed_available_date && !row.parsed_availability_text) return 'MISSING_AVAILABILITY'
  if (row.parsed_lease_type === 'winter_let') return 'WINTER_PERIODIC'
  if (row.import_status === 'BASE_INVENTORY') return 'BASE_INVENTORY'
  if (row.import_status === 'PARSED') return 'READY_FOR_BOARD'
  return 'NEEDS_REVIEW'
}

// Agent Board promotion gate (spec §5) — the one place "is this actually
// usable stock" gets decided, checked again server-side on the promote
// action itself, not just reflected in the list's status label.
function validatePromotion(row) {
  const reasons = []
  if (row.parsed_price == null) reasons.push('No usable monthly price.')
  if (!row.parsed_lease_type) reasons.push('Lease type not set.')
  if (!row.parsed_available_date && !row.parsed_availability_text) reasons.push('Availability not confirmed.')
  if (row.parsed_bedrooms == null) reasons.push('Bedroom count unknown.')
  if (!row.parsed_locality && !row.parsed_address) reasons.push('Locality/address unknown.')
  if (row.import_status === 'ACTIVE') reasons.push('Already promoted.')
  if (row.import_status === 'MERGED' || row.import_status === 'REMOVED') reasons.push('This record is no longer active.')
  // Provider listings must go through Property Sources review (rights, price
  // conflicts, duplicates) — never straight to the Agent Board from here.
  if (row.source_id) reasons.push('Managed by Property Sources: accept it in Integrations → Property Sources.')
  return { eligible: reasons.length === 0, reasons }
}

function withStatus(row) {
  const { eligible, reasons } = validatePromotion(row)
  return { ...row, display_status: computeDisplayStatus(row), promotion_eligible: eligible, promotion_blockers: reasons }
}

// ── GET / — filtered list + summary (spec §1-2, §8) ─────────────────────────
router.get('/', auth, async (req, res) => {
  try {
    const q = req.query
    const where = []
    const params = []
    let i = 1
    if (q.source) { where.push(`source_domain = $${i++}`); params.push(q.source) }
    if (q.owner_id) { where.push(`owner_id = $${i++}`); params.push(q.owner_id) }
    if (q.locality) { where.push(`parsed_locality ILIKE $${i++}`); params.push(`%${q.locality}%`) }
    if (q.lease_type) { where.push(`parsed_lease_type = $${i++}`); params.push(q.lease_type) }
    if (q.price_known === 'true') where.push(`parsed_price IS NOT NULL`)
    if (q.price_known === 'false') where.push(`parsed_price IS NULL`)
    if (q.availability_known === 'true') where.push(`(parsed_available_date IS NOT NULL OR parsed_availability_text IS NOT NULL)`)
    if (q.availability_known === 'false') where.push(`(parsed_available_date IS NULL AND parsed_availability_text IS NULL)`)
    if (q.seafront === 'true') where.push(`parsed_seafront = true`)
    if (q.bedrooms) { where.push(`parsed_bedrooms = $${i++}`); params.push(Number(q.bedrooms)) }
    if (q.search) {
      where.push(`(external_ref ILIKE $${i} OR external_title ILIKE $${i} OR parsed_address ILIKE $${i} OR source_url ILIKE $${i})`)
      params.push(`%${q.search}%`); i++
    }
    const sql = `SELECT w.*, o.name AS owner_name, o.phone AS owner_phone
                   FROM website_source_inventory w
                   LEFT JOIN owners o ON o.id = w.owner_id
                  ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                  ORDER BY w.source_domain, w.external_ref::text`
    const { rows } = await db.query(sql, params)
    let withStatuses = rows.map(withStatus)

    // needs_review / agent_board_eligible are DERIVED filters (they depend on
    // computed status), so they run as a post-filter rather than more SQL.
    if (q.needs_review === 'true') withStatuses = withStatuses.filter(r => r.display_status === 'NEEDS_REVIEW')
    if (q.agent_board_eligible === 'true') withStatuses = withStatuses.filter(r => r.promotion_eligible)

    const bySource = {}
    for (const r of rows) {
      const s = withStatus(r)
      bySource[r.source_domain] = bySource[r.source_domain] || { discovered: 0, imported: 0, merged: 0, readyForBoard: 0, baseOnly: 0, needsReview: 0 }
      const b = bySource[r.source_domain]
      b.discovered++
      if (r.import_status !== 'DISCOVERED') b.imported++
      if (s.display_status === 'DUPLICATE_MERGED') b.merged++
      if (s.display_status === 'READY_FOR_BOARD') b.readyForBoard++
      if (s.display_status === 'BASE_INVENTORY') b.baseOnly++
      if (s.display_status === 'NEEDS_REVIEW' || s.display_status === 'MISSING_PRICE' || s.display_status === 'MISSING_AVAILABILITY') b.needsReview++
    }

    res.json({ rows: withStatuses, summary: bySource })
  } catch (err) {
    log.error('base-inventory list failed', { err: err.message })
    res.status(500).json({ error: err.message })
  }
})

// ── GET /:id — full review detail (spec §3) ─────────────────────────────────
router.get('/:id', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT w.*, o.name AS owner_name, o.phone AS owner_phone
         FROM website_source_inventory w LEFT JOIN owners o ON o.id = w.owner_id
        WHERE w.id = $1`, [req.params.id])
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(withStatus(rows[0]))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

const EDITABLE = ['parsed_price', 'parsed_price_unit', 'parsed_bedrooms', 'parsed_bathrooms',
  'parsed_locality', 'parsed_address', 'parsed_availability_text', 'parsed_available_date',
  'parsed_lease_type', 'parsed_seafront', 'parsed_property_type', 'parsed_sqm', 'review_notes']

router.patch('/:id', auth, async (req, res) => {
  try {
    const b = req.body || {}
    const beforeResult = await db.query(`SELECT * FROM website_source_inventory WHERE id = $1`, [req.params.id])
    const before = beforeResult.rows[0]
    if (!before) return res.status(404).json({ error: 'Not found' })
    const sets = []
    const params = []
    let i = 1
    for (const f of EDITABLE) {
      if (b[f] !== undefined) { sets.push(`${f} = $${i++}`); params.push(b[f]) }
    }
    if (!sets.length) return res.status(400).json({ error: 'No editable fields provided' })
    params.push(req.params.id)
    sets.push('updated_at = NOW()')
    const { rows } = await db.query(
      `UPDATE website_source_inventory SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, params)
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    // Every human field correction becomes structured eval data. The old
    // parsed value is the model/import output; the saved value is target truth.
    // Provenance is preserved as evidence rather than training on bot text.
    for (const field of EDITABLE) {
      if (b[field] === undefined || JSON.stringify(before[field]) === JSON.stringify(rows[0][field])) continue
      const provenanceKey = field.replace(/^parsed_/, '')
      await learningLedger.record({
        flow: 'property_draft', entityType: 'website_source_inventory', entityId: before.id,
        propertyRef: before.external_ref, field: provenanceKey, action: 'HUMAN_CORRECTION',
        modelOutput: before[field], finalHumanValue: rows[0][field],
        sourceEvidence: before.field_provenance?.[provenanceKey] || [],
        errorTaxonomy: before[field] == null ? 'missing_value' : 'incorrect_extraction',
        modelName: 'source-import', promptVersion: before.source_domain || 'unknown',
        reviewerAgentId: req.agent.id, vertical: rows[0].parsed_lease_type || 'unknown', mode: 'ASSIST',
        downstreamConsequence: rows[0].canonical_property_id ? 'canonical_property_requires_review' : 'draft_corrected_before_publish',
      })
    }
    res.json(withStatus(rows[0]))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

async function setStatus(id, importStatus, extra = {}) {
  const sets = ['import_status = $1', 'updated_at = NOW()']
  const params = [importStatus]
  let i = 2
  for (const [k, v] of Object.entries(extra)) { sets.push(`${k} = $${i++}`); params.push(v) }
  params.push(id)
  const { rows } = await db.query(`UPDATE website_source_inventory SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, params)
  return rows[0]
}

router.post('/:id/approve-base', auth, async (req, res) => {
  const row = await setStatus(req.params.id, 'BASE_INVENTORY')
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(withStatus(row))
})
router.post('/:id/keep-base-only', auth, async (req, res) => {
  const row = await setStatus(req.params.id, 'BASE_INVENTORY')
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(withStatus(row))
})
router.post('/:id/needs-review', auth, async (req, res) => {
  const row = await setStatus(req.params.id, 'REVIEW_NEEDED', { review_notes: req.body?.note || null })
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(withStatus(row))
})
router.post('/:id/archive', auth, async (req, res) => {
  const row = await setStatus(req.params.id, 'REMOVED')
  if (!row) return res.status(404).json({ error: 'Not found' })
  // Security audit finding (2026-09-17): promote/archive/merge had no
  // durable audit trail at all — reusing agent_activity_log, same table
  // every other Agent-Layer action already writes to.
  db.query(`INSERT INTO agent_activity_log (actor_agent_id, actor_role, actor_display_name, action_type, details) VALUES ($1,$2,$3,'BASE_INVENTORY_ARCHIVED',$4)`,
    [req.agent.id, req.agent.role, req.agent.name, JSON.stringify({ website_source_inventory_id: row.id, source_domain: row.source_domain, external_ref: row.external_ref })])
    .catch(err => log.warn('base-inventory archive audit insert failed', { err: err.message }))
  res.json(withStatus(row))
})
router.post('/:id/merge', auth, async (req, res) => {
  const { into_id } = req.body || {}
  if (!into_id) return res.status(400).json({ error: 'into_id is required' })
  const row = await setStatus(req.params.id, 'MERGED', { merged_into_id: into_id })
  if (!row) return res.status(404).json({ error: 'Not found' })
  db.query(`INSERT INTO agent_activity_log (actor_agent_id, actor_role, actor_display_name, action_type, details) VALUES ($1,$2,$3,'BASE_INVENTORY_MERGED',$4)`,
    [req.agent.id, req.agent.role, req.agent.name, JSON.stringify({ website_source_inventory_id: row.id, merged_into_id: into_id })])
    .catch(err => log.warn('base-inventory merge audit insert failed', { err: err.message }))
  res.json(withStatus(row))
})

// ── POST /:id/promote — the ONE path from Base Inventory to the Agent Board
// (spec §5). Validates again server-side (never trusts the list's cached
// eligibility flag), then creates a real `properties` row and links back via
// canonical_property_id. Never overwrites an existing promotion.
router.post('/:id/promote', auth, async (req, res) => {
  try {
    const cur = await db.query(`SELECT * FROM website_source_inventory WHERE id = $1`, [req.params.id])
    const row = cur.rows[0]
    if (!row) return res.status(404).json({ error: 'Not found' })
    if (row.canonical_property_id) return res.status(409).json({ error: 'Already promoted', propertyId: row.canonical_property_id })
    const { eligible, reasons } = validatePromotion(row)
    if (!eligible) return res.status(422).json({ error: 'Cannot promote', reasons })

    const ref = `WSI-${row.source_domain.split('.')[0].toUpperCase()}-${row.external_ref}`
    const description = [
      row.external_title,
      row.parsed_property_type ? `${row.parsed_property_type} in ${row.parsed_locality || row.parsed_address || 'Malta'}.` : null,
      row.parsed_bedrooms != null ? `${row.parsed_bedrooms} bedroom${row.parsed_bedrooms === 1 ? '' : 's'}${row.parsed_bathrooms != null ? `, ${row.parsed_bathrooms} bathroom${row.parsed_bathrooms === 1 ? '' : 's'}` : ''}.` : null,
      row.parsed_seafront ? 'Direct seafront.' : null,
      row.parsed_sqm ? `${row.parsed_sqm} sqm.` : null,
    ].filter(Boolean).join(' ')

    // properties.owner_id is a legacy INTEGER column, unrelated to the UUID
    // `owners` table website_source_inventory.owner_id points into -- the two
    // owner-identity systems don't share a key, so this intentionally leaves
    // properties.owner_id unset rather than force an incompatible value.
    // website_source_inventory keeps the real (UUID) owner link for
    // provenance regardless of promotion.
    // Kev, 2026-09-17 (live bug: the two already-promoted Marsaskala
    // properties went to the board with zero photos): this INSERT never
    // carried row.source_images across at all. properties.images is jsonb,
    // and routes/crmScheduleBoard.js's own orderedImages() already accepts
    // either a plain URL string or {url} per entry -- plain strings here.
    // Field provenance (Phase B, 2026-09-18): promotion is the ONE moment
    // every carried-over fact's real origin is known precisely (this exact
    // scraped row, this exact source domain, this exact scrape timestamp) —
    // seed properties.field_provenance right here rather than leaving it
    // permanently empty. Source priority per spec: a website scrape is
    // "trusted structured source field" tier (source_type='website_scrape'),
    // below a human CRM correction or an owner's own WhatsApp statement —
    // routes/crm.js's PATCH /properties/:id (Phase A) already overwrites
    // whichever of these fields a human edits later, at a higher trust tier,
    // via the SAME field_provenance column (see that route's own comment).
    const now = new Date().toISOString()
    const provenanceEntry = (value, field) => ({
      value, source_type: 'website_scrape', source_reference: `${row.source_domain}#${row.external_ref}`,
      observed_at: row.scraped_at || now, confidence: 'inferred', explicit_or_inferred: 'inferred', updated_by: `agent:${req.agent.id}`,
    })
    const fieldProvenance = {}
    for (const [field, value] of Object.entries({
      locality: row.parsed_locality, address: row.parsed_address, property_type: row.parsed_property_type,
      bedrooms: row.parsed_bedrooms, bathrooms: row.parsed_bathrooms, sqm: row.parsed_sqm,
      price: row.parsed_price_unit === 'month' ? row.parsed_price : null, lease_type: row.parsed_lease_type,
      availability: row.parsed_available_date,
    })) {
      if (value !== null && value !== undefined) fieldProvenance[field] = [provenanceEntry(value, field)]
    }

    // Global property sanity check (Phase A, 2026-09-18) — SUSPICIOUS values
    // (e.g. an absurd bathroom count) don't block promotion — validatePromotion()
    // above already gates the fields that genuinely must be known — but they
    // ARE surfaced so the promoting agent sees the flag instead of it
    // silently reaching the Agent Board.
    const sanity = require('../services/propertySanity').validateProperty({
      bedrooms: row.parsed_bedrooms, bathrooms: row.parsed_bathrooms,
      longlet_price: row.parsed_price_unit === 'month' ? row.parsed_price : null, price_unit: row.parsed_price_unit,
      size_sqm: row.parsed_sqm, available_date: row.parsed_available_date,
      lease_type: row.parsed_lease_type, property_type: row.parsed_property_type,
    })
    const sanityWarnings = sanity.suspicious.map(f => sanity.fields[f].note)

    const ins = await db.query(
      `INSERT INTO properties (ref, town, street, property_type, bedrooms, bathrooms, size_sqm,
         longlet_price, lease_type, available_date, description, images, system_online, available_status,
         listed_by_agent_id, field_provenance)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,'available',$13,$14)
       RETURNING id`,
      [ref, row.parsed_locality, row.parsed_address, row.parsed_property_type, row.parsed_bedrooms,
       row.parsed_bathrooms, row.parsed_sqm, row.parsed_price_unit === 'month' ? row.parsed_price : null,
       row.parsed_lease_type, row.parsed_available_date, description, JSON.stringify(row.source_images || []),
       req.agent.id, JSON.stringify(fieldProvenance)])
    const propertyId = ins.rows[0].id

    const updated = await setStatus(row.id, 'ACTIVE', { canonical_property_id: propertyId })
    db.query(`INSERT INTO agent_activity_log (actor_agent_id, actor_role, actor_display_name, action_type, target_property_id, target_ref, details) VALUES ($1,$2,$3,'BASE_INVENTORY_PROMOTED',$4,$5,$6)`,
      [req.agent.id, req.agent.role, req.agent.name, propertyId, ref, JSON.stringify({ website_source_inventory_id: row.id, source_domain: row.source_domain, external_ref: row.external_ref, sanityWarnings })])
      .catch(err => log.warn('base-inventory promote audit insert failed', { err: err.message }))
    res.json({ ...withStatus(updated), propertyId, sanityWarnings })
  } catch (err) {
    log.error('base-inventory promote failed', { err: err.message })
    res.status(500).json({ error: err.message })
  }
})

// ── Bulk actions (spec §6) — never bulk-promotes; that always needs
// per-property eligibility, so it isn't offered here at all.
router.post('/bulk', auth, async (req, res) => {
  try {
    const { ids, action, note } = req.body || {}
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids[] is required' })
    const STATUS_BY_ACTION = { 'approve-base': 'BASE_INVENTORY', 'keep-base-only': 'BASE_INVENTORY', 'needs-review': 'REVIEW_NEEDED' }
    const importStatus = STATUS_BY_ACTION[action]
    if (!importStatus) return res.status(400).json({ error: `Unsupported bulk action: ${action}` })
    const extra = action === 'needs-review' ? { review_notes: note || null } : {}
    const results = []
    for (const id of ids) results.push(await setStatus(id, importStatus, extra))
    res.json({ updated: results.filter(Boolean).length })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
