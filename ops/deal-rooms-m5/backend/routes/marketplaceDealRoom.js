'use strict'
// NEXUS Deal Room, client side (Claude, 2026-11-21), mounted at /api/nexus/mp-deal. Public route, access only with the
// conversation token (X-MP-Token) of the Marketplace conversation the Deal Room belongs to. The client sees the stage,
// the timeline entries meant for the parties, the documents meant for the parties and the payment requests; the client
// can add photos, videos and documents (evidence). Internal notes and staff-only documents are never returned.
const express = require('express')
const log = require('../logger')
const D = require('../services/dealRooms')
const X = require('../services/dealRoomDocs')

const router = express.Router()
const visitor = req => ({ kind: 'visitor', convId: req.params.conv, token: String(req.get('x-mp-token') || '') })
const fail = (res, err) => {
  const k = err instanceof X.DocError || err instanceof D.DealError
  if (!k) log.error('mp deal route failed', { err: err.message })
  res.status(k ? err.status : 500).json({ ok: false, error: k ? err.code : 'FAILED', message: k ? err.message : 'Request failed' })
}
router.get('/:conv', async (req, res) => {
  try { const { room } = await X.visitorRoom(req.params.conv, visitor(req).token); res.set('Cache-Control', 'private, no-store').json({ ok: true, deal: await D.forConversation(room.conversation_id, 'visitor') }) } catch (e) { fail(res, e) }
})
router.post('/:conv/documents', async (req, res) => {
  try {
    const v = visitor(req); const { room } = await X.visitorRoom(v.convId, v.token)
    await X.upload(v, room.id, req.body || {})
    res.json({ ok: true, deal: await D.forConversation(room.conversation_id, 'visitor') })
  } catch (e) { fail(res, e) }
})
router.get('/:conv/documents/:doc', async (req, res) => {
  try {
    const v = visitor(req); const { room } = await X.visitorRoom(v.convId, v.token)
    const f = await X.download(v, room.id, req.params.doc)
    res.set({ 'Content-Type': f.mime, 'Content-Disposition': `attachment; filename="${String(f.filename).replace(/[^A-Za-z0-9._-]/g, '_')}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }).send(f.buffer)
  } catch (e) { fail(res, e) }
})
module.exports = router
