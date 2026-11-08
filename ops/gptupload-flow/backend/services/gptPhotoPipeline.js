'use strict'

// Optional photo-preparation stage for !gptupload / !plusupload / !gptuploadv. It does not
// publish anything and it never owns a property record.  Callers pass its
// ordered buffers to the existing !upload path, then persist the resulting
// source/final URL mapping once that path has created or selected a property.

const crypto = require('crypto')
const { GoogleGenAI } = require('@google/genai')
const db = require('../db')
const log = require('../logger')
const config = require('../config')

const MAX_EDIT_IMAGES = 10
const MAX_AUDIT_IMAGES = 30
const EDIT_MODEL = process.env.GPTUPLOAD_IMAGE_MODEL || 'gemini-3.1-flash-image'
const PLUS_EDIT_MODEL = process.env.PLUSUPLOAD_IMAGE_MODEL || EDIT_MODEL
const PLUS_IMAGE_SIZE = ['1K', '2K', '4K'].includes(String(process.env.PLUSUPLOAD_IMAGE_SIZE || '').toUpperCase())
  ? String(process.env.PLUSUPLOAD_IMAGE_SIZE).toUpperCase()
  : '2K'
const VISION_MODEL = process.env.GPTUPLOAD_VISION_MODEL || 'gemini-2.5-flash'
const EDIT_TIMEOUT_MS = Number(process.env.GPTUPLOAD_IMAGE_TIMEOUT_MS || 120000)
const VISION_TIMEOUT_MS = Number(process.env.GPTUPLOAD_VISION_TIMEOUT_MS || 90000)
// Edits run a few at a time: sequential took up to 10 × EDIT_TIMEOUT_MS, all
// at once would hammer the provider and hold ten decoded images in memory.
const EDIT_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.GPTUPLOAD_CONCURRENCY || 3)))
// An edit whose long edge falls below this share of the original is kept but
// flagged for review — the model may return a smaller frame than WhatsApp sent.
const MIN_RESOLUTION_RATIO = 0.8

const PRESETS = Object.freeze({
  conservative: Object.freeze({
    key: 'conservative',
    editType: 'CONSERVATIVE_ENHANCEMENT',
    label: 'GPT conservative enhancement',
    prompt: `Edit this real-estate photograph using a conservative clean-listing profile. Preserve the photograph and room exactly. Improve exposure, brightness, crisp detail, resolution appearance, neutral natural white balance and mild warmth. Correct only subtle lens and perspective distortion. Keep every wall, window, doorway, floor, fixture, furniture item, view and material recognizable and in the same position. Make no decorative additions and do not remove permanent or material condition details.`,
  }),
  premium: Object.freeze({
    key: 'premium',
    editType: 'PREMIUM_ENHANCEMENT',
    label: 'PLUS premium enhancement',
    prompt: `Edit this real-estate photograph as a visibly refined, high-end international property editorial while remaining completely truthful. The PLUS result must be clearly more polished and aspirational than a basic exposure correction: create bright refined ambient daylight, a soft believable interior glow, clean neutral-warm Mediterranean colour, elegant tonal depth, corrected verticals and perspective, crisp premium texture, magazine-quality framing and an airy upscale mood. Preserve the room's recognizable identity and all essential property characteristics. In a finished furnished room, tastefully style the existing scene with a restrained selection of believable removable accessories such as an elegant plant, refined cushions, neatly styled bedding, subtle artwork or table styling. Improve the presentation of existing furniture without replacing the room or changing its function. Never change or invent walls, windows, doors, floor plan, room size, built-in furniture, appliances, permanent fixtures, view, structural condition or amenities. If the image shows an unfinished, renovation or construction-stage space, preserve that exact unfinished construction state: improve only exposure, clarity, perspective and presentation; never fabricate completed walls, floors, ceilings, kitchens, bathrooms, landscaping, fixtures or furniture. Avoid fake HDR, orange cast, fantasy luxury, fake sunset, extreme wide angle, impossible reflections, duplicated objects, people, text, logos and watermarks.`,
  }),
  vision: Object.freeze({
    key: 'vision',
    editType: 'CONSERVATIVE_ENHANCEMENT_WITH_VISION',
    label: 'Vision audit + conservative enhancement',
    prompt: `Use a conservative real-estate photo enhancement. Preserve the photograph and room exactly. Improve exposure, brightness, sharpness, resolution appearance, natural white balance and mild warmth. Correct only subtle lens and perspective distortion. Keep every wall, window, doorway, floor, fixture, furniture item, view and material recognizable and in the same position. Make no decorative additions and do not remove permanent or material condition details.`,
  }),
})

