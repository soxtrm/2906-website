// node --test lib/owner/argus-sync.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { intakePayload } from './argus-sync.ts'

const base = { owner: { name: 'Test Owner', phone: '+35600000000' }, propertyType: 'Penthouse', town: 'Swieqi', address: '', bedrooms: 2, bathrooms: 1, furnished: 'Furnished', features: ['AC'], description: 'Nice', photos: [] }

test('a home with long let and sale goes to ARGUS as "Both" with both prices', () => {
  const p = intakePayload({ ...base, offers: [{ mode: 'long_let', price: 2200, terms: { minMonths: 12 } }, { mode: 'sale', price: 650000 }] }, [])
  assert.equal(p.listing_type, 'Both'); assert.equal(p.price_rent, 2200); assert.equal(p.price_sale, 650000)
  assert.match(p.notes, /Long let €2200\/month \(12\+ months\); For sale €650000/)
})
test('the intake rules are met: name, phone, location, 30+ character description, known furniture value', () => {
  const p = intakePayload({ ...base, offers: [{ mode: 'winter_let', price: 1400 }] }, [])
  assert.equal(p.listing_type, 'For Rent'); assert.ok(p.description.length >= 30); assert.equal(p.furnished, 'Fully Furnished')
  assert.ok(p.owner_name && p.owner_phone && p.location && p.property_type)
})
