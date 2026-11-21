'use strict'
// CRM Deal Rooms (Claude, 2026-11-21), mounted at /api/crm/deal-rooms. Staff only (no board accounts).
// Same visibility as the Marketplace inbox: admins see every Deal Room of the agency, staff the ones assigned to
// them and unassigned ones. Messages are written through /api/crm/marketplace-inbox (one chat backend).
const express = require('express')
const log = require('../logger')
const { requireStaff } = require('../middleware/staffAuth')
const D = require('../services/dealRooms')

const router = express.Router()
const send = fn => async (req, res) => {
  try { res.json({ ok: true, ...(await fn(req)) }) }
  catch (err) {
    if (err instanceof D.DealError) return res.status(err.status).json({ ok: false, error: err.code, message: err.message })
    log.error('deal room route failed', { err: err.message })
    res.status(500).json({ ok: false, error: 'FAILED', message: 'Deal Room request failed' })
  }
}
router.use(requireStaff)
router.get('/', send(req => D.list(req.agent, { stage: String(req.query.stage || 'open') })))
router.get('/:id', send(req => D.view(req.agent, req.params.id)))
router.post('/:id/stage', send(req => D.setStage(req.agent, req.params.id, { stage: String(req.body?.stage || ''), note: req.body?.note })))
router.post('/:id/notes', send(req => D.addNote(req.agent, req.params.id, req.body?.text)))

module.exports = router
