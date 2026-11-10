'use strict'
// ============================================================================
// routes/crmPropertySources.js — ARGUS Integrations → Property Sources
// (Claude, 2026-11-09). Mounted at /api/crm/property-sources BEFORE the
// /api/crm catch-all. Admin only, checked against the LIVE agents row (a role
// change or deactivation takes effect immediately, not when the JWT expires).
// Bearer-token API: no cookies, so no CSRF surface.
// ============================================================================
const express = require('express')
const jwt = require('jsonwebtoken')
const rateLimit = require('express-rate-limit')
const db = require('../db')
const log = require('../logger')
const S = require('../services/propertySourceSync')

const router = express.Router()
const JWT_SECRET = process.env.JWT_SECRET

async function adminAuth(req, res, next) {
  const h = req.headers.authorization
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' })
  let payload
  try { payload = jwt.verify(h.slice(7), JWT_SECRET) } catch { return res.status(401).json({ error: 'Session invalid or expired' }) }
  if (payload.aud === 'board') return res.status(403).json({ error: 'Board account — no access to CRM data.' })
  try {
    const { rows: [a] } = await db.query(`SELECT id, role, active, name, username FROM agents WHERE id=$1`, [payload.id])
    if (!a || !a.active) return res.status(401).json({ error: 'Account inactive' })
    if (a.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
    req.agent = { id: a.id, role: a.role, name: a.name || a.username }
    next()
  } catch (err) {
    log.error('property-sources auth failed', { err: err.message })
    res.status(500).json({ error: 'Auth check failed' })
  }
}

const scanLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 6, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many manual scans; the provider is checked politely.' } })

const send = fn => async (req, res) => {
  try { res.json(await fn(req)) }
  catch (err) {
    if (err instanceof S.SyncError) return res.status(err.status).json({ error: err.message, code: err.code, ...(err.event ? { event: err.event } : {}), ...(err.current ? { current: err.current } : {}), ...(err.latestFingerprint ? { latestFingerprint: err.latestFingerprint } : {}) })
    if (/Unapproved|Only HTTPS|Credentials|Non-standard|Invalid URL|Invalid source path|must be the approved|Only Long Let|Unknown source adapter/.test(err.message)) return res.status(400).json({ error: err.message, code: 'INVALID_SOURCE_URL' })
    log.error('property-sources route failed', { err: err.message })
    res.status(500).json({ error: 'Property Sources request failed' })
  }
}
const id = v => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new S.SyncError('INVALID_ID', 'Invalid id'); return n }

router.use(adminAuth)

router.get('/summary', send(() => S.summary()))
router.get('/sources', send(() => S.listSources()))
router.post('/sources', send(req => S.createSource(req.body || {}, req.agent)))
router.patch('/sources/:id', send(req => S.updateSource(id(req.params.id), req.body || {}, req.agent)))
router.get('/sources/:id/scans', send(req => S.scans(id(req.params.id))))
router.post('/sources/:id/scan', scanLimiter, send(req => S.runScan(id(req.params.id), { trigger: 'MANUAL', agent: req.agent })))
router.get('/events', send(req => S.listEvents({ sourceId: req.query.source, status: req.query.status, type: req.query.type, limit: req.query.limit })))
router.get('/events/:id', send(req => S.eventDetail(id(req.params.id))))
router.post('/events/:id/:action(accept|reject|link|clarify|acknowledge)', send(req =>
  S.decide(id(req.params.id), req.params.action, req.agent, { fingerprint: req.body?.fingerprint, propertyId: req.body?.propertyId, note: req.body?.note })))
router.post('/sources/:id/accept-safe-new', send(req => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
  if (!ids.length || ids.length > 50) throw new S.SyncError('INVALID_BATCH', 'Select 1–50 proposals')
  return S.acceptSafeNew(id(req.params.id), req.agent, ids)
}))

module.exports = router