function normaliseMode(mode) {
  // Production historically used `pimp`/`plus`; keep both aliases so the
  // recovery can roll out without invalidating already queued commands.
  if (mode === 'pimp') return 'conservative'
  if (mode === 'plus') return 'premium'
  return PRESETS[mode] ? mode : 'conservative'
}

function presetFor(mode) {
  return PRESETS[normaliseMode(mode)]
}

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
    .map(item => ({
      index: Number(item.index),
      action: String(item.action || 'REVIEW').toUpperCase(),
      scene: String(item.scene || 'OTHER').toUpperCase(),
      reason: String(item.reason || '').slice(0, 240),
    }))
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
  const audited = images.slice(0, MAX_AUDIT_IMAGES)
  const parts = audited.map((image, index) => ({
    inlineData: { mimeType: image.mimeType || 'image/jpeg', data: image.buffer.toString('base64') },
  }))
  parts.push({ text: `Internally audit this ordered property photo set (indices start at 0). Known structured facts: ${JSON.stringify(factsForPrompt(facts))}.
Do not infer that a room or amenity does not exist merely because it is unseen. Do not infer protected characteristics. Similar rooms may be distinct; use confidence.
Return JSON only with:
{"coverage":[{"label":"living room","state":"PHOTOGRAPHED|LIKELY_PHOTOGRAPHED|NOT_SEEN|UNKNOWN","confidence":0.0,"evidence_indices":[0]}],"likely_missing":[{"label":"Bedroom 3","state":"NOT_SEEN|UNKNOWN","reason":"..."}],"photo_recommendations":[{"index":0,"action":"USE|EDIT|LOW_PRIORITY|DUPLICATE|REVIEW","scene":"LIVING|KITCHEN|OUTDOOR|BEDROOM|BATHROOM|OTHER","reason":"..."}],"hero_candidates":[0,1,2],"soft_observations":[{"value":"possible balcony","confidence":0.0,"evidence_image_index":0}],"summary":"short internal summary"}` })
  try {
    const response = await withTimeout(client.models.generateContent({
      model: VISION_MODEL,
      contents: [{ role: 'user', parts }],
      config: { responseMimeType: 'application/json', temperature: 0.1 },
    }), VISION_TIMEOUT_MS, 'vision audit')
    return normaliseAudit(jsonText(response), audited.length)
  } catch (error) {
    log.warn('gptPhotoPipeline: vision audit failed; continuing', { err: error.message })
    return null
  }
}

function dedupeImages(images = []) {
  const seen = new Set()
  const unique = []
  for (const image of images) {
    if (!Buffer.isBuffer(image?.buffer) || !image.buffer.length) continue
    const hash = sha256(image.buffer)
    if (seen.has(hash)) continue
    seen.add(hash)
    unique.push(image)
  }
  return unique
}

const SCENE_PRIORITY = { LIVING: 0, KITCHEN: 1, OUTDOOR: 2, OTHER: 3, BEDROOM: 4, BATHROOM: 5 }
function editPriorityIndices(images, audit, limit = MAX_EDIT_IMAGES) {
  const scenes = new Map((audit?.photo_recommendations || []).map(item => [item.index, item.scene]))
  return images.map((_, index) => index)
    .sort((a, b) => (SCENE_PRIORITY[scenes.get(a)] ?? SCENE_PRIORITY.OTHER) - (SCENE_PRIORITY[scenes.get(b)] ?? SCENE_PRIORITY.OTHER) || a - b)
    .slice(0, limit)
}

function editModelForMode(mode) {
  return normaliseMode(mode) === 'premium' ? PLUS_EDIT_MODEL : EDIT_MODEL
}

