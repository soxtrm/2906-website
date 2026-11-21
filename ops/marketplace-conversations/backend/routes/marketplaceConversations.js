'use strict'
// Public NEXUS Marketplace conversations (Claude, 2026-11-21), mounted at /api/nexus/mp.
// No account: the visitor's token (header X-MP-Token) is the only key to a conversation. Rules: services/marketplaceConversations.js
const express = require('express')
const log = require('../logger')
const M = require('../services/marketplaceConversations')

const router = express.Router()
const ip = req => String(req.headers['x-mp-client-ip'] || req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim()
const send = fn => async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store')
  try { res.json({ ok: true, ...(await fn(req)) }) }
  catch (err) {
    if (err instanceof M.MpError) return res.status(err.status).json({ ok: false, error: err.code, message: err.message })
    log.error('marketplace conversation route failed', { err: err.message })
    res.status(500).json({ ok: false, error: 'FAILED', message: 'Your message could not be sent. Please try again.' })
  }
}
const token = req => String(req.headers['x-mp-token'] || '')

router.post('/conversations', send(req => M.start({ ref: req.body?.ref, name: req.body?.name, email: req.body?.email, phone: req.body?.phone, role: req.body?.role, message: req.body?.message, ip: ip(req) })))
router.get('/conversations/:id', send(req => M.read({ id: req.params.id, token: token(req) })))
router.post('/conversations/:id/messages', send(req => M.visitorSend({ id: req.params.id, token: token(req), body: req.body?.body })))
router.post('/conversations/:id/viewing', send(req => M.requestViewing({ id: req.params.id, token: token(req), preferred: req.body?.preferred, note: req.body?.note })))

module.exports = router
