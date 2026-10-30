'use strict'
// ============================================================================
// services/websitePublication.js — keeps 2906.estate in step with the CRM
// (Kev, 2026-10-31).
//
// The public site reads website_properties (routes/properties.js), a
// projection written by services/websiteSync.js. That bridge was only called
// from the CRM edit routes, so every other change (owner says rented, board
// check-out, rentedDetector, ownerFactEngine, price edits from chat …) left
// the public row as it was: 175 listings were online as AVAILABLE although
// the CRM said otherwise.
//
// Now a trigger on properties raises website_publication_state.desired_revision
// for every change the public page depends on; this worker:
//   - claims due rows with a short lease (FOR UPDATE SKIP LOCKED, no lock is
//     held while publishing, so CRM edits never wait on it)
//   - publishes from the CURRENT CRM row, never from event contents, so an
//     old event can never overwrite newer data; published_revision records
//     the revision that was read, and a change made meanwhile stays pending
//   - reuses websiteSync (idempotent upsert, stable slug, ≤10 photos, no owner
//     data) — not a second publishing path
//   - retries with backoff; after MAX_ATTEMPTS the row is 'failed' (dead
//     letter) and shown as Sync failed, never as live
//   - reconcile() re-queues anything the projection disagrees with
//
// Publication rules (unchanged business rules, applied consistently):
//   published = FALSE, website_manually_hidden, archived, staging → unpublished
//   otherwise websiteSync: available → listed as available; every other CRM
//   status → listed as unavailable ('rented' on the public card, the existing
//   design), never as available
//   not publish-ready (no photo / description) but already online → only the
//   public status is corrected, so it can never stay falsely available
// Only properties.published (the existing approval) puts a listing online;
// nothing here publishes a listing that was not approved.
// ============================================================================
const db = require('../db')
const log = require('../logger')
const websiteSync = require('./websiteSync')

const MAX_ATTEMPTS = 8
const LEASE_SECONDS = 120
const LABEL = {
  draft: 'Draft', not_ready: 'Needs approval', sync_pending: 'Sync pending', published: 'Published',
  marked_unavailable: 'Published · unavailable', unpublished: 'Unpublished', failed: 'Sync failed',
}

function backoffSeconds(attempts) {
  return Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1))
}

async function loadProperty(id) {
  const r = await db.query(
    `SELECT id, ref, published, website_manually_hidden, available_status, is_staging
       FROM properties WHERE id = $1`, [id])
  return r.rows[0] || null
}

async function websiteRow(ref) {
  if (!ref) return null
  const r = await db.query(`SELECT id, status, is_published FROM website_properties WHERE property_reference = $1`, [ref])
  return r.rows[0] || null
}

// Bring the public row to what the CRM says right now. Returns the state.
async function publishOne(propertyId) {
  const prop = await loadProperty(propertyId)
  if (!prop) return { status: 'unpublished', reason: 'property_deleted', websiteStatus: null }
  const row = await websiteRow(prop.ref)
  const withdraw = !prop.published || prop.website_manually_hidden || prop.is_staging || prop.available_status === 'archived'
  if (withdraw) {
    if (row && row.is_published) await websiteSync.unpublishFromWebsite(prop.ref)
    const reason = !prop.published ? 'not_published_in_crm' : prop.website_manually_hidden ? 'manually_hidden'
      : prop.is_staging ? 'staging' : 'archived'
    return { status: row ? 'unpublished' : 'draft', reason, websiteStatus: null }
  }
  const publicStatus = websiteSync.statusFor(prop.available_status)
  const r = await websiteSync.syncPropertyToWebsite(prop.id)
  if (r.ok) {
    return { status: publicStatus === 'available' ? 'published' : 'marked_unavailable', reason: r.action, websiteStatus: publicStatus }
  }
  if (r.reason === 'not_ready') {
    if (row && row.is_published && row.status !== publicStatus) {
      await db.query(`UPDATE website_properties SET status = $2, updated_at = NOW() WHERE property_reference = $1`, [prop.ref, publicStatus])
    }
    return { status: 'not_ready', reason: 'missing_photo_or_description', websiteStatus: row && row.is_published ? publicStatus : null }
  }
  return { status: 'unpublished', reason: r.reason || 'not_found', websiteStatus: null }
}

