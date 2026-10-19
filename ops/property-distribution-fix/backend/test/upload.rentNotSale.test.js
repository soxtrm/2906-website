'use strict'
// Kev, 2026-10-19 (#2906-9502, Olga): "3500€ asking price" for a 3-bedroom in
// Tigné was stored as a €3,500 SALE. Nothing in Malta sells for < €20,000 — it is
// the monthly rent. Drives the REAL handlers/upload.js createListing with the
// extraction stubbed to what Gemini returned for that ad; checks the INSERT.
//   node test/upload.rentNotSale.test.js [path/to/handlers/upload.js]
const assert = require('assert')
const path = require('path')
const Module = require('module')

const inserts = []
const db = {
  query: async (q, p = []) => {
    if (/INSERT INTO properties/.test(q)) { inserts.push(p); return { rows: [{ id: 99001, ref: p[0] }] } }
    if (/nextval|MAX\(|ref_seq|SELECT .*ref/i.test(q)) return { rows: [{ next: 9999, max: 9998, ref: '2906-9999', nextval: 9999 }] }
    if (/INSERT INTO owner_contacts|RETURNING id/i.test(q)) return { rows: [{ id: 7 }] }
    return { rows: [] }
  },
  connect: async () => ({ query: db.query, release() {} }),
}
let extraction = null
const inert = new Proxy(function () {}, { get: (_, k) => (k === 'then' ? undefined : inert), apply: () => inert, construct: () => inert })
const original = Module._load
Module._load = function (request, parent) {
  if (request === '../db') return db
  if (request === '../logger') return { info() {}, warn() {}, error() {}, debug() {} }
  if (request === './uploadListing') {
    const real = original.apply(this, arguments)
    return { ...real, extractListing: async () => extraction }
  }
  if (request.startsWith('.') && !/uploadListing/.test(request)) return inert
  if (['ioredis', 'bullmq', 'axios', '@google/genai', 'openai', 'cloudinary', 'sharp'].includes(request)) return inert
  return original.apply(this, arguments)
}
const upload = require(process.argv[2] || path.join(__dirname, '../handlers/upload.js'))

const olgaAd = '💖 COMING SOON – ONE OF TIGNÉ’S BEST SEAFRONT ADDRESSES!\n📍 Sliema Tigné Point – Seafront\n😎3500€ asking price\nA truly exceptional 3-bedroom seafront apartment'
const run = async (name, ex, check) => {
  inserts.length = 0
  extraction = ex
  try {
    await upload.createListing({ rawText: olgaAd, images: [], videos: [], agent: { id: 2, name: 'Olga' }, senderPhone: '35679010070', chatId: 'olga@g.us', session: 'default', variant: '7', force: true, noAd: true })
  } catch (e) { /* side effects after the INSERT are stubbed and may throw — the INSERT is what we check */ }
  assert.ok(inserts.length, `${name}: a property row was inserted`)
  const params = inserts[0]
  check({ longlet: params[9], sale: params[11] })
  console.log(`  ok   ${name}`)
}

;(async () => {
  let failed = 0
  const t = async (...a) => { try { await run(...a) } catch (e) { failed++; console.error(`  FAIL ${a[0]}\n       ${e.message}`) } }
  await t('"3500€ asking price" (Gemini: sale 3500) → rent €3,500/month', { owner: { phones: ['35679010070'] }, property: { location: 'Sliema', type: 'apartment', beds: 3, sale_price: 3500, longlet_price: 0, description: 'A truly exceptional 3-bedroom apartment in Tigné, corner position.' } },
    ({ longlet, sale }) => { assert.equal(longlet, 3500); assert.equal(sale, null) })
  await t('a real sale price (€650,000) stays a sale', { owner: { phones: ['35679010070'] }, property: { location: 'Sliema', type: 'apartment', beds: 3, sale_price: 650000, longlet_price: 0, description: 'A truly exceptional 3-bedroom apartment in Tigné, corner position.' } },
    ({ longlet, sale }) => { assert.equal(sale, 650000); assert.equal(longlet, null) })
  console.log(failed ? `\n${failed} failed` : '\nall passed')
  process.exit(failed ? 1 : 0)
})()
