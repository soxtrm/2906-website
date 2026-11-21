'use strict'
// CRM Deal Rooms (Claude, 2026-11-21), mounted at /api/crm/deal-rooms. Staff only (no board accounts).
// Same visibility as the Marketplace inbox: admins see every Deal Room of the agency, staff the ones assigned to
// them and unassigned ones. Messages are written through /api/crm/marketplace-inbox (one chat backend).
const express = require('express')
const log = require('../logger')
const { requireStaff } = require('../middleware/staffAuth')
const D = require('../services/dealRooms')
const X = require('../services/dealRoomDocs')

const router = express.Router()
const send = fn => async (req, res) => {
  try { res.json({ ok: true, ...(await fn(req)) }) }
  catch (err) {
    if (err instanceof D.DealError || err instanceof X.DocError) return res.status(err.status).json({ ok: false, error: err.code, message: err.message })
    log.error('deal room route failed', { err: err.message })
    res.status(500).json({ ok: false, error: 'FAILED', message: 'Deal Room request failed' })
  }
}
router.use(requireStaff)
router.get('/', send(req => D.list(req.agent, { stage: String(req.query.stage || 'open') })))
router.get('/:id', send(req => D.view(req.agent, req.params.id)))
router.post('/:id/stage', send(req => D.setStage(req.agent, req.params.id, { stage: String(req.body?.stage || ''), note: req.body?.note })))
router.post('/:id/notes', send(req => D.addNote(req.agent, req.params.id, req.body?.text)))
// M5: documents & evidence, generated drafts, payment requests (no money is held or moved)
const staff = req => ({ kind: 'staff', agent: req.agent })
router.post('/:id/documents', send(async req => { await X.upload(staff(req), req.params.id, req.body || {}); return D.view(req.agent, req.params.id) }))
router.post('/:id/documents/:doc/remove', send(async req => { await X.remove(req.agent, req.params.id, req.params.doc); return D.view(req.agent, req.params.id) }))
router.get('/:id/documents/:doc', async (req, res) => {
  try { const f = await X.download(staff(req), req.params.id, req.params.doc); res.set({ 'Content-Type': f.mime, 'Content-Disposition': `attachment; filename="${String(f.filename).replace(/[^A-Za-z0-9._-]/g, '_')}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }).send(f.buffer) }
  catch (err) { const k = err instanceof X.DocError || err instanceof D.DealError; if (!k) log.error('deal room download failed', { err: err.message }); res.status(k ? err.status : 500).json({ ok: false, error: k ? err.code : 'FAILED', message: k ? err.message : 'Download failed' }) }
})
router.post('/:id/drafts/contract', send(async req => { await X.contractDraft(req.agent, req.params.id, req.body || {}); return D.view(req.agent, req.params.id) }))
router.post('/:id/drafts/invoice', send(async req => { await X.invoiceDraft(req.agent, req.params.id, req.body || {}); return D.view(req.agent, req.params.id) }))
router.post('/:id/payments', send(async req => { await X.requestPayment(req.agent, req.params.id, req.body || {}); return D.view(req.agent, req.params.id) }))
router.post('/:id/payments/:pid/status', send(async req => { await X.paymentStatus(req.agent, req.params.id, req.params.pid, req.body || {}); return D.view(req.agent, req.params.id) }))

module.exports = router