function editTypeForMode(mode) {
  return presetFor(mode).editType
}

function validateGeneratedImage(source, output) {
  if (!output?.buffer?.length) return { ok: false, reason: 'image model returned no image' }
  const dimensions = imageSize(output.buffer)
  if (!dimensions?.width || !dimensions?.height) return { ok: false, reason: 'image model returned an unreadable image' }
  if (!/^image\/(?:png|jpe?g|webp)$/i.test(String(output.mimeType || ''))) return { ok: false, reason: 'image model returned an unsupported image type' }
  if (source?.buffer && sha256(source.buffer) === sha256(output.buffer)) return { ok: false, reason: 'image model returned the unchanged original' }
  return { ok: true, dimensions }
}

function editPrompt(mode, context = {}) {
  const preset = presetFor(mode)
  return `${preset.prompt}
Across every preset: never invent a balcony, pool, garage, terrace, sea view, room or amenity. Never hide defects or unfinished work. Avoid HDR, fake sunset, extreme wide angle, artificial-looking textures and redesign.
Property context: ${JSON.stringify(factsForPrompt(context.facts))}. Set context: ${String(context.auditSummary || 'same property across all images').slice(0, 600)}.
Return one edited image and no prose.`
}

async function editOne(image, context, { ai } = {}) {
  const client = ai || new GoogleGenAI({ apiKey: apiKey() })
  const mode = normaliseMode(context.mode)
  const prompt = editPrompt(mode, context)
  const generationConfig = { responseModalities: ['IMAGE'] }
  if (mode === 'premium') generationConfig.imageConfig = { imageSize: PLUS_IMAGE_SIZE }
  const response = await withTimeout(client.models.generateContent({
    model: editModelForMode(mode),
    contents: [{ role: 'user', parts: [
      { inlineData: { mimeType: image.mimeType || 'image/jpeg', data: image.buffer.toString('base64') } },
      { text: prompt },
    ] }],
    config: generationConfig,
  }), EDIT_TIMEOUT_MS, 'photo edit')
  const result = responseImage(response)
  const checked = validateGeneratedImage(image, result)
  if (!checked.ok) throw new Error(checked.reason)
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

async function recordStage(id, stage, { store = db, reason = null, details = {} } = {}) {
  const safeReason = reason ? String(reason).slice(0, 500) : null
  await safeQuery(
    `UPDATE property_photo_processing_runs
        SET status=$2, failure_reason=$3, retry_available=($2='failed'), updated_at=NOW(),
            completed_at=CASE WHEN $2='processing' THEN NULL WHEN $2 IN ('ready','failed') THEN NOW() ELSE completed_at END
      WHERE run_id=$1`,
    [id, stage, safeReason], store)
  await safeQuery(
    `INSERT INTO property_photo_processing_events (run_id, stage, reason, details, created_at)
     VALUES ($1,$2,$3,$4::jsonb,NOW())`,
    [id, stage, safeReason, JSON.stringify(details || {})], store)
}

async function loadCheckpoints(id, store, fetcher) {
  const rows = await safeQuery(
    `SELECT position, source_sha256, edited_image_url, edited_sha256 FROM property_photo_edits
      WHERE run_id=$1 AND status IN ('generated','quality_checked','saved','ready') AND edited_image_url IS NOT NULL`,
    [id], store)
  const byPosition = new Map(rows.rows.map(row => [Number(row.position), row]))
  return async (index, sourceSha256) => {
    const row = byPosition.get(index)
    if (!row || row.source_sha256 !== sourceSha256) return null
    try {
      const response = await fetcher(row.edited_image_url, { signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined })
      if (!response.ok) throw new Error(`checkpoint fetch ${response.status}`)
      const buffer = Buffer.from(await response.arrayBuffer())
      if (row.edited_sha256 && sha256(buffer) !== row.edited_sha256) throw new Error('checkpoint hash mismatch')
      const output = { buffer, mimeType: response.headers.get('content-type') || 'image/jpeg' }
      const checked = validateGeneratedImage(null, output)
      if (!checked.ok) throw new Error(checked.reason)
      return { ...output, editedUrl: row.edited_image_url }
    } catch (error) {
      log.warn('gptPhotoPipeline: checkpoint unusable; generating again', { runId: id, index, stage: 'processing', reason: error.message })
      return null
    }
  }
}

async function checkpoint(id, index, sourceImage, output, editedUrl, mode, store) {
  const preset = presetFor(mode)
  await safeQuery(
    `INSERT INTO property_photo_edits
     (run_id, property_id, position, source_image_id, edited_image_id, source_image_url, edited_image_url,
      source_sha256, edited_sha256, source_kind, edit_type, model_version, status, error, created_at)
     VALUES ($1,NULL,$2,$3,$4,NULL,$5,$3,$4,$6,$7,$8,'generated',NULL,NOW())
     ON CONFLICT (run_id, position) DO UPDATE SET edited_image_url=EXCLUDED.edited_image_url,
       edited_sha256=EXCLUDED.edited_sha256, source_sha256=EXCLUDED.source_sha256,
       edit_type=EXCLUDED.edit_type, model_version=EXCLUDED.model_version, status='generated', error=NULL`,
    [id, index, sourceImage.sourceSha256, sha256(output.buffer), editedUrl,
      sourceImage.sourceKind || 'ORIGINAL', preset.editType, editModelForMode(mode)], store)
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
    const reason = `stored original recovery failed: ${String(error.message || error).slice(0, 300)}`
    log.warn('gptPhotoPipeline: original recovery failed', { stage: 'processing', reason })
    // Re-editing an already generated asset would compound drift. Keep the
    // incoming bytes for evidence, but make the item explicitly retryable.
    return { ...image, sourceKind: 'GPT_ENHANCED', sourceSha256: incomingHash, recoveryError: reason }
  }
}

