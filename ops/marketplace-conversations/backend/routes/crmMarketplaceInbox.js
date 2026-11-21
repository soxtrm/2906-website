'use strict'
// CRM Marketplace inbox (Claude, 2026-11-21), mounted at /api/crm/marketplace-inbox. Staff only (no board accounts).
// Admins see every conversation of the agency; staff see the ones assigned to them and unassigned ones.
const express = require('express')
const log = require('../logger')
const { requireStaff } = require('../middleware/staffAuth')
const M = require('../services/marketplaceConversations')

const router = express.Router()
const send = fn => async (req, res) => {
  try { res.json({ ok: true, ...(await fn(req)) }) }
  catch (err) {
    if (err instanceof M.MpError) return res.status(err.status).json({ ok: false, error: err.code, message: err.message })
    log.error('marketplace inbox route failed', { err: err.message })
    res.status(500).json({ ok: false, error: 'FAILED', message: 'Marketplace inbox request failed' })
  }
}
router.use(requireStaff)
router.get('/', send(req => M.inbox(req.agent, { q: String(req.query.q || ''), filter: String(req.query.filter || 'all') })))
router.get('/count', send(req => M.unreadCount(req.agent)))
router.get('/:id', send(req => M.staffView(req.agent, req.params.id)))
router.post('/:id/messages', send(req => M.staffSend(req.agent, req.params.id, req.body?.body)))
router.post('/:id/requests/:rid/book', send(req => M.staffBook(req.agent, req.params.id, req.params.rid, { startsAt: req.body?.startsAt, durationMin: req.body?.durationMin })))
router.post('/:id/requests/:rid/decline', send(req => M.staffDecline(req.agent, req.params.id, req.params.rid, req.body?.note)))
router.post('/:id/close', send(req => M.staffClose(req.agent, req.params.id, req.body?.closed !== false)))

module.exports = router
