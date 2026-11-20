// node --test lib/owner/wishes.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractWishes, mergeWishes, wishesFor, type Wish } from './wishes.ts'

const keys = (t: string) => extractWishes(t).wishes.map(w => `${w.polarity === 'plus' ? '+' : '-'}${w.key}`).sort()

test('plus and minus from plain owner sentences', () => {
  assert.deepEqual(keys("I'm looking for a couple, no pets please"), ['+couple', '-pets'])
  assert.deepEqual(keys('Working professionals only. Non-smokers.'), ['+professionals', '-smoking'])
  assert.deepEqual(keys("I don't want students or sharers"), ['-sharers', '-students'])
  assert.deepEqual(keys('Small dogs are fine, long term preferred'), ['+long_stay', '+pets'])
  assert.deepEqual(keys('Families with kids are welcome'), ['+children', '+family'])
})

test('nationality and similar are never recorded, the rest of the sentence still is', () => {
  const a = extractWishes("I'm looking for a European couple")
  assert.equal(a.protectedRemark, true)
  assert.deepEqual(a.wishes.map(w => w.key), ['couple'])
  assert.ok(!a.wishes.some(w => /europe/i.test(w.label)))
  const b = extractWishes('No Pakistanis')
  assert.equal(b.protectedRemark, true)
  assert.deepEqual(b.wishes, [])
  assert.equal(extractWishes('No pets, quiet couple').protectedRemark, false)
})

const w = (key: string, polarity: 'plus' | 'minus', propertyId: number | null, label = key): Wish =>
  ({ id: `${key}${propertyId}${polarity}`, key, polarity, label, propertyId, quote: label, at: '2026-11-19T10:00' })

test('a wish said on three properties becomes a wish for all of them', () => {
  const list = [w('pets', 'minus', 1), w('pets', 'minus', 2), w('couple', 'plus', 1)]
  assert.equal(wishesFor(list, [1, 2, 3, 4], 4).length, 0, 'two properties are not enough')
  const more = mergeWishes(list, [w('pets', 'minus', 3)])
  const v = wishesFor(more, [1, 2, 3, 4], 4)
  assert.deepEqual(v.map(x => [x.key, x.scope]), [['pets', 'all']])
  assert.deepEqual(wishesFor(more, [1, 2, 3, 4], 1).map(x => x.key).sort(), ['couple', 'pets'])
})

test('a newer statement replaces the older one on the same property; the property beats the general rule', () => {
  const list = mergeWishes([w('pets', 'minus', 1)], [w('pets', 'plus', 1, 'Pets welcome')])
  assert.deepEqual(list.map(x => x.polarity), ['plus'])
  const mix = [w('pets', 'minus', null), w('pets', 'plus', 2, 'Pets welcome')]
  assert.equal(wishesFor(mix, [1, 2], 2)[0].polarity, 'plus')
  assert.equal(wishesFor(mix, [1, 2], 1)[0].polarity, 'minus')
})
