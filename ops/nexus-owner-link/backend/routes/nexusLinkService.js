'use strict'
// ============================================================================
// routes/nexusLinkService.js — NEXUS server → ARGUS, service-to-service
// (Claude, 2026-11-11). Mounted at /api/nexus-link/v1.
//
// NOT the public /api/nexus bridge and never reachable through it: every
// request must carry a valid HMAC signature made with NEXUS_LINK_INBOUND_SECRET.
// While that secret is not configured the whole surface answers 503 — there is
// no unauthenticated fallback. Browsers never call this; the NEXUS server does.
// ============================================================================
const express = require('express')
const rateLimit = require('express-rate-limit')
const log = require('../logger')
const S = require('../services/nexusOwnerLink')
const C = require('../services/nexusLinkCrypto')

const router = express.Router()
const limiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false, message: { error: 'RATE_LIMITED', message: 'Too many requests' } })

function signed(req, res, next) {
  const secret = process.env.NEXUS_LINK_INBOUND_SECRET || ''
  if (secret.length < 32) return res.status(503).json({ error: 'LINK_NOT_CONFIGURED', message: 'The NEXUS link is not enabled on this ARGUS instance.' })
  const expectedKey = process.env.NEXUS_LINK_INBOUND_KEY_ID || 'nexus'
  if (req.get('X-Nexus-Link-Key') !== expectedKey) return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Unknown key' })
  const check = C.verify(secret, { timestamp: req.get('X-Nexus-Link-Timestamp'), method: req.method, path: req.path, body: req.body ?? null }, req.get('X-Nexus-Link-Signature'))
  if (!check.ok) return res.status(401).json({ error: 'UNAUTHORIZED', message: check.reason })
  next()
}

const send = fn => async (req, res) => {
  try { res.json(await fn(req)) }
  catch (err) {
    if (err instanceof S.LinkError) return res.status(err.status).json({ error: err.code, message: err.message })
    log.error('nexus-link service route failed', { err: err.message })
    res.status(500).json({ error: 'INTERNAL', message: 'Request failed' })
  }
}

router.use(limiter, signed)
router.post('/invitations/resolve', send(req => S.resolveInvitation(req.body?.token)))
router.post('/events', send(req => S.applyInboundEvent(req.body)))

// Read API: what NEXUS needs to know, over the same signed channel. NEXUS has
// no login on the ARGUS database. POST so the signature covers the question.
const R = () => require('../services/nexusOwnerInbound')
router.post('/read/owner-link', send(req => R().readOwnerLink(req.body)))
router.post('/read/properties', send(req => R().readProperties(req.body)))
router.post('/read/viewing-busy', send(req => R().readViewingBusy(req.body)))
router.post('/read/source-match', send(req => R().readSourceMatch(req.body)))

module.exports = router
