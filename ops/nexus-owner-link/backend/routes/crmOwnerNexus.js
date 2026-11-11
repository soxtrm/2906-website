'use strict'
// ============================================================================
// routes/crmOwnerNexus.js — ARGUS owner profile → NEXUS controls
// (Claude, 2026-11-11). Mounted at /api/crm/owner-nexus BEFORE the /api/crm
// catch-all. Staff only: an admin, or an agent whose LIVE agents row carries
// feature_entitlements.nexus_owner_link = true. Board accounts never.
// Bearer-token API (no cookies → no CSRF surface). Nothing here sends a message.
// ============================================================================
const express = require('express')
const jwt = require('jsonwebtoken')
const rateLimit = require('express-rate-limit')
const db = require('../db')
const log = require('../logger')
const S = require('../services/nexusOwnerLink')
const R = require('../services/nexusDistributionRouting')

const router = express.Router()

async function staffAuth(req, res, next) {
  const h = req.headers.authorization
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' })
  let payload
  try { payload = jwt.verify(h.slice(7), process.env.JWT_SECRET) } catch { return res.status(401).json({ error: 'Session invalid or expired' }) }
  if (payload.aud === 'board') return res.status(403).json({ error: 'Board account — no access to owner data.' })
  try {
    const { rows: [a] } = await db.query(`SELECT id, role, active, name, username, feature_entitlements FROM agents WHERE id=$1`, [payload.id])
    if (!a || !a.active) return res.status(401).json({ error: 'Account inactive' })
    const entitled = a.role === 'admin' || (a.role === 'agent' && a.feature_entitlements && a.feature_entitlements.nexus_owner_link === true)
    if (!entitled) return res.status(403).json({ error: 'NEXUS owner controls are not enabled for this account.' })
    req.agent = { id: a.id, role: a.role, name: a.name || a.username }
    next()
  } catch (err) {
    log.error('owner-nexus auth failed', { err: err.message })
    res.status(500).json({ error: 'Auth check failed' })
  }
}

const send = fn => async (req, res) => {
  try { res.json(await fn(req)) }
  catch (err) {
    if (err instanceof S.LinkError) return res.status(err.status).json({ error: err.message, code: err.code })
    log.error('owner-nexus route failed', { err: err.message })
    res.status(500).json({ error: 'NEXUS owner request failed' })
  }
}
const ownerId = req => { const n = Number(req.params.ownerId); if (!Number.isInteger(n) || n <= 0) throw new S.LinkError('INVALID_ID', 'Invalid owner id'); return n }
const inviteLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many invitation requests. Try again in a few minutes.' } })

router.use(staffAuth)

// Agency distribution routing (queue addendum 01). Per listing; the service
// checks that the caller is an admin or the listing agent.
const propertyId = req => { const n = Number(req.params.propertyId); if (!Number.isInteger(n) || n <= 0) throw new S.LinkError('INVALID_ID', 'Invalid property id'); return n }
const adminOnly = (req, res, next) => (req.agent.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' }))
router.get('/property/:propertyId/route', send(req => R.getRoute(propertyId(req), req.agent)))
router.put('/property/:propertyId/route', send(req => R.setRoute(propertyId(req), req.agent, req.body || {})))
router.post('/property/:propertyId/route/approve', send(req => R.approveRelease(propertyId(req), req.agent)))
router.post('/property/:propertyId/route/revoke', send(req => R.revokeRoute(propertyId(req), req.agent, req.body?.reason)))
router.post('/routes/process-due', adminOnly, send(() => R.tick()))

// Harmless form defaults with their explanation; decision fields are never prefilled.
router.get('/defaults/availability-answer', send(() => require('../services/nexusSmartDefaults').availabilityAnswerDefaults()))

router.get('/:ownerId', send(req => S.status(ownerId(req), req.agent)))
router.post('/:ownerId/invitation', inviteLimiter, send(req => S.createInvitation(ownerId(req), req.agent, { rotate: req.body?.rotate === true })))
router.post('/:ownerId/invitation/copy', inviteLimiter, send(req => S.copyInvitationLink(ownerId(req), req.agent)))
router.post('/:ownerId/invitation/revoke', send(req => S.revokeInvitation(ownerId(req), req.agent, req.body?.reason)))
router.post('/:ownerId/verify', send(req => S.verifyOwner(ownerId(req), req.agent, req.body || {})))
router.post('/:ownerId/dispute', send(req => S.disputeOwner(ownerId(req), req.agent, req.body || {})))
router.post('/:ownerId/dispute/resolve', send(req => S.resolveDispute(ownerId(req), req.agent, req.body || {})))
router.post('/:ownerId/sync-owner', send(req => S.syncOwner(ownerId(req), req.agent)))
router.post('/:ownerId/sync-properties', send(req => S.syncProperties(ownerId(req), req.agent)))
router.post('/:ownerId/retry', send(req => S.retrySync(ownerId(req), req.agent)))
router.post('/:ownerId/availability-answer', send(req => S.recordAnswerByStaff(ownerId(req), req.agent, req.body || {})))

module.exports = router
