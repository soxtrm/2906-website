'use strict'

// Optional photo-preparation stage for !gptupload / !gptuploadv.  It does not
// publish anything and it never owns a property record.  Callers pass its
// ordered buffers to the existing !upload path, then persist the resulting
// source/final URL mapping once that path has created or selected a property.

const crypto = require('crypto')
const { GoogleGenAI } = require('@google/genai')
const db = require('../db')
const log = require('../logger')
const config = require('../config')

const MAX_EDIT_IMAGES = 10
const EDIT_MODEL = process.env.GPTUPLOAD_IMAGE_MODEL || 'gemini-3.1-flash-image'
const VISION_MODEL = process.env.GPTUPLOAD_VISION_MODEL || 'gemini-2.5-flash'
const EDIT_TIMEOUT_MS = Number(process.env.GPTUPLOAD_IMAGE_TIMEOUT_MS || 120000)
const VISION_TIMEOUT_MS = Number(process.env.GPTUPLOAD_VISION_TIMEOUT_MS || 90000)
// Edits run a few at a time: sequential took up to 10 × EDIT_TIMEOUT_MS, all
// at once would hammer the provider and hold ten decoded images in memory.
const EDIT_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.GPTUPLOAD_CONCURRENCY || 3)))
// An edit whose long edge falls below this share of the original is kept but
// flagged for review — the model may return a smaller frame than WhatsApp sent.
const MIN_RESOLUTION_RATIO = 0.8

const apiKey = () => process.env.GEMINI_API_KEY || config?.gemini?.apiKey || null
const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex')
const runId = () => crypto.randomUUID()
function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// Width/height from the image header (PNG, JPEG, WebP) without a decoder.
// Returns null for anything it cannot read; callers treat that as unknown.
function imageSize(buffer) {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length < 30) return null
    if (buffer.readUInt32BE(0) === 0x89504e47) return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
      const chunk = buffer.toString('ascii', 12, 16)
      if (chunk === 'VP8X') return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) }
      if (chunk === 'VP8 ') return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
      if (chunk === 'VP8L') { const bits = buffer.readUInt32LE(21); return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 } }
      return null
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
      let offset = 2
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) { offset += 1; continue }
        const marker = buffer[offset + 1]
        const length = buffer.readUInt16BE(offset + 2)
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) }
        }
        offset += 2 + length
      }
    }
  } catch { /* unreadable header */ }
  return null
}

function lowerResolution(source, edited) {
  if (!source || !edited) return false
  return Math.max(edited.width, edited.height) < MIN_RESOLUTION_RATIO * Math.max(source.width, source.height)
}