async function processImages({ images = [], facts = {}, mode = 'conservative', triggerId = null, source = 'whatsapp', onProgress = null, ai = null, store = db, fetcher = fetch, uploader = null } = {}) {
  let id = runId()
  const effectiveMode = normaliseMode(mode)
  const inputCount = images.length
  images = dedupeImages(images)
  const inserted = await safeQuery(
    `INSERT INTO property_photo_processing_runs (run_id, trigger_id, source, mode, status, source_count, edit_model, vision_model, created_at)
     VALUES ($1,$2,$3,$4,'received',$5,$6,$7,NOW()) ON CONFLICT (trigger_id) WHERE trigger_id IS NOT NULL DO NOTHING RETURNING run_id`,
    [id, triggerId, source, effectiveMode, images.length, editModelForMode(effectiveMode), effectiveMode === 'vision' ? VISION_MODEL : null], store)
  let resumedRun = false
  if (!inserted.rows.length && triggerId) {
    const existing = await safeQuery(`SELECT run_id FROM property_photo_processing_runs WHERE trigger_id=$1 LIMIT 1`, [triggerId], store)
    if (existing.rows[0]?.run_id) { id = existing.rows[0].run_id; resumedRun = true }
  }

  if (!resumedRun) await recordStage(id, 'received', { store, details: { mode: effectiveMode, sourceCount: images.length } })
  await recordStage(id, 'processing', { store, details: { mode: effectiveMode, sourceCount: images.length, resumed: resumedRun } })

  // Keep the production set audit and scene priority: living areas, kitchens
  // and outdoor spaces consume the bounded edit slots before secondary rooms.
  // Live production keeps the existing set audit. Unit/integration callers
  // that inject an image editor do not unexpectedly spend their edit double
  // on an additional audit unless they explicitly selected vision mode.
  const audit = (effectiveMode === 'vision' || apiKey())
    ? await auditImages(images, facts, { ai: effectiveMode === 'vision' ? ai : null })
    : null
  const selectedIndices = editPriorityIndices(images, audit)
  const bases = []
  for (const position of selectedIndices) {
    const image = await recoverOriginal(images[position], { store, fetcher })
    if (!image.sourceSha256) image.sourceSha256 = sha256(image.buffer)
    bases.push({ position, image })
  }
  const fromCheckpoint = resumedRun ? await loadCheckpoints(id, store, fetcher) : async () => null
  let editedCount = 0
  let failedCount = 0
  let resumedCount = 0
  let lowerResolutionCount = 0
  let completed = 0
  const keyPresent = !!apiKey() || !!ai
  // Bounded parallel edits; every item is written to its own index, so the
  // final order is the input order no matter which edit finishes first.
  const editedItems = await mapLimited(bases, EDIT_CONCURRENCY, async ({ position, image: sourceImage }) => {
    let output = null
    let editedUrl = null
    let status = 'failed'
    let error = null
    let resumed = false
    const checkpointed = sourceImage.recoveryError ? null : await fromCheckpoint(position, sourceImage.sourceSha256)
    if (sourceImage.recoveryError) {
      error = sourceImage.recoveryError
      failedCount += 1
    } else if (checkpointed) {
      output = { buffer: checkpointed.buffer, mimeType: checkpointed.mimeType }
      editedUrl = checkpointed.editedUrl
      status = 'quality_checked'
      editedCount += 1
      resumedCount += 1
      resumed = true
    } else if (keyPresent) {
      try {
        output = await editOne(sourceImage, { facts, auditSummary: audit?.summary, mode: effectiveMode }, { ai })
        status = 'quality_checked'
        editedCount += 1
      } catch (caught) {
        error = String(caught.message || caught).slice(0, 500)
        failedCount += 1
        output = null
        editedUrl = null
        status = 'failed'
        log.warn('gptPhotoPipeline: image generation failed', { runId: id, index: position, stage: 'processing', mode: effectiveMode, reason: error })
      }
    } else {
      error = 'image editing key unavailable'
      failedCount += 1
    }
    const sourceSize = imageSize(sourceImage.buffer)
    const editedSize = status === 'quality_checked' ? imageSize(output.buffer) : null
    const reviewResolution = status === 'quality_checked' && lowerResolution(sourceSize, editedSize)
    if (reviewResolution) {
      lowerResolutionCount += 1
      editedCount -= 1
      failedCount += 1
      status = 'failed'
      error = `quality check failed: edited ${editedSize.width}x${editedSize.height} < original ${sourceSize.width}x${sourceSize.height}`
      log.warn('gptPhotoPipeline: edited image is lower resolution than its original', { index: position, sourceSize, editedSize })
    }
    if (status === 'quality_checked' && uploader && !editedUrl) {
      try {
        editedUrl = await uploader(output.buffer, output.mimeType)
        if (!editedUrl) throw new Error('generated image storage returned no URL')
        await checkpoint(id, position, sourceImage, output, editedUrl, effectiveMode, store)
      } catch (caught) {
        error = String(caught.message || caught).slice(0, 500)
        editedCount -= 1
        failedCount += 1
        status = 'failed'
        editedUrl = null
        log.warn('gptPhotoPipeline: generated image storage failed', { runId: id, index: position, stage: 'saved', mode: effectiveMode, reason: error })
      }
    }
    completed += 1
    if (onProgress) await onProgress({ complete: completed, total: bases.length, edited: editedCount, failed: failedCount, stage: status })
    return {
      position,
      sourceBuffer: sourceImage.buffer,
      sourceMimeType: sourceImage.mimeType,
      sourceSha256: sourceImage.sourceSha256 || sha256(sourceImage.buffer),
      sourceKind: sourceImage.sourceKind || 'ORIGINAL',
      buffer: output?.buffer || null,
      mimeType: output?.mimeType || null,
      editedSha256: status === 'quality_checked' ? sha256(output.buffer) : null,
      editedUrl,
      resumed,
      status,
      error,
      sourceSize,
      editedSize,
      reviewResolution,
    }
  })
  const byPosition = new Map(editedItems.map(item => [item.position, item]))
  const items = images.map((image, position) => byPosition.get(position) || {
    position, sourceBuffer: image.buffer, sourceMimeType: image.mimeType,
    sourceSha256: sha256(image.buffer), sourceKind: 'ORIGINAL',
    buffer: null, mimeType: null, editedSha256: null, editedUrl: null,
    status: 'failed', error: `preset limit is ${MAX_EDIT_IMAGES}; retry this image in a separate batch`,
  })
  failedCount += Math.max(0, images.length - selectedIndices.length)
  await safeQuery(
    `UPDATE property_photo_processing_runs SET edited_count=$2, fallback_count=$3, audit=$4::jsonb, updated_at=NOW() WHERE run_id=$1`,
    [id, editedCount, failedCount, JSON.stringify(audit || {})], store)
  if (!images.length) {
    failedCount += 1
    await recordStage(id, 'failed', { store, reason: 'no source images received', details: { retryAvailable: true } })
  } else if (editedCount) {
    await recordStage(id, 'generated', { store, details: { editedCount, failedCount, resumedCount } })
    await recordStage(id, 'quality_checked', { store, details: { lowerResolutionCount } })
  }
  if (failedCount && images.length) {
    const firstFailure = items.find(item => item.status === 'failed')?.error || 'one or more images failed'
    await recordStage(id, 'failed', { store, reason: firstFailure, details: { editedCount, failedCount, retryAvailable: true } })
  }
  return {
    runId: id, mode: effectiveMode, preset: presetFor(effectiveMode), items, audit,
    editedCount, failedCount, fallbackCount: 0, resumedCount, lowerResolutionCount,
    overLimitCount: Math.max(0, images.length - selectedIndices.length), duplicateCount: inputCount - images.length,
    sourceCount: images.length, retryAvailable: failedCount > 0,
    status: failedCount ? 'failed' : 'quality_checked',
    models: { edit: editModelForMode(effectiveMode), vision: VISION_MODEL },
  }
}

