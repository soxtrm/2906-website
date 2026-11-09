'use strict'
// ============================================================================
// services/propertySourceSync.js — ARGUS Property Source Sync (Claude, 2026-11-09)
//
// Registry of authorised provider collections, scan runs, change detection and
// the human review workflow. Listing observations live in the EXISTING
// website_source_inventory table (Base Inventory); an accepted review writes a
// STAGED canonical draft (is_staging, offline, unpublished, pending_check) or a
// linked/updated existing property — never a public listing, never a repost,
// never a WhatsApp message. Missing from source never means rented.
// ============================================================================
const db = require('../db')
const log = require('../logger')
const A = require('./propertySourceAdapters')
const F = require('./propertySourceFetch')

const MISSING_THRESHOLD = 2
const DETAIL_DELAY_MS = 3200
const MAX_LISTINGS = 100
const CHANGE_TYPES = ['PRICE_UPDATED', 'AVAILABILITY_CHANGED', 'MEDIA_CHANGED', 'DETAILS_CHANGED']

class SyncError extends Error { constructor(code, message, status = 400, extra = {}) { super(message); this.code = code; this.status = status; Object.assign(this, extra) } }

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function tx(fn) {
  const client = await db.connect()
  try { await client.query('BEGIN'); const out = await fn(client); await client.query('COMMIT'); return out }
  catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e }
  finally { client.release() }
}
async function audit(q, agent, action, details, propertyId = null, ref = null) {
  await q.query(`INSERT INTO agent_activity_log (actor_agent_id, actor_role, actor_display_name, action_type, target_property_id, target_ref, details)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [agent?.id ?? null, agent?.role ?? 'system', agent?.name ?? (agent ? null : 'source-sync'), action, propertyId, ref, JSON.stringify(details)])
}

// ── Registry ────────────────────────────────────────────────────────────────
function publicSource(row) {
  if (!row) return null
  const pollingBlockers = []
  if (row.read_permission !== 'GRANTED') pollingBlockers.push('Provider read/sync permission is not recorded')
  if (!row.permission_reference) pollingBlockers.push('No permission evidence reference')
  return { ...row, polling_allowed: pollingBlockers.length === 0, polling_blockers: pollingBlockers }
}
async function listSources(q = db) {
  const { rows } = await q.query(`SELECT * FROM property_sources ORDER BY provider_name, category`)
  return rows.map(publicSource)
}
async function getSource(id, q = db) {
  const { rows } = await q.query(`SELECT * FROM property_sources WHERE id=$1`, [id])
  if (!rows[0]) throw new SyncError('NOT_FOUND', 'Source not found', 404)
  return rows[0]
}
async function createSource(input, agent) {
  const adapter = String(input.adapter || 'mynexthome')
  const url = A.validateRegistration({ adapter, category: input.category, url: input.url })
  const a = A.adapterFor(adapter)
  const label = String(input.label || `${a.label} · ${input.category === 'sale' ? 'For Sale' : 'Long Let'}`).slice(0, 120)
  return tx(async q => {
    const { rows } = await q.query(
      `INSERT INTO property_sources (adapter, label, provider_name, provider_website, category, url, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (url) DO NOTHING RETURNING *`,
      [adapter, label, a.label, a.website, input.category, url, agent.id])
    if (!rows[0]) throw new SyncError('DUPLICATE_SOURCE', 'This source collection is already registered', 409)
    await audit(q, agent, 'PROPERTY_SOURCE_ADDED', { source_id: rows[0].id, url, category: input.category })
    return publicSource(rows[0])
  })
}

const INTERVALS = [6, 12, 24, 48, 72, 168]
async function updateSource(id, patch, agent) {
  return tx(async q => {
    const { rows: [cur] } = await q.query(`SELECT * FROM property_sources WHERE id=$1 FOR UPDATE`, [id])
    if (!cur) throw new SyncError('NOT_FOUND', 'Source not found', 404)
    if (patch.version != null && Number(patch.version) !== cur.version) throw new SyncError('VERSION_CONFLICT', 'Source changed elsewhere; reload', 409, { current: publicSource(cur) })
    const next = { ...cur }
    if (patch.label != null) next.label = String(patch.label).trim().slice(0, 120) || cur.label
    if (patch.interval_hours != null) {
      const h = Number(patch.interval_hours)
      if (!INTERVALS.includes(h)) throw new SyncError('INVALID_INTERVAL', `Interval must be one of ${INTERVALS.join(', ')} hours`)
      next.interval_hours = h
    }
    if (patch.import_mode != null) {
      if (!['DETECT_ONLY', 'REVIEW_REQUIRED'].includes(patch.import_mode)) throw new SyncError('INVALID_MODE', 'Unknown import mode')
      next.import_mode = patch.import_mode
    }
    if (patch.permission) {
      const p = patch.permission
      if (!['NOT_RECORDED', 'GRANTED', 'REVOKED'].includes(p.read_permission)) throw new SyncError('INVALID_PERMISSION', 'Unknown permission state')
      if (p.read_permission === 'GRANTED' && !String(p.reference || '').trim()) throw new SyncError('PERMISSION_EVIDENCE_REQUIRED', 'Record where the provider granted read/sync permission (agreement, email, date)')
      next.read_permission = p.read_permission
      next.permission_reference = p.read_permission === 'NOT_RECORDED' ? null : String(p.reference || cur.permission_reference || '').trim().slice(0, 500) || null
      next.permission_recorded_by = agent.id; next.permission_recorded_at = new Date()
      if (p.media_use) { if (!['LINK_ONLY', 'LICENSED'].includes(p.media_use)) throw new SyncError('INVALID_MEDIA_USE', 'Unknown media use'); next.media_use = p.media_use }
      if (p.text_use) { if (!['METADATA_ONLY', 'LICENSED'].includes(p.text_use)) throw new SyncError('INVALID_TEXT_USE', 'Unknown text use'); next.text_use = p.text_use }
      if (p.read_permission !== 'GRANTED') next.sync_enabled = false
      if (p.read_permission !== 'GRANTED' || next.media_use !== 'LICENSED') next.media_use = p.read_permission === 'GRANTED' ? next.media_use : 'LINK_ONLY'
    }
    if (patch.sync_enabled != null) {
      const on = patch.sync_enabled === true
      if (on && (next.read_permission !== 'GRANTED' || !next.permission_reference)) throw new SyncError('PERMISSION_REQUIRED', 'Automatic checking needs the provider’s recorded read/sync permission', 403)
      next.sync_enabled = on
      if (on && !cur.sync_enabled) next.next_check_at = new Date()
    }
    const { rows: [row] } = await q.query(
      `UPDATE property_sources SET label=$2, interval_hours=$3, import_mode=$4, read_permission=$5, permission_reference=$6,
              permission_recorded_by=$7, permission_recorded_at=$8, media_use=$9, text_use=$10, sync_enabled=$11, next_check_at=$12,
              version=version+1, updated_at=NOW() WHERE id=$1 RETURNING *`,
      [id, next.label, next.interval_hours, next.import_mode, next.read_permission, next.permission_reference,
       next.permission_recorded_by, next.permission_recorded_at, next.media_use, next.text_use, next.sync_enabled, next.next_check_at])
    await audit(q, agent, 'PROPERTY_SOURCE_UPDATED', { source_id: id, changes: Object.keys(patch) })
    return publicSource(row)
  })
}

// ── Matching (candidates only — never merges) ───────────────────────────────
function unitToken(s) { const m = /\b(?:flat|apt|apartment|unit)\s*(?:no\.?\s*)?(\d+[a-z]?)\b/i.exec(String(s || '')); return m ? m[1].toLowerCase() : null }
async function matchCandidates(q, item, wsiId) {
  const out = []
  const price = item.price?.amount != null ? Number(item.price.amount) : null
  const priceCol = item.category === 'sale' ? 'sale_price' : 'longlet_price'
  if (item.locality && item.bedrooms != null) {
    const { rows } = await q.query(
      `SELECT id, ref, town, apt, bedrooms, bathrooms, ${priceCol} AS price, available_status FROM properties
        WHERE archived_at IS NULL AND LOWER(town)=LOWER($1) AND bedrooms=$2
          AND ($3::numeric IS NULL OR ${priceCol} IS NULL OR ${priceCol} BETWEEN $3*0.85 AND $3*1.15)
        ORDER BY updated_at DESC NULLS LAST LIMIT 6`, [item.locality, item.bedrooms, price])
    const myUnit = unitToken(item.title)
    for (const r of rows) {
      if (myUnit && r.apt && String(r.apt).toLowerCase() !== myUnit) continue // same building ≠ same flat
      out.push({ kind: 'property', id: r.id, ref: r.ref, town: r.town, bedrooms: r.bedrooms, price: r.price, available_status: r.available_status,
                 reasons: ['same locality', 'same bedrooms', ...(price != null && r.price != null ? ['price within 15%'] : [])] })
    }
  }
  const { rows: other } = await q.query(
    `SELECT id, source_domain, external_title, canonical_property_id FROM website_source_inventory
      WHERE id <> $1 AND source_domain <> $2 AND (LOWER(external_title)=LOWER($3)
         OR ($4::text IS NOT NULL AND LOWER(parsed_locality)=LOWER($4) AND parsed_bedrooms=$5 AND $6::numeric IS NOT NULL AND parsed_price BETWEEN $6*0.95 AND $6*1.05))
      LIMIT 4`, [wsiId || 0, item.source_domain, item.title, item.locality, item.bedrooms, price])
  for (const r of other) out.push({ kind: 'other_source', id: r.id, source: r.source_domain, title: r.external_title, canonical_property_id: r.canonical_property_id, reasons: ['possible same unit offered by another source'] })
  return out
}

// ── Snapshot ingestion (the diff engine) ────────────────────────────────────
function flagsFor(item) {
  const f = []
  if (item.price?.conflict) f.push('PRICE_CONFLICT')
  if (item.price?.amount == null) f.push('NEEDS_PRICE_REVIEW')
  if (item.market_country === 'OUTSIDE_MALTA') f.push('OUTSIDE_MALTA')
  if (item.available_from_conflict) f.push('AVAILABILITY_CONFLICT')
  return f
}
function priceProvenance(item, observedAt) {
  if (item.price?.amount == null) return []
  return [{ value: Number(item.price.amount), source: `source_sync:${item.source_domain}`, confidence: item.price.conflict ? 'conflict_lower_chosen' : 'single_quote',
            observed_at: observedAt, note: (item.price.candidate_prices || []).map(c => `${c.amount} ${c.basis} — “${c.evidence}”`).join(' | ') }]
}
function stagedColumns(item, source) {
  return {
    external_title: item.title, parsed_price: item.price?.amount != null ? Number(item.price.amount) : null,
    parsed_price_unit: item.price?.amount != null ? (item.category === 'sale' ? 'sale' : 'month') : null,
    parsed_bedrooms: item.bedrooms ?? null, parsed_bathrooms: item.bathrooms ?? null, parsed_locality: item.locality ?? null,
    parsed_availability_text: item.available_from_source ? `Source says available from ${item.available_from_source} (unverified)` : null,
    parsed_available_date: item.available_date ?? A.maltaDate(item.available_from_source) ?? null,
    parsed_lease_type: item.category === 'long_let' ? 'long_let' : null, parsed_property_type: item.property_type ?? null,
    parsed_sqm: item.total_area_sqm ?? null,
    // LINK_ONLY: never copy media URLs into the column promotion reads from.
    source_images: source.media_use === 'LICENSED' ? (item.media_source_urls || []) : [],
    // Existing vocabulary: a provider quote is never CONFIRMED. Conflict detail
    // lives in event flags and field_provenance.price.
    price_confidence: 'REVIEW_REQUIRED',
  }
}

function normaliseItem(raw, source) {
  const a = A.adapterFor(source.adapter)
  if (raw.category !== source.category) throw new SyncError('CATEGORY_MISMATCH', 'Listing category must come from the source collection; detail-page buttons cannot override it')
  const url = A.canonicalUrl(raw.source_url, source.adapter)
  if (!new URL(url).pathname.startsWith(a.listingPrefix)) throw new SyncError('OUTSIDE_SOURCE_SECTION', 'Listing URL outside the approved source section')
  const item = JSON.parse(JSON.stringify(raw))
  item.source_url = url
  item.source_domain = a.canonicalHost
  item.external_id = A.externalRef(url)
  if (item.locality === undefined) item.locality = A.localityFromTitle(item.title)
  if (item.total_area_sqm === undefined && item.total_area) item.total_area_sqm = Number(String(item.total_area).replace(/[^\d.]/g, '')) || null
  if (!item.market_country || item.market_country === 'Malta') item.market_country = /malta/i.test(item.market_country || 'Malta') ? 'MALTA' : 'OUTSIDE_MALTA'
  if (item.price) item.price.conflict = item.price.conflict ?? (item.price.candidate_prices || []).length > 1
  item.availability_state = item.availability_state || 'SOURCE_LISTED_UNVERIFIED'
  return item
}

// listings: parsed items for ONE source collection. complete=false (or a
// failed scan) never advances missing counters.
async function ingestSnapshot(sourceId, listings, { complete = true, trigger = 'SNAPSHOT', agent = null, now = new Date() } = {}) {
  if (!Array.isArray(listings)) throw new SyncError('INVALID_SNAPSHOT', 'Expected a listing array')
  return tx(async q => {
    const { rows: [source] } = await q.query(`SELECT * FROM property_sources WHERE id=$1 FOR UPDATE`, [sourceId])
    if (!source) throw new SyncError('NOT_FOUND', 'Source not found', 404)
    const { rows: [scan] } = await q.query(`INSERT INTO property_source_scans (source_id, trigger, started_by, started_at) VALUES ($1,$2,$3,$4) RETURNING id`, [sourceId, trigger, agent?.id ?? null, now])
    const counts = { new: 0, price_updated: 0, availability_changed: 0, media_changed: 0, details_changed: 0, missing: 0, unchanged: 0 }
    const seen = new Set()
    const items = []
    for (const raw of listings) { const item = normaliseItem(raw, source); if (!seen.has(item.external_id)) { seen.add(item.external_id); items.push(item) } }
    const ts = now.toISOString()
    for (const item of items) {
      const fp = A.fingerprint(item)
      const flags = flagsFor(item)
      const staged = stagedColumns(item, source)
      const { rows: [row] } = await q.query(`SELECT * FROM website_source_inventory WHERE source_domain=$1 AND source_url=$2 FOR UPDATE`, [item.source_domain, item.source_url])
      if (!row) {
        const { rows: [ins] } = await q.query(
          `INSERT INTO website_source_inventory (source_domain, source_url, external_ref, external_title, source_metadata, source_images, import_status,
             parsed_price, parsed_price_unit, parsed_bedrooms, parsed_bathrooms, parsed_locality, parsed_availability_text, parsed_available_date,
             parsed_lease_type, parsed_property_type, parsed_sqm, field_provenance, price_confidence, scraped_at, last_checked_at, created_at, updated_at,
             source_id, source_category, current_fingerprint, current_snapshot, first_seen_at, last_seen_at, missing_scan_count, availability_state)
           VALUES ($1,$2,$3,$4,$5,$6,'REVIEW_NEEDED',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19,$19,$19,$20,$21,$22,$23,$19,$19,0,$24) RETURNING id`,
          [item.source_domain, item.source_url, item.external_id, staged.external_title,
           JSON.stringify({ adapter: source.adapter, category: source.category, provider: source.provider_name, market: item.market_country }),
           staged.source_images, staged.parsed_price, staged.parsed_price_unit, staged.parsed_bedrooms, staged.parsed_bathrooms, staged.parsed_locality,
           staged.parsed_availability_text, staged.parsed_available_date, staged.parsed_lease_type, staged.parsed_property_type, staged.parsed_sqm,
           JSON.stringify({ price: priceProvenance(item, ts) }), staged.price_confidence, ts,
           sourceId, source.category, fp, JSON.stringify(item), item.availability_state])
        const candidates = await matchCandidates(q, item, ins.id)
        if (candidates.length) flags.push('POSSIBLE_DUPLICATE')
        await q.query(`INSERT INTO property_source_events (source_id, wsi_id, scan_id, event_type, fingerprint, previous, current, flags, match_candidates)
                       VALUES ($1,$2,$3,'NEW',$4,NULL,$5,$6,$7) ON CONFLICT DO NOTHING`,
          [sourceId, ins.id, scan.id, fp, JSON.stringify(item), flags, JSON.stringify(candidates)])
        counts.new++
        continue
      }
      if (row.source_id && row.source_id !== sourceId) throw new SyncError('SOURCE_CONFLICT', 'Listing already belongs to another source collection')
      const previous = row.current_snapshot || null
      if (row.current_fingerprint === fp) {
        await q.query(`UPDATE website_source_inventory SET last_seen_at=$2, last_checked_at=$2, missing_scan_count=0, source_id=$3 WHERE id=$1`, [row.id, ts, sourceId])
        await q.query(`UPDATE property_source_events SET status='SUPERSEDED' WHERE wsi_id=$1 AND event_type='MISSING_FROM_SOURCE' AND status='PENDING'`, [row.id])
        counts.unchanged++
        continue
      }
      const changes = A.fieldChanges(previous, item)
      const neverAccepted = !row.canonical_property_id && !(await q.query(`SELECT 1 FROM property_source_events WHERE wsi_id=$1 AND event_type='NEW' AND status IN ('ACCEPTED','LINKED')`, [row.id])).rows.length
      const rejectedNew = (await q.query(`SELECT 1 FROM property_source_events WHERE wsi_id=$1 AND event_type='NEW' AND status='REJECTED'`, [row.id])).rows.length > 0
      const type = neverAccepted && !rejectedNew ? 'NEW' : A.classifyChange(changes)
      // A newer observation makes every older pending proposal for this listing stale.
      await q.query(`UPDATE property_source_events SET status='SUPERSEDED' WHERE wsi_id=$1 AND status='PENDING'`, [row.id])
      const candidates = type === 'NEW' ? await matchCandidates(q, item, row.id) : []
      if (candidates.length) flags.push('POSSIBLE_DUPLICATE')
      await q.query(`INSERT INTO property_source_events (source_id, wsi_id, scan_id, event_type, fingerprint, previous, current, field_changes, flags, match_candidates)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
        [sourceId, row.id, scan.id, type, fp, previous ? JSON.stringify(previous) : null, JSON.stringify(item), JSON.stringify(changes), flags, JSON.stringify(candidates)])
      // Observation advances; staged/canonical values only change on acceptance
      // (except a never-reviewed NEW row, whose staged values are the observation).
      const extra = neverAccepted && !rejectedNew ? stagedColumns(item, source) : null
      await q.query(`UPDATE website_source_inventory SET current_fingerprint=$2, current_snapshot=$3, last_seen_at=$4, last_checked_at=$4, missing_scan_count=0,
                       availability_state=$5, source_id=$6, updated_at=$4 ${extra ? `, external_title=$7, parsed_price=$8, parsed_price_unit=$9, parsed_bedrooms=$10, parsed_bathrooms=$11, parsed_available_date=$12, parsed_sqm=$13, price_confidence=$14` : ''}
                     WHERE id=$1`,
        [row.id, fp, JSON.stringify(item), ts, item.availability_state, sourceId,
         ...(extra ? [extra.external_title, extra.parsed_price, extra.parsed_price_unit, extra.parsed_bedrooms, extra.parsed_bathrooms, extra.parsed_available_date, extra.parsed_sqm, extra.price_confidence] : [])])
      counts[type === 'NEW' ? 'new' : type.toLowerCase()]++
    }
    if (complete) {
      const { rows: absent } = await q.query(
        `SELECT * FROM website_source_inventory WHERE source_id=$1 AND import_status <> 'REJECTED' AND NOT (external_ref = ANY($2::text[])) FOR UPDATE`, [sourceId, [...seen]])
      for (const row of absent) {
        const n = row.missing_scan_count + 1
        await q.query(`UPDATE website_source_inventory SET missing_scan_count=$2 WHERE id=$1`, [row.id, n])
        if (n === MISSING_THRESHOLD) {
          await q.query(`INSERT INTO property_source_events (source_id, wsi_id, scan_id, event_type, fingerprint, previous, current, flags)
                         VALUES ($1,$2,$3,'MISSING_FROM_SOURCE',$4,$5,$5,$6) ON CONFLICT DO NOTHING`,
            [sourceId, row.id, scan.id, `${row.current_fingerprint}:missing:${scan.id}`, JSON.stringify(row.current_snapshot || {}), ['VERIFY_WITH_PROVIDER']])
          counts.missing++
        }
      }
    }
    await q.query(`UPDATE property_source_scans SET finished_at=NOW(), status='SUCCEEDED', complete=$2, items_seen=$3, counts=$4 WHERE id=$1`, [scan.id, complete, items.length, JSON.stringify(counts)])
    await q.query(`UPDATE property_sources SET last_check_at=$2, last_success_at=$2, last_error=NULL, consecutive_failures=0,
                   complete_scan_count=complete_scan_count + $3::int, next_check_at = CASE WHEN sync_enabled THEN $2::timestamptz + make_interval(hours => interval_hours) ELSE next_check_at END
                   WHERE id=$1`, [sourceId, ts, complete ? 1 : 0])
    const changed = counts.new + counts.price_updated + counts.availability_changed + counts.media_changed + counts.details_changed + counts.missing
    if (changed > 0) await audit(q, agent, 'SOURCE_SYNC_DIGEST', { source_id: sourceId, scan_id: scan.id, label: source.label, counts })
    return { scanId: scan.id, itemsSeen: items.length, counts }
  })
}

