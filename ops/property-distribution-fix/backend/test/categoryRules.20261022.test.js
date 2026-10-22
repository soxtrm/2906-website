'use strict'
// Kev, 2026-10-22: "Wenn direct Seafront erwähnt wird → IMMER SEAFRONT. Luxury
// und House sind danach. 3b 2b 1b wenn unter 2500€. Houses = alle Häuser,
// Villen und co." #2906-9519 ("🌊 Direct Seafront Location") went to Luxury.
// Drives the REAL services/categoryClassifier.js classifyProperty with the
// real #2906-9519 payload; db = every group active, no Gemini key.
//   node test/categoryRules.20261022.test.js [path/to/categoryClassifier.js]
const assert = require('assert')
const path = require('path')
const Module = require('module')

const original = Module._load
Module._load = function (request) {
  if (request === '../db') return { query: async (q, p) => ({ rows: (p[0] || []).map(key => ({ key })) }) }
  if (request === '../logger') return { info() {}, warn() {}, error() {}, debug() {} }
  if (request === '@google/genai') return { GoogleGenAI: class { constructor() { throw new Error('no network in tests') } } }
  return original.apply(this, arguments)
}
delete process.env.GEMINI_API_KEY
const C = require(process.argv[2] || path.join(__dirname, '../services/categoryClassifier.js'))
const real9519 = require('./fixtures-9519.json')

let passed = 0, failed = 0
const run = async (name, fn) => { try { await fn(); console.log(`  ok   ${name}`); passed++ } catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++ } }
const key = async payload => (await C.classifyProperty(payload)).keys[0] || null
const ad = (social, extra = {}) => ({ description_social: social, description: 'Generated description of the listing.', type: 'apartment', bedrooms: 2, beds: 2, longlet_price: 1800, ...extra })

;(async () => {
  console.log('=== category rules 2026-10-22 ===')

  await run('#2906-9519 real payload ("🌊 Direct Seafront Location", €3,000) → seafront, not luxury', async () => {
    const r = await C.classifyProperty(real9519)
    assert.deepStrictEqual(r.keys, ['seafront'], r.reasoning)
    assert.match(r.seafront_evidence, /Direct Seafront/i)
  })

  await run('direct seafront always wins — over luxury, houses and every bedroom group', async () => {
    assert.strictEqual(await key(ad('DIRECT SEAFRONT penthouse', { longlet_price: 6000 })), 'seafront')
    assert.strictEqual(await key(ad('Direct seafront villa in Marsascala', { type: 'villa', bedrooms: 4, beds: 4, longlet_price: 4500 })), 'seafront')
    assert.strictEqual(await key(ad('Flat directly on the seafront, Qawra', { longlet_price: 1200 })), 'seafront')
    assert.strictEqual(await key(ad('Lovely flat. 🌊 Direct Seafront Location. Sea views.')), 'seafront')
  })

  await run('the generated description can no longer veto the agent\'s "direct seafront"', async () => {
    assert.strictEqual(await key(ad('Direct seafront apartment', { description_public: 'Apartment close to the seafront.' })), 'seafront')
  })

  await run('"near"/"close to"/"access to"/negated seafront is not the Sea Front group', async () => {
    for (const t of ['Nice apartment near the seafront in Sliema', 'Close to the seafront and all amenities', 'Direct access to the seafront promenade',
      'Only 2 minutes walk to Tower Road & Seafront', 'Not direct seafront but great views', 'Easy Access to Sliema Seafront'])
      assert.notStrictEqual(await key(ad(t)), 'seafront', t)
  })

  await run('houses (villa, townhouse, house of character, terraced …) come after seafront, before luxury', async () => {
    for (const type of ['villa', 'townhouse', 'house of character', 'terraced house', 'semi-detached villa', 'farmhouse', 'bungalow'])
      assert.strictEqual(await key(ad('Lovely home', { type, bedrooms: 3, beds: 3, longlet_price: 3200 })), 'villas', type)
    assert.strictEqual(await key(ad('Lovely home', { type: 'maisonette', bedrooms: 3, beds: 3, longlet_price: 1800 })), 'bed3', 'maisonette stays an apartment')
    assert.strictEqual(await key(ad('Penthouse', { type: 'penthouse', bedrooms: 3, beds: 3, longlet_price: 3200 })), 'luxury', 'penthouse is not a house')
  })

  await run('luxury from €2,500 for every size; below it the bedroom groups', async () => {
    assert.strictEqual(await key(ad('Flat', { bedrooms: 1, beds: 1, longlet_price: 2100 })), 'bed1', '1BR €2,100 (was luxury)')
    assert.strictEqual(await key(ad('Flat', { bedrooms: 1, beds: 1, longlet_price: 2500 })), 'luxury')
    assert.strictEqual(await key(ad('Flat', { bedrooms: 2, beds: 2, longlet_price: 2499 })), 'bed2')
    assert.strictEqual(await key(ad('Flat', { bedrooms: 3, beds: 3, longlet_price: 2600 })), 'luxury')
    assert.strictEqual(await key(ad('Flat', { bedrooms: 3, beds: 3, longlet_price: 1500 })), 'bed3')
  })

  await run('€2,500+ with unknown bedrooms is luxury instead of "needs manual categorisation"', async () => {
    assert.strictEqual(await key(ad('Flat', { bedrooms: null, beds: null, longlet_price: 3000 })), 'luxury')
    assert.strictEqual(await key(ad('Flat', { bedrooms: null, beds: null, longlet_price: 1500 })), null)   // still needs a human
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})()
