'use strict'
// ============================================================================
// services/websiteReconcile.js — the public website follows ARGUS (2026-11-20).
//
// The website serves its own copy of each listing (website_properties). That copy was only refreshed on
// upload, on a CRM edit and on a date change. "Rented", "not available", "archived", a price changed by
// command and the availability check never reached it, so 323 of 733 listings stayed "available" on the
// website long after ARGUS knew better.
//
// reconcile() compares every website listing that has an ARGUS listing behind it and brings the copy in line:
//   ARGUS available + published, copy differs  -> refreshed through the one existing sync (ARGUS is the
//                                                 source for ARGUS-origin listings)
//   ARGUS rented                               -> shown as rented; the detail page stays reachable
//   ARGUS archived / not available             -> hidden from the website
//   ARGUS available but not published          -> hidden from the website
//   ARGUS availability under review            -> hidden ONLY when there is no recent sign of life: no
//                                                 confirmation and no owner reply in the last 14 days.
//                                                 A missing confirmation never makes a listing "rented".
//   hidden by this job, ARGUS available again  -> shown again (only what this job itself hid)
//
// What it never does: delete anything; publish a listing that was never on the website (an available
// status is not a permission to publish); touch a website listing that has no ARGUS listing behind it
// (Marketplace-only and older entries are not invalid because ARGUS does not know them); or move the
// public "updated" time when nothing but its own bookkeeping changed.
//
// Every change is written to website_reconcile_log. A scheduled run that would change more than
// maxChanges listings changes nothing and reports instead: a mass change is a decision, not a routine.
// ============================================================================
const db = require('../db')
const log = require('../logger')

const AVAILABLE = new Set(['available', 'available_confirmed'])
const GONE = new Set(['archived', 'not_available'])
const FRESH_DAYS = 14

async function plan() {
  const { rows } = await db.query(
    `SELECT w.id::text AS wid, w.property_reference AS ref, w.status AS wstatus, w.is_published, w.price AS wprice, w.location AS wlocation,
            p.id AS pid, p.available_status, p.published, p.system_online, p.longlet_price, p.sale_price, p.town,
            (p.last_confirmed_available_at >= NOW() - make_interval(days => $1)) AS confirmed_recently,
            (oc.last_reply_at >= NOW() - make_interval(days => $1)) AS owner_replied_recently,
            (SELECT l.action FROM website_reconcile_log l WHERE l.website_id = w.id::text AND l.action IN ('hide', 'show') ORDER BY l.id DESC LIMIT 1) AS last_action
       FROM website_properties w
       JOIN properties p ON p.ref = w.property_reference
       LEFT JOIN owner_contacts oc ON oc.id = p.owner_id`, [FRESH_DAYS])
  const out = { refresh: [], markRented: [], hide: [], show: [], keptUnderReview: 0, inLine: 0 }
  for (const r of rows) {
    const st = r.available_status
    const liveInArgus = AVAILABLE.has(st) && r.published && r.system_online
    if (!r.is_published) {
      if (r.last_action === 'hide' && liveInArgus) out.show.push({ ...r, why: 'available again' })
      continue
    }
    if (AVAILABLE.has(st)) {
      if (!liveInArgus) { out.hide.push({ ...r, why: 'available but not published' }); continue }
      const price = r.longlet_price ?? r.sale_price
      const priceDiffers = price != null && r.wprice != null && Number(price) !== Number(r.wprice)
      const noLocation = !String(r.wlocation || '').trim() && Boolean(String(r.town || '').trim())
      // 'viewings' is the website's own state of an available listing with a viewing day; only 'rented' is wrong here
      if (r.wstatus === 'rented' || priceDiffers || noLocation) out.refresh.push({ ...r, why: r.wstatus === 'rented' ? 'status' : priceDiffers ? 'price' : 'location' })
      else out.inLine++
    } else if (st === 'rented') {
      if (r.wstatus !== 'rented') out.markRented.push({ ...r, why: 'rented' }); else out.inLine++
    } else if (GONE.has(st)) {
      out.hide.push({ ...r, why: st })
    } else if (st === 'pending_check') {
      if (r.confirmed_recently || r.owner_replied_recently) out.keptUnderReview++
      else out.hide.push({ ...r, why: 'under review, no recent confirmation or owner reply' })
    } else out.inLine++
  }
  return out
}

function summarise(p) {
  const tally = list => list.reduce((m, r) => (m[r.why] = (m[r.why] || 0) + 1, m), {})
  return {
    refresh: p.refresh.length, markRented: p.markRented.length, hide: p.hide.length, show: p.show.length,
    refreshBy: tally(p.refresh), hideBy: tally(p.hide), keptUnderReview: p.keptUnderReview, inLine: p.inLine,
  }
}

async function record(client, r, action, before, after) {
  await client.query(
    `INSERT INTO website_reconcile_log (website_id, property_reference, property_id, action, reason, argus_status, before_state, after_state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [r.wid, r.ref, r.pid, action, r.why, r.available_status, JSON.stringify(before), JSON.stringify(after)])
}

// apply: write the changes. maxChanges: the most a run may change (null = no limit, for a reviewed one-off run).
async function reconcile({ apply = false, maxChanges = 40 } = {}) {
  const p = await plan()
  const summary = { ...summarise(p), applied: false, failed: 0, held: false }
  const total = summary.refresh + summary.markRented + summary.hide + summary.show
  if (!apply || total === 0) return summary
  if (maxChanges != null && total > maxChanges) {
    summary.held = true
    log.error('websiteReconcile: too many changes for an unattended run, nothing changed', { total, maxChanges, ...summarise(p) })
    return summary
  }
  const ws = require('./websiteSync')
  // status changes: one transaction, guarded by the state the plan saw, so a second run finds nothing to do
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    for (const r of p.markRented) {
      const u = await client.query(`UPDATE website_properties SET status = 'rented' WHERE id::text = $1 AND is_published = TRUE AND status <> 'rented' RETURNING id`, [r.wid])
      if (u.rows.length) await record(client, r, 'rented', { status: r.wstatus }, { status: 'rented' })
    }
    for (const r of p.hide) {
      const u = await client.query(`UPDATE website_properties SET is_published = FALSE WHERE id::text = $1 AND is_published = TRUE RETURNING id`, [r.wid])
      if (u.rows.length) await record(client, r, 'hide', { is_published: true, status: r.wstatus }, { is_published: false })
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    summary.failed += p.markRented.length + p.hide.length
    log.error('websiteReconcile: status changes rolled back', { err: err.message })
    client.release()
    return summary
  }
  client.release()
  // refresh and show go through the existing sync, one listing at a time
  for (const r of [...p.refresh, ...p.show]) {
    try {
      const res = await ws.syncPropertyToWebsite(r.pid)
      if (res && res.ok === false) { summary.failed++; log.warn('websiteReconcile: listing not ready for the website', { ref: r.ref, reason: res.reason }); continue }
      await record(db, r, p.show.includes(r) ? 'show' : 'refresh', { status: r.wstatus, price: r.wprice, is_published: r.is_published }, { status: 'available', price: r.longlet_price ?? r.sale_price, is_published: true })
    } catch (err) { summary.failed++; log.warn('websiteReconcile: refresh failed', { ref: r.ref, err: err.message }) }
  }
  summary.applied = true
  log.info('websiteReconcile: website brought in line with ARGUS', summary)
  return summary
}

module.exports = { reconcile, plan, FRESH_DAYS }
