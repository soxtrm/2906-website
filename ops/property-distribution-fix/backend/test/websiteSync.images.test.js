'use strict'
// Website shows at most 10 photos (Kev, 2026-10-18, #2906-9484 had 32 online).
const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('module')
const path = require('path')

let row = null, sent = null
const stubs = {
  '../db': { query: async (sql, params) => {
    if (/FROM properties WHERE id/.test(sql)) return { rows: [row] }
    if (/FROM website_properties WHERE property_reference/.test(sql)) return { rows: [] }
    if (/INSERT INTO website_properties/.test(sql)) { sent = params; return { rows: [{ id: 1, slug: 's' }] } }
    return { rows: [] }
  } },
  '../logger': { info() {}, warn() {}, error() {} },
  '../lib/locationNormalize': { normalizeLocation: s => s },
  '../config': new Proxy({}, { get: () => ({}) }),
  '../waha': {},
  '@google/genai': { GoogleGenAI: class {} },
}
const original = Module._load
Module._load = function (request) { return stubs[request] || original.apply(this, arguments) }
// Loader stays installed: websiteSync requires imageRanker/rentalModes lazily.
const ws = require(path.join(__dirname, '..', 'services', 'websiteSync.js'))

const urls = n => Array.from({ length: n }, (_, i) => `https://res.cloudinary.com/x/${i + 1}.jpg`)
const base = { id: 29455, ref: '2906-9484', property_type: 'apartment', town: 'Sliema', bedrooms: 3, bathrooms: 3, longlet_price: 3500, available_status: 'available', description: 'Luxury seafront apartment with three bedrooms and views', published: true }
const imagesParam = () => sent.find(p => Array.isArray(p) && p.every(u => typeof u === 'string' && u.startsWith('https://res.cloudinary')))

test('32 photos → the website gets 10, in upload order when unranked', async () => {
  row = { ...base, public_payload: { images: urls(32), description_public: base.description }, image_ranking: null }
  const r = await ws.syncPropertyToWebsite(29455)
  assert.equal(r.ok, true)
  assert.deepEqual(imagesParam(), urls(10))
})

test('ranked listing: the 10 best by image_ranking', async () => {
  const order = [31, 30, 29, 0, 1, 2, 3, 4, 5, 6, 7]
  row = { ...base, public_payload: { images: urls(32), description_public: base.description }, image_ranking: { order } }
  await ws.syncPropertyToWebsite(29455)
  assert.deepEqual(imagesParam(), order.slice(0, 10).map(i => urls(32)[i]))
})

test('fewer than 10 photos stay as they are', async () => {
  row = { ...base, public_payload: { images: urls(4), description_public: base.description }, image_ranking: null }
  await ws.syncPropertyToWebsite(29455)
  assert.deepEqual(imagesParam(), urls(4))
})
