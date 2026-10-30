'use strict'

const { normalizeLocation } = require('../lib/locationNormalize')
const fs   = require('fs')
const path = require('path')
const log  = require('../logger')
const cfg  = require('../config')
const waha = require('../waha')
const db   = require('../db')

const UPLOAD_DIR = '/app/uploads'
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })

// ── Cloudinary ────────────────────────────────────────────────────────────────

function getCloudinary() {
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) return null
  try {
    const cld = require('cloudinary').v2
    cld.config({ cloud_name: CLOUDINARY_CLOUD_NAME, api_key: CLOUDINARY_API_KEY, api_secret: CLOUDINARY_API_SECRET })
    return cld
  } catch { return null }
}

const IMAGE_PRIORITY = [
  { score: 100, tags: ['swimming pool', 'pool', 'infinity pool'] },
  { score: 90,  tags: ['sea', 'ocean', 'sea view', 'marina', 'seafront'] },
  { score: 80,  tags: ['kitchen', 'luxury kitchen', 'open kitchen'] },
  { score: 70,  tags: ['terrace', 'balcony', 'rooftop', 'outdoor', 'garden'] },
  { score: 60,  tags: ['living room', 'living area', 'lounge'] },
  { score: 50,  tags: ['dining room', 'dining area'] },
  { score: 20,  tags: ['bedroom', 'bed'] },
  { score: 10,  tags: ['bathroom', 'bath', 'toilet', 'shower'] },
]

function imagePriorityScore(tags = []) {
  const lower = tags.map(t => t.toLowerCase())
  for (const { score, tags: pt } of IMAGE_PRIORITY) {
    if (pt.some(p => lower.some(l => l.includes(p)))) return score
  }
  return 0
}

async function uploadImage(buffer, mimeType) {
  const cld = getCloudinary()
  if (!cld) throw new Error('Cloudinary credentials not set in .env (CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET)')
  const b64 = `data:${mimeType};base64,${buffer.toString('base64')}`
  const result = await cld.uploader.upload(b64, {
    folder:        '2906-properties',
    resource_type: 'image',
    auto_tagging:  0.6,
    transformation: [{ quality: 'auto', fetch_format: 'auto' }],
  })
  return { url: result.secure_url, tags: result.tags || [] }
}

// ── Text helpers ──────────────────────────────────────────────────────────────

function getMsgBody(m) {
  return (m.body || m.caption || m._data?.body || m._data?.caption || '').trim()
}

function isDotSeparator(text) {
  return /^\.{2,}\s*$/.test(text.trim())
}

