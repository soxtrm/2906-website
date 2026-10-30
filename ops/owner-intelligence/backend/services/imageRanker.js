'use strict'
// ============================================================================
// imageRanker.js — decide which photos of a listing are worth posting.
//
// Once a post carries 5 photos instead of 10, "the first 5 in the payload" is
// not good enough: agents send whatever order their phone gave them, so the
// lead shot is often a toilet, a dark corridor or a close-up of a wall socket.
// This ranks the photos once per listing with one Gemini vision call and stores
// the order on properties.image_ranking.
//
// ONE call per LISTING, never per group post. A 31-group run reads the stored
// ranking 31 times and calls nothing.
//
// Failure is always soft: no key, no answer, bad JSON, fewer indices than
// images — every path falls back to the original payload order. A listing must
// never fail to post because a photo could not be scored.
// ============================================================================

const { GoogleGenAI } = require('@google/genai')
const db     = require('../db')
const log    = require('../logger')
const config = require('../config')

const MODEL = 'gemini-2.5-flash'
// Sending 15 full-size photos inline is slow and buys nothing — the model only
// needs to tell a bright living room from a dark bathroom.
const MAX_IMAGES_TO_SCORE = 15
const FETCH_TIMEOUT_MS    = 15_000
const CALL_TIMEOUT_MS     = 90_000

const apiKey = () => process.env.GEMINI_API_KEY || config?.gemini?.apiKey || null

const PROMPT = `You are choosing which photos of a rental property to put in a Facebook listing ad.

Rank ALL the images from best to worst for that purpose.

Strongly prefer:
- bright, wide shots of the living room, kitchen, bedrooms, terrace or balcony
- views (sea, skyline, open outlook)
- the building exterior if it looks good

Push to the back:
- bathrooms and toilets, especially close-ups
- dark, blurry, tilted or heavily shadowed shots
- corridors, empty walls, closed doors, storage rooms, close-ups of appliances or sockets
- near-duplicates of a shot already ranked higher
- screenshots, floor plans, watermarked or text-covered images

Return ONLY JSON, no prose:
{"order": [<image indices, best first, EVERY index exactly once>],
 "notes": [<one short phrase per entry in order, same length as order>]}

The images are given in index order starting at 0.`

// ── fetching ────────────────────────────────────────────────────────────────

function payloadImages(payload) {
  const imgs = Array.isArray(payload?.images) ? payload.images : []
  return imgs
    .map(i => (typeof i === 'string' ? i : (i && i.url) || null))
    .filter(u => typeof u === 'string' && /^https?:\/\//.test(u))
}

async function fetchInline(url) {
  const signal = AbortSignal.timeout ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`image fetch ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  return {
    inlineData: {
      mimeType: res.headers.get('content-type') || 'image/jpeg',
      data: buf.toString('base64'),
    },
  }
}

// ── ranking ─────────────────────────────────────────────────────────────────

// Whatever the model returns, the result must be a permutation of 0..n-1.
// A missing index would silently drop a photo; a repeated one would post the
// same picture twice.
function sanitiseOrder(order, n) {
  const seen = new Set()
  const clean = []
  for (const raw of Array.isArray(order) ? order : []) {
    const i = Number(raw)
    if (!Number.isInteger(i) || i < 0 || i >= n || seen.has(i)) continue
    seen.add(i); clean.push(i)
  }
  // Anything the model forgot keeps its original relative position, at the back.
  for (let i = 0; i < n; i++) if (!seen.has(i)) clean.push(i)
  return clean
}

// Rank an explicit list of image URLs. Returns the ranking object or null;
// writes nothing to the database. Split out of rankProperty so a caller that
// holds the URLs from somewhere other than public_payload — the properties
// .images column, which is the only image list the older listings have — can
// reuse the exact same prompt, model and sanitising.
async function rankImageUrls(urls, { ref = null } = {}) {
  if (!Array.isArray(urls) || urls.length < 2) return null

  const key = apiKey()
  if (!key) { log.warn('imageRanker: GEMINI_API_KEY unset — keeping payload order'); return null }

  const slice = urls.slice(0, MAX_IMAGES_TO_SCORE)
  const parts = []
  for (const url of slice) {
    try { parts.push(await fetchInline(url)) }
    catch (err) {
      // A photo we cannot download cannot be scored either. Bail out rather
      // than rank a partial set — the indices would no longer line up.
      log.warn('imageRanker: image fetch failed, skipping ranking', { ref, err: err.message })
      return null
    }
  }

  let parsed
  try {
    const ai = new GoogleGenAI({ apiKey: key })
    const response = await Promise.race([
      ai.models.generateContent({
        model: MODEL,
        contents: [{ role: 'user', parts: [...parts, { text: PROMPT }] }],
        config: { responseMimeType: 'application/json', temperature: 0.1 },
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('gemini timeout')), CALL_TIMEOUT_MS)),
    ])
    const raw = (response.text || '').replace(/^```json\s*/i, '').replace(/```\s*$/g, '').trim()
    parsed = JSON.parse(raw)
  } catch (err) {
    log.warn('imageRanker: ranking failed', { ref, err: err.message })
    return null
  }

  const order = sanitiseOrder(parsed.order, slice.length)
  const notes = Array.isArray(parsed.notes) ? parsed.notes.map(String) : []
  return {
    order,
    notes: order.map((idx, pos) => notes[pos] || null),
    model: MODEL,
    ranked_at: new Date().toISOString(),
    scored: slice.length,
    total: urls.length,
  }
}

// Returns the stored ranking object, or null if it could not be produced.
async function rankProperty(prop, { force = false } = {}) {
  if (!force && prop.image_ranking) return prop.image_ranking

  const urls = payloadImages(prop.public_payload)
  if (urls.length < 2) return null            // nothing to reorder

  const ranking = await rankImageUrls(urls, { ref: prop.ref })
  if (!ranking) return null

  await db.query('UPDATE properties SET image_ranking = $2 WHERE id = $1', [prop.id, ranking])
  log.info('imageRanker: ranked', {
    ref: prop.ref, images: ranking.scored, best: ranking.notes.slice(0, 3),
  })
  return ranking
}

// Reorder a payload's image URLs best-first. Falls back to payload order
// whenever there is no usable ranking — the caller never has to check.
function orderedImageUrls(payload, ranking) {
  const urls = payloadImages(payload)
  const order = ranking && Array.isArray(ranking.order) ? ranking.order : null
  if (!order || !order.length) return urls
  const picked = order.filter(i => i >= 0 && i < urls.length).map(i => urls[i])
  // Images beyond MAX_IMAGES_TO_SCORE were never ranked — keep them at the back
  // rather than lose them.
  const inRanking = new Set(order)
  for (let i = 0; i < urls.length; i++) if (!inRanking.has(i)) picked.push(urls[i])
  return picked
}

module.exports = { rankProperty, rankImageUrls, orderedImageUrls, payloadImages, sanitiseOrder, MODEL }