// Claim up to `limit` due rows (short lease), publish each, record the result.
async function processDue({ limit = 25 } = {}) {
  const claimed = (await db.query(
    `UPDATE website_publication_state s
        SET next_attempt_at = NOW() + ($2 || ' seconds')::interval, last_attempt_at = NOW()
      WHERE s.property_id IN (
        SELECT property_id FROM website_publication_state
         WHERE desired_revision > published_revision AND status <> 'failed' AND next_attempt_at <= NOW()
         ORDER BY next_attempt_at
         LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING s.property_id, s.desired_revision, s.attempts`, [limit, String(LEASE_SECONDS)])).rows
  const results = []
  for (const job of claimed) {
    try {
      const out = await publishOne(job.property_id)
      await db.query(
        `UPDATE website_publication_state
            SET published_revision = GREATEST(published_revision, $2),
                status = CASE WHEN desired_revision > $2 THEN 'sync_pending' ELSE $3 END,
                website_status = $4, last_reason = $5, last_error = NULL, attempts = 0,
                next_attempt_at = NOW(),
                last_published_at = CASE WHEN $3 IN ('published','marked_unavailable','unpublished','not_ready') THEN NOW() ELSE last_published_at END,
                updated_at = NOW()
          WHERE property_id = $1`,
        [job.property_id, job.desired_revision, out.status, out.websiteStatus, out.reason])
      results.push({ propertyId: job.property_id, ...out })
    } catch (err) {
      const attempts = job.attempts + 1
      const failed = attempts >= MAX_ATTEMPTS
      await db.query(
        `UPDATE website_publication_state
            SET attempts = $2, status = $3, last_error = $4,
                next_attempt_at = NOW() + ($5 || ' seconds')::interval, updated_at = NOW()
          WHERE property_id = $1`,
        [job.property_id, attempts, failed ? 'failed' : 'sync_pending', String(err.message || err).slice(0, 500), String(backoffSeconds(attempts))])
      log.warn('websitePublication: publish failed', { propertyId: job.property_id, attempts, failed, err: err.message })
      results.push({ propertyId: job.property_id, status: failed ? 'failed' : 'sync_pending', error: err.message })
    }
  }
  return results
}

// Re-queue every listing whose public row disagrees with the CRM (status,
// price, publication) or that never had a state row. Never deletes anything.
async function reconcile() {
  const r = await db.query(
    `WITH drift AS (
       SELECT p.id FROM properties p
         LEFT JOIN website_properties w ON w.property_reference = p.ref
        WHERE p.ref IS NOT NULL AND (
              (w.is_published AND (NOT p.published OR COALESCE(p.website_manually_hidden, FALSE) OR p.is_staging
                                   OR p.available_status = 'archived'))
           OR (w.is_published AND w.status = 'available' AND COALESCE(p.available_status,'') NOT IN ('available','available_confirmed'))
           OR (w.is_published AND w.status <> 'available' AND p.available_status IN ('available','available_confirmed') AND p.published)
           OR (w.is_published AND p.longlet_price IS NOT NULL AND w.price IS DISTINCT FROM p.longlet_price AND w.price_type = 'month')
           OR (p.published AND p.available_status IN ('available','available_confirmed') AND (w.id IS NULL OR NOT w.is_published))
        ))
     INSERT INTO website_publication_state (property_id, desired_revision, status, next_attempt_at)
     SELECT id, 1, 'sync_pending', NOW() FROM drift
     ON CONFLICT (property_id) DO UPDATE
       SET desired_revision = website_publication_state.desired_revision + 1,
           status = CASE WHEN website_publication_state.status = 'failed' THEN 'failed' ELSE 'sync_pending' END,
           updated_at = NOW()
     RETURNING property_id`)
  return { requeued: r.rowCount }
}

// Admin overview: state counts, drift still visible on the site, failures.
async function summary() {
  const [counts, drift, failed, orphans] = await Promise.all([
    db.query(`SELECT status, COUNT(*)::int AS n FROM website_publication_state GROUP BY 1`),
    db.query(`SELECT COUNT(*)::int AS n FROM website_properties w JOIN properties p ON p.ref = w.property_reference
               WHERE w.is_published AND w.status = 'available' AND COALESCE(p.available_status,'') NOT IN ('available','available_confirmed')`),
    db.query(`SELECT s.property_id, p.ref, s.attempts, s.last_error, s.updated_at FROM website_publication_state s
                JOIN properties p ON p.id = s.property_id WHERE s.status = 'failed' ORDER BY s.updated_at DESC LIMIT 50`),
    db.query(`SELECT COUNT(*)::int AS n FROM website_properties w LEFT JOIN properties p ON p.ref = w.property_reference
               WHERE w.is_published AND p.id IS NULL`),
  ])
  return {
    counts: Object.fromEntries(counts.rows.map(x => [x.status, x.n])),
    falselyAvailableOnSite: drift.rows[0].n,
    legacyRowsWithoutCrmRecord: orphans.rows[0].n,
    failed: failed.rows,
  }
}

// Admin "retry" on a dead-lettered listing: back into the queue, fresh count.
async function retryFailed(propertyId) {
  const r = await db.query(
    `UPDATE website_publication_state
        SET status = 'sync_pending', attempts = 0, next_attempt_at = NOW(), updated_at = NOW()
      WHERE property_id = $1 AND status = 'failed' RETURNING property_id`, [propertyId])
  return { retried: r.rowCount > 0 }
}

// One listing's chip for the CRM card. Errors only for admins.
function chipFor(row, { admin = false } = {}) {
  if (!row) return { status: 'draft', label: LABEL.draft }
  const pending = Number(row.desired_revision) > Number(row.published_revision) && row.status !== 'failed'
  const status = pending ? 'sync_pending' : row.status
  return {
    status, label: LABEL[status] || status, lastPublishedAt: row.last_published_at || null,
    websiteStatus: row.website_status || null, attempts: row.attempts || 0,
    error: admin ? (row.last_error || null) : undefined,
  }
}

module.exports = { MAX_ATTEMPTS, LABEL, publishOne, processDue, reconcile, summary, chipFor, retryFailed, backoffSeconds }
