import test from 'node:test'
import assert from 'node:assert/strict'
import { tier, publicImpact, modes, weights, reasons, dishes, fit, verticals } from '../lib/nexus-brain/demo.ts'

test('all 101 rating positions have the required raw-score tier', () => {
  const boundaries = [[0, 'Unsatisfactory'], [1, 'Poor'], [3, 'Passable'], [5, 'Okay'], [6, 'Solid'], [7, 'Good'], [8, 'Very Good'], [9, 'Excellent'], [9.5, 'World Class']]
  for (let i = 0; i <= 100; i++) assert.equal(tier(i / 10), boundaries.findLast(([min]) => i / 10 >= min)[1])
  assert.equal(tier(9.4999), 'Excellent')
  assert.equal(tier(9.5), 'World Class')
})
test('extreme new opinions are retained without replacing the 200 fixed observations', () => {
  assert.equal(publicImpact(0), 1680 / 201)
  assert.equal(publicImpact(10), 1690 / 201)
  assert.ok(publicImpact(0) > 8.35 && publicImpact(10) < 8.41)
})
test('each service mode has six distinct evidence dimensions and normalized weight presets', () => {
  for (const mode of Object.values(modes)) {
    assert.equal(mode.values.length, 6)
    assert.equal(new Set(mode.labels).size, 6)
    assert.ok(mode.values.every(n => n >= 0 && n <= 10))
  }
  assert.ok(modes.delivery.labels.includes('Temperature & Texture'))
  assert.ok(modes.takeaway.labels.includes('Pickup'))
  for (const values of Object.values(weights)) assert.ok(Math.abs(values.reduce((a,b) => a+b, 0) - 1) < 1e-10)
})
test('every semantic branch has a question, correction type and concrete choices', () => {
  for (const name of ['Too greasy','Dry','Wrong texture','Too salty','Salami','Cheese','Temperature','Packaging','Wrong item','Too late','Other','Flavor balance','Crisp crust','Perfect temperature','Great service']) {
    assert.ok(reasons[name].question && reasons[name].category)
    assert.ok(reasons[name].options.length >= 3)
  }
  assert.equal(reasons['Too late'].category, 'Uncertain')
})
test('unknown preference stays unknown at every exploration setting', () => {
  for (let curiosity = 0; curiosity <= 100; curiosity += 5) {
    assert.equal(fit(dishes[2], curiosity), null)
    assert.ok(fit(dishes[0], curiosity) >= 0 && fit(dishes[0], curiosity) <= 10)
  }
  assert.ok(fit(dishes[0], 100) > fit(dishes[0], 0))
  assert.notDeepEqual(verticals.Food.dimensions, verticals.Services.dimensions)
})