async function persistResult({ result, propertyId, uploaded, store = db }) {
  if (!result) return null
  await safeQuery(`UPDATE property_photo_processing_runs SET property_id=$2, updated_at=NOW() WHERE run_id=$1`, [result.runId, propertyId], store)
  let savedCount = 0
  for (const row of uploaded) {
    const item = result.items[row.position]
    if (!item) continue
    const saved = item.status === 'quality_checked' && !!row.sourceUrl && !!row.editedUrl
    if (saved) savedCount += 1
    await safeQuery(
      `INSERT INTO property_photo_edits
       (run_id, property_id, position, source_image_id, edited_image_id, source_image_url, edited_image_url,
        source_sha256, edited_sha256, source_kind, edit_type, model_version, status, error, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
       ON CONFLICT (run_id, position) DO UPDATE SET property_id=EXCLUDED.property_id, source_image_url=EXCLUDED.source_image_url,
       edited_image_url=EXCLUDED.edited_image_url, edit_type=EXCLUDED.edit_type,
       model_version=EXCLUDED.model_version, status=EXCLUDED.status, error=EXCLUDED.error`,
      [result.runId, propertyId, row.position, item.sourceSha256, item.editedSha256, row.sourceUrl, row.editedUrl,
        item.sourceSha256, item.editedSha256, item.sourceKind, result.preset.editType,
        result.models.edit, saved ? 'saved' : 'failed', item.error || (!row.sourceUrl ? 'original storage failed' : (!row.editedUrl && item.status !== 'failed' ? 'generated image storage failed' : null))], store)
  }
  for (const observation of result.audit?.soft_observations || []) {
    const confidence = Number(observation.confidence)
    if (!observation.value || !Number.isFinite(confidence)) continue
    await safeQuery(
      `INSERT INTO property_photo_vision_observations (property_id, run_id, value, confidence, source, evidence_image_position, observed_at)
       VALUES ($1,$2,$3,$4,'IMAGE_VISION',$5,NOW())`,
      [propertyId, result.runId, String(observation.value).slice(0, 300), Math.max(0, Math.min(1, confidence)), Number(observation.evidence_image_index) || 0], store)
  }
  if (savedCount) await recordStage(result.runId, 'saved', { store, details: { savedCount, propertyId } })
  const ready = result.failedCount === 0 && savedCount === result.editedCount && savedCount > 0
  if (ready) {
    await safeQuery(`UPDATE property_photo_edits SET status='ready' WHERE run_id=$1 AND status='saved'`, [result.runId], store)
    await recordStage(result.runId, 'ready', { store, details: { savedCount, propertyId } })
  } else {
    const reason = result.failedCount
      ? `${result.failedCount} image${result.failedCount === 1 ? '' : 's'} failed; retry available`
      : 'generated image storage incomplete; retry available'
    await recordStage(result.runId, 'failed', { store, reason, details: { savedCount, expected: result.editedCount, propertyId } })
  }
  return { runId: result.runId, status: ready ? 'ready' : 'failed', savedCount, retryAvailable: !ready }
}

