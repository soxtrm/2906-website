'use strict'
// ============================================================================
// routes/crmAutomation.js — what the automation actually did (2026-11-12).
// Mounted at /api/crm/automation BEFORE the /api/crm catch-all. Admin only,
// checked against the live agents row. Read-only: three GET endpoints.
//   GET /events    executed / skipped / failed automatic actions (newest first)
//   GET /workers   last run, last success, next expected run, overdue flag
//   GET /uploads   divider upload packages with state, property ids, media counts
// Owner references are ids only; no phone numbers leave this route.
// ============================================================================
const express = require('express')
const jwt = require('jsonwebtoken')
const db = require('../db')
const log = require('../logger')
const events = require('../services/automationEvents')

const router = express.Router()

async function adminAuth(req, res, next) {
  const h = req.headers.authorization
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' })
  let payload
  try { payload = jwt.verify(h.slice(7), process.env.JWT_SECRET) } catch { return res.status(401).json({ error: 'Session invalid or expired' }) }
  if (payload.aud === 'board') return res.status(403).json({ error: 'Board account — no access to CRM data.' })
  try {
    const { rows: [a] } = await db.query(`SELECT id, role, active FROM agents WHERE id=$1`, [payload.id])
    if (!a || !a.active) return res.status(401).json({ error: 'Account inactive' })
    if (a.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
    next()
  } catch (err) {
    log.error('automation auth failed', { err: err.message })
    res.status(500).json({ error: 'Auth check failed' })
  }
}
router.use(adminAuth)

const send = fn => async (req, res) => {
  try { res.set('Cache-Control', 'no-store'); res.json(await fn(req)) }
  catch (err) { log.error('automation route failed', { err: err.message }); res.status(500).json({ error: 'Automation status request failed' }) }
}
const clean = v => (typeof v === 'string' && /^[\w:.\-# ]{1,64}$/.test(v) ? v : null)

router.get('/events', send(async req => {
  const rows = await events.listEvents({ limit: req.query.limit, rule: clean(req.query.rule), propertyRef: clean(req.query.ref), result: clean(req.query.result), before: req.query.before })
  return {
    events: rows.map(r => {
      const [, rule, action] = String(r.action_type).split(':')
      const d = r.details || {}
      return { id: r.id, at: r.created_at, rule, action, result: d.result || null, property_id: r.target_property_id, property_ref: r.target_ref,
        owner_ref: d.owner_ref || null, agent: r.agent_name || null, account: d.account || null, trigger: d.trigger || null,
        message_id: d.message_id || null, reason: d.reason || null, next_at: d.next_at || null, details: d }
    }),
  }
}))

router.get('/workers', send(async () => ({ now: new Date().toISOString(), workers: await events.listHeartbeats() })))

router.get('/uploads', send(async req => {
  const limit = Math.min(Number(req.query.limit) || 50, 200)
  const r = await db.query(
    `SELECT u.id, u.state, u.received_at, u.finished_at, u.media_expected, u.media_imported, u.property_ids, u.property_refs, u.failure_reason,
            u.attempts, u.summary, a.name AS agent_name
       FROM upload_packages u LEFT JOIN agents a ON a.id = u.agent_id ORDER BY u.id DESC LIMIT $1`, [limit])
  return { packages: r.rows }
}))

module.exports = router
