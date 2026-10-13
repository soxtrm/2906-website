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

const png = (width, height) => {
  const buffer = Buffer.alloc(33)
  buffer.writeUInt32BE(0x89504e47, 0); buffer.writeUInt32BE(0x0d0a1a0a, 4)
  buffer.writeUInt32BE(13, 8); buffer.write('IHDR', 12, 'ascii')
  buffer.writeUInt32BE(width, 16); buffer.writeUInt32BE(height, 20)
  return buffer
}
const runStore = () => ({ query: async sql => ({ rows: /INSERT INTO property_photo_processing_runs/.test(sql) ? [{ run_id: '00000000-0000-0000-0000-000000000003' }] : [] }) })

test('parallel edits keep the input order even when they finish out of order', async () => {
  let inFlight = 0
  let peak = 0
  const ai = { models: { generateContent: async request => {
    inFlight += 1; peak = Math.max(peak, inFlight)
    const source = Buffer.from(request.contents[0].parts[0].inlineData.data, 'base64').toString()
    await new Promise(resolve => setTimeout(resolve, source.endsWith('0') ? 40 : 5)) // first image is slowest
    inFlight -= 1
    return { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: Buffer.from(`edited-${source}`).toString('base64') } }] } }] }
  } } }
  const images = Array.from({ length: 6 }, (_, i) => ({ buffer: Buffer.from(`source-${i}`), mimeType: 'image/jpeg' }))
  const result = await pipeline.processImages({ images, ai, store: runStore() })
  assert.deepEqual(result.items.map(item => item.buffer.toString()), images.map((_, i) => `edited-source-${i}`))
  assert.deepEqual(result.items.map(item => item.position), [0, 1, 2, 3, 4, 5])
  assert.ok(peak > 1 && peak <= pipeline.EDIT_CONCURRENCY, `bounded concurrency, peak ${peak}`)
})

test('more than ten images: first ten are edited, the rest stay original and are counted', async () => {
  const ai = { models: { generateContent: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: Buffer.from('e').toString('base64') } }] } }] }) } }
  const images = Array.from({ length: 11 }, (_, i) => ({ buffer: Buffer.from(`s${i}`), mimeType: 'image/jpeg' }))
  const result = await pipeline.processImages({ images, ai, store: runStore() })
  assert.equal(result.editedCount, 10)
  assert.equal(result.overLimitCount, 1)
  assert.equal(result.items.length, 11)
  assert.equal(result.items[10].status, 'skipped_limit')
  assert.deepEqual(result.items[10].buffer, Buffer.from('s10'))
})

test('reads PNG and JPEG dimensions from the header', () => {
  assert.deepEqual(pipeline.imageSize(png(1600, 1200)), { width: 1600, height: 1200 })
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x00, 0x04, 0x00, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0x00, 0x00, 0x00, 0x00])
  assert.deepEqual(pipeline.imageSize(jpeg), { width: 1024, height: 768 })
  assert.equal(pipeline.imageSize(Buffer.from('not an image at all, just text')), null)
})

test('an edit that shrinks the photo is kept but flagged for review', async () => {
  const ai = { models: { generateContent: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png(1024, 768).toString('base64') } }] } }] }) } }
  const result = await pipeline.processImages({ images: [{ buffer: png(1600, 1200), mimeType: 'image/png' }], ai, store: runStore() })
  assert.equal(result.items[0].status, 'edited')
  assert.equal(result.items[0].reviewResolution, true)
  assert.equal(result.lowerResolutionCount, 1)
  assert.match(result.items[0].error, /review: edited 1024x768 < original 1600x1200/)
})
