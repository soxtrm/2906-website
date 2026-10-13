'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const pipeline = require('../services/gptPhotoPipeline')

test('vision output cannot reference nonexistent images', () => {
  const audit = pipeline.normaliseAudit({
    hero_candidates: [2, 99, 1, 0],
    photo_recommendations: [{ index: 9, action: 'DELETE' }, { index: 1, action: 'edit', reason: 'dark' }],
    soft_observations: [{ value: 'possible balcony', confidence: .7, evidence_image_index: 1 }],
  }, 3)
  assert.deepEqual(audit.hero_candidates, [2, 1, 0])
  assert.deepEqual(audit.photo_recommendations, [{ index: 1, action: 'EDIT', reason: 'dark' }])
})

test('image response extraction accepts Gemini candidate parts', () => {
  const expected = Buffer.from('edited-image')
  const image = pipeline.responseImage({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: expected.toString('base64') } }] } }] })
  assert.equal(image.mimeType, 'image/png')
  assert.deepEqual(image.buffer, expected)
})

test('edit uses injected provider and returns one final image', async () => {
  const expected = Buffer.from('safe-edit')
  const ai = { models: { generateContent: async request => {
    assert.equal(request.model, pipeline.EDIT_MODEL)
    return { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: expected.toString('base64') } }] } }] }
  } } }
  const result = await pipeline.editOne({ buffer: Buffer.from('source'), mimeType: 'image/jpeg' }, { facts: { bedrooms: 2 } }, { ai })
  assert.deepEqual(result.buffer, expected)
})

test('one edit failure falls back in place without blocking the set', async () => {
  let calls = 0
  const ai = { models: { generateContent: async () => {
    calls += 1
    if (calls === 2) throw new Error('provider unavailable')
    return { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: Buffer.from('edited-one').toString('base64') } }] } }] }
  } } }
  const store = { query: async sql => ({ rows: /INSERT INTO property_photo_processing_runs/.test(sql) ? [{ run_id: '00000000-0000-0000-0000-000000000001' }] : [] }) }
  const result = await pipeline.processImages({
    images: [
      { buffer: Buffer.from('original-one'), mimeType: 'image/jpeg' },
      { buffer: Buffer.from('original-two'), mimeType: 'image/jpeg' },
    ],
    mode: 'pimp', ai, store,
  })
  assert.equal(result.editedCount, 1)
  assert.equal(result.fallbackCount, 1)
  assert.equal(result.items[0].status, 'edited')
  assert.equal(result.items[1].status, 'fallback_original')
  assert.deepEqual(result.items[1].buffer, Buffer.from('original-two'))
})

test('an enhanced input resolves back to its stored original before editing', async () => {
  const original = Buffer.from('original-basis')
  let received
  const ai = { models: { generateContent: async request => {
    received = Buffer.from(request.contents[0].parts[0].inlineData.data, 'base64')
    return { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: Buffer.from('second-edit').toString('base64') } }] } }] }
  } } }
  const store = { query: async (sql) => {
    if (/SELECT source_image_url/.test(sql)) return { rows: [{ source_image_url: 'https://example.test/original.jpg' }] }
    if (/INSERT INTO property_photo_processing_runs/.test(sql)) return { rows: [{ run_id: '00000000-0000-0000-0000-000000000002' }] }
    return { rows: [] }
  } }
  const fetcher = async () => ({ ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => original })
  const result = await pipeline.processImages({ images: [{ buffer: Buffer.from('prior-edit'), mimeType: 'image/jpeg' }], ai, store, fetcher })
  assert.deepEqual(received, original)
  assert.equal(result.items[0].sourceKind, 'GPT_ENHANCED')
})
