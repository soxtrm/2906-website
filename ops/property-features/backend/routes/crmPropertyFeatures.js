'use strict'
// ============================================================================
// routes/crmPropertyFeatures.js — property features for CRM staff (Claude, 2026-11-21).
// Mounted at /api/crm/property-features. Listing agents work on their own listings, admins on all and curate the
// dictionary (candidates -> standard / merge / retire). Data rules: services/propertyFeatures.js.
// ============================================================================
const express = require('express')
const log = require('../logger')
const { requireStaff } = require('../middleware/staffAuth')
const { LinkError } = require('../services/nexusOwnerLink')
const F = require('../services/propertyFeatures')

const router = express.Router()
const send = fn => async (req, res) => {
  try { res.json({ ok: true, ...(await fn(req)) }) }
  catch (err) {
    if (err instanceof LinkError) return res.status(err.status).json({ ok: false, error: err.message, code: err.code })
    log.error('property-features route failed', { err: err.message })
    res.status(500).json({ ok: false, error: 'Property features request failed' })
  }
}
router.use(requireStaff)
router.use((req, res, next) => (req.agent?.role === 'board' ? res.status(403).json({ ok: false, error: 'Not for board accounts' }) : next()))

router.get('/review', send(req => F.reviewQueue(req.agent)))
router.get('/dictionary/candidates', send(() => F.candidates()))
router.post('/dictionary/curate', send(req => F.curate(req.agent, req.body || {})))
router.get('/suggest', send(req => F.suggest(String(req.query.q || '').slice(0, 120))))
router.get('/:propertyId', send(req => F.agentList(req.agent, { propertyId: req.params.propertyId })))
router.post('/:propertyId', send(req => F.agentSet(req.agent, { propertyId: req.params.propertyId, key: req.body?.key, text: req.body?.text, value: req.body?.value, note: req.body?.note })))
router.post('/:propertyId/decide', send(req => F.agentDecide(req.agent, { propertyId: req.params.propertyId, key: req.body?.key, decision: req.body?.decision, verification: req.body?.verification, documentId: req.body?.documentId })))

module.exports = router
