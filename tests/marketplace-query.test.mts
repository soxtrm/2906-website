// node --experimental-strip-types tests/marketplace-query.test.mts
import assert from 'node:assert/strict'
import { understand } from '../lib/marketplace/query.ts'

const ctx = {
  areas: ['Sliema', "St Julian's", 'St Paul’s Bay', 'Gzira', 'Swieqi', 'Valletta', 'Marsaskala', 'Ta’ Xbiex'],
  types: ['apartment', 'penthouse', 'maisonette', 'house', 'villa'],
  features: [
    { key: 'sea_view', label: 'Sea view', aliases: ['Meerblick', 'vista mare', 'seaview'] },
    { key: 'air_conditioning', label: 'Air conditioning', aliases: ['aircon', 'AC', 'Klimaanlage'] },
    { key: 'lift', label: 'Lift', aliases: ['elevator', 'Aufzug'] },
    { key: 'balconies', label: 'Balcony', aliases: ['balconies', 'Balkon'] },
    { key: 'pool', label: 'Pool', aliases: ['swimming pool', 'Schwimmbad'] },
  ],
  agencyKeys: ['2906'],
}
const t = (q: string) => understand(q, ctx)

let r = t('2 bed sliema sea view under 1500')
assert.equal(r.beds, '2'); assert.equal(r.area, 'Sliema'); assert.deepEqual(r.feat, ['sea_view']); assert.equal(r.max, '1500'); assert.equal(r.rest, '')
r = t('Penthouse in St Julians with pool 2k-3k')
assert.equal(r.type, 'penthouse'); assert.equal(r.area, "St Julian's"); assert.deepEqual(r.feat, ['pool']); assert.equal(r.min, '2000'); assert.equal(r.max, '3000')
r = t('Wohnung mit Balkon und Aufzug, Gzira, bis 1200')
assert.equal(r.type, 'apartment'); assert.equal(r.area, 'Gzira'); assert.deepEqual(r.feat.sort(), ['balconies', 'lift']); assert.equal(r.max, '1200')
r = t('2906-1234')
assert.equal(r.rest, '2906-1234'); assert.equal(r.min, undefined); assert.equal(r.max, undefined)
r = t('1200-1500 swieqi aircon')
assert.equal(r.min, '1200'); assert.equal(r.max, '1500'); assert.equal(r.area, 'Swieqi'); assert.deepEqual(r.feat, ['air_conditioning'])
r = t('3 bedrooms available now from 900')
assert.equal(r.beds, '3'); assert.equal(r.now, true); assert.equal(r.min, '900')
r = t('ta xbiex')
assert.equal(r.area, 'Ta’ Xbiex')
r = t('quiet street')
assert.equal(r.rest, 'quiet street'); assert.deepEqual(r.feat, [])
r = t('')
assert.equal(r.rest, '')
console.log('marketplace query: all assertions passed')
