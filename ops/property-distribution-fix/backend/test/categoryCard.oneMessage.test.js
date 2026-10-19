'use strict'
// Kev, 2026-10-19 (corrected): the booking + info links and the availability
// marker belong in the second AGENT card (Package 2: 📍 street / Viewings /
// Available / #REF), NEVER in the client description (Package 1) that agents
// forward to clients. Drives the REAL categoryPublisher + categoryFormatter +
// categoryClassifier; WAHA stubbed.
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
    description_social: '🔥 GREAT PRICE VALUE – SLIEMA 🔥\n📍 Sliema – Depiro Street, Opposite the Local Council\n💰 €1,600/month – Bills Excluded\n2 Bedrooms, 1 Bathroom, Modern Apartment\n🌊 Easy Access to Sliema Seafront\n🟢 Available Now – Ready to Rent!\nREF #2906-9489',
    description_public: 'A beautiful and spacious 2-bedroom apartment in central Sliema.',
    beds: 2, baths: 1, town: 'Sliema', type: 'apartment', longlet_price: 1600, images: [],
  },
}
const db = {
  query: async (q, p = []) => {
    if (/FROM properties p/i.test(q)) return { rows: [row] }
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
  await pub.publishToCategoryGroups(row.id, { session: 'default' }).catch(() => {})
  const texts = sent.filter(t => t !== '...')
  const [description, agentCard] = texts
  await run('two messages: client description, then the agent card', async () => {
    assert.equal(texts.length, 2, `got ${texts.length}`)
  })
  await run('client description has NO links and NO marker', async () => {
    assert.ok(!/schedule-board\?ref=/.test(description), 'no CRM links in the client description')
    assert.ok(!/AVAILABLE NOW\n/.test(description.split('\n')[0] + '\n'), 'no marker line on top')
  })
  await run('agent card: AVAILABLE NOW on top, street, booking + info links, #REF', async () => {
    assert.match(agentCard.split('\n')[0], /^🟢 AVAILABLE NOW$/)
    assert.match(agentCard, /📍 Depiro Street/)
    assert.match(agentCard, /Book a viewing: https:\/\/crm\.2906\.estate\/schedule-board\?ref=2906-9489&action=book/)
    assert.match(agentCard, /Info & photos: https:\/\/crm\.2906\.estate\/schedule-board\?ref=2906-9489&action=detail/)
    assert.match(agentCard, /#2906-9489/)
  })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})()
