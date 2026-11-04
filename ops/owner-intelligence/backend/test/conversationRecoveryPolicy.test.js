'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const Policy = require('../services/conversationPolicy')

const portfolio = [
  { id: 101, ref: '2906-9101', property_type: 'Apartment', bedrooms: 1, floor_level: '2', apt: '1' },
  { id: 102, ref: '2906-9102', property_type: 'Apartment', bedrooms: 1, floor_level: '3', apt: '2' },
  { id: 103, ref: '2906-9103', property_type: 'Studio', bedrooms: 0, floor_level: '4', apt: '3' },
]

function decide(text, ids = portfolio.map(p => p.id), properties = portfolio) {
  return Policy.interpretInbound({ text, context: { referencedPropertyIds: ids, properties } })
}
function action(d, status) { return d.actions.find(a => a.type === 'PROPERTY_STATUS' && a.status === status) }
function fact(d, name) { return d.facts.find(f => f.fieldName === name) }

test('A: two rented plus one available studio never rents the whole portfolio', () => {
  const d = decide('Hi, 2 of the apartments have been rented out. The studio on the 4th floor is available. Official price is €1,700, slightly negotiable for the right client.')
  assert.equal(action(d, Policy.OPERATIONAL_STATUS.RENTED), undefined)
  assert.deepEqual(action(d, Policy.OPERATIONAL_STATUS.AVAILABLE).propertyIds, [103])
  assert.equal(fact(d, 'askingPrice').fieldValue, 1700)
  assert.deepEqual(fact(d, 'askingPrice').propertyIds, [103])
  assert.equal(fact(d, 'priceNegotiable').fieldValue, true)
  assert.ok(d.actions.some(a => a.type === 'HUMAN_REVIEW' && a.reason === 'mixed_unit_status_requires_mapping'))
  assert.equal(fact(d, 'bedrooms'), undefined, 'studio must not be inferred as one bedroom')
})

test('B: a rental four years ago is historical evidence, not current status', () => {
  const d = decide('When the apartment was finished four years ago, it was rented immediately.', [101], [portfolio[0]])
  assert.equal(action(d, Policy.OPERATIONAL_STATUS.RENTED), undefined)
  assert.equal(fact(d, 'historicalPropertyEvent').fieldValue, 'rented')
  assert.equal(Policy.planDirectReply(d, null, {}), null)
})

test('B correction: still available restores only the verified property', () => {
  const d = decide('The apartment is still available.', [101], [portfolio[0]])
  assert.deepEqual(action(d, Policy.OPERATIONAL_STATUS.AVAILABLE).propertyIds, [101])
  assert.equal(fact(d, 'availabilityStatus').correction, true)
  assert.equal(Policy.planDirectReply(d, null, {}), null, 'no removal or congratulatory reply')
})

test('all rented applies only to the verified conversation property set', () => {
  const d = decide('All rented', [101, 102], portfolio.slice(0, 2))
  assert.deepEqual(action(d, Policy.OPERATIONAL_STATUS.RENTED).propertyIds.sort(), [101, 102])
})

test('one beds rented targets one-bedroom units, never the studio', () => {
  const d = decide('One beds rented')
  assert.deepEqual(action(d, Policy.OPERATIONAL_STATUS.RENTED).propertyIds.sort(), [101, 102])
})

test('number three available only resolves the canonical unit number', () => {
  const d = decide('Number three available only')
  assert.deepEqual(action(d, Policy.OPERATIONAL_STATUS.AVAILABLE).propertyIds, [103])
})

test('unit descriptors resolve against the owner portfolio without prior property context', () => {
  const d = decide('The studio on the 4th floor is available', [], portfolio)
  assert.deepEqual(action(d, Policy.OPERATIONAL_STATUS.AVAILABLE).propertyIds, [103])
})

test('an unconstrained status never expands from empty context to the full owner portfolio', () => {
  const d = decide('Rented', [], portfolio)
  assert.equal(action(d, Policy.OPERATIONAL_STATUS.RENTED), undefined)
  assert.ok(d.actions.some(a => a.type === 'HUMAN_REVIEW' && a.reason === 'ambiguous_property_status'))
})

test('tenant moved out is vacancy evidence but not a destructive status guess', () => {
  const d = decide('The tenant moved out')
  assert.equal(fact(d, 'tenancyStatus').fieldValue, 'VACATED')
  assert.equal(action(d, Policy.OPERATIONAL_STATUS.AVAILABLE), undefined)
  assert.ok(d.actions.some(a => a.type === 'HUMAN_REVIEW'))
})

test('available from December is future availability, not current availability', () => {
  const d = decide('Available from December', [103], [portfolio[2]])
  assert.equal(fact(d, 'availabilityFrom').fieldValue, 'december')
  assert.equal(fact(d, 'availabilityFrom').factStatus, Policy.FACT_STATUS.CONDITIONAL)
  assert.equal(action(d, Policy.OPERATIONAL_STATUS.AVAILABLE), undefined)
})

test('refurbishment keeps photos pending and bookability separate', () => {
  const d = decide('Currently being refurbished. New photos will be taken after painting and cleaning.', [103], [portfolio[2]])
  assert.equal(fact(d, 'refurbishmentStatus').fieldValue, 'IN_PROGRESS')
  assert.equal(fact(d, 'photosStatus').fieldValue, 'PENDING')
  assert.equal(fact(d, 'confirmedBookable').fieldValue, false)
  assert.equal(action(d, Policy.OPERATIONAL_STATUS.RENTED), undefined)
})

test('viewing pause does not change property availability', () => {
  const d = decide('Not available for viewings until next week', [103], [portfolio[2]])
  assert.equal(fact(d, 'viewingStatus').fieldValue, Policy.OPERATIONAL_STATUS.VIEWING_PAUSED)
  assert.equal(fact(d, 'viewingsFrom').fieldValue, 'next week')
  assert.equal(d.actions.some(a => a.type === 'PROPERTY_STATUS'), false)
})

test('protected-group preferences are restricted compliance facts, never ordinary matching criteria', () => {
  const d = decide('I do not accept Indians for this apartment', [101], [portfolio[0]])
  const restricted = fact(d, 'restrictedComplianceNote')
  assert.ok(restricted)
  assert.equal(restricted.restricted, true)
  assert.equal(d.complianceReview, true)
  assert.equal(fact(d, 'occupancyRestriction'), undefined)
  assert.equal(d.suppressAutomation, true)
})

test('near-identical replies are recognized after greeting and punctuation changes', () => {
  const { nearDuplicate } = require('../services/responseDedup')
  assert.equal(nearDuplicate(
    "Good afternoon. Thanks for letting me know. I've updated our records and removed the property from our available listings.",
    "Hello, thank you for letting me know - I have updated our records and removed the property from our available listings!",
  ), true)
  assert.equal(nearDuplicate('The property is available.', 'Could you send the photos tomorrow?'), false)
})