/** Runs fn over items with at most `limit` in flight; results keep input order. */
async function mapLimited(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await fn(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function jsonText(response) {
  const raw = String(response?.text || '').replace(/^```json\s*/i, '').replace(/```\s*$/g, '').trim()
  return JSON.parse(raw)
}

function responseImage(response) {
  const parts = response?.candidates?.[0]?.content?.parts || response?.parts || []
  const part = parts.find(candidate => candidate?.inlineData?.data)
  if (!part) return null
  return {
    buffer: Buffer.from(part.inlineData.data, 'base64'),
    mimeType: part.inlineData.mimeType || 'image/png',
  }
}

function normaliseAudit(value, count) {
  const audit = value && typeof value === 'object' ? value : {}
  const valid = index => Number.isInteger(Number(index)) && Number(index) >= 0 && Number(index) < count
  const hero = (Array.isArray(audit.hero_candidates) ? audit.hero_candidates : []).map(Number).filter(valid).slice(0, 3)
  const recommendations = (Array.isArray(audit.photo_recommendations) ? audit.photo_recommendations : [])
    .filter(item => valid(item?.index))
    .map(item => ({ index: Number(item.index), action: String(item.action || 'REVIEW').toUpperCase(), reason: String(item.reason || '').slice(0, 240) }))
  return {
    coverage: Array.isArray(audit.coverage) ? audit.coverage : [],
    likely_missing: Array.isArray(audit.likely_missing) ? audit.likely_missing : [],
    photo_recommendations: recommendations,
    hero_candidates: hero,
    soft_observations: Array.isArray(audit.soft_observations) ? audit.soft_observations : [],
    summary: String(audit.summary || '').slice(0, 1200),
  }
}

function factsForPrompt(facts = {}) {
  return {
    property_type: facts.type || facts.property_type || null,
    town: facts.location || facts.town || null,
    bedrooms: Number(facts.beds ?? facts.bedrooms) || null,
    bathrooms: Number(facts.baths ?? facts.bathrooms) || null,
    features: Array.isArray(facts.features) ? facts.features.slice(0, 30) : [],
  }
}

async function auditImages(images, facts, { ai } = {}) {
  if (!images.length || (!apiKey() && !ai)) return null
  const client = ai || new GoogleGenAI({ apiKey: apiKey() })
  const parts = images.slice(0, MAX_EDIT_IMAGES).map((image, index) => ({
    inlineData: { mimeType: image.mimeType || 'image/jpeg', data: image.buffer.toString('base64') },
  }))
  parts.push({ text: `Internally audit this ordered property photo set (indices start at 0). Known structured facts: ${JSON.stringify(factsForPrompt(facts))}.
Do not infer that a room or amenity does not exist merely because it is unseen. Do not infer protected characteristics. Similar rooms may be distinct; use confidence.
Return JSON only with:
{"coverage":[{"label":"living room","state":"PHOTOGRAPHED|LIKELY_PHOTOGRAPHED|NOT_SEEN|UNKNOWN","confidence":0.0,"evidence_indices":[0]}],"likely_missing":[{"label":"Bedroom 3","state":"NOT_SEEN|UNKNOWN","reason":"..."}],"photo_recommendations":[{"index":0,"action":"USE|EDIT|LOW_PRIORITY|DUPLICATE|REVIEW","reason":"..."}],"hero_candidates":[0,1,2],"soft_observations":[{"value":"possible balcony","confidence":0.0,"evidence_image_index":0}],"summary":"short internal summary"}` })
  try {
    const response = await withTimeout(client.models.generateContent({
      model: VISION_MODEL,
      contents: [{ role: 'user', parts }],
      config: { responseMimeType: 'application/json', temperature: 0.1 },
    }), VISION_TIMEOUT_MS, 'vision audit')
    return normaliseAudit(jsonText(response), Math.min(images.length, MAX_EDIT_IMAGES))
  } catch (error) {
    log.warn('gptPhotoPipeline: vision audit failed; continuing', { err: error.message })
    return null
  }
}

async function editOne(image, context, { ai } = {}) {
  const client = ai || new GoogleGenAI({ apiKey: apiKey() })
  const prompt = `Edit this real-estate photograph using the REAL ESTATE CLEAN / PREMIUM profile.
Preserve the exact property: walls, dimensions, doors, windows, view, floors, kitchen architecture, permanent furniture identity and all real amenities. Never invent a balcony, pool, garage, terrace, sea view, room or architectural feature. Never hide a permanent defect in a way that misrepresents condition.
Only improve exposure, neutral white balance, realistic daylight, shadows/highlights, colour, subtle perspective/lens correction and crop. Remove only clearly temporary clutter. Any styling must be minor, plausible and consistent with the same property. Avoid HDR, orange cast, fake sunset, extreme wide angle and redesign.
Property context: ${JSON.stringify(factsForPrompt(context.facts))}. Set context: ${String(context.auditSummary || 'same property across all images').slice(0, 600)}.
Return one edited image and no prose.`
  const response = await withTimeout(client.models.generateContent({
    model: EDIT_MODEL,
    contents: [{ role: 'user', parts: [
      { inlineData: { mimeType: image.mimeType || 'image/jpeg', data: image.buffer.toString('base64') } },
      { text: prompt },
    ] }],
    config: { responseModalities: ['IMAGE'] },
  }), EDIT_TIMEOUT_MS, 'photo edit')
  const result = responseImage(response)
  if (!result?.buffer?.length) throw new Error('image model returned no image')
  return result
}

async function safeQuery(sql, params, store = db) {
  try { return await store.query(sql, params) }
  catch (error) {
    // Migration absence must not block the canonical upload path.
    log.warn('gptPhotoPipeline: audit persistence unavailable', { err: error.message })
    return { rows: [] }
  }
}

async function recoverOriginal(image, { store = db, fetcher = fetch } = {}) {
  if (image.sourceKind === 'MANUALLY_EDITED') {
    return { ...image, sourceKind: 'MANUALLY_EDITED', sourceSha256: sha256(image.buffer) }
  }
  const incomingHash = sha256(image.buffer)
  const found = await safeQuery(
    `SELECT source_image_url FROM property_photo_edits WHERE edited_sha256=$1 AND source_image_url IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
    [incomingHash], store)
  const sourceUrl = found.rows[0]?.source_image_url
  if (!sourceUrl) return { ...image, sourceKind: 'ORIGINAL', sourceSha256: incomingHash }
  try {
    const response = await fetcher(sourceUrl, { signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined })
    if (!response.ok) throw new Error(`source fetch ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    return { buffer, mimeType: response.headers.get('content-type') || image.mimeType, sourceKind: 'GPT_ENHANCED', sourceSha256: sha256(buffer), incomingSha256: incomingHash }
  } catch (error) {
    log.warn('gptPhotoPipeline: original recovery failed; current input retained', { err: error.message })
    return { ...image, sourceKind: 'GPT_ENHANCED', sourceSha256: incomingHash }
  }
}

async function processImages({ images = [], facts = {}, mode = 'pimp', triggerId = null, source = 'whatsapp', onProgress = null, ai = null, store = db, fetcher = fetch } = {}) {
  let id = runId()
  const limited = images.slice(0, MAX_EDIT_IMAGES)
  const untouched = images.slice(MAX_EDIT_IMAGES)
  const inserted = await safeQuery(
    `INSERT INTO property_photo_processing_runs (run_id, trigger_id, source, mode, status, source_count, edit_model, vision_model, created_at)
     VALUES ($1,$2,$3,$4,'processing',$5,$6,$7,NOW()) ON CONFLICT (trigger_id) WHERE trigger_id IS NOT NULL DO NOTHING RETURNING run_id`,
    [id, triggerId, source, mode, images.length, EDIT_MODEL, mode === 'vision' ? VISION_MODEL : null], store)
  if (!inserted.rows.length && triggerId) {
    const existing = await safeQuery(`SELECT run_id FROM property_photo_processing_runs WHERE trigger_id=$1 LIMIT 1`, [triggerId], store)
    if (existing.rows[0]?.run_id) id = existing.rows[0].run_id
  }

  const bases = []
  for (const image of limited) bases.push(await recoverOriginal(image, { store, fetcher }))
  const audit = mode === 'vision' ? await auditImages(bases, facts, { ai }) : null
  let editedCount = 0
  let fallbackCount = 0
  let lowerResolutionCount = 0
  let completed = 0
  const keyPresent = !!apiKey() || !!ai
  // Bounded parallel edits; every item is written to its own index, so the
  // final order is the input order no matter which edit finishes first.
  const items = await mapLimited(bases, EDIT_CONCURRENCY, async (sourceImage, index) => {
    let output = { buffer: sourceImage.buffer, mimeType: sourceImage.mimeType }
    let status = 'fallback_original'
    let error = null
    if (keyPresent) {
      try {
        output = await editOne(sourceImage, { facts, auditSummary: audit?.summary }, { ai })
        status = 'edited'
        editedCount += 1
      } catch (caught) {
        error = String(caught.message || caught).slice(0, 500)
        fallbackCount += 1
        log.warn('gptPhotoPipeline: image edit failed; using original', { index, err: error })
      }
    } else {
      error = 'image editing key unavailable'
      fallbackCount += 1
    }
    const sourceSize = imageSize(sourceImage.buffer)
    const editedSize = status === 'edited' ? imageSize(output.buffer) : null
    const reviewResolution = status === 'edited' && lowerResolution(sourceSize, editedSize)
    if (reviewResolution) {
      lowerResolutionCount += 1
      log.warn('gptPhotoPipeline: edited image is lower resolution than its original', { index, sourceSize, editedSize })
    }
    completed += 1
    if (onProgress) await onProgress({ complete: completed, total: bases.length, edited: editedCount, fallback: fallbackCount })
    return {
      position: index,
      sourceBuffer: sourceImage.buffer,
      sourceMimeType: sourceImage.mimeType,
      sourceSha256: sourceImage.sourceSha256 || sha256(sourceImage.buffer),
      sourceKind: sourceImage.sourceKind || 'ORIGINAL',
      buffer: output.buffer,
      mimeType: output.mimeType,
      editedSha256: status === 'edited' ? sha256(output.buffer) : null,
      status,
      error: error || (reviewResolution ? `review: edited ${editedSize.width}x${editedSize.height} < original ${sourceSize.width}x${sourceSize.height}` : null),
      sourceSize,
      editedSize,
      reviewResolution,
    }
  })
  for (let i = 0; i < untouched.length; i += 1) {
    const image = untouched[i]
    items.push({ position: MAX_EDIT_IMAGES + i, sourceBuffer: image.buffer, sourceMimeType: image.mimeType, sourceSha256: sha256(image.buffer), sourceKind: 'ORIGINAL', buffer: image.buffer, mimeType: image.mimeType, editedSha256: null, status: 'skipped_limit', error: null })
  }
  await safeQuery(
    `UPDATE property_photo_processing_runs SET status='processed', edited_count=$2, fallback_count=$3, audit=$4::jsonb, completed_at=NOW() WHERE run_id=$1`,
    [id, editedCount, fallbackCount, JSON.stringify(audit || {})], store)
  return { runId: id, mode, items, audit, editedCount, fallbackCount, lowerResolutionCount, overLimitCount: untouched.length, sourceCount: images.length, models: { edit: EDIT_MODEL, vision: mode === 'vision' ? VISION_MODEL : null } }
}

async function persistResult({ result, propertyId, uploaded }) {
  if (!result) return
  await safeQuery(`UPDATE property_photo_processing_runs SET property_id=$2, status='completed', completed_at=NOW() WHERE run_id=$1`, [result.runId, propertyId])
  for (const row of uploaded) {
    const item = result.items[row.position]
    if (!item) continue
    await safeQuery(
      `INSERT INTO property_photo_edits
       (run_id, property_id, position, source_image_id, edited_image_id, source_image_url, edited_image_url,
        source_sha256, edited_sha256, source_kind, edit_type, model_version, status, error, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'REAL_ESTATE_CLEAN_PREMIUM',$11,$12,$13,NOW())
       ON CONFLICT (run_id, position) DO UPDATE SET property_id=EXCLUDED.property_id, source_image_url=EXCLUDED.source_image_url,
       edited_image_url=EXCLUDED.edited_image_url, status=EXCLUDED.status, error=EXCLUDED.error`,
      [result.runId, propertyId, row.position, item.sourceSha256, item.editedSha256, row.sourceUrl, row.editedUrl,
        item.sourceSha256, item.editedSha256, item.sourceKind, result.models.edit, item.status, item.error])
  }
  for (const observation of result.audit?.soft_observations || []) {
    const confidence = Number(observation.confidence)
    if (!observation.value || !Number.isFinite(confidence)) continue
    await safeQuery(
      `INSERT INTO property_photo_vision_observations (property_id, run_id, value, confidence, source, evidence_image_position, observed_at)
       VALUES ($1,$2,$3,$4,'IMAGE_VISION',$5,NOW())`,
      [propertyId, result.runId, String(observation.value).slice(0, 300), Math.max(0, Math.min(1, confidence)), Number(observation.evidence_image_index) || 0])
  }
}

module.exports = {
  MAX_EDIT_IMAGES, EDIT_MODEL, VISION_MODEL, EDIT_CONCURRENCY, sha256, normaliseAudit, imageSize, mapLimited,
  auditImages, editOne, processImages, persistResult, responseImage,
}