// ── Live scan (permission-gated) ────────────────────────────────────────────
async function recordFailure(sourceId, scanId, err) {
  await db.query(`UPDATE property_source_scans SET finished_at=NOW(), status='FAILED', complete=FALSE, error=$2 WHERE id=$1`, [scanId, String(err.message).slice(0, 500)])
  await db.query(`UPDATE property_sources SET last_check_at=NOW(), last_error=$2, consecutive_failures=consecutive_failures+1,
                  next_check_at = CASE WHEN sync_enabled THEN NOW() + make_interval(hours => LEAST(168, interval_hours * POWER(2, LEAST(consecutive_failures, 4))::int)) ELSE next_check_at END
                  WHERE id=$1`, [sourceId, String(err.message).slice(0, 500)])
}

async function runScan(sourceId, { trigger = 'MANUAL', agent = null, request, robotsRequest, delayMs = DETAIL_DELAY_MS } = {}) {
  const source = await getSource(sourceId)
  if (source.read_permission !== 'GRANTED' || !source.permission_reference) throw new SyncError('PERMISSION_REQUIRED', 'Live checking needs the provider’s recorded read/sync permission', 403)
  if (trigger === 'SCHEDULED' && !source.sync_enabled) throw new SyncError('PAUSED', 'Source is paused', 409)
  const lock = await db.query(`SELECT pg_try_advisory_lock(hashtext('property_source_scan'), $1) AS ok`, [sourceId])
  if (!lock.rows[0].ok) throw new SyncError('SCAN_RUNNING', 'A scan for this source is already running', 409)
  const { rows: [scan] } = await db.query(`INSERT INTO property_source_scans (source_id, trigger, started_by) VALUES ($1,$2,$3) RETURNING id`, [sourceId, trigger, agent?.id ?? null])
  try {
    const a = A.adapterFor(source.adapter)
    await F.checkRobots(source.adapter, [new URL(source.url).pathname, a.listingPrefix], robotsRequest ? { request: robotsRequest } : {})
    const page = await F.fetchAllowed(source.url, source.adapter, { request })
    const urls = A.linksFromCategory(page.body, source.url, source.adapter)
    // An empty or oversized collection is never accepted as a successful scan.
    if (!urls.length) throw new Error('Zero listing links found; the page layout may have changed. No listing was marked missing.')
    if (urls.length > MAX_LISTINGS) throw new Error(`Unexpectedly many listings (${urls.length}); manual review required`)
    const items = []
    for (const [i, url] of urls.entries()) {
      if (i && delayMs) await sleep(delayMs)
      const detail = await F.fetchAllowed(url, source.adapter, { request })
      items.push(A.parseDetail(detail.body, detail.finalUrl, source.category, source.adapter))
    }
    await db.query(`DELETE FROM property_source_scans WHERE id=$1`, [scan.id]) // ingest records the authoritative run
    const result = await ingestSnapshot(sourceId, items, { complete: true, trigger, agent })
    await db.query(`UPDATE property_sources SET etag=$2, last_modified=$3 WHERE id=$1`, [sourceId, page.etag || null, page.lastModified || null])
    return result
  } catch (err) {
    await recordFailure(sourceId, scan.id, err)
    log.warn('property source scan failed', { sourceId, err: err.message })
    throw err instanceof SyncError ? err : new SyncError('SCAN_FAILED', err.message, 502)
  } finally {
    await db.query(`SELECT pg_advisory_unlock(hashtext('property_source_scan'), $1)`, [sourceId]).catch(() => {})
  }
}

