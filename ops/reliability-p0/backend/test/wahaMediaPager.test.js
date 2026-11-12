'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { collectMessagePages, normaliseLimit } = require('../services/wahaMediaPager')

const messages = count => Array.from({ length: count }, (_, index) => ({
  id: `message-${index}`,
  timestamp: 10_000 - index,
  media: { mimetype: 'image/jpeg', url: `https://media/${index}.jpg` },
}))

test('collects every requested message instead of returning only the newest ten', async () => {
  const source = messages(27)
  const calls = []
  const result = await collectMessagePages({
    limit: 27,
    fetchMediaPage: async ({ offset, limit }) => {
      calls.push({ offset, limit })
      return source.slice(offset, offset + limit)
    },
    fetchTextPage: async () => assert.fail('text fallback must not run'),
  })

  assert.deepEqual(calls, [
    { offset: 0, limit: 10 },
    { offset: 10, limit: 10 },
    { offset: 20, limit: 7 },
  ])
  assert.deepEqual(result.map(item => item.id), source.map(item => item.id))
})

test('splits a failing page and retains media from every healthy subrange', async () => {
  const source = messages(20)
  const failures = []
  const result = await collectMessagePages({
    limit: 20,
    fetchMediaPage: async ({ offset, limit }) => {
      if (offset === 10 && limit === 10) throw new Error('bulk page timeout')
      return source.slice(offset, offset + limit)
    },
    fetchTextPage: async () => assert.fail('single-message fallback must not run'),
    onMediaError: failure => failures.push(failure),
  })

  assert.equal(failures.length, 1)
  assert.deepEqual(result.map(item => item.id), source.map(item => item.id))
  assert.ok(result.every(item => item.media?.url))
})

test('falls back only the irretrievable message to text and keeps surrounding images', async () => {
  const source = messages(12)
  const result = await collectMessagePages({
    limit: 12,
    fetchMediaPage: async ({ offset, limit }) => {
      if (offset <= 7 && offset + limit > 7) throw new Error('expired image')
      return source.slice(offset, offset + limit)
    },
    fetchTextPage: async ({ offset }) => [{
      id: source[offset].id,
      timestamp: source[offset].timestamp,
      body: 'caption retained',
    }],
  })

  assert.equal(result.length, 12)
  assert.equal(result[7].id, 'message-7')
  assert.equal(result[7].media, undefined)
  assert.equal(result.filter(item => item.media?.url).length, 11)
})

test('deduplicates an item repeated across a moving page boundary', async () => {
  const source = messages(15)
  const result = await collectMessagePages({
    limit: 15,
    fetchMediaPage: async ({ offset, limit }) => {
      if (offset === 10) return [source[9], ...source.slice(10, 10 + limit - 1)]
      return source.slice(offset, offset + limit)
    },
    fetchTextPage: async () => [],
  })

  assert.equal(new Set(result.map(item => item.id)).size, result.length)
  assert.equal(result.filter(item => item.id === 'message-9').length, 1)
})

test('normalises invalid limits and caps unbounded reads', () => {
  assert.equal(normaliseLimit(undefined), 50)
  assert.equal(normaliseLimit(-1), 50)
  assert.equal(normaliseLimit(27.9), 27)
  assert.equal(normaliseLimit(10_000), 500)
})

// P0 2026-11-12 regression: OLGA UPLOADS. WAHA removes non-content messages after
// paging, so pages come back short although older messages exist. The read stopped
// at the first short page and a 38-photo album lost its description and photos.
test('a short page is not the end of the history: a 38-photo album behind it is read completely', async () => {
  const raw = Array.from({ length: 130 }, (_, index) => ({
    id: `m-${index}`, timestamp: 50_000 - index,
    hidden: index % 9 === 4,                                  // reactions / protocol messages WAHA filters out
    media: index >= 80 && index < 118 ? { mimetype: 'image/jpeg', url: `https://media/${index}.jpg` } : undefined,
    body: index === 79 ? 'Charming 3-bedroom townhouse in Rabat' : '',
  }))
  const result = await collectMessagePages({
    limit: 200,
    fetchMediaPage: async ({ offset, limit }) => raw.slice(offset, offset + limit).filter(m => !m.hidden),
    fetchTextPage: async () => assert.fail('text fallback must not run'),
  })
  assert.equal(result.length, raw.filter(m => !m.hidden).length)
  assert.equal(result.filter(m => m.media?.url).length, raw.filter(m => !m.hidden && m.media).length)
  assert.ok(result.some(m => m.body.includes('Rabat')))
})

test('a page that is empty only because everything in it was filtered does not end the read', async () => {
  const raw = Array.from({ length: 45 }, (_, index) => ({ id: `m-${index}`, timestamp: 9_000 - index, hidden: index >= 10 && index < 20 }))
  const result = await collectMessagePages({
    limit: 100,
    fetchMediaPage: async ({ offset, limit }) => raw.slice(offset, offset + limit).filter(m => !m.hidden),
    fetchTextPage: async () => [],
  })
  assert.equal(result.length, 35)
})