async function retryRun({ runId: parentRunId, store = db, fetcher = fetch, uploader, ai = null } = {}) {
  if (!parentRunId) throw new Error('run id is required')
  if (typeof uploader !== 'function') throw new Error('image uploader is required')
  const runRow = await safeQuery(
    `SELECT r.run_id, r.property_id, r.mode, r.status, r.retry_available,
            p.property_type, p.town, p.bedrooms, p.bathrooms
       FROM property_photo_processing_runs r
       JOIN properties p ON p.id=r.property_id
      WHERE r.run_id=$1 LIMIT 1`, [parentRunId], store)
  const parent = runRow.rows[0]
  if (!parent) throw new Error('photo processing run not found or not associated with a property')
  if (!parent.retry_available && parent.status !== 'failed') throw new Error('photo processing run is not retryable')
  const failedRows = await safeQuery(
    `SELECT position, source_image_url FROM property_photo_edits
      WHERE run_id=$1 AND status='failed' AND source_image_url IS NOT NULL
      ORDER BY position`, [parentRunId], store)
  if (!failedRows.rows.length) throw new Error('no failed source images are available for retry')

  const images = []
  for (const row of failedRows.rows) {
    const response = await fetcher(row.source_image_url, { signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined })
    if (!response.ok) throw new Error(`retry source fetch ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    const mimeType = response.headers.get('content-type') || 'image/jpeg'
    if (!imageSize(buffer)) throw new Error(`retry source at position ${row.position} is unreadable`)
    images.push({ buffer, mimeType, sourceKind: 'ORIGINAL' })
  }

  const facts = { property_type: parent.property_type, town: parent.town, bedrooms: parent.bedrooms, bathrooms: parent.bathrooms }
  const result = await processImages({
    images, facts, mode: parent.mode, triggerId: `manual-retry:${parentRunId}`,
    source: 'manual_retry', ai, store, fetcher, uploader,
  })
  await safeQuery(`UPDATE property_photo_processing_runs SET parent_run_id=$2 WHERE run_id=$1`, [result.runId, parentRunId], store)
  const uploaded = []
  for (let index = 0; index < result.items.length; index += 1) {
    const item = result.items[index]
    let editedUrl = item.editedUrl || null
    if (item.status === 'quality_checked' && !editedUrl) editedUrl = await uploader(item.buffer, item.mimeType)
    uploaded.push({ position: index, sourceUrl: failedRows.rows[index]?.source_image_url || null, editedUrl })
  }
  const persisted = await persistResult({ result, propertyId: parent.property_id, uploaded, store })
  await safeQuery(
    `UPDATE property_photo_processing_runs
        SET retry_count=retry_count+1, retry_available=CASE WHEN $2='ready' THEN FALSE ELSE retry_available END, updated_at=NOW()
      WHERE run_id=$1`, [parentRunId, persisted.status], store)
  return {
    result, persisted, propertyId: parent.property_id,
    replacements: uploaded.map((row, index) => ({
      position: Number(failedRows.rows[index]?.position), editedUrl: row.editedUrl,
    })).filter(row => row.editedUrl),
  }
}

module.exports = {
  MAX_EDIT_IMAGES, MAX_AUDIT_IMAGES, EDIT_MODEL, PLUS_EDIT_MODEL, PLUS_IMAGE_SIZE, VISION_MODEL, EDIT_CONCURRENCY,
  PRESETS, sha256, normaliseAudit, imageSize, mapLimited, dedupeImages, editPriorityIndices,
  normaliseMode, presetFor, editModelForMode, editTypeForMode, editPrompt, validateGeneratedImage,
  auditImages, editOne, processImages, persistResult, retryRun, responseImage,
}