// Scheduler tick (registered in cron.js). Only enabled, permitted, due sources.
async function tick(opts = {}) {
  const { rows } = await db.query(
    `SELECT id FROM property_sources WHERE sync_enabled AND read_permission='GRANTED' AND permission_reference IS NOT NULL
       AND (next_check_at IS NULL OR next_check_at <= NOW()) ORDER BY next_check_at NULLS FIRST LIMIT 2`)
  const out = []
  for (const r of rows) {
    try { out.push({ id: r.id, ok: true, result: await runScan(r.id, { trigger: 'SCHEDULED', ...opts }) }) }
    catch (err) { out.push({ id: r.id, ok: false, error: err.message }) }
  }
  return out
}

// ── Review decisions ────────────────────────────────────────────────────────
const SOURCE_TIERS = new Set(['website_scrape']) // weaker than owner/agent/human tiers
function newerAuthority(property, field, observedAt) {
  const entries = (property.field_provenance || {})[field]
  if (!Array.isArray(entries)) return null
  for (const e of entries) {
    const t = e.source_type || e.source
    const at = Date.parse(e.observed_at || e.updated_at || '')
    if (t && !SOURCE_TIERS.has(t) && !String(t).startsWith('source_sync:') && Number.isFinite(at) && at > Date.parse(observedAt)) return e
  }
  return null
}

