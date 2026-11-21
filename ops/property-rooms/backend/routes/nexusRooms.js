'use strict'
// Public NEXUS Rooms (2026-11-21), mounted at /api/nexus/rooms: homes let room by room, their rooms, shared
// spaces and the owner-confirmed layout. No owner or tenant data. Availability by date comes from NEXUS Booking.
// /demo/* serves the clearly labelled demonstration home (ref DEMO-*, is_staging) and nothing else.
const express = require('express')
const log = require('../logger')
const { LinkError } = require('../services/nexusOwnerLink')
const PR = require('../services/propertyRooms')

const router = express.Router()
const send = fn => async (req, res) => {
  try { res.set('Cache-Control', 'public, max-age=30'); res.json(await fn(req)) }
  catch (err) {
    if (err instanceof LinkError) return res.status(err.status).json({ error: err.code, message: err.message })
    log.error('public rooms route failed', { err: err.message })
    res.status(500).json({ error: 'FAILED', message: 'Rooms are not available right now.' })
  }
}
router.get('/', send(() => PR.publicList()))
router.get('/demo', send(() => PR.publicList({ demo: true })))
router.get('/demo/:ref', send(req => PR.publicHome(req.params.ref, { demo: true })))
router.get('/:ref', send(req => PR.publicHome(req.params.ref)))
module.exports = router