function stripEmoji(str) {
  return str
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
    .replace(/[\u{2600}-\u{27FF}]/gu, '')
    .replace(/[\u{FE00}-\u{FEFF}]/gu, '')
    .replace(/[\uD800-\uDFFF]/g, '')
    .replace(/[✨•*_~`]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ── Cluster extraction ────────────────────────────────────────────────────────

function findCluster(messages, cmdMsgId, cmdTs) {
  const byTime = [...messages].sort((a, b) =>
    (a.timestamp || a._data?.t || 0) - (b.timestamp || b._data?.t || 0)
  )
  let postIdx = byTime.findIndex(m => m.id === cmdMsgId || m.key?.id === cmdMsgId)
  if (postIdx < 0) {
    postIdx = byTime.findIndex(m =>
      getMsgBody(m).toUpperCase().trim() === '!POSTWEB' &&
      Math.abs((m.timestamp || m._data?.t || 0) - cmdTs) < 15
    )
  }
  if (postIdx < 0) postIdx = byTime.length

  let upperSepIdx = -1
  for (let i = postIdx - 1; i >= 0; i--) {
    if (isDotSeparator(getMsgBody(byTime[i]))) { upperSepIdx = i; break }
  }
  let lowerSepIdx = -1
  if (upperSepIdx >= 0) {
    for (let i = upperSepIdx - 1; i >= 0; i--) {
      if (isDotSeparator(getMsgBody(byTime[i]))) { lowerSepIdx = i; break }
    }
  }
  if (upperSepIdx >= 0) {
    const start = lowerSepIdx >= 0 ? lowerSepIdx + 1 : Math.max(0, upperSepIdx - 20)
    return byTime.slice(start, upperSepIdx)
  }
  return byTime.slice(Math.max(0, postIdx - 15), postIdx)
    .filter(m => getMsgBody(m).toUpperCase().trim() !== '!POSTWEB')
}

// ── Image helpers ─────────────────────────────────────────────────────────────

async function downloadWahaMedia(url, mimeType) {
  if (!url) return null
  const wahaBase = (cfg.waha?.url || 'http://waha:3000').replace(/\/$/, '')
  const fixedUrl = url
    .replace(/^https?:\/\/localhost(:\d+)?/, wahaBase)
    .replace(/^https?:\/\/127\.0\.0\.1(:\d+)?/, wahaBase)
  const res = await fetch(fixedUrl, { headers: { 'X-Api-Key': cfg.waha?.apiKey || '' } })
  if (!res.ok) throw new Error(`Media fetch ${res.status}`)
  return { buffer: Buffer.from(await res.arrayBuffer()), mimeType: mimeType || 'image/jpeg' }
}

async function getMsgImages(m) {
  if (m.media?.url) {
    const mime = m.media.mimetype || 'image/jpeg'
    if (!mime.startsWith('image/')) return []
    try { const item = await downloadWahaMedia(m.media.url, mime); return item ? [item] : [] }
    catch (err) { log.warn('webPost: media download failed', { err: err.message }); return [] }
  }
  const mediaData = m.mediaData || m._data?.mediaData
  if (!mediaData?.data) return []
  const mime = mediaData.mimetype || m.mimetype || 'image/jpeg'
  if (!mime.startsWith('image/')) return []
  return [{ buffer: Buffer.from(mediaData.data, 'base64'), mimeType: mime }]
}

// ── Metadata extraction ───────────────────────────────────────────────────────

function extractPrice(text) {
  const m = text.match(/€\s*([\d,.]+)/) || text.match(/([\d,.]+)\s*(?:€|eur)\b/i)
  if (!m) return null
  return parseInt(m[1].replace(/[,.]/g, '').replace(/\D/g, ''), 10) || null
}

function extractBedrooms(text) {
  if (/\bstudio\b/i.test(text)) return 0
  // "5 bedrooms", "5-bedroom", "5 BR"
  const m1 = text.match(/(\d+)[\s-]*(?:bed(?:room)?s?|BR)\b/i)
  if (m1) return parseInt(m1[1], 10)
  // "bedrooms: 5", "bedrooms x5", "bedrooms | 5"
  const m2 = text.match(/bed(?:room)?s?[\s:x*|–\-]+(\d+)/i)
  if (m2) return parseInt(m2[1], 10)
  return null
}

function extractBathrooms(text) {
  // "4 bathrooms", "4-bathroom", "4 en-suite", "4 en suite", "4 WC"
  const m1 = text.match(/(\d+)[\s-]*(?:en[\s-]?suite|bath(?:room)?s?|wc|toilet)\b/i)
  if (m1) return parseInt(m1[1], 10)
  // "bathrooms: 4", "bathrooms x 4", "bathrooms | 4", "baths – 4"
  const m2 = text.match(/(?:en[\s-]?suite|bath(?:room)?s?|wc|toilet)[\s:x*|–\-]+(\d+)/i)
  if (m2) return parseInt(m2[1], 10)
  return 1
}

function extractSqm(text) {
  const m = text.match(/(\d+)\s*(?:sqm|m²|m2|qm)\b/i)
  return m ? parseInt(m[1], 10) : null
}

const MALTA_PLACES = [
  "St Paul's Bay","St Julian's","St Andrew's","San Gwann","Santa Venera",
  "Bahar ic-Caghaq","Ta' Giorni","Ta' Xbiex","Guardamangia","Marsascala",
  "Marsaxlokk","Pendergardens","Attard","Bahrija","Balzan","Birkirkara",
  "Birzebbuga","Bugibba","Burmarrad","Cospicua","Dingli","Fgura","Floriana",
  "Ghaxaq","Gozo","Gudja","Gzira","Hamrun","Iklin","Kalkara","Kappara",
  "Kirkop","Lija","Luqa","Madliena","Marsa","Mdina","Mellieha","Mensija",
  "Mosta","Mqabba","Msida","Mtarfa","Naxxar","Paceville","Paola","Pembroke",
  "Pieta","Portomaso","Qawra","Qormi","Rabat","Senglea","Siggiewi","Sliema",
  "Swatar","Swieqi","Tarxien","Valletta","Vittoriosa","Wardija","Xemxija",
  "Zabbar","Zejtun","Zurrieq",
]

function extractLocation(text) {
  const firstLine = text.split('\n')[0] || ''
  const parts = firstLine.split('|')
  if (parts.length >= 2) { const loc = stripEmoji(parts[0]).trim(); if (loc) return loc }
  for (const place of MALTA_PLACES) {
    const esc = place.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "[''']?")
    if (new RegExp('\\b' + esc + '\\b', 'i').test(text)) return place
  }
  return null
}

const PROPERTY_TYPE_MAP = [
  [/penthouse/i, 'Penthouse'], [/maisonette/i, 'Maisonette'],
  [/house\s+of\s+character/i, 'House of Character'], [/farm\s*house/i, 'Farmhouse'],
  [/\bvilla\b/i, 'Villa'], [/\bbungalow\b/i, 'Bungalow'], [/\bpalazzo\b/i, 'Palazzo'],
  [/\bstudio\b/i, 'Apartment'], [/\boffice\b/i, 'Office'],
  [/\bretail\b/i, 'Retail'], [/\bwarehouse\b/i, 'Warehouse'],
]
function detectPropertyType(text) {
  for (const [re, label] of PROPERTY_TYPE_MAP) { if (re.test(text)) return label }
  return 'Apartment'
}

// ── Kimi prompt ───────────────────────────────────────────────────────────────

const KIMI_PROMPT = `You are a luxury real estate copywriter for 2906 Real Estate Malta, a Sotheby's-inspired brand. Transform raw WhatsApp property notes into elegant marketing content. Even short property notes must become beautiful flowing prose - if details are sparse, expand naturally with refined language about lifestyle, location, and atmosphere without inventing specific features.

Return STRICT JSON only (no markdown, no code blocks):
{
  "headline": "evocative magazine-style headline under 80 chars — MUST include the property type word (Villa, Penthouse, Palazzo, Maisonette, Apartment, etc.) and location",
  "summary": "2-3 refined sentences under 300 chars",
  "fullDescription": "flowing elegant prose, 3-5 short paragraphs, 400-700 words minimum even from short input, NO emojis, NO bullet points, NO asterisks, NO ✨ symbols",
  "features": ["5-12 short feature tags"]
}

EXAMPLE INPUT:
🏡 *Luxury 5-Bedroom Villa in Madliena – €7,500/month*
Experience upscale living in one of Malta's most prestigious areas. This stunning villa offers the perfect blend of space, privacy, and outdoor lifestyle.
✨ *Property Features:*
• 5 spacious bedrooms
• 4 modern bathrooms
• Bright open-plan living & dining area
• Fully equipped kitchen
🌿 *Outdoor Living:*
• Private swimming pool
• Beautiful garden area
• Large outdoor terrace
• BBQ & entertainment space
📍 Located in the exclusive Madliena / High Ridge area, just minutes from St. Julian's.

EXAMPLE OUTPUT:
{
  "headline": "Luxury Villa for Rent in Madliena | €7,500/month",
  "summary": "An elegant 5-bedroom villa in Malta's prestigious Madliena area, offering refined comfort, privacy, and Mediterranean outdoor living just minutes from St. Julian's.",
  "fullDescription": "Set within one of Malta's most prestigious residential areas, this elegant 5-bedroom villa offers a refined blend of comfort, privacy, and Mediterranean outdoor living.\\n\\nThe property features spacious interiors, a bright open-plan living and dining area, a fully equipped kitchen, 5 well-sized bedrooms, and 4 modern bathrooms, making it ideal for families or professionals seeking a high-standard home in a prime location.\\n\\nDesigned for both relaxation and entertaining, the villa enjoys a private swimming pool, landscaped garden, generous outdoor terraces, and a dedicated BBQ and entertainment area.\\n\\nLocated in the exclusive Madliena / High Ridge area, the residence offers peaceful surroundings and scenic views while remaining just minutes away from St. Julian's, Sliema, and key lifestyle destinations.",
  "features": ["Private Pool", "Landscaped Garden", "Outdoor Terrace", "BBQ Area", "5 Bedrooms", "4 Bathrooms", "Open-Plan Living", "Fully Equipped Kitchen", "Premium Location", "Scenic Views", "Bright", "Air Conditioning", "Fully Furnished"]
}

RULES:
- Match example style: refined, aspirational, magazine-quality
- Words to use: refined, elegant, sought-after, distinguished, sanctuary, sophisticated, curated, prestigious, serene, timeless
- NEVER invent features not in the input
- NEVER use emojis, bullet points, asterisks, or markdown
- Keep factual details (price, bedrooms, location) exactly as given
- Headline MUST include the property type name (e.g., "Palazzo", "Villa", "Penthouse", "Apartment")
- Headline must be evocative magazine-style, NOT comma-joined fields
- Even from short/sparse input: still produce 400-700 word elegant description by expanding on lifestyle, location atmosphere, Malta's appeal - but never invent specific physical features

DEFAULT FEATURES (always add unless text explicitly says otherwise):
- Always add: 'Bright', 'Air Conditioning', 'Fully Furnished'
- Skip 'Air Conditioning' if text says: 'no AC', 'without AC', 'no air conditioning'
- Skip 'Fully Furnished' if text says: 'unfurnished', 'no furniture', 'partly furnished'
- Skip 'Bright' if text says: 'dark', 'no natural light'

CONDITIONAL AUTO-FEATURES:
- Price >= 2500 EUR/month: add 'Premium Appliances'
- Penthouse type: add 'Terrace'

For all other features (pool, garden, sea views, modern design, dishwasher, parking, etc.) - extract ONLY if explicitly mentioned in the input text. Do not auto-add.

PROPERTY TYPE (detected): [PROP_TYPE_HERE]

NOW TRANSFORM THIS:
[RAW_TEXT_HERE]`

// ── Kimi call ─────────────────────────────────────────────────────────────────

async function kimiCopywrite(rawText, propType = 'Apartment') {
  const { apiKey, baseUrl, model } = cfg.kimi || {}
  const prompt = KIMI_PROMPT
    .replace('[PROP_TYPE_HERE]', propType)
    .replace('[RAW_TEXT_HERE]', rawText)

  if (!apiKey) {
    log.warn('webPost: Kimi not configured, using raw text fallback')
    const cleaned = stripEmoji(rawText)
    return fallbackCopy(cleaned)
  }

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.7 }),
    })
    if (!res.ok) throw new Error(`Kimi API ${res.status}`)
    const data    = await res.json()
    const raw     = (data.choices?.[0]?.message?.content || '').trim()
    const jsonStr = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
    const parsed  = JSON.parse(jsonStr)

    if (!parsed.headline || !parsed.fullDescription) throw new Error('Kimi response missing required fields')

    return {
      headline:        String(parsed.headline).slice(0, 80),
      summary:         String(parsed.summary || '').slice(0, 300),
      fullDescription: String(parsed.fullDescription),
      features:        Array.isArray(parsed.features) ? parsed.features : [],
    }
  } catch (err) {
    log.warn('webPost: Kimi failed', { err: err.message })
    return fallbackCopy(stripEmoji(rawText))
  }
}

function fallbackCopy(cleaned) {
  const firstLine = cleaned.split('\n').find(l => l.trim().length > 10) || cleaned.slice(0, 80)
  return {
    headline:        firstLine.slice(0, 80),
    summary:         cleaned.slice(0, 300),
    fullDescription: cleaned,
    features:        [],
  }
}

// ── Standardised website title + description ─────────────────────────────────
// Website-only formatting. PropertyMarket and Facebook still use the original
// (Kimi-cleaned / as-is) text — do NOT reuse these helpers there.

function buildWebsiteTitle({ location, price, bedrooms, bathrooms }) {
  const parts = []
  if (location) parts.push(location)
  if (price)    parts.push(`€${Number(price).toLocaleString('en-US')}`)
  if (bedrooms || bathrooms) {
    const br = bedrooms ? `${bedrooms} Bedroom${bedrooms > 1 ? 's' : ''}` : ''
    const ba = bathrooms ? `${bathrooms} Bathroom${bathrooms > 1 ? 's' : ''}` : ''
    const tail = [br, ba].filter(Boolean).join(' - ')
    if (tail) parts.push(tail)
  }
  return parts.join(' | ')
}

function buildWebsiteDescription(cleanedText) {
  if (!cleanedText) return ''
  const lines = cleanedText
    .split(/\n+/)
    .map(s => s.trim())
    // Drop bullet/separator chars left over from raw notes
    .map(s => s.replace(/^[\s\-•*·–—]+/, '').trim())
    .filter(s => s.length > 3 && s.length < 200)
  return lines.map(l => `  ${l}`).join('\n')
}

// ── Slug ──────────────────────────────────────────────────────────────────────

function makeSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    + '-' + Date.now().toString(36)
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * @param {string}   session      WAHA session name
 * @param {object}   payload      Incoming message payload
 * @param {string}   listingType  'To Rent' | 'For Sale'
 * @param {Function} onStatus     Called with a status string AFTER cluster extracted, BEFORE Kimi
 */
async function postPropertyToWebsite(session, payload, listingType = 'To Rent', onStatus = null) {
  const chatId   = payload.from
  const cmdMsgId = payload.id || payload.key?.id || null
  const cmdTs    = payload.timestamp || payload._data?.t || 0

  log.info('webPost: command received', { chatId: chatId?.slice(0, 15), session, listingType })

  // ── 1. Fetch messages ──────────────────────────────────────────────────────
  // AutoAdvertise bypass: skip chat-fetch entirely. messages stays empty,
  // which triggers the inline-path below using payload._data.quotedMsg.body.
  let messages = []
  if (!payload._autoAdvertiseInline) {
    try { messages = await waha.getChatMessagesWithMedia(session, chatId, 80) }
    catch (err) { log.warn('webPost: primary session fetch failed', { err: err.message }) }

    // Notes-chat: skip cross-session fallback (LID is per-session, fallback
    // would fetch the wrong account's notes-chat content).
    if (!messages.length && !payload._isNotesChat) {
      const working = await waha.getWorkingSessions()
      for (const s of working.filter(w => w.name !== session)) {
        try { messages = await waha.getChatMessagesWithMedia(s.name, chatId, 80); if (messages.length) break }
        catch {}
      }
    }
  }

  // ── 2. Extract raw text and images ─────────────────────────────────────────
  let rawText
  let imageItems = []

  const inlineText = (!messages.length)
    ? (payload._data?.quotedMsg?.body || payload.contextInfo?.quotedMessage?.conversation || null)
    : null

  if (inlineText) {
    rawText = inlineText.trim()
    const qmd = payload._data?.quotedMsg?.mediaData
    if (qmd?.data && (qmd.mimetype || '').startsWith('image/')) {
      imageItems.push({ buffer: Buffer.from(qmd.data, 'base64'), mimeType: qmd.mimetype })
    }
    if (!imageItems.length && !payload._autoAdvertiseInline) {
      const extra = await getMsgImages(payload).catch(() => [])
      for (const img of extra) { if (imageItems.length < 10) imageItems.push(img) }
    }
    // AutoAdvertise multi-message images (collected during 2-min bundle window)
    if (payload._autoAdvertiseInline && Array.isArray(payload._autoAdvertiseImages)) {
      for (const img of payload._autoAdvertiseImages) {
        if (imageItems.length < 10) imageItems.push(img)
      }
    }
  } else if (messages.length) {
    const BOT_NOISE_RE = /^(?:❌|✅|📋|🏳️|❓|⏭️|⚠️|✍️|⏳|Scanning|Generating|Posted)/
    const cluster = findCluster(messages, cmdMsgId, cmdTs)
      .filter(m => {
        const mid = String(m.id || m.key?.id || '')
        if (mid && waha.wasSentByBackend?.(mid)) return false
        const body = getMsgBody(m)
        if (!body) return true
        return !BOT_NOISE_RE.test(body) && !/^!postweb/i.test(body)
      })

    if (!cluster.length) throw new Error('No content found. Use dot separators:\n.....\n[property text]\n.....\n!postweb')
    rawText = cluster.map(m => getMsgBody(m)).filter(Boolean).join('\n\n').trim()
    if (!rawText) throw new Error('No text found in the content block.')

    for (const m of cluster) {
      if (imageItems.length >= 10) break
      const imgs = await getMsgImages(m)
      for (const img of imgs) {
        if (imageItems.length < 10 && img.buffer.length <= 5 * 1024 * 1024) imageItems.push(img)
      }
    }
  } else {
    throw new Error('Could not read messages. Use dot separators around the property text, then reply !postweb')
  }

  // ── 3. Signal admin AFTER cluster is locked (prevents status contaminating cluster) ──
  if (onStatus) {
    try { await onStatus('✍️ Writing copy and posting to website…') } catch {}
  }

  // ── 4. Extract metadata (normalize location variants first) ──────────────
  const normText  = normalizeLocation(rawText)
  const price     = extractPrice(normText)
  const bedrooms  = extractBedrooms(normText)
  const bathrooms = extractBathrooms(normText)
  const sqm       = extractSqm(normText)
  const location  = normalizeLocation(extractLocation(normText))
  const propType  = detectPropertyType(normText)

  const COMMERCIAL_PROP_TYPES = ['Office', 'Retail', 'Warehouse']
  const category = listingType === 'For Sale'                  ? 'sales'
    : COMMERCIAL_PROP_TYPES.includes(propType)                 ? 'commercial'
    : (price || 0) >= 2500                                     ? 'aesthetics'
    : 'letting'

  // Every aesthetics/letting upload is featured; sales/commercial set manually
  const featured = category === 'aesthetics' || category === 'letting'

  // ── 5. Kimi copywriting ────────────────────────────────────────────────────
  log.info('webPost: calling Kimi', { chars: normText.length })
  const copy = await kimiCopywrite(normText, propType)
  copy.headline = normalizeLocation(copy.headline)

  // ── 6. Upload images to Cloudinary ────────────────────────────────────────
  const uploadedImages = []
  let cloudinaryError = null

  for (const img of imageItems) {
    try {
      const result = await uploadImage(img.buffer, img.mimeType)
      uploadedImages.push(result)
    } catch (err) {
      log.warn('webPost: image upload failed', { err: err.message })
      if (!cloudinaryError) cloudinaryError = err.message
    }
  }

  // Sort images by priority only when at least one image has recognisable tags;
  // otherwise preserve original WhatsApp upload order.
  const hasRankedImages = uploadedImages.some(i => imagePriorityScore(i.tags) > 0)
  if (hasRankedImages) {
    uploadedImages.sort((a, b) => imagePriorityScore(b.tags) - imagePriorityScore(a.tags))
  }
  const imageUrls = uploadedImages.map(i => i.url)

  // ── 7. Build standardised website title + description ────────────────────
  // Title:       "{Location} | €{Price} | {Bedrooms} Bedrooms - {Bathrooms} Bathrooms"
  // Description: cleaned raw text, one phrase per line, bullet-style with leading spaces
  const websiteTitle =
    buildWebsiteTitle({ location, price, bedrooms, bathrooms }) ||
    copy.headline ||
    'Property in Malta'
  const websiteDescription =
    buildWebsiteDescription(stripEmoji(normText)) || copy.fullDescription || ''

  // ── 8. Insert to DB ───────────────────────────────────────────────────────
  const slug = makeSlug(websiteTitle || 'property-malta')
  const ref  = '2906-' + Math.random().toString(36).slice(2, 7).toUpperCase()

  const r = await db.query(
    `INSERT INTO website_properties
       (title, slug, listing_type, price, price_after, price_type,
        bedrooms, bathrooms, size, area, property_type,
        category, location, status, images,
        summary, description, full_description, features,
        property_reference, featured, is_published, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     RETURNING id, slug, property_reference`,
    [
      websiteTitle,                                      // $1  title (standardised)
      slug,                                              // $2
      listingType,                                       // $3
      price || 0,                                        // $4
      listingType === 'For Sale' ? 'total' : 'month',    // $5  price_after
      listingType === 'For Sale' ? 'total' : 'month',    // $6  price_type
      bedrooms ?? null,                                  // $7
      bathrooms ?? 1,                                    // $8
      sqm ?? null,                                       // $9  size
      sqm ?? null,                                       // $10 area
      propType,                                          // $11
      category,                                          // $12
      location || '',                                    // $13
      'available',                                       // $14
      imageUrls,                                         // $15
      copy.summary,                                      // $16 summary (Kimi card preview)
      websiteDescription,                                // $17 description (bullet template)
      websiteDescription,                                // $18 full_description (bullet template)
      copy.features,                                     // $19
      ref,                                               // $20
      featured,                                          // $21 featured flag
      true,                                              // $22 auto-publish
      null,                                              // $23 bot-created
    ]
  )

  const row = r.rows[0]
  const url = `https://2906.estate/property/${row.slug}`

  log.info('webPost: inserted', { id: row.id, ref: row.property_reference, featured, images: imageUrls.length })

  // ── 9. Build reply ────────────────────────────────────────────────────────
  const replyMsg = `✅ Posted to website\n${websiteTitle}\n🔗 ${url}`

  // Cloudinary warning as separate context (logged only — handled by caller)
  return {
    ref,
    url,
    message:          replyMsg,
    cloudinaryError:  cloudinaryError,
    imageCount:       imageUrls.length,
  }
}

module.exports = {
  postPropertyToWebsite,
  // Exported for services/websiteSync.js (Kev, 2026-08-28) — the CRM→website
  // publish bridge reuses the SAME title/description/slug conventions the
  // legacy !postweb flow already established, rather than inventing a
  // second website-formatting style.
  buildWebsiteTitle, buildWebsiteDescription, makeSlug,
}
