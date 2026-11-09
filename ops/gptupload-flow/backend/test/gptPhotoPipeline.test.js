'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('module')
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === '@google/genai') return { GoogleGenAI: class GoogleGenAI {} }
  if (request === '../db') return { query: async () => ({ rows: [] }) }
  if (request === '../logger') return { warn() {}, info() {}, error() {} }
  if (request === '../config') return { gemini: {} }
  return originalLoad.call(this, request, parent, isMain)
}
const pipeline = require('../services/gptPhotoPipeline')
Module._load = originalLoad

const png = (width, height, marker = 0) => {
  const buffer = Buffer.alloc(40)
  buffer.writeUInt32BE(0x89504e47, 0); buffer.writeUInt32BE(0x0d0a1a0a, 4)
  buffer.writeUInt32BE(13, 8); buffer.write('IHDR', 12, 'ascii')
  buffer.writeUInt32BE(width, 16); buffer.writeUInt32BE(height, 20)
  buffer.writeUInt32BE(marker, 32)
  return buffer
}
const runStore = () => ({ query: async sql => ({ rows: /INSERT INTO property_photo_processing_runs/.test(sql) ? [{ run_id: '00000000-0000-0000-0000-000000000003' }] : [] }) })

test('vision output cannot reference nonexistent images', () => {
  const audit = pipeline.normaliseAudit({
    hero_candidates: [2, 99, 1, 0],
    photo_recommendations: [{ index: 9, action: 'DELETE' }, { index: 1, action: 'edit', reason: 'dark' }],
    soft_observations: [{ value: 'possible balcony', confidence: .7, evidence_image_index: 1 }],
  }, 3)
  assert.deepEqual(audit.hero_candidates, [2, 1, 0])
  assert.deepEqual(audit.photo_recommendations, [{ index: 1, action: 'EDIT', scene: 'OTHER', reason: 'dark' }])
})

test('image response extraction accepts Gemini candidate parts', () => {
  const expected = png(1600, 1200, 1)
  const image = pipeline.responseImage({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: expected.toString('base64') } }] } }] })
  assert.equal(image.mimeType, 'image/png')
  assert.deepEqual(image.buffer, expected)
})

test('edit uses injected provider and returns one readable transformed image', async () => {
  const expected = png(1600, 1200, 2)
  const ai = { models: { generateContent: async request => {
    assert.equal(request.model, pipeline.EDIT_MODEL)
    return { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: expected.toString('base64') } }] } }] }
  } } }
  const result = await pipeline.editOne({ buffer: png(1600, 1200, 1), mimeType: 'image/png' }, { facts: { bedrooms: 2 }, mode: 'conservative' }, { ai })
  assert.deepEqual(result.buffer, expected)
})

test('provider billing errors are reduced to an actionable non-secret reason', () => {
  const failure = pipeline.classifyProviderFailure(new Error(JSON.stringify({
    error: { code: 402, status: 'RESOURCE_EXHAUSTED', message: 'prepayment credits are depleted' },
  })))
  assert.deepEqual(failure, {
    code: 'provider_billing_blocked',
    terminal: true,
    message: 'image provider billing is unavailable (402); restore provider credits, then retry this run',
  })
})

test('terminal provider failure opens a batch circuit without pretending originals were enhanced', async () => {
  let calls = 0
  const providerError = Object.assign(new Error('Your prepayment credits are depleted'), {
    code: 402,
    status: 'RESOURCE_EXHAUSTED',
  })
  const ai = { models: { generateContent: async () => {
    calls += 1
    throw providerError
  } } }
  const images = Array.from({ length: 7 }, (_, index) => ({ buffer: png(1600, 1200, index), mimeType: 'image/png' }))
  const result = await pipeline.processImages({ images, mode: 'premium', ai, store: runStore() })

  assert.ok(calls > 0 && calls <= pipeline.EDIT_CONCURRENCY, `provider calls bounded by concurrency, got ${calls}`)
  assert.equal(result.editedCount, 0)
  assert.equal(result.failedCount, 7)
  assert.equal(result.status, 'failed')
  assert.equal(result.retryAvailable, true)
  assert.equal(result.providerFailureCode, 'provider_billing_blocked')
  assert.ok(result.items.every(item => item.status === 'failed' && item.buffer === null))
  assert.ok(result.items.every(item => /restore provider credits/.test(item.error)))
})

test('one edit failure is explicit and never falls back to the original as enhanced', async () => {
  let calls = 0
  const ai = { models: { generateContent: async () => {
    calls += 1
    if (calls === 2) throw new Error('provider unavailable')
    return { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png(1600, 1200, 30).toString('base64') } }] } }] }
  } } }
  const result = await pipeline.processImages({
    images: [
      { buffer: png(1600, 1200, 10), mimeType: 'image/png' },
      { buffer: png(1600, 1200, 20), mimeType: 'image/png' },
    ],
    mode: 'premium', ai, store: runStore(),
  })
  assert.equal(result.editedCount, 1)
  assert.equal(result.failedCount, 1)
  assert.equal(result.fallbackCount, 0)
  assert.equal(result.status, 'failed')
  assert.equal(result.retryAvailable, true)
  assert.equal(result.items[0].status, 'quality_checked')
  assert.equal(result.items[1].status, 'failed')
  assert.equal(result.items[1].buffer, null)
})

