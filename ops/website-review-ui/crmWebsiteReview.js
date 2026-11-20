'use strict'
// ============================================================================
// routes/crmWebsiteReview.js — listings taken off the public website, for review (2026-11-20).
// Mounted at /api/crm/website-review, admins only.
//
//   GET  /                 what is hidden and why (from website_reconcile_log), newest first
//   GET  /:websiteId/history  every recorded change of one listing's website state
//   POST /:websiteId/show  put a listing back on the website, with the reason on record
//
// Showing again is only offered for entries that have no ARGUS listing behind them (older website entries,
// later Marketplace-only listings): nobody else can vouch for those, so an admin decides and signs for it.
// A listing with an ARGUS listing comes back by itself once ARGUS says it is available and published;
// forcing it here would be undone by the next reconcile run, so that is refused with the reason.
// Nothing is ever deleted here.
// ============================================================================
const express = require('express')
const db = require('../db')
const log = require('../logger')
const { requireAdmin } = require('../middleware/staffAuth')

const router = express.Router()
router.use(requireAdmin)

router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT w.id::text AS website_id, w.property_reference AS ref, w.slug, w.title, w.location, w.price, w.category, w.status,
              COALESCE(array_length(w.images, 1), 0) AS photos, w.created_at, w.updated_at,
              l.reason, l.at AS hidden_at, l.argus_status,
              (p.id IS NOT NULL) AS has_argus_listing, p.id AS property_id, p.available_status AS argus_now, p.published AS argus_published,
              p.last_confirmed_available_at AS argus_confirmed_at
         FROM website_properties w
         JOIN LATERAL (SELECT reason, at, argus_status, action FROM website_reconcile_log x WHERE x.website_id = w.id::text ORDER BY x.id DESC LIMIT 1) l ON l.action = 'hide'
         LEFT JOIN properties p ON p.ref = w.property_reference
        WHERE w.is_published = FALSE
        ORDER BY l.at DESC LIMIT 1000`)
    const byReason = rows.reduce((m, r) => (m[r.reason] = (m[r.reason] || 0) + 1, m), {})
    res.json({ ok: true, total: rows.length, byReason, listings: rows.map(r => ({
      websiteId: r.website_id, ref: r.ref, title: r.title, location: r.location, price: r.price == null ? null : Number(r.price), category: r.category,
      websiteStatus: r.status, photos: r.photos, createdAt: r.created_at, lastChangedAt: r.updated_at, hiddenAt: r.hidden_at, reason: r.reason,
      slug: r.slug, hasArgusListing: r.has_argus_listing, propertyId: r.property_id || null, argusStatus: r.argus_now || null,
      argusPublished: r.has_argus_listing ? r.argus_published === true : null, argusConfirmedAt: r.argus_confirmed_at || null,
      // where the entry comes from: an ARGUS listing, an entry of the old website administration, or an ARGUS listing that no longer exists
      source: r.has_argus_listing ? 'argus' : /^2906-[0-9]{4,}$/.test(r.ref || '') ? 'argus_deleted' : /^2906-[A-Z0-9]{5}$/.test(r.ref || '') ? 'legacy_website' : 'unknown',
      canShow: !r.has_argus_listing,
      howToShow: r.has_argus_listing ? 'Comes back by itself when the ARGUS listing is available and published.' : 'An admin can show it again with a reason.',
    })) })
  } catch (err) {
    log.error('website-review list failed', { err: err.message })
    res.status(500).json({ ok: false, error: 'Could not load the review list' })
  }
})

router.get('/:websiteId/history', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT at, action, reason, argus_status, before_state, after_state FROM website_reconcile_log WHERE website_id = $1 ORDER BY id DESC LIMIT 200`, [String(req.params.websiteId)])
    res.json({ ok: true, history: rows.map(r => ({ at: r.at, action: r.action, reason: r.reason, argusStatus: r.argus_status, before: r.before_state, after: r.after_state })) })
  } catch (err) {
    log.error('website-review history failed', { err: err.message })
    res.status(500).json({ ok: false, error: 'Could not load the history' })
  }
})

router.post('/:websiteId/show', async (req, res) => {
  const note = String(req.body?.reason || '').trim()
  if (note.length < 5 || note.length > 300) return res.status(400).json({ ok: false, error: 'Say in a few words why this listing may be shown again (who confirmed it).' })
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const { rows: [w] } = await client.query(
      `SELECT w.id::text AS id, w.property_reference AS ref, w.is_published, w.status,
              EXISTS (SELECT 1 FROM properties p WHERE p.ref = w.property_reference) AS has_argus
         FROM website_properties w WHERE w.id::text = $1 FOR UPDATE OF w`, [String(req.params.websiteId)])
    if (!w) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, error: 'Listing not found' }) }
    if (w.has_argus) { await client.query('ROLLBACK'); return res.status(409).json({ ok: false, error: 'This listing follows ARGUS. Make it available and published there; it then comes back by itself.' }) }
    if (w.is_published) { await client.query('ROLLBACK'); return res.status(409).json({ ok: false, error: 'This listing is already on the website.' }) }
    await client.query(`UPDATE website_properties SET is_published = TRUE WHERE id::text = $1`, [w.id])
    await client.query(
      `INSERT INTO website_reconcile_log (website_id, property_reference, action, reason, before_state, after_state)
       VALUES ($1, $2, 'show', $3, $4, $5)`,
      [w.id, w.ref, `shown again by ${req.agent.username}: ${note}`, JSON.stringify({ is_published: false, status: w.status }), JSON.stringify({ is_published: true })])
    await client.query('COMMIT')
    log.info('website-review: listing shown again', { ref: w.ref, by: req.agent.username })
    res.json({ ok: true, ref: w.ref })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    log.error('website-review show failed', { err: err.message })
    res.status(500).json({ ok: false, error: 'Could not show the listing' })
  } finally { client.release() }
})

module.exports = router
