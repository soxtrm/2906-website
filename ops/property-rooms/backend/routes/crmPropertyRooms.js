'use strict'
// CRM: NEXUS Rooms of a property (2026-11-21), mounted at /api/crm/property-rooms. Staff only.
// Admins and the listing agent change rooms; other staff read. Room stays come from NEXUS Booking.
const express = require('express')
const log = require('../logger')
const { requireStaff } = require('../middleware/staffAuth')
const { LinkError } = require('../services/nexusOwnerLink')
const PR = require('../services/propertyRooms')
const RB = require('../services/roomsBooking')

const router = express.Router()
const send = fn => async (req, res) => {
  try { res.json({ ok: true, ...(await fn(req)) }) }
  catch (err) {
    if (err instanceof LinkError) return res.status(err.status).json({ ok: false, error: err.code, message: err.message })
    log.error('property rooms route failed', { err: err.message })
    res.status(500).json({ ok: false, error: 'FAILED', message: 'Rooms request failed' })
  }
}
const staff = req => ({ kind: 'staff', agent: req.agent })
router.use(requireStaff)
router.get('/:propertyId', send(req => PR.rooms(staff(req), { propertyId: req.params.propertyId })))
router.post('/:propertyId/save', send(req => PR.saveUnits(staff(req), { propertyId: req.params.propertyId, rooms: req.body?.rooms, shared: req.body?.shared })))
router.post('/:propertyId/mode', send(req => PR.setMode(staff(req), { propertyId: req.params.propertyId, mode: req.body?.mode, markets: req.body?.markets })))
router.post('/:propertyId/photo', send(req => PR.photo(staff(req), { propertyId: req.params.propertyId, unitId: req.body?.unitId, dataBase64: req.body?.dataBase64, url: req.body?.url, remove: req.body?.remove })))
router.post('/:propertyId/layout', send(req => PR.saveLayout(staff(req), { propertyId: req.params.propertyId, layout: req.body?.layout, confirm: req.body?.confirm === true })))
router.get('/:propertyId/stays', send(req => RB.stays(staff(req), { propertyId: req.params.propertyId })))
router.post('/:propertyId/stays/:stayId/decide', send(req => RB.decide(staff(req), { propertyId: req.params.propertyId, stayId: req.params.stayId, action: req.body?.action, holdHours: req.body?.holdHours, note: req.body?.note })))
module.exports = router
