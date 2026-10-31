'use strict'
// Kev, 2026-10-31 — "ask only for missing facts" acceptance tests on the REAL
// services/ownerQuestionPlan.js + services/ownerFacts.js (pure).
//   node --test test/ownerQuestionPlan.test.js
const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Q = require(path.join(__dirname, '..', 'services/ownerQuestionPlan'))
const { extractFacts } = require(path.join(__dirname, '..', 'services/ownerFacts'))
const SUB = 'One last question, ... would you may consider it?'

test('address given, floor missing → ask ONLY the floor', () => {
  const b = Q.bundleFor('floor', { address: 'Triq il-Kbira 12, Sliema' })
  assert.deepStrictEqual(b.fields, ['floor'])
  assert.strictEqual(b.text, 'Which floor is the apartment on?')
  assert.doesNotMatch(b.label, /address/)
})

test('floor given, address missing → ask ONLY the address', () => {
  const b = Q.bundleFor('map', { floor: '2' })
  assert.deepStrictEqual(b.fields, ['map'])
  assert.doesNotMatch(b.text, /floor/i)
})

test('both missing → one combined question', () => {
  const b = Q.bundleFor('map', {})
  assert.deepStrictEqual(b.fields, ['map', 'floor'])
  assert.match(b.text, /address.*floor/)
})

test('garage confirmed, subletting unknown → ask ONLY subletting (Kev\'s wording untouched)', () => {
  const b = Q.bundleFor('subletting', { parking: 'yes' }, { verbatim: { subletting: SUB } })
  assert.deepStrictEqual(b.fields, ['subletting'])
  assert.strictEqual(b.text, SUB)
})

test('both unknown and subletting eligible → parking first, then the verbatim subletting question', () => {
  const b = Q.bundleFor('parking', {}, { verbatim: { subletting: SUB } })
  assert.deepStrictEqual(b.fields, ['parking', 'subletting'])
  assert.strictEqual(b.text, `Is there a garage or a parking space with it? ${SUB}`)
})

test('subletting not yet eligible (Stage 4 gate) → parking alone', () => {
  const b = Q.bundleFor('parking', {}, { eligible: f => f !== 'subletting' })
  assert.deepStrictEqual(b.fields, ['parking'])
})

test('pets accepted never implies subletting; known fields are never re-asked', () => {
  let c = Q.factsIntoChecklist({ pets: 'yes' }, extractFacts('Pets are ok', new Date('2026-10-30')))
  assert.strictEqual(c.subletting, undefined)
  assert.deepStrictEqual(Q.bundleFor('parking', c, { eligible: f => f !== 'subletting' }).fields, ['parking'])
  c = { address: 'x', floor: 'ground' }
  assert.deepStrictEqual(Q.bundleFor('map', c).fields, ['map'], 'only what the caller asked for — the companion is known')
})

test('rent type and available-from are asked together; Winter Let captured from the reply', () => {
  assert.deepStrictEqual(Q.bundleFor('available_date', {}).fields, ['available_date', 'rent_type'])
  const c = Q.factsIntoChecklist({}, extractFacts("It's a winter let, available from 1 December. Second floor, there is a garage.", new Date('2026-10-30')))
  assert.deepStrictEqual([c.rent_type, c.floor, c.parking, c.parking_type], [['winter_let'], '2', 'yes', 'garage'])
  assert.deepStrictEqual(Q.bundleFor('map', c).fields, ['map'], 'floor already known → address alone')
})

test('an earlier explicit answer is never overwritten by a later mention', () => {
  const c = Q.factsIntoChecklist({ floor: '3' }, extractFacts('ground floor is the garage', new Date('2026-10-30')))
  assert.strictEqual(c.floor, '3')
})
