'use strict'
// ============================================================================
// services/websiteReconcile.js — the public website follows ARGUS (2026-11-20).
//
// The website serves its own copy of each listing (website_properties). That copy was only refreshed on
// upload, on a CRM edit and on a date change. "Rented", "not available", "archived" and the availability
// check never reached it, so listings stayed "available" on the website long after ARGUS knew better.
//
// reconcile() compares every published website listing with its ARGUS listing and brings the copy in line:
//   ARGUS available + published      -> refreshed through the one existing sync (price, facts, photos)
//   ARGUS rented                     -> shown as rented (the website's existing "rented" state)
//   ARGUS archived / not available   -> taken off the website
//   ARGUS availability being checked -> taken off the website until it is confirmed again
//   ARGUS available, not published   -> taken off the website
//   no ARGUS listing behind it       -> left alone and counted (older website-only entries)
// A listing that becomes available + published again is put back by the first rule.
// reconcile({ apply: false }) only reports.
// ============================================================================
const db = require('../db')
const log = require('../logger')

const AVAILABLE = new Set(['available', 'available_confirmed'])
const OFF = new Set(['archived', 'not_available', 'pending_check'])

async function plan() {
  const { rows } = await db.query(
    `SELECT w.id AS wid, w.property_reference AS ref, w.status AS wstatus, w.is_published, w.price AS wprice, w.location AS wlocation,
            p.id AS pid, p.available_status, p.published, p.system_online, p.longlet_price, p.sale_price, p.town
       FROM website_properties w LEFT JOIN properties p ON p.ref = w.property_reference
      WHERE w.is_published = TRUE`)
  const out = { refresh: [], markRented: [], takeOff: [], untouched: { noArgusListing: 0, upcoming: 0, inLine: 0 } }
  for (const r of rows) {
    if (!r.pid) { out.untouched.noArgusListing++; continue }
    const st = r.available_status
    if (AVAILABLE.has(st)) {
      if (!r.published || !r.system_online) { out.takeOff.push({ ...r, why: 'available but not published' }); continue }
      const price = r.longlet_price ?? r.sale_price
      const stale = r.wstatus !== 'available' || (price != null && r.wprice != null && Number(price) !== Number(r.wprice)) || (!String(r.wlocation || '').trim() && String(r.town || '').trim())
      if (stale) out.refresh.push(r); else out.untouched.inLine++
    } else if (st === 'rented') {
      if (r.wstatus !== 'rented') out.markRented.push(r); else out.untouched.inLine++
    } else if (OFF.has(st)) {
      out.takeOff.push({ ...r, why: st })
    } else if (st === 'upcoming') out.untouched.upcoming++
    else out.untouched.inLine++
  }
  // available + published in ARGUS, but not on the website at all
  const missing = (await db.query(
    `SELECT p.id AS pid, p.ref FROM properties p
      WHERE p.system_online AND p.published AND p.available_status IN ('available','available_confirmed') AND p.ref IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM website_properties w WHERE w.property_reference = p.ref AND w.is_published)`)).rows
  out.putBack = missing
  return out
}

async function reconcile({ apply = false } = {}) {
  const p = await plan()
  const summary = {
    refresh: p.refresh.length, markRented: p.markRented.length, takeOff: p.takeOff.length, putBack: p.putBack.length,
    takeOffBy: p.takeOff.reduce((m, r) => (m[r.why] = (m[r.why] || 0) + 1, m), {}), untouched: p.untouched, applied: false, failed: 0,
  }
  if (!apply) return summary
  const ws = require('./websiteSync')
  for (const r of [...p.refresh, ...p.putBack]) {
    try { await ws.syncPropertyToWebsite(r.pid) } catch (err) { summary.failed++; log.warn('websiteReconcile: refresh failed', { ref: r.ref, err: err.message }) }
  }
  if (p.markRented.length) {
    await db.query(`UPDATE website_properties SET status = 'rented', updated_at = NOW() WHERE id = ANY($1) AND is_published = TRUE`, [p.markRented.map(r => r.wid)])
  }
  if (p.takeOff.length) {
    await db.query(`UPDATE website_properties SET is_published = FALSE, updated_at = NOW() WHERE id = ANY($1)`, [p.takeOff.map(r => r.wid)])
  }
  summary.applied = true
  if (summary.refresh + summary.markRented + summary.takeOff + summary.putBack > 0) log.info('websiteReconcile: website brought in line with ARGUS', summary)
  return summary
}

module.exports = { reconcile, plan }