test('an enhanced input resolves back to its stored original before editing', async () => {
  const original = png(1600, 1200, 11)
  let received
  const ai = { models: { generateContent: async request => {
    received = Buffer.from(request.contents[0].parts[0].inlineData.data, 'base64')
    return { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png(1600, 1200, 12).toString('base64') } }] } }] }
  } } }
  const store = { query: async (sql) => {
    if (/SELECT source_image_url/.test(sql)) return { rows: [{ source_image_url: 'https://example.test/original.jpg' }] }
    if (/INSERT INTO property_photo_processing_runs/.test(sql)) return { rows: [{ run_id: '00000000-0000-0000-0000-000000000002' }] }
    return { rows: [] }
  } }
  const fetcher = async () => ({ ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => original })
  const result = await pipeline.processImages({ images: [{ buffer: png(1600, 1200, 13), mimeType: 'image/png' }], ai, store, fetcher })
  assert.deepEqual(received, original)
  assert.equal(result.items[0].sourceKind, 'GPT_ENHANCED')
})

test('parallel edits keep the input order even when they finish out of order', async () => {
  let inFlight = 0
  let peak = 0
  const ai = { models: { generateContent: async request => {
    inFlight += 1; peak = Math.max(peak, inFlight)
    const source = Buffer.from(request.contents[0].parts[0].inlineData.data, 'base64')
    const marker = source.readUInt32BE(32)
    await new Promise(resolve => setTimeout(resolve, marker === 0 ? 40 : 5))
    inFlight -= 1
    return { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png(1600 + marker, 1200, 100 + marker).toString('base64') } }] } }] }
  } } }
  const images = Array.from({ length: 6 }, (_, i) => ({ buffer: png(1600, 1200, i), mimeType: 'image/png' }))
  const result = await pipeline.processImages({ images, ai, store: runStore() })
  assert.deepEqual(result.items.map(item => item.editedSize.width), images.map((_, i) => 1600 + i))
  assert.deepEqual(result.items.map(item => item.position), [0, 1, 2, 3, 4, 5])
  assert.ok(peak > 1 && peak <= pipeline.EDIT_CONCURRENCY, `bounded concurrency, peak ${peak}`)
})

test('more than ten images: extras require an explicit retry batch', async () => {
  let marker = 100
  const ai = { models: { generateContent: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png(1600, 1200, marker++).toString('base64') } }] } }] }) } }
  const images = Array.from({ length: 11 }, (_, i) => ({ buffer: png(1600, 1200, i), mimeType: 'image/png' }))
  const result = await pipeline.processImages({ images, ai, store: runStore() })
  assert.equal(result.editedCount, 10)
  assert.equal(result.failedCount, 1)
  assert.equal(result.overLimitCount, 1)
  assert.equal(result.items[10].status, 'failed')
  assert.equal(result.items[10].buffer, null)
})

test('reads PNG and JPEG dimensions from the header', () => {
  assert.deepEqual(pipeline.imageSize(png(1600, 1200)), { width: 1600, height: 1200 })
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x00, 0x04, 0x00, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0x00, 0x00, 0x00, 0x00])
  assert.deepEqual(pipeline.imageSize(jpeg), { width: 1024, height: 768 })
  assert.equal(pipeline.imageSize(Buffer.from('not an image at all, just text')), null)
})

test('an edit that shrinks the photo fails quality check and is retryable', async () => {
  const ai = { models: { generateContent: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png(1024, 768, 1).toString('base64') } }] } }] }) } }
  const result = await pipeline.processImages({ images: [{ buffer: png(1600, 1200), mimeType: 'image/png' }], ai, store: runStore() })
  assert.equal(result.items[0].status, 'failed')
  assert.equal(result.items[0].reviewResolution, true)
  assert.equal(result.lowerResolutionCount, 1)
  assert.equal(result.retryAvailable, true)
  assert.match(result.items[0].error, /quality check failed: edited 1024x768 < original 1600x1200/)
})

test('conservative and premium presets are distinct and preserve unfinished construction', () => {
  const conservative = pipeline.editPrompt('conservative', { facts: { property_type: 'Apartment' } })
  const premium = pipeline.editPrompt('premium', { facts: { property_type: 'Apartment' } })
  assert.notEqual(conservative, premium)
  assert.match(conservative, /no decorative additions/i)
  assert.match(premium, /visibly refined/i)
  assert.match(premium, /unfinished construction state/i)
  assert.match(premium, /never change or invent walls, windows, doors, floor plan, room size/i)
})

test('empty, unreadable and unchanged provider output is rejected', () => {
  const source = { buffer: png(1600, 1200, 1), mimeType: 'image/png' }
  assert.equal(pipeline.validateGeneratedImage(source, null).ok, false)
  assert.equal(pipeline.validateGeneratedImage(source, { buffer: Buffer.from('not-image'), mimeType: 'image/png' }).ok, false)
  assert.equal(pipeline.validateGeneratedImage(source, { buffer: source.buffer, mimeType: 'image/png' }).ok, false)
})

