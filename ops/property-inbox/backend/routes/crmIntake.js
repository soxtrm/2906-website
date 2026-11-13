'use strict'
// ============================================================================
// routes/crmIntake.js — Incoming Properties API (2026-11-13)
// Mounted at /api/crm/intake BEFORE the /api/crm catch-all. Staff tokens only
// (board tokens refused), checked against the live agents row. Administrators
// see every intake; an agent sees and reviews the properties they uploaded.
// Nothing here publishes, posts or messages an owner or a client.
// ============================================================================
const express = require('express')
const jwt = require('jsonwebtoken')
const db = require('../db')
const log = require('../logger')
const intake = require('../services/propertyIntake')

const router = express.Router()

async function staffAuth(req, res, next) {
  const h = req.headers.authorization
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' })
  let payload
  try { payload = jwt.verify(h.slice(7), process.env.JWT_SECRET) } catch { return res.status(401).json({ error: 'Session invalid or expired' }) }
  if (payload.aud === 'board') return res.status(403).json({ error: 'Board account — no access to CRM data.' })
  try {
    const { rows: [a] } = await db.query(`SELECT id, role, active, name, username FROM agents WHERE id = $1`, [payload.id])
    if (!a || !a.active) return res.status(401).json({ error: 'Account inactive' })
    if (!['admin', 'agent'].includes(a.role)) return res.status(403).json({ error: 'No access to Incoming Properties' })
    req.agent = a
    next()
  } catch (err) {
    log.error('intake auth failed', { err: err.message })
    res.status(500).json({ error: 'Auth check failed' })
  }
}
router.use(staffAuth)

const send = fn => async (req, res) => {
  try { res.set('Cache-Control', 'no-store'); res.json(await fn(req)) }
  catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, ...(err.missing ? { missing: err.missing } : {}) })
    log.error('intake route failed', { path: req.path, err: err.message })
    res.status(500).json({ error: 'Incoming Properties request failed' })
  }
}
const id = v => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) { const e = new Error('Invalid id'); e.status = 400; throw e } return n }

router.get('/summary', send(req => intake.summary(req.agent)))
router.get('/items', send(async req => ({ items: await intake.listItems(req.agent, { filter: String(req.query.filter || 'needs_verification'), limit: req.query.limit }) })))
router.get('/items/:id', send(async req => {
  const item = await intake.getItem(req.agent, id(req.params.id))
  if (!item) { const e = new Error('Not an incoming property'); e.status = 404; throw e }
  if (item.forbidden) { const e = new Error('Not your upload'); e.status = 403; throw e }
  return { item }
}))
router.get('/feed', send(async req => ({ events: await intake.feed(req.agent, { limit: req.query.limit }) })))

router.post('/items/:id/save', send(req => intake.saveEdits(req.agent, id(req.params.id), req.body?.edits || {})))
router.post('/items/:id/verify', send(req => intake.verify(req.agent, id(req.params.id), { edits: req.body?.edits || {}, note: req.body?.note || null })))
router.post('/items/:id/needs-correction', send(req => intake.requestCorrection(req.agent, id(req.params.id), { note: req.body?.note })))
router.post('/items/:id/link', send(req => intake.linkExisting(req.agent, id(req.params.id), { target: req.body?.target, copyPhotos: req.body?.copyPhotos !== false })))
router.post('/items/:id/reject-duplicate', send(req => intake.rejectDuplicate(req.agent, id(req.params.id), { target: req.body?.target || null, note: req.body?.note || null })))

// A failed upload package: run it again through the same pipeline, or close it.
router.post('/packages/:id/retry', send(async req => {
  await intake.packageAccess(req.agent, id(req.params.id))
  const du = require('../services/dividerUpload')
  const r = await du.retryPackage({ packageId: id(req.params.id), run: require('../handlers/upload').cmdUpload,
    reply: (s, c, t) => require('../lib/sessionRouter').sendVia(s, c, t), requestedBy: req.agent })
  return { ok: true, state: r.state || r.skipped || null, created: (r.created || []).map(c => ({ id: c.propId, ref: c.ref })) }
}))
router.post('/packages/:id/dismiss', send(req => intake.dismissPackage(req.agent, id(req.params.id), { note: req.body?.note || null })))

module.exports = router