async function decide(eventId, action, agent, opts = {}) {
  const ACTIONS = ['accept', 'reject', 'link', 'clarify', 'acknowledge']
  if (!ACTIONS.includes(action)) throw new SyncError('INVALID_ACTION', 'Unknown review action')
  return tx(async q => {
    const { rows: [ev] } = await q.query(`SELECT * FROM property_source_events WHERE id=$1 FOR UPDATE`, [eventId])
    if (!ev) throw new SyncError('NOT_FOUND', 'Proposal not found', 404)
    if (ev.status !== 'PENDING') {
      if (ev.decided_by === agent.id && ev.decision_result?.action === action) return { event: ev, idempotentReplay: true }
      throw new SyncError('ALREADY_DECIDED', `Proposal is already ${ev.status.toLowerCase()}`, 409, { event: ev })
    }
    const { rows: [wsi] } = await q.query(`SELECT * FROM website_source_inventory WHERE id=$1 FOR UPDATE`, [ev.wsi_id])
    const { rows: [source] } = await q.query(`SELECT * FROM property_sources WHERE id=$1`, [ev.source_id])
    if (opts.fingerprint && opts.fingerprint !== ev.fingerprint) throw new SyncError('STALE', 'You reviewed an older revision; reload the latest snapshot', 409)
    if (['accept', 'link'].includes(action) && ev.event_type !== 'MISSING_FROM_SOURCE' && wsi.current_fingerprint !== ev.fingerprint) {
      throw new SyncError('STALE', 'The source changed after this proposal; review the latest snapshot', 409, { latestFingerprint: wsi.current_fingerprint })
    }
    const item = ev.current
    const observedAt = wsi.last_seen_at ? new Date(wsi.last_seen_at).toISOString() : new Date().toISOString()
    let status, result = { action }, propertyId = wsi.canonical_property_id || null

    if (action === 'reject') {
      status = 'REJECTED'
      if (ev.event_type === 'NEW') await q.query(`UPDATE website_source_inventory SET import_status='REJECTED', review_notes=$2, updated_at=NOW() WHERE id=$1`, [wsi.id, `Rejected in Property Sources by agent ${agent.id}${opts.note ? `: ${String(opts.note).slice(0, 300)}` : ''}`])
    } else if (action === 'clarify') {
      status = 'CLARIFICATION'
    } else if (action === 'acknowledge') {
      if (ev.event_type !== 'MISSING_FROM_SOURCE') throw new SyncError('INVALID_ACTION', 'Only missing-from-source checks can be acknowledged')
      status = 'ACKNOWLEDGED' // never marks rented / unavailable
    } else if (action === 'link') {
      if (ev.event_type !== 'NEW') throw new SyncError('INVALID_ACTION', 'Only a new source listing can be linked to an existing property', 422)
      const pid = Number(opts.propertyId)
      const { rows: [p] } = await q.query(`SELECT id, ref FROM properties WHERE id=$1 AND archived_at IS NULL`, [pid])
      if (!p) throw new SyncError('PROPERTY_NOT_FOUND', 'Choose an existing, active ARGUS property', 422)
      const { rows: taken } = await q.query(`SELECT id FROM website_source_inventory WHERE source_id=$1 AND canonical_property_id=$2 AND id<>$3`, [ev.source_id, pid, wsi.id])
      if (taken.length) throw new SyncError('ALREADY_LINKED', 'That property is already linked to another listing of this source', 409)
      await q.query(`UPDATE website_source_inventory SET canonical_property_id=$2, import_status='SOURCE_DRAFT', updated_at=NOW() WHERE id=$1`, [wsi.id, pid])
      status = 'LINKED'; propertyId = pid; result = { action, propertyId: pid, ref: p.ref }
    } else if (ev.event_type === 'MISSING_FROM_SOURCE') {
      throw new SyncError('INVALID_ACTION', 'A missing listing can only be acknowledged or clarified; it is never marked rented from a website', 422)
    } else if (ev.event_type === 'NEW') {
      if ((ev.flags || []).includes('OUTSIDE_MALTA')) throw new SyncError('OUTSIDE_MALTA', 'International listing: not Maltese inventory. Link or reject it.', 422)
      if (wsi.canonical_property_id) throw new SyncError('ALREADY_LINKED', 'Already linked to an ARGUS property', 409)
      const staged = stagedColumns(item, source)
      const ref = `WSI-${source.adapter.toUpperCase()}-${wsi.external_ref.slice(0, 12)}`
      const prov = {}
      const add = (field, value) => { if (value != null) prov[field] = [{ value, source_type: 'website_scrape', source_reference: `${wsi.source_domain}#${wsi.external_ref}`, observed_at: observedAt, confidence: 'inferred', explicit_or_inferred: 'inferred', updated_by: `agent:${agent.id}` }] }
      add('locality', staged.parsed_locality); add('property_type', staged.parsed_property_type); add('bedrooms', staged.parsed_bedrooms)
      add('bathrooms', staged.parsed_bathrooms); add('sqm', staged.parsed_sqm); add('price', staged.parsed_price); add('availability', staged.parsed_available_date)
      if (prov.price && item.price?.conflict) prov.price[0].note = `PRICE_CONFLICT: lower of ${(item.price.candidate_prices || []).map(c => c.amount).join(' / ')} chosen`
      const description = `${item.title} — listed by ${source.provider_name} (${item.source_url}). Imported from Property Sources; availability unverified until the owner or agency confirms.`
      const { rows: [p] } = await q.query(
        `INSERT INTO properties (ref, town, property_type, bedrooms, bathrooms, size_sqm, longlet_price, sale_price, lease_type, available_date, description, images,
           system_online, published, is_staging, available_status, listed_by_agent_id, field_provenance, internal_notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,false,false,true,'pending_check',$13,$14,$15) RETURNING id, ref`,
        [ref, staged.parsed_locality, staged.parsed_property_type, staged.parsed_bedrooms, staged.parsed_bathrooms, staged.parsed_sqm,
         item.category === 'long_let' ? staged.parsed_price : null, item.category === 'sale' ? staged.parsed_price : null,
         staged.parsed_lease_type, staged.parsed_available_date, description, JSON.stringify(staged.source_images),
         agent.id, JSON.stringify(prov),
         `Source: ${source.provider_name} (${source.label}), Property Sources event #${ev.id}. Media/text rights: ${source.media_use}/${source.text_use}. Staged draft — not published, no repost.`])
      await q.query(`UPDATE website_source_inventory SET canonical_property_id=$2, import_status='SOURCE_DRAFT', updated_at=NOW() WHERE id=$1`, [wsi.id, p.id])
      status = 'ACCEPTED'; propertyId = p.id; result = { action, propertyId: p.id, ref: p.ref, staged: true }
    } else {
      // Accepted change: staged values first, then permitted write-through.
      const staged = stagedColumns(item, source)
      await q.query(`UPDATE website_source_inventory SET external_title=$2, parsed_price=$3, parsed_price_unit=$4, parsed_bedrooms=$5, parsed_bathrooms=$6,
                       parsed_available_date=$7, parsed_availability_text=$8, parsed_sqm=$9, price_confidence=$10, source_images=$11, updated_at=NOW() WHERE id=$1`,
        [wsi.id, staged.external_title, staged.parsed_price, staged.parsed_price_unit, staged.parsed_bedrooms, staged.parsed_bathrooms,
         staged.parsed_available_date, staged.parsed_availability_text, staged.parsed_sqm, staged.price_confidence, staged.source_images])
      const applied = [], skipped = []
      if (wsi.canonical_property_id) {
        const { rows: [p] } = await q.query(`SELECT * FROM properties WHERE id=$1 FOR UPDATE`, [wsi.canonical_property_id])
        const priceCol = item.category === 'sale' ? 'sale_price' : 'longlet_price'
        const plan = [['price', priceCol, staged.parsed_price], ['bedrooms', 'bedrooms', staged.parsed_bedrooms], ['bathrooms', 'bathrooms', staged.parsed_bathrooms],
                      ['sqm', 'size_sqm', staged.parsed_sqm], ['availability', 'available_date', staged.parsed_available_date]]
        const prov = { ...(p.field_provenance || {}) }
        const sets = [], vals = []
        for (const [field, col, value] of plan) {
          if (!(field === 'price' ? ev.field_changes.price_amount : field === 'availability' ? ev.field_changes.available_from_source : ev.field_changes[field === 'sqm' ? 'total_area_sqm' : field])) continue
          if (value == null) { skipped.push({ field, reason: 'source value unknown' }); continue }
          const stronger = newerAuthority(p, field, observedAt)
          if (stronger) { skipped.push({ field, reason: `newer ${stronger.source_type || stronger.source} confirmation (${stronger.observed_at})` }); continue }
          if (field === 'availability' && p.last_confirmed_available_at && Date.parse(p.last_confirmed_available_at) > Date.parse(observedAt)) { skipped.push({ field, reason: 'newer owner availability confirmation' }); continue }
          sets.push(`${col}=$${vals.length + 2}`); vals.push(value); applied.push(field)
          prov[field] = [{ value, source_type: 'website_scrape', source_reference: `${wsi.source_domain}#${wsi.external_ref}`, observed_at: observedAt, confidence: item.price?.conflict && field === 'price' ? 'conflict_lower_chosen' : 'inferred', updated_by: `agent:${agent.id}` }, ...(Array.isArray(prov[field]) ? prov[field] : [])].slice(0, 10)
        }
        if (sets.length) await q.query(`UPDATE properties SET ${sets.join(', ')}, field_provenance=$${vals.length + 2}, updated_at=NOW() WHERE id=$1`, [p.id, ...vals, JSON.stringify(prov)])
        await audit(q, agent, 'PROPERTY_SOURCE_WRITE_THROUGH', { event_id: ev.id, applied, skipped, save_mode: 'SAVE_ONLY_NO_REPOST' }, p.id, p.ref)
      }
      status = 'ACCEPTED'; result = { action, propertyId, applied, skipped }
    }
    const { rows: [updated] } = await q.query(
      `UPDATE property_source_events SET status=$2, decided_by=$3, decided_at=NOW(), decision_note=$4, decision_result=$5, canonical_property_id=$6 WHERE id=$1 RETURNING *`,
      [ev.id, status, agent.id, opts.note ? String(opts.note).slice(0, 500) : null, JSON.stringify(result), propertyId])
    await audit(q, agent, 'PROPERTY_SOURCE_REVIEW', { event_id: ev.id, event_type: ev.event_type, status, result }, propertyId, wsi.external_ref)
    return { event: updated, result }
  })
}

