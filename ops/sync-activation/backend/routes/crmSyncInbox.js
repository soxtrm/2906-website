'use strict'
// ============================================================================
// routes/crmSyncInbox.js — the SYNC inbox for CRM staff (Claude, 2026-11-19).
// Mounted at /api/crm/sync-inbox. Staff see SYNC accounts, their claims and
// messages, and answer as themselves (name + agency shown to the owner).
// Ownership is still verified only through /api/crm/owner-nexus/:ownerId/verify.
// ============================================================================
const express = require('express')
const log = require('../logger')
const { requireStaff } = require('../middleware/staffAuth')
const { LinkError } = require('../services/nexusOwnerLink')
const S = require('../services/syncAccount')

const router = express.Router()
const send = fn => async (req, res) => {
  try { res.json({ ok: true, ...(await fn(req)) }) }
  catch (err) {
    if (err instanceof LinkError) return res.status(err.status).json({ ok: false, error: err.message, code: err.code })
    log.error('sync-inbox route failed', { err: err.message })
    res.status(500).json({ ok: false, error: 'SYNC inbox request failed' })
  }
}

router.use(requireStaff)
router.get('/threads', send(() => S.staffThreads()))
router.get('/threads/:accountId', send(req => S.staffMessages(req.params.accountId)))
router.post('/threads/:accountId/reply', send(req => S.staffReply(req.params.accountId, req.agent, { text: req.body?.text, propertyId: req.body?.propertyId })))

module.exports = router
