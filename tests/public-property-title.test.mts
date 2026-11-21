// node --experimental-strip-types tests/public-property-title.test.mts
import assert from 'node:assert/strict'
import { publicPropertyTitle, publicPropertyHeadline, publicPriceLabel, publicPropertyDescription, publicShareImage, titleCase } from '../lib/public-property-title.ts'

// the live example Kev named (2906.estate/property/2-200-2-bedrooms-2-bathrooms-mw3wdsej)
const swieqi = {
  title: 'Swieqi | €2,027 | 2 Bedrooms - 2 Bathrooms', propertyType: 'penthouse', location: 'Swieqi', bedrooms: 2, category: 'letting',
  price: '2027', priceAfter: 'per month', priceType: 'month',
  fullDescription: 'MODERN PENTHOUSE – SWIEQI\n\nSwieqi\n€2,027/month\n\n2 Bedrooms - 2 Bathrooms - Stylish Penthouse\n\nA beautiful modern penthouse in sought-after Swieqi, offering stylish furnishings, quality finishes and a fantastic central location close to everyday amenities.',
  images: ['https://res.cloudinary.com/du2jwqnbs/image/upload/v1793904425/2906-properties/js8xoeko3yld3xqtqflh.jpg'],
}
assert.equal(publicPropertyTitle(swieqi), '2-Bedroom Penthouse in Swieqi')
assert.equal(publicPropertyHeadline(swieqi), null, 'place/price/rooms only: no extra headline')
assert.equal(publicPriceLabel(swieqi), '€2,027/month')
const d = publicPropertyDescription(swieqi)
assert.ok(d.startsWith('A beautiful modern penthouse in sought-after Swieqi'), d)
assert.ok(d.length <= 160, String(d.length))
assert.equal(publicShareImage(swieqi), 'https://res.cloudinary.com/du2jwqnbs/image/upload/c_fill,g_auto,w_1200,h_630,q_auto,f_jpg/v1793904425/2906-properties/js8xoeko3yld3xqtqflh.jpg')

// never a "Selected …" placeholder, Title Case everywhere
assert.equal(publicPropertyTitle({ propertyType: 'apartment', bedrooms: 3 }), '3-Bedroom Apartment in Malta')
assert.equal(publicPropertyTitle({ propertyType: 'APARTMENT', bedrooms: 1, location: "st julian's" }), "1-Bedroom Apartment in St Julian's")
assert.equal(publicPropertyTitle({ propertyType: 'studio', bedrooms: 1, location: 'Gzira' }), 'Studio in Gzira')
assert.equal(publicPropertyTitle({ propertyType: 'ground_floor_maisonette', bedrooms: 2, location: 'Mellieha' }), '2-Bedroom Ground Floor Maisonette in Mellieha')
assert.equal(publicPropertyTitle({ propertyType: 'office', bedrooms: 3, location: 'Msida', category: 'commercial' }), 'Office in Msida')
assert.equal(publicPropertyTitle({ propertyType: '', location: 'Sliema' }), 'Home in Sliema')
assert.equal(publicPropertyTitle({ category: 'commercial', location: 'Qormi' }), 'Commercial Property in Qormi')
for (const p of [{}, { propertyType: 'villa' }, { location: '' }]) assert.ok(!/selected/i.test(publicPropertyTitle(p)))

// a real marketing headline survives, in Title Case
assert.equal(publicPropertyHeadline({ title: 'Sliema | seafront penthouse with pool | €3,500', location: 'Sliema' }), 'Seafront Penthouse with Pool')
assert.equal(titleCase('two-storey town house'), 'Two-Storey Town House')
assert.equal(titleCase('3 BEDROOMS'), '3 Bedrooms')
assert.equal(titleCase('BBQ area with AC'), 'BBQ Area with AC')

// no description: a clean sentence, not empty
assert.equal(publicPropertyDescription({ propertyType: 'villa', bedrooms: 4, location: 'Madliena', price: 6500, priceType: 'month' }), '4-Bedroom Villa in Madliena, €6,500/month. A home listed by 2906 Real Estate Malta.')
assert.equal(publicShareImage({ images: [] }), null)
assert.equal(publicShareImage({ images: ['https://res.cloudinary.com/du2jwqnbs/image/upload/w_720,q_auto,f_auto,c_limit/v1793904425/2906-properties/js8xoeko3yld3xqtqflh.jpg'] }), 'https://res.cloudinary.com/du2jwqnbs/image/upload/c_fill,g_auto,w_1200,h_630,q_auto,f_jpg/v1793904425/2906-properties/js8xoeko3yld3xqtqflh.jpg', 'existing transformations are replaced, not chained')
console.log('public-property-title: all assertions passed')