// Batch: only SAFE new drafts (no conflict, no duplicate, Malta, known price).
async function acceptSafeNew(sourceId, agent, ids) {
  const { rows } = await db.query(
    `SELECT id FROM property_source_events WHERE source_id=$1 AND status='PENDING' AND event_type='NEW' AND id = ANY($2::int[])
       AND NOT (flags && ARRAY['PRICE_CONFLICT','NEEDS_PRICE_REVIEW','OUTSIDE_MALTA','POSSIBLE_DUPLICATE','AVAILABILITY_CONFLICT'])`, [sourceId, ids.map(Number)])
  const results = []
  for (const r of rows) { try { results.push({ id: r.id, ok: true, ...(await decide(r.id, 'accept', agent)).result }) } catch (e) { results.push({ id: r.id, ok: false, error: e.message }) } }
  return { accepted: results.filter(r => r.ok).length, skipped: ids.length - rows.length, results }
}

// ── Read models ─────────────────────────────────────────────────────────────
async function summary() {
  const sources = await listSources()
  const { rows: counts } = await db.query(
    `SELECT source_id, COUNT(*) FILTER (WHERE event_type='NEW')::int AS new,
            COUNT(*) FILTER (WHERE event_type IN ('PRICE_UPDATED','AVAILABILITY_CHANGED','MEDIA_CHANGED','DETAILS_CHANGED'))::int AS updated,
            COUNT(*) FILTER (WHERE event_type='MISSING_FROM_SOURCE')::int AS check
       FROM property_source_events WHERE status IN ('PENDING','CLARIFICATION') GROUP BY source_id`)
  const { rows: digests } = await db.query(
    `SELECT id, details, created_at FROM agent_activity_log WHERE action_type='SOURCE_SYNC_DIGEST' ORDER BY created_at DESC LIMIT 10`)
  const by = Object.fromEntries(counts.map(c => [c.source_id, c]))
  const out = sources.map(s => ({ ...s, pending: by[s.id] || { new: 0, updated: 0, check: 0 } }))
  const totals = out.reduce((t, s) => ({ new: t.new + s.pending.new, updated: t.updated + s.pending.updated, check: t.check + s.pending.check }), { new: 0, updated: 0, check: 0 })
  return { sources: out, totals, digests: digests.map(d => ({ id: Number(d.id), createdAt: d.created_at, ...d.details })) }
}
async function listEvents({ sourceId, status = 'PENDING', type, limit = 200 } = {}) {
  const where = ['1=1'], params = []
  if (sourceId) { params.push(Number(sourceId)); where.push(`e.source_id=$${params.length}`) }
  if (status && status !== 'ALL') { params.push(status === 'OPEN' ? ['PENDING', 'CLARIFICATION'] : [status]); where.push(`e.status = ANY($${params.length})`) }
  if (type) { params.push(type); where.push(`e.event_type=$${params.length}`) }
  params.push(Math.min(Number(limit) || 200, 500))
  const { rows } = await db.query(
    `SELECT e.*, s.label AS source_label, s.category, s.media_use, w.canonical_property_id AS wsi_property_id, w.current_fingerprint, w.import_status
       FROM property_source_events e JOIN property_sources s ON s.id=e.source_id JOIN website_source_inventory w ON w.id=e.wsi_id
      WHERE ${where.join(' AND ')} ORDER BY e.created_at DESC, e.id DESC LIMIT $${params.length}`, params)
  return rows.map(r => ({ ...r, current: A.sanitizedPreview(r.current), previous: r.previous ? A.sanitizedPreview(r.previous) : null, stale: r.event_type !== 'MISSING_FROM_SOURCE' && r.current_fingerprint !== r.fingerprint }))
}
// Admin detail: full evidence. Private address and media URLs are returned to
// admins only, labelled; media stays a link unless the source is licensed.
async function eventDetail(id) {
  const { rows: [r] } = await db.query(
    `SELECT e.*, s.label AS source_label, s.media_use, s.text_use, s.provider_name, w.current_fingerprint, w.canonical_property_id AS wsi_property_id, w.last_seen_at, w.first_seen_at, w.missing_scan_count
       FROM property_source_events e JOIN property_sources s ON s.id=e.source_id JOIN website_source_inventory w ON w.id=e.wsi_id WHERE e.id=$1`, [id])
  if (!r) throw new SyncError('NOT_FOUND', 'Proposal not found', 404)
  let property = null
  if (r.wsi_property_id) property = (await db.query(`SELECT id, ref, town, bedrooms, bathrooms, longlet_price, sale_price, available_status, available_date, published, system_online, is_staging, last_confirmed_available_at FROM properties WHERE id=$1`, [r.wsi_property_id])).rows[0] || null
  const licensed = r.media_use === 'LICENSED'
  const strip = snap => { if (!snap) return snap; const c = { ...snap }; if (!licensed) delete c.media_source_urls; return c }
  const mediaCount = (r.current?.media_source_urls || []).length
  return { ...r, current: strip(r.current), previous: strip(r.previous), stale: r.event_type !== 'MISSING_FROM_SOURCE' && r.current_fingerprint !== r.fingerprint, property,
           privacy: { address: r.current?.private_address_candidate ? 'PRIVATE — admin only, never shared or published' : null },
           media: { use: r.media_use, count: mediaCount, urls: licensed ? r.current?.media_source_urls || [] : [], note: r.media_use === 'LICENSED' ? null : 'Link only: open the source page to view photos.' } }
}
async function scans(sourceId, limit = 20) {
  const { rows } = await db.query(`SELECT * FROM property_source_scans WHERE source_id=$1 ORDER BY started_at DESC LIMIT $2`, [sourceId, limit])
  return rows
}

module.exports = { SyncError, listSources, getSource, createSource, updateSource, ingestSnapshot, runScan, tick, decide, acceptSafeNew, summary, listEvents, eventDetail, scans, publicSource, matchCandidates, MISSING_THRESHOLD }
