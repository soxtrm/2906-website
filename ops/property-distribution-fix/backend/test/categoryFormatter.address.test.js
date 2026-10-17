'use strict'
// #2906-9481 (Gżira townhouse, 2026-10-17): category distribution, Facebook
// scheduling and auto-share all died with
//   categoryFormatter: address "📍 Gżira, 421" in category group message
// and !recategorize repeated the same error. Drives the REAL production
// sanitizer + categoryFormatter with the REAL ad text of that listing.
const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('module')
const path = require('path')

const stubs = { '../db': { query: async () => ({ rows: [] }) }, '../logger': { info() {}, warn() {}, error() {}, debug() {} }, '../waha': {} }
const original = Module._load
Module._load = function (request) { return stubs[request] || original.apply(this, arguments) }
const sanitizer = require('../services/sanitizer')
const { formatForCategoryGroup } = require('../services/categoryFormatter')
Module._load = original

// Verbatim description_social of #2906-9481 as stored in production.
const AD_9481 = `🏡 MODERN TOWNHOUSE – GŻIRA 🏡

📍 Gżira – 421 Rue D’Argens
💰 €2,300/month

✨ 3 Double Bedrooms - 2 Bathrooms - Modern Townhouse ✨

A beautiful, spacious townhouse in the heart of Gżira, combining modern interiors, stylish furnishings and the comfort of a proper house in one of Malta’s most convenient central locations.

🛏 3 Spacious Double Bedrooms
🛁 2 Bathrooms
🏡 Townhouse
📍 Prime Rue D’Argens Location
🌊 Close to Gżira & Sliema Waterfront

🟡 Available First Week of November 2026`

const payload9481 = { ref_id: '2906-9481', type: 'house', town: 'Gzira', beds: 3, baths: 2, longlet_price: 2300, available_date: '2026-11-01', description_social: AD_9481 }

test('#2906-9481: the stored payload renders instead of crashing distribution', () => {
  const message = formatForCategoryGroup(payload9481)
  assert.match(message, /MODERN TOWNHOUSE/)
  assert.match(message, /REF #2906-9481/)
  assert.doesNotMatch(message, /421/, 'house number never reaches the category group')
  assert.doesNotMatch(message, /Rue D.Argens/i, 'street never reaches the category group')
  assert.match(message, /📍 Gżira/, 'the town stays')
  assert.match(message, /Close to Gżira & Sliema Waterfront/, 'nearby-area copy is not an address')
  assert.match(message, /€2,300\/month/)
})

test('upload-time sanitizing removes a French "Rue" street with its house number', () => {
  const cleaned = sanitizer.stripAddresses('📍 Gżira – 421 Rue D’Argens\n📍 Prime Rue D’Argens Location', 'Gzira')
  assert.doesNotMatch(cleaned, /421|Rue D.Argens/i, cleaned)
  assert.match(cleaned, /Gżira|Gzira/)
})

test('dash-separated pin lines are caught like comma-separated ones', () => {
  assert.ok(sanitizer.findAddress('📍 Luxor – 234'), 'en dash')
  assert.ok(sanitizer.findAddress('📍 Luxor - 234'), 'hyphen')
  assert.ok(sanitizer.findAddress('📍 Luxor, 234'), 'comma (existing rule)')
})

test('existing firewall cases still hold', () => {
  for (const leak of ['📍 66, Triq Sir Frederick, Gzira', '📍 172/1, The Strand, Gzira', '📍 Luxor, 234', '39 Sir Frederick Street']) {
    const out = formatForCategoryGroup({ ref_id: '2906-1', town: 'Gzira', description_social: `Nice flat\n${leak}\n€1,200/month` })
    assert.doesNotMatch(out, /\b(66|172|234|39)\b/, `${leak} → ${out}`)
  }
  // Landmarks and prices are not addresses.
  const ok = formatForCategoryGroup({ ref_id: '2906-2', town: 'Sliema', description_social: 'Close to The Point\n2 bedrooms · €1,500/month\nNear Balluta Bay' })
  assert.match(ok, /Close to The Point/)
  assert.match(ok, /Near Balluta Bay/)
})

test('a maps link frozen in an old payload is redacted, not fatal', () => {
  const out = formatForCategoryGroup({ ref_id: '2906-4', town: 'Sliema', description_social: 'Sea view flat\n📍 Location: https://maps.app.goo.gl/eTSb9EwvQHuCpNWMA?g_st=ic\n🗺️ maps.app.goo.gl/XQaPgCh5gWoN4dSm9\n€1,400/month' })
  assert.doesNotMatch(out, /goo\.gl|maps\./i, out)
  assert.match(out, /Sea view flat/)
  assert.match(out, /€1,400\/month/)
})

test('phone numbers still abort (a leaked owner number is worse than no post)', () => {
  assert.throws(() => formatForCategoryGroup({ ref_id: '2906-3', town: 'Gzira', description_social: 'Call 79123456 now' }), /categoryFormatter/)
})
