'use strict'
// Kev, 2026-10-19: every property post in a category group was followed by a
// second message ("📍 Depiro Street / Available: Now / #2906-9489"). Now ONE
// card: availability marker on top, description, then restrictions, Viewings /
// Available, booking link and info link. The street never appears in it.
// Drives the REAL categoryPublisher + categoryFormatter + categoryClassifier.
const assert = require('assert')
const path = require('path')
const Module = require('module')

const sent = []
const row = {
  id: 29460, ref: '2906-9489', town: 'Sliema', street: 'Depiro Street', apt: null, sub_location: null,
  bedrooms: 2, bathrooms: 1, longlet_price: 1600, sale_price: null, property_type: 'apartment',
  available_date: '2026-10-01', viewing_date: null, available_until: null, lease_type: 'long_let', rental_modes: null,
  category_override: null, videos: [], original_group_images: [], listed_by_agent_id: 1, post_tag: null,
  public_payload: {
    description_social: '🔥 GREAT PRICE VALUE – SLIEMA 🔥\n📍 Sliema – Depiro Street, Opposite the Local Council\n💰 €1,600/month – Bills Excluded\n2 Bedrooms, 1 Bathroom, Modern Apartment\n🌊 Easy Access to Sliema Seafront\nNo pets\n🟢 Available Now – Ready to Rent!\nREF #2906-9489',
    description_public: 'A beautiful and spacious 2-bedroom apartment in central Sliema.',
    beds: 2, baths: 1, town: 'Sliema', type: 'apartment', longlet_price: 1600, images: [],
  },
}
const db = {
  query: async (q, p = []) => {
    if (/FROM properties p/i.test(q) || /FROM properties\b/.test(q) && /WHERE p?\.?id = \$1/.test(q)) return { rows: [row] }
    if (/FROM category_groups/.test(q)) return { rows: (p[0] || []).map(k => ({ key: k, group_id: `${k}@g.us`, display_name: k })) }
    return { rows: [] }
  },
}
const original = Module._load
Module._load = function (request) {
  if (request === '../db') return db
  if (request === '../logger') return { info() {}, warn() {}, error() {}, debug() {} }
  if (request === '../waha') return { pickActiveAdminSession: async () => 'default', sendText: async (s, chat, text) => { sent.push(text); return { id: `m${sent.length}` } }, sendImage: async () => ({}), sendVideo: async () => ({}), getSessionStatus: async () => ({ status: 'WORKING' }) }
  if (request === './extractionProvenance') return { recordSeafrontProvenance: async () => {} }
  if (request === '@google/genai') return { GoogleGenAI: function () {} }
  return original.apply(this, arguments)
}
const pub = require(process.argv[2] || path.join(__dirname, '../services/categoryPublisher.js'))

let passed = 0, failed = 0
const run = async (name, fn) => { try { await fn(); console.log(`  ok   ${name}`); passed++ } catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++ } }
;(async () => {
  await run('one text message per group between the dividers', async () => {
    sent.length = 0
    const out = await pub.publishToCategoryGroups(row.id, { session: 'default' }).catch(e => ({ err: e.message }))
    if (process.env.DEBUG) console.log(JSON.stringify({ ...out, message: undefined }).slice(0, 900))
    const texts = sent.filter(t => t !== '...')
    assert.equal(texts.length, 1, `got ${texts.length} text messages: ${texts.map(t => t.slice(0, 30)).join(' | ')}`)
  })
  await run('card: AVAILABLE NOW on top, booking + info links, #REF', async () => {
    const card = sent.find(t => t !== '...')
    assert.match(card.split('\n')[0], /AVAILABLE NOW/)
    assert.match(card, /Book a viewing: https:\/\/crm\.2906\.estate\/schedule-board\?ref=2906-9489&action=book/)
    assert.match(card, /Info & photos: https:\/\/crm\.2906\.estate\/schedule-board\?ref=2906-9489&action=detail/)
    assert.match(card, /#?2906-9489/)
  })
  await run('card never carries a "📍 <street>" agent line', async () => {
    const card = sent.find(t => t !== '...')
    assert.ok(!/📍 Depiro Street\n/.test(card), 'no separate street line from Package 2')
  })
  await run('future date → AVAILABLE <month> marker', async () => {
    const future = { ...row, available_date: new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10) }
    const card = pub.buildGroupCard(future, [])
    assert.match(card.split('\n')[0], /^🗓️ AVAILABLE (EARLY|MID|END) [A-Z]+$/)
  })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})()
