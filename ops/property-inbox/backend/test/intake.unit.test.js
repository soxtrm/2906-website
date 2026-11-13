'use strict'
// Pure rules of Incoming Properties (no database).  node --test test/intake.unit.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('module')
const path = require('path')

const original = Module._load
Module._load = function (request, parent) {
  if (parent && /propertyIntake\.js$/.test(parent.filename || '') && (request === '../db' || request === '../logger')) {
    return { query: async () => { throw new Error('no db in unit test') }, info() {}, warn() {}, error() {}, debug() {} }
  }
  return original.apply(this, arguments)
}
const I = require(path.join(__dirname, '..', 'services', 'propertyIntake.js'))

const base = { longlet_price: 2200, town: 'Rabat', bedrooms: 3, bathrooms: 3, property_type: 'house', images: [{ url: 'a' }], available_date: '2027-02-15', owner_id: null }

test('missing information: critical facts block, owner and date only warn', () => {
  assert.deepEqual(I.missingFields(base).map(m => m.field), ['owner'])
  const m = I.missingFields({ ...base, longlet_price: null, images: '[]', available_date: null })
  assert.deepEqual(m.filter(x => x.critical).map(x => x.field), ['price', 'photos'])
  assert.deepEqual(m.filter(x => !x.critical).map(x => x.field), ['available_date', 'owner'])
  assert.equal(I.missingFields({ ...base, sale_price: 450000, longlet_price: null }).some(x => x.field === 'price'), false, 'a sale price is a price')
  assert.equal(I.missingFields({ ...base, bedrooms: null, property_type: 'studio' }).some(x => x.field === 'bedrooms'), false, 'a studio has no bedroom count')
})

test('edits: only whitelisted columns, numbers and dates are validated', () => {
  const { edits, errors } = I.sanitizeEdits({ longlet_price: '€2,200', bedrooms: '3', town: '  Rabat ', available_date: '2027-02-15', published: true, owner_id: 9, property_type: 'Penthouse' })
  assert.deepEqual(errors, [])
  assert.deepEqual(edits, { bedrooms: 3, longlet_price: 2200, town: 'Rabat', property_type: 'penthouse', available_date: '2027-02-15' })
  assert.match(I.sanitizeEdits({ bedrooms: '2.5' }).errors[0], /bedrooms/)
  assert.match(I.sanitizeEdits({ available_date: '15/02/2027' }).errors[0], /YYYY-MM-DD/)
  assert.match(I.sanitizeEdits({ property_type: 'castle' }).errors[0], /type/)
  assert.deepEqual(I.sanitizeEdits({ longlet_price: '' }).edits, { longlet_price: null })
})

test('review rights: administrator, or the agent who uploaded it; viewers never', () => {
  const row = { listed_by_agent_id: 7, package_agent_id: 7 }
  assert.equal(I.canReview({ id: 1, role: 'admin' }, row), true)
  assert.equal(I.canReview({ id: 7, role: 'agent' }, row), true)
  assert.equal(I.canReview({ id: 8, role: 'agent' }, row), false)
  assert.equal(I.canReview({ id: 7, role: 'viewer' }, row), false)
  assert.equal(I.canReview({ id: 7, role: 'board' }, row), false)
})

test('a card is "ready" only while pending, unverified and complete', () => {
  const row = { ...base, id: 1, verification_status: 'unverified', intake_source: 'whatsapp_divider', archived_at: null }
  assert.equal(I.shapeItem(row).ready, true)
  assert.equal(I.shapeItem({ ...row, longlet_price: null }).ready, false)
  assert.equal(I.shapeItem({ ...row, verification_status: 'needs_correction' }).ready, false)
  assert.equal(I.shapeItem({ ...row, archived_at: new Date() }).pending, false)
  assert.equal(I.shapeItem({ ...row, description: '**BIG** title\n\nline two' }).summary, 'BIG title · line two')
})