test('successful persistence records Saved and Ready stages with side-by-side URLs', async () => {
  const calls = []
  const store = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] } } }
  const source = png(1600, 1200, 1)
  const edited = png(1600, 1200, 2)
  const result = {
    runId: '00000000-0000-0000-0000-000000000010', mode: 'premium', preset: pipeline.PRESETS.premium,
    items: [{ position: 0, sourceSha256: pipeline.sha256(source), editedSha256: pipeline.sha256(edited), sourceKind: 'ORIGINAL', status: 'quality_checked', error: null }],
    audit: null, editedCount: 1, failedCount: 0, models: { edit: pipeline.EDIT_MODEL },
  }
  const persisted = await pipeline.persistResult({
    result, propertyId: 2906, store,
    uploaded: [{ position: 0, sourceUrl: 'https://media.test/original.png', editedUrl: 'https://media.test/plus.png' }],
  })
  assert.deepEqual(persisted, { runId: result.runId, status: 'ready', savedCount: 1, retryAvailable: false })
  const editInsert = calls.find(call => /INSERT INTO property_photo_edits/.test(call.sql))
  assert.equal(editInsert.params[5], 'https://media.test/original.png')
  assert.equal(editInsert.params[6], 'https://media.test/plus.png')
  const stages = calls.filter(call => /INSERT INTO property_photo_processing_events/.test(call.sql)).map(call => call.params[1])
  assert.deepEqual(stages, ['saved', 'ready'])
})

test('restart reuses a verified generated checkpoint instead of paying twice', async () => {
  const runId = '00000000-0000-0000-0000-000000000020'
  const source = png(1600, 1200, 1)
  const edited = png(1600, 1200, 2)
  let inserted = false
  let checkpointRow = null
  const store = { query: async (sql, params) => {
    if (/INSERT INTO property_photo_processing_runs/.test(sql)) {
      if (!inserted) { inserted = true; return { rows: [{ run_id: runId }] } }
      return { rows: [] }
    }
    if (/SELECT run_id FROM property_photo_processing_runs/.test(sql)) return { rows: [{ run_id: runId }] }
    if (/INSERT INTO property_photo_edits/.test(sql) && /property_id/.test(sql)) {
      checkpointRow = { position: params[1], source_sha256: params[2], edited_sha256: params[3], edited_image_url: params[4] }
      return { rows: [] }
    }
    if (/SELECT position, source_sha256, edited_image_url/.test(sql)) return { rows: checkpointRow ? [checkpointRow] : [] }
    return { rows: [] }
  } }
  let providerCalls = 0
  const ai = { models: { generateContent: async () => {
    providerCalls += 1
    return { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: edited.toString('base64') } }] } }] }
  } } }
  const uploader = async () => 'https://media.test/checkpoint.png'
  const fetcher = async () => ({ ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => edited })
  await pipeline.processImages({ images: [{ buffer: source, mimeType: 'image/png' }], mode: 'premium', triggerId: 'same-event', ai, store, uploader, fetcher })
  const resumed = await pipeline.processImages({ images: [{ buffer: source, mimeType: 'image/png' }], mode: 'premium', triggerId: 'same-event', ai, store, uploader, fetcher })
  assert.equal(providerCalls, 1)
  assert.equal(resumed.resumedCount, 1)
  assert.equal(resumed.items[0].resumed, true)
})

test('manual retry uses the retained original and preserves its gallery position', async () => {
  const parentRunId = '00000000-0000-0000-0000-000000000030'
  const retryRunId = '00000000-0000-0000-0000-000000000031'
  const source = png(1600, 1200, 3)
  const edited = png(1600, 1200, 4)
  const store = { query: async (sql) => {
    if (/JOIN properties p/.test(sql)) return { rows: [{ run_id: parentRunId, property_id: 55, mode: 'premium', status: 'failed', retry_available: true, property_type: 'Apartment', town: 'Sliema', bedrooms: 2, bathrooms: 1 }] }
    if (/SELECT position, source_image_url FROM property_photo_edits/.test(sql)) return { rows: [{ position: 4, source_image_url: 'https://media.test/original-4.png' }] }
    if (/INSERT INTO property_photo_processing_runs/.test(sql)) return { rows: [{ run_id: retryRunId }] }
    if (/SELECT source_image_url FROM property_photo_edits/.test(sql)) return { rows: [] }
    return { rows: [] }
  } }
  const fetcher = async () => ({ ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => source })
  const uploader = async () => 'https://media.test/retried-4.png'
  const ai = { models: { generateContent: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: edited.toString('base64') } }] } }] }) } }
  const retried = await pipeline.retryRun({ runId: parentRunId, store, fetcher, uploader, ai })
  assert.equal(retried.propertyId, 55)
  assert.equal(retried.persisted.status, 'ready')
  assert.deepEqual(retried.replacements, [{ position: 4, editedUrl: 'https://media.test/retried-4.png' }])
})
