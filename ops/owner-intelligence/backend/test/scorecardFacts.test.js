'use strict'
// Kev, 2026-10-31 — scorecard fields from owner chat through the REAL
// services/ownerFactEngine.js (+ ownerFacts, viewingWindows) on the test DB.
//   node --test test/scorecardFacts.test.js
const test = require('node:test')
const assert = require('node:assert')
const H = require('./helpers/ownerHarness')
const Engine = H.load('services/ownerFactEngine')
const { extractFacts } = H.load('services/ownerFacts')

const OCT = new Date('2026-10-30T10:00:00Z')
let owner

async function prop(ref, town) {
  return (await H.db.query(
    `INSERT INTO properties (ref, owner_id, town, available_status, longlet_price) VALUES ($1, $2, $3, 'available', 1500) RETURNING id`,
    [ref, owner.id, town])).rows[0].id
}
const row = async id => (await H.db.query(
  `SELECT rental_modes, available_date, floor_level, parking_available, parking_type, subletting_allowed, field_provenance FROM properties WHERE id = $1`, [id])).rows[0]

test.beforeEach(async () => {
  await H.reset()
  await H.db.query(`DELETE FROM properties WHERE ref LIKE '2906-T3%'`)
  owner = await H.owner('35699000333', 'Owner Scorecard')
})

test('"winter let, available from 1 December, 2nd floor, garage" → scorecard with provenance; unknown stays unknown', async () => {
  const id = await prop('2906-T301', 'Sliema')
  const text = "It's a winter let, available from 1 December. Second floor, there is a garage."
  await Engine.applyFacts(id, extractFacts(text, OCT), { observedAt: OCT, reference: 'wamid-sc-1' })
  const r = await row(id)
  assert.deepStrictEqual(r.rental_modes, ['winter_let'])
  assert.strictEqual(new Date(r.available_date).toISOString().slice(0, 10), '2026-12-01')
  assert.deepStrictEqual([r.floor_level, r.parking_available, r.parking_type], ['2', true, 'garage'])
  assert.strictEqual(r.subletting_allowed, null, 'subletting never inferred')
  for (const f of ['rental_modes', 'available_from', 'floor', 'parking']) {
    const p = r.field_provenance[f]
    assert.ok(Array.isArray(p) && p.length === 1, f)
    assert.strictEqual(p[0].source_reference, 'wamid-sc-1', `${f} keeps its source message`)
    assert.ok(p[0].evidence && p[0].observed_at, `${f} keeps evidence and time`)
  }
})

test('an older message never overwrites a newer statement', async () => {
  const id = await prop('2906-T302', 'Gzira')
  await Engine.applyFacts(id, extractFacts('third floor', OCT), { observedAt: OCT })
  await Engine.applyFacts(id, extractFacts('ground floor', OCT), { observedAt: new Date('2026-10-01T10:00:00Z') })
  assert.strictEqual((await row(id)).floor_level, '3')
})

test('owner with several listings: a fact with no clear unit is NOT attached to any of them', async () => {
  await prop('2906-T303', 'Mellieha')
  await prop('2906-T304', 'Qawra')
  const res = await Engine.resolveProperty(owner.id, 'Second floor, there is a garage.')
  assert.strictEqual(res.property, null)
  assert.strictEqual(res.reason, 'ambiguous')
  const named = await Engine.resolveProperty(owner.id, 'The Qawra one is on the second floor')
  assert.strictEqual(named.property.ref, '2906-T304', 'a named locality binds to that unit only')
})
