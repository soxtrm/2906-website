'use strict'
// ============================================================================
// routes/syncAccountService.js — SYNC server (nexussync.one) → ARGUS,
// service-to-service (Claude, 2026-11-19). Mounted at /api/sync-account/v1.
//
// Same signing as /api/nexus-link/v1 (NEXUS_LINK_INBOUND_SECRET, HMAC over
// timestamp, method, path and body). Browsers never call this: the SYNC server
// keeps the owner's session in an httpOnly cookie and passes it in the signed
// body. While the secret is not configured, everything answers 503.
// ============================================================================
const express = require('express')
const rateLimit = require('express-rate-limit')
const log = require('../logger')
const C = require('../services/nexusLinkCrypto')
const { LinkError } = require('../services/nexusOwnerLink')
const S = require('../services/syncAccount')

const router = express.Router()
const limiter = rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false, message: { error: 'RATE_LIMITED', message: 'Too many requests' } })

function signed(req, res, next) {
  const secret = process.env.NEXUS_LINK_INBOUND_SECRET || ''
  if (secret.length < 32) return res.status(503).json({ error: 'LINK_NOT_CONFIGURED', message: 'SYNC is not enabled on this ARGUS instance.' })
  const expectedKey = process.env.SYNC_LINK_KEY_ID || 'nexus-sync'
  if (req.get('X-Nexus-Link-Key') !== expectedKey) return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Unknown key' })
  const check = C.verify(secret, { timestamp: req.get('X-Nexus-Link-Timestamp'), method: req.method, path: req.path, body: req.body ?? null }, req.get('X-Nexus-Link-Signature'))
  if (!check.ok) return res.status(401).json({ error: 'UNAUTHORIZED', message: check.reason })
  next()
}

// The SYNC server forwards the owner's address; only a signed caller can set it.
const clientKey = req => String(req.get('X-Sync-Client-IP') || req.ip || '').slice(0, 64)
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, keyGenerator: clientKey, standardHeaders: true, legacyHeaders: false, message: { error: 'TOO_MANY', message: 'Too many attempts. Please wait 15 minutes.' } })
const loginByEmail = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, keyGenerator: req => `e:${String(req.body?.email || '').trim().toLowerCase().slice(0, 200)}`, standardHeaders: false, legacyHeaders: false, message: { error: 'TOO_MANY', message: 'Too many attempts. Please wait 15 minutes.' } })

const send = fn => async (req, res) => {
  try { res.json({ ok: true, ...(await fn(req)) }) }
  catch (err) {
    if (err instanceof LinkError) return res.status(err.status).json({ ok: false, error: err.code, message: err.message })
    log.error('sync-account route failed', { err: err.message, path: req.path })
    res.status(500).json({ ok: false, error: 'INTERNAL', message: 'Something went wrong. Please try again.' })
  }
}
const me = req => S.sessionAccount(req.body?.session)
const ua = req => req.body?.userAgent

router.use(limiter, signed)

router.post('/signup', authLimiter, send(req => S.signup({ email: req.body?.email, password: req.body?.password, name: req.body?.name, userAgent: ua(req) })))
router.post('/login', authLimiter, loginByEmail, send(req => S.login({ email: req.body?.email, password: req.body?.password, userAgent: ua(req) })))
router.post('/social', authLimiter, send(req => S.socialSignIn({ provider: req.body?.provider, code: req.body?.code, redirectUri: req.body?.redirectUri, userAgent: ua(req), linkToToken: req.body?.session })))
router.post('/logout', send(req => S.logout(req.body?.session)))

router.post('/me', send(async req => { const a = await me(req); return { account: S.accountView(a), owner: await S.ownerView(a) } }))
router.post('/account/update', send(async req => S.updateAccount(await me(req), req.body || {})))

router.post('/email/start', send(async req => S.emailStart(await me(req))))
router.post('/email/confirm', send(async req => S.emailConfirm(await me(req), req.body?.code)))
router.post('/phone/start', send(async req => S.phoneStart(await me(req), { phone: req.body?.phone, channel: req.body?.channel })))
router.post('/phone/status', send(async req => S.phoneStatus(await me(req))))

router.post('/claims/decide', send(async req => S.decideClaims(await me(req), req.body?.decisions)))
router.post('/owner/event', send(async req => S.ownerEvent(await me(req), { eventType: req.body?.eventType, eventId: req.body?.eventId, data: req.body?.data })))

router.post('/messages', send(async req => S.messages(await me(req), { after: req.body?.after })))
router.post('/messages/send', send(async req => S.postMessage(await me(req), { text: req.body?.text, propertyId: req.body?.propertyId })))

module.exports = router
