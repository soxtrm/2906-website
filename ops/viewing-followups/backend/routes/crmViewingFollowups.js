'use strict'
// ============================================================================
// routes/crmViewingFollowups.js — viewing request follow-up for CRM agents
// (Claude, 2026-11-21). Mounted at /api/crm/viewing-followups.
//   GET  /                         follow-ups (own; all for admins and owner-contact staff)
//   GET  /summary                  my counts (feedback due, upcoming)
//   GET  /:id                      one follow-up with its timeline
//   POST /:id/answer               { outcome, nextStep?, note?, newStartsAt? }
//   GET  /by-viewing/:viewingId/owner-info   owner contact for a booking request (logged)
//   POST /sync                     run one pass now (admin)
// ============================================================================
const express = require('express')
const rateLimit = require('express-rate-limit')
const log = require('../logger')
const { requireAgent } = require('../middleware/staffAuth')
const F = require('../services/viewingFollowups')

const router = express.Router()
const send = fn => async (req, res) => {
  try { res.json({ ok: true, ...(await fn(req)) }) }
  catch (err) {
    if (err instanceof F.FollowupError) return res.status(err.status).json({ ok: false, error: err.message, code: err.code })
    log.error('viewing follow-up route failed', { err: err.message, path: req.path })
    res.status(500).json({ ok: false, error: 'Viewing follow-up request failed' })
  }
}
const contactLimiter = rateLimit({ windowMs: 60 * 60e3, max: 40, keyGenerator: req => `a:${req.agent?.id}`, standardHeaders: false, legacyHeaders: false,
  message: { ok: false, error: 'Too many owner lookups this hour.' } })

router.use(requireAgent)
router.get('/', send(req => F.list(req.agent, { open: req.query.all !== '1' })))
router.get('/summary', send(req => F.summary(req.agent)))
router.get('/by-viewing/:viewingId/owner-info', contactLimiter, send(req => F.ownerInfo(req.agent, req.params.viewingId, { ip: req.ip, userAgent: req.get('user-agent') })))
router.post('/sync', send(async req => {
  if (req.agent.role !== 'admin') throw new F.FollowupError('FORBIDDEN', 'Admins only.', 403)
  return { pass: await F.syncAll() }
}))
router.get('/:id', send(req => F.detail(req.agent, req.params.id)))
router.post('/:id/answer', send(req => F.answer(req.agent, req.params.id, req.body || {})))

F.start()
module.exports = router
