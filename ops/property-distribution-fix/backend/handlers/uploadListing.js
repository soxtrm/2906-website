'use strict'
// ============================================================================
// !uploadlisting — SINGLE-SHOT CRM listing creation from a WhatsApp group/DM/Notes.
//
// Behaves like !post: ONE message contains the trigger word `!uploadlisting`,
// the listing content (property details + owner contact, mixed in any order)
// and images. A SINGLE Gemini call extracts BOTH owner and property fields —
// no block splitting, no scoring. Dot/slash separator lines are just stripped.
//
// NO collection window. NO !done. NO !cancel. NO upload_listing_sessions writes.
// Touches NO operational code (!post / AutoAdvertise / outreach / reminders).
// Creates a DRAFT property: published=FALSE (not on public site), but
// available_status='available' so it shows in the CRM inventory immediately.
//
// Tables: owner_contacts / properties / property_activities / locations.
// ============================================================================
const db = require('../db')
const log = require('../logger')
const waha = require('../waha')
const config = require('../config')
const cloudinary = require('cloudinary').v2
const { GoogleGenAI } = require('@google/genai')
const { realSenderJid, phoneFromJid, senderDigits, isLid } = require('../services/senderIdentity')
const { availabilityStatus } = require('../services/futureAvailability')

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

let _ai = null
function getAI() {
  if (_ai) return _ai
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return null
  _ai = new GoogleGenAI({ apiKey })
  return _ai
}

// ── small helpers ─────────────────────────────────────────────────────────────
const digits = (s) => String(s || '').replace(/\D/g, '')
const adminNumbers = (config.admin?.adminNumbers || []).map(digits)
const isAdmin = (phone) => adminNumbers.includes(digits(phone))

function normMaltphone(raw) {
  let p = digits(raw)
  if (p.length === 8 && /^[79]/.test(p)) p = '356' + p
  return p
}
// Resolve the SENDER's phone, tolerant of engines/contexts where the webhook's
// pre-derived senderPhone is empty.
function resolveUploaderPhone(payload, senderPhone, isGroup) {
  const p = normMaltphone(senderPhone)
  if (p) return p
  // LID-safe: prefers key.participantAlt over the @lid participant, and falls
  // back to the LID digits so sender comparisons never break. A group's `from`
  // is the @g.us JID and is never treated as a sender.
  const inGroup = isGroup || String(payload?.from || '').endsWith('@g.us')
  return normMaltphone(senderDigits(payload, inGroup))
}

function calcCompleteness(p, imageCount) {
  let pct = 0
  const req10 = [p.town, p.property_type, p.bedrooms, p.bathrooms,
    (p.longlet_price || p.sale_price), p.available_status, p.available_date, p.description]
  for (const f of req10) if (f !== null && f !== undefined && f !== '') pct += 10
  if (p.street) pct += 5
  if (imageCount >= 1) pct += 5
  if (imageCount >= 3) pct += 5
  if (p.viewing_status && p.viewing_status !== 'none') pct += 5
  if (p.internal_notes) pct += 5
  return Math.min(100, pct)
}

async function reply(session, chatId, text) {
  try { await waha.sendText(session, chatId, text) }
  catch (e) { log.warn('uploadListing reply failed', { err: e.message, chatId }) }
}
async function alertKev(text) {
  try {
    const session = (await waha.pickActiveAdminSession()) || 'default'
    await waha.sendText(session, `${digits(config.admin.botNumber) || '35699811819'}@c.us`, text)
  }
  catch (e) { log.warn('uploadListing alertKev failed', { err: e.message }) }
}

// ── agent resolution (sender phone → agents.whatsapp_phones) ────────────────────
async function resolveAgent(senderPhone) {
  const p = digits(senderPhone)
  if (!p) return null
  const candidates = [p]
  if (p.length === 8 && /^[79]/.test(p)) candidates.push('356' + p)
  const r = await db.query(
    `SELECT id, username, name, display_name, alias, role, post_tag FROM agents WHERE whatsapp_phones && $1::text[] AND active=TRUE LIMIT 1`,
    [candidates])
  return r.rows[0] || null
}
function agentDisplayName(a) {
  return a?.alias || a?.display_name || a?.name || a?.username || 'agent'
}

// Colleague-aware: returns [primary, ...colleagues]. When COLLEAGUE_AGENTS is
// unset and the fallback list is empty, returns just [primary] — i.e. the
// single-agent path is byte-for-byte unaffected. Backwards-compat preserved.
// The implementation lives in services/colleagueAgents.js; re-exported here so
// handlers/upload.js can pick it up alongside the other shared helpers.
const { resolveAgentWithColleagues } = require('../services/colleagueAgents')

// The phone a WAHA session belongs to — authoritative sender for fromMe / Notes.
// Case-insensitive on session_name (live DB has both 'Kevthirdd' and 'kevthirdd'),
// via the shared resolver. READ-ONLY.
async function sessionPhone(sessionName) {
  if (!sessionName) return ''
  try {
    const { findAccountBySessionName } = require('../services/whatsappResolver')
    const row = await findAccountBySessionName(sessionName)
    return row ? digits(row.phone) : ''
  } catch (e) { log.warn('uploadListing sessionPhone lookup failed', { err: e.message }); return '' }
}
// Resolve the sender for EVERY message type (TASK 2):
//   A) fromMe / Notes-to-self → the session's OWN phone (whatsapp_accounts)
//   B) Group                  → key.participantAlt → participant (never `from`)
//   C) DM                     → from
// See services/senderIdentity.js for the @lid handling.
async function extractSenderPhone(payload, sessionName, isGroup) {
  if (payload?.fromMe) {
    const sp = await sessionPhone(sessionName)
    if (sp) return sp
  }
  const inGroup = isGroup || String(payload?.from || '').endsWith('@g.us')
  // LID-safe sender: `participant` is an @lid in most groups now, the real
  // number sits in key.participantAlt. Without this every group upload
  // resolved to "unknown agent" and fell back to the default agent.
  const jid = realSenderJid(payload, inGroup)
  const real = normMaltphone(phoneFromJid(jid))
  if (real) return real
  if (isLid(jid)) {
    // No phone alt at all: keep returning the LID digits (pre-LID behaviour) so
    // sender comparisons still work. Agent lookup simply won't match.
    log.warn('uploadListing: sender is a LID with no phone alt — agent cannot be resolved',
      { jid, session: sessionName })
    return normMaltphone(senderDigits(payload, inGroup))
  }
  // last-resort: webhook-derived / payload fallbacks
  return resolveUploaderPhone(payload, '', isGroup)
}
function sourceLabel(payload, isGroup) {
  if (payload?.fromMe) return isGroup ? 'Group (self)' : 'Notes-to-self'
  return isGroup ? 'Group' : 'DM'
}

// ── image grabbing — SAME mechanism !post uses ──────────────────────────────────
// Download an image from a WAHA NOWEB file URL (localhost → docker-internal host).
async function downloadWahaMedia(url, mimeType) {
  if (!url) return null
  const wahaBase = (config.waha?.url || 'http://waha:3000').replace(/\/$/, '')
  const fixedUrl = url
    .replace(/^https?:\/\/localhost(:\d+)?/, wahaBase)
    .replace(/^https?:\/\/127\.0\.0\.1(:\d+)?/, wahaBase)
  const res = await fetch(fixedUrl, { headers: { 'X-Api-Key': config.waha?.apiKey || '' } })
  if (!res.ok) throw new Error(`Media fetch ${res.status}: ${fixedUrl}`)
  return { buffer: Buffer.from(await res.arrayBuffer()), mimeType: mimeType || 'image/jpeg' }
}
// Returns array of { buffer, mimeType } for a single message — NOWEB (media.url)
// and legacy (mediaData base64). Identical logic to fbPost.getMsgImages.
//
// `kind` is the media family to keep: 'image' (default, the original behaviour)
// or 'video'. Anything else on the message is skipped, so an album of photos
// with one clip in it yields the photos to one call and the clip to the other.
async function getMsgMedia(m, kind = 'image') {
  const prefix = `${kind}/`
  const fallback = kind === 'video' ? 'video/mp4' : 'image/jpeg'
  if (m.media?.url) {
    const mime = m.media.mimetype || fallback
    if (!mime.startsWith(prefix)) return []
    try { const item = await downloadWahaMedia(m.media.url, mime); return item ? [item] : [] }
    catch (err) { log.warn('uploadListing: media download failed', { kind, err: err.message }); return [] }
  }
  const mediaData = m.mediaData || m._data?.mediaData
  if (!mediaData?.data) return []
  const mime = mediaData.mimetype || m.mimetype || fallback
  if (!mime.startsWith(prefix)) return []
  return [{ buffer: Buffer.from(mediaData.data, 'base64'), mimeType: mime }]
}
// Unchanged signature — every existing caller keeps getting images only.
const getMsgImages = (m) => getMsgMedia(m, 'image')
const getMsgVideos = (m) => getMsgMedia(m, 'video')
// Returns { buffer, mimeType } (or null) for a single message's non-image/
// video attachment — a PDF, Excel sheet, Word doc, etc. Same download
// mechanism as getMsgMedia above (WAHA media.url, or legacy base64
// mediaData) but WITHOUT the image/video mimetype-prefix filter: a
// document's mimetype is never one fixed family ahead of time
// (application/pdf, .xlsx, .docx, ...), so getMsgMedia's `${kind}/` prefix
// match can't be reused as-is for this case. Added for owner-conversation
// file-first intake (Kev, 2026-09-22 hotfix) — autoOwnerConversation.js.
async function getMsgDocument(m) {
  if (m.media?.url) {
    const mime = m.media.mimetype || 'application/octet-stream'
    try { return await downloadWahaMedia(m.media.url, mime) }
    catch (err) { log.warn('uploadListing: document download failed', { err: err.message }); return null }
  }
  const mediaData = m.mediaData || m._data?.mediaData
  if (!mediaData?.data) return null
  const mime = mediaData.mimetype || m.mimetype || 'application/octet-stream'
  return { buffer: Buffer.from(mediaData.data, 'base64'), mimeType: mime }
}
async function uploadBuffer(buffer, mimeType) {
  try {
    const res = await cloudinary.uploader.upload(`data:${mimeType};base64,${buffer.toString('base64')}`, {
      folder: '2906-properties',
      transformation: [{ width: 1600, crop: 'limit', quality: 'auto', fetch_format: 'auto' }],
    })
    return res.secure_url
  } catch (e) { log.warn('uploadListing image upload failed', { err: e.message }); return null }
}
// Videos need resource_type:'video' — the default 'image' pipeline rejects them
// outright — and no image transformation (it would strip the audio track).
// upload_large chunks the body, so a 40 MB clip does not go out as one request.
async function uploadVideoBuffer(buffer, mimeType) {
  try {
    const res = await cloudinary.uploader.upload_large(
      `data:${mimeType || 'video/mp4'};base64,${buffer.toString('base64')}`, {
        folder: '2906-properties/videos',
        resource_type: 'video',
        chunk_size: 6_000_000,
      })
    return res.secure_url
  } catch (e) { log.warn('uploadListing video upload failed', { err: e.message }); return null }
}
function getMsgBody(m) {
  return (m.body || m.caption || m._data?.body || m._data?.caption || '').toString().trim()
}
// Looks like one of OUR own bot replies (so we never gather them as content).
//
// 2026-08-20: missing `📂 #` here is why a post's TOP line and its bottom
// "REF #..." line disagreed by exactly one property. handlers/upload.js's
// formatDistributionResult() replies into the SAME chat after each listing
// ("📂 #2906-147 → Villas Houses"), sent via the same account the agent
// uploads from — sameSender() above treats that as "same sender" for both
// the fromMe/Notes case and the same-phone-in-group case, so this regex was
// the only thing that could have caught it. The next listing, if created
// within WINDOW_SECONDS (10 min — routine for a batch upload), swept that
// leftover "📂 #<previous ref> → category" line into ITS OWN gathered
// rawText, which is stored verbatim as description_social (upload.js:319-327)
// — the wrong, off-by-one number at the top of the post. The bottom
// "REF #..." (categoryFormatter.js) was always reading properties.ref
// correctly; nothing there needed to change. Same shape already guarded
// against for command-dispatch in handlers/upload.js:1158 — this brings the
// content-gathering guard in line with it.
function looksLikeBotReply(body) {
  return /✅ Listing #|❌ Could not identify|📇 Agent phones|❌ No listing content|crm\.2906\.estate\/property\/|📂 #/.test(body || '')
}
// LID-safe, and MUST use the same resolution as extractSenderPhone() — the
// gatherer compares the two ("did the uploader write this message?"). If one
// side returned a real phone and the other an @lid, nothing would ever match
// and every upload would report "no listing content".
const msgSenderPhone = (m) => normMaltphone(senderDigits(m, String(m?.from || '').endsWith('@g.us')))
const WINDOW_SECONDS = 600 // 10 minutes (TASK: never extend beyond 10 min)
// Deliberately lower than the 15-image cap: each clip is a Cloudinary upload
// plus an ffmpeg re-encode per WhatsApp group, so a 10-video listing would
// stall the whole distribution cycle.
const MAX_VIDEO_ITEMS = 3

// Per-chat de-dup: don't re-gather messages from before the last successful
// creation in this chat. In-memory (exact for this process) + a DB backstop
// (most recent property_created_via_upload in this chat) for after a restart.
const _lastProcessed = new Map()
async function getLastProcessedTs(chatId, triggerTs) {
  let ts = _lastProcessed.get(chatId) || 0
  try {
    // Kev, 2026-08-28: also floor on !picup pickups in this chat — !picup
    // reuses this same window-gather (handlers/upload.js gatherQuotedPhotos),
    // and without this a !picup shortly after another !picup (or !upload) in
    // the same chat would re-collect photos already consumed by the first one.
    const r = await db.query(
      `SELECT EXTRACT(EPOCH FROM MAX(created_at))::bigint AS ts
         FROM property_activities
        WHERE activity_type IN ('property_created_via_upload', 'photos_added_via_picup')
          AND details->>'chat'=$1`, [chatId])
    const dbts = Number(r.rows[0]?.ts || 0)
    // guard against server-TZ skew: only trust a DB floor that is sane (<= now)
    if (dbts > 0 && dbts <= triggerTs && dbts > ts) ts = dbts
  } catch (e) { log.warn('uploadListing getLastProcessedTs failed', { err: e.message }) }
  return ts
}

// Gather listing content like !post does — but scoped to the SAME SENDER in the
// SAME CHAT within the last 10 minutes, excluding the command msg, bot replies,
// other commands, and anything already consumed by a prior !uploadlisting.
// Returns { combinedText, imageItems, priorCount, windowStart }.
// `allUploadImages` is reserved for the two property-creation commands. It
// widens the history read and removes the legacy 15-photo trim for that one
// upload only. Callers such as !picup and !wupload keep the smaller bounded
// batch they were designed around.
async function gatherContent(payload, session, chatId, isGroup, uploaderPhone, triggerTs, { allUploadImages = false } = {}) {
  const cmdId = String(payload.id || payload.key?.id || '')
  const cmdFromMe = !!payload.fromMe
  const lastTs = await getLastProcessedTs(chatId, triggerTs)
  const windowStart = Math.max(triggerTs - WINDOW_SECONDS, lastTs)

  const sameSender = (m) => {
    if (cmdFromMe) return m.fromMe === true              // Notes / self → fromMe content
    if (isGroup) return msgSenderPhone(m) === uploaderPhone
    return m.fromMe === false                            // DM → the other party
  }

  let msgs = []
  const historyLimit = allUploadImages ? 80 : 30
  try { msgs = await waha.getChatMessagesWithMedia(session, chatId, historyLimit) }
  catch (e) { log.warn('uploadListing: getChatMessages failed', { err: e.message }) }

  const prior = msgs
    .filter(m => {
      const mid = String(m.id || m.key?.id || '')
      if (mid && mid === cmdId) return false
      const ts = m.timestamp || m._data?.t || 0
      if (!ts || ts <= windowStart || ts > triggerTs) return false
      const body = getMsgBody(m)
      if (body.startsWith('!')) return false             // commands aren't content
      if (looksLikeBotReply(body)) return false
      return sameSender(m)
    })
    .sort((a, b) => (a.timestamp || a._data?.t || 0) - (b.timestamp || b._data?.t || 0))

  // text: prior messages (chronological) + the command message's own inline text
  const parts = prior.map(getMsgBody).filter(Boolean)
  const inline = getMsgBody(payload)
  if (inline) parts.push(inline)
  const combinedText = parts.join('\n')

  // media: command payload's own + each prior message's, deduped by message id.
  // Images and videos are gathered in the SAME pass — a listing that arrives as
  // "8 photos + 1 walkthrough clip" must not lose the clip.
  const imageItems = []
  const commandImageItems = []
  const priorMessageImages = []
  const videoItems = []
  const seen = new Set()
  if (cmdId) seen.add(cmdId)
  commandImageItems.push(...await getMsgImages(payload))
  imageItems.push(...commandImageItems)
  videoItems.push(...await getMsgVideos(payload))
  for (const m of prior) {
    const mid = String(m.id || m.key?.id || '')
    if (mid && seen.has(mid)) {
      priorMessageImages.push([])
      continue
    }
    if (mid) seen.add(mid)
    const messageImages = await getMsgImages(m)
    priorMessageImages.push(messageImages)
    imageItems.push(...messageImages)
    videoItems.push(...await getMsgVideos(m))
  }

  // priorMessages is additive (used by handlers/upload.js for positional
  // image↔listing association) — existing callers ignore it. So is videoItems.
  // imageItemsRawCount is additive too (Kev, 2026-09-03: !picup always
  // reporting exactly 15 photos, every single time, across 4 different real
  // calls checked in property_activities — the 15-cap was silently eating
  // whatever came after it with no signal to the caller that anything was
  // dropped). Existing callers that only read imageItems/videoItems are
  // unaffected; handlers/upload.js's !picup path uses this to tell the
  // operator when more photos exist than the cap could carry.
  return {
    combinedText,
    imageItems: allUploadImages ? imageItems : imageItems.slice(0, 15),
    imageItemsRawCount: imageItems.length,
    videoItems: videoItems.slice(0, MAX_VIDEO_ITEMS),
    priorCount: prior.length, windowStart, priorMessages: prior,
    // Exact first-pass media groups for deterministic multi-property image
    // assignment. Keeping them beside priorMessages avoids downloading the
    // same WhatsApp media a second time and makes count verification exact.
    commandImageItems,
    priorMessageImages,
  }
}

// ── TASK 2 — preprocess the raw message into a clean content blob ───────────────
function preprocessUploadText(rawBody) {
  let text = rawBody || ''
  // strip the command tag (case-insensitive)
  text = text.replace(/!uploadlisting/gi, '')
  // strip lines that are ONLY dots or slashes (outer markers OR inner separators —
  // we don't use them to split; just remove them)
  text = text.split('\n').filter(line => !/^\s*[.\/]+\s*$/.test(line)).join('\n')
  // collapse 3+ blank lines
  text = text.replace(/\n{3,}/g, '\n\n').trim()
  return text
}

// ── TASK 3 — ONE Gemini call extracts owner + property together ─────────────────
function buildExtractPrompt(cleanedText) {
  const todayStr = new Date().toISOString().slice(0, 10)
  return `You are extracting real estate listing data from a WhatsApp message.

The message contains BOTH property details AND owner contact info, mixed in any order. Extract everything into a structured JSON.

RULES — ABSOLUTE:
- A phone number (lines with +356, +49, +44, or 7-15 digits) is OWNER CONTACT. Never put it in property.description.
- An email (anything@anything.tld) is OWNER CONTACT.
- A bare name (just letters + optional spaces, no numbers, looks like a human name e.g. 'Joseph Cassar', 'Maria Borg') is OWNER NAME.
- Bedroom/bathroom counts (3BR, 2 beds, "2 Double Bedrooms", "3 Single Beds", etc.) go to property.beds/baths — the count is the NUMBER even when a descriptive word (Double/Single/Master/Twin) sits between it and "bedroom(s)".
- Price (€2500/mo, €450000, EUR 1800) goes to property.longlet_price or property.sale_price. A short-let monthly rate (e.g. "€1,500/month" on a listing also marked short-let) still goes to property.longlet_price — it is the only rent-amount field this schema has, regardless of lease length.
- Malta locations (Sliema, Valletta, St Julian's, Mellieha, Swieqi, etc.) go to property.location.
- A SPECIFIC street-level address — a house/building number or named building plus a street (e.g. "45 Tower Road", "Fawwara Court, Triq il-Kbira", "Block 3, Flat 12, Manoel Dimech Street") — goes to property.street. A bare town/area name alone ("Sliema", "St Julian's") is NOT a street address — leave property.street empty in that case.
- Available date goes to property.available_date in ISO format YYYY-MM-DD. TODAY is ${todayStr} — a bare day/month with no year ("Available from 1st December", "from Dec 1") means the NEXT occurrence of that date on or after TODAY (e.g. if today is in September 2026, "1st December" is 2026-12-01, never a past or training-data year). A date that has already passed this year means next year's occurrence. An explicit year in the text always wins.
- shortlet_available: true when the text says short-let/short term/temporary/flexible-period rental, or gives a lease length under 12 months. false/omit for a normal long-let.
- shortlet_duration_min_months / shortlet_duration_max_months: when shortlet_available is true AND the text states or implies a duration range (e.g. "3 to 6 months" -> min 3, max 6; "up to 4 months" -> min null, max 4; a single fixed duration -> min and max the same number). Plain integers, null if no duration is given at all.
- Features (sea view, parking, furnished, AC, balcony) go to property.features array.
- Everything else descriptive about the property goes to property.description as PLAIN TEXT (no emojis, no icons — strip all emoji from description text).

Return ONLY this JSON, no other text, no markdown fences:
{
  "owner": {
    "name": "" or "Joseph Cassar",
    "phones": ["35699123456", "35679987654"],
    "email": "" or "foo@bar.com"
  },
  "property": {
    "location": "Sliema",
    "street": "" or "45 Tower Road",
    "type": "apartment" | "penthouse" | "house" | "maisonette" | "commercial",
    "beds": 3,
    "baths": 2,
    "sqm": 0,
    "longlet_price": 2500,
    "sale_price": 0,
    "shortlet_available": false,
    "shortlet_duration_min_months": 3,
    "shortlet_duration_max_months": 6,
    "available_date": "2026-07-01" or null,
    "description": "Plain text description without emojis or icons.",
    "features": ["sea view", "parking", "furnished"]
  }
}

Use 0 / null / empty string for missing fields. Phones array as digits only (normalize: '+356 9949 3214' -> '35699493214').

TODAY: ${todayStr}

INPUT MESSAGE:
${cleanedText}`
}

// CRITICAL EXTRACTION BUG (Kev, 2026-09-16, live incident #2906-9304): the
// prompt above now anchors "today" so Gemini stops guessing a training-data
// year for a bare day/month ("1st December" came back as 2024-12-01 while
// this ran in September 2026 — a stale year over a year and a half in the
// past). This is the deterministic backstop for whenever it still happens
// (a model hiccup, an explicit-but-wrong year in the source text) --
// exactly the "never invent, mark unknown instead" rule every other guard
// in this file already follows: a date that is implausibly far in the past
// for a BRAND NEW listing is worth losing rather than silently publishing.
// A few days in the past is left alone (an owner reporting "available since
// Monday" for an already-vacant unit is real and correct); anything older
// than that is almost never a genuine fact about a listing being uploaded
// today.
const AVAILABLE_DATE_PAST_GRACE_DAYS = 14
function guardAvailableDate(dateStr) {
  if (!dateStr) return null
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return null
  const graceMs = AVAILABLE_DATE_PAST_GRACE_DAYS * 86400_000
  if (d.getTime() < Date.now() - graceMs) {
    log.warn('uploadListing: available_date implausibly far in the past for a new listing — dropping to unknown rather than publishing a stale year', { rejected: dateStr })
    return null
  }
  return dateStr
}

// Deterministic — the LLM only ever supplies the duration NUMBER(s) (spec
// principle: deterministic services compute hard facts, the model
// interprets intent). available_until = available_date + N calendar months,
// only when both a start date and a shortlet duration are actually known.
//
// Kev, 2026-09-16 ("bei winterlet standardmäßig bis April machen nicht
// Juni"): defaults to the MINIMUM stated duration, not the maximum — "3 to
// 6 months" means the property is confirmed free again as early as month 3,
// and treating it as tied up until month 6 understates how soon it's back
// on the market (Malta's own winter-let convention runs roughly Oct-April,
// the shorter end of a typical "3 to 6 months from December" range, not the
// longer one). Falls back to max only when no minimum was ever stated.
function computeAvailableUntil(availableDate, durationMinMonths, durationMaxMonths) {
  const months = Number(durationMinMonths ?? durationMaxMonths)
  if (!availableDate || !Number.isFinite(months) || months <= 0) return null
  const d = new Date(availableDate + 'T00:00:00Z')
  if (Number.isNaN(d.getTime())) return null
  d.setUTCMonth(d.getUTCMonth() + Math.round(months))
  return d.toISOString().slice(0, 10)
}

// ── property field sanity guard (Kev, 2026-09-15: "never publish absurd
// counts" -- 28 bathrooms, 12 bedrooms on a €1,350 apartment) ──────────────
// Lives here, on extractListing()'s own output, because this ONE function is
// already the shared choke point both !upload (handlers/upload.js
// createListing()) and !uploadlisting call -- so canonical listing render,
// AV Central review, CRM auto-upload and Match Engine activation all
// inherit this automatically. No second copy needed anywhere else.
//
// Two independent rules:
//  1. SEMANTIC BINDING (always on, any price): Gemini's beds/baths number is
//     only trusted if the source text itself actually says "N bed(room)s" /
//     "N bath(room)s" (digit or spelled-out) -- a bare number elsewhere
//     (a phone digit, a price fragment, an unrelated count) must never
//     become a bed/bath count just because it landed in that JSON key.
//  2. PLAUSIBILITY (price-gated, per Kev's exact rule): price < €5,000/mo
//     AND count > 5 is treated as suspicious and dropped to unknown, even
//     if rule 1 found a real "N bedrooms" mention -- at that price a "12
//     bedrooms" mention is almost always a misread house/unit number, not
//     a real fact. Price is ONLY ever a trigger to distrust, never a
//     source of the actual number (no <€2000=1bath inference, ever).
const SPELLED_NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }
const PLAUSIBLE_MAX_COUNT = 5
const SUSPICIOUS_PRICE_CEILING = 5000

// CRITICAL EXTRACTION BUG (Kev, 2026-09-16, live incident #2906-9304): this
// regex required the number to sit IMMEDIATELY before the label ("2
// bedrooms"), with at most one space/hyphen between them. "2 Double
// Bedrooms" -- standard Malta rental phrasing, distinguishing a double-bed
// room from a single -- has an extra descriptive word in between and never
// matched at all. Gemini extracted beds=2 correctly; this guard then found
// ZERO corroborating mentions for it (the real mention existed, the regex
// just couldn't see it) and nulled out a completely correct answer,
// publishing a 2-bedroom apartment with bedrooms=NULL and, downstream,
// routing it to the wrong category-group bucket. Now tolerates one optional
// descriptive word (double/single/master/twin/en-suite) between the number
// and the label -- the only other order Malta listings actually use.
function findLabeledCounts(text, labelRe) { return findLabeledMentions(text, labelRe).map(x => x.n) }

// Same scan, but keeps the words each number came from (provenance evidence).
function findLabeledMentions(text, labelRe) {
  const found = []
  const numWord = Object.keys(SPELLED_NUMBERS).join('|')
  // Number BEFORE the label -- "2 bathrooms" / "2 bath" / "two bathrooms" /
  // "2 Double Bedrooms" / "3 Single Beds" -- the orders a human actually
  // writes this in.
  const re = new RegExp(`\\b(\\d{1,2}|${numWord})\\s*[- ]?(?:double|single|master|twin|en-?suite)?\\s*[- ]?(?:${labelRe})\\b`, 'gi')
  let m
  while ((m = re.exec(text || '')) !== null) {
    const raw = m[1].toLowerCase()
    const n = SPELLED_NUMBERS[raw] ?? parseInt(raw, 10)
    if (Number.isFinite(n)) found.push({ n, snippet: m[0].trim() })
  }
  return found
}

// Rule 1 alone -- confidence is 'explicit' only when Gemini's own number is
// itself one of the corroborated mentions; 'inferred' when the source has
// exactly one OTHER labeled count we can fall back to instead ("if a
// confident corrected value exists in the source, use it" — Kev's spec);
// 'none' when nothing in the text backs up any number at all.
// BEDROOMS / BATHROOMS ONLY FROM EXPLICIT EVIDENCE (2026-09-21) — replaces the
// rule described above. Confidence and what it means downstream:
//   'explicit'    the text says "N bedrooms" and Gemini's number is that N — or the
//                 stated parts add up to it ("1 double + 1 single" = 2) — or the
//                 text states exactly one count and Gemini disagreed (text wins)
//   'conflicting' two DIFFERENT multi-bedroom counts in the text ("3 bedroom …
//                 2 bedroom …"), or a count that neither matches Gemini's number nor
//                 explains it → value null = UNKNOWN for matching and categories,
//                 never a pick
//   'none'        no usable evidence → value null
// Removed: the 'inferred' branch, which adopted "the only other number in the
// text" even when it was one half of a layout ("one double bedroom + one single
// bedroom" became 1 bedroom).
function sanitizeCount(rawValue, text, labelRe) {
  const extracted = Number(rawValue)
  const hasExtracted = Number.isFinite(extracted) && extracted > 0
  if (!hasExtracted) return { value: null, confidence: 'none' }

  const mentions = findLabeledMentions(text, labelRe)
  if (!mentions.length) return { value: null, confidence: 'none' }
  const counts = mentions.map(x => x.n)
  const distinct = [...new Set(counts)]
  const quoted = mentions.map(x => x.snippet).slice(0, 4)

  if (distinct.filter(n => n >= 2).length > 1) {
    return { value: null, confidence: 'conflicting', evidence: quoted.join(' | ') }
  }
  const hit = mentions.find(x => x.n === extracted)
  if (hit) return { value: extracted, confidence: 'explicit', evidence: hit.snippet }
  if (counts.length >= 2 && counts.reduce((a, b) => a + b, 0) === extracted) {
    return { value: extracted, confidence: 'explicit', evidence: quoted.join(' + ') }
  }
  // ROOT CAUSE (Kev, 2026-09-23, live incident #2906-9343): this used to be
  // `counts.length === 1` -- exactly ONE raw mention -- so a listing that
  // states "2 bedrooms" FOUR times (once as "2 Bedrooms", once as
  // "2-bedroom", twice more the same way) had counts.length === 4 and fell
  // through to 'conflicting' below, discarding a completely unambiguous
  // fact just because Gemini's own number that turn didn't happen to match
  // any of them. The header comment above already documents the intended
  // behaviour ("the text states exactly one count and Gemini disagreed —
  // text wins") — this was simply checking the wrong thing: how many
  // mentions exist, not how many DISTINCT values they agree on. Any number
  // of repeated mentions of the SAME value is exactly as unambiguous as one
  // mention of it.
  if (distinct.length === 1) return { value: distinct[0], confidence: 'explicit', evidence: quoted.join(' | ') }
  return { value: null, confidence: 'conflicting', evidence: quoted.join(' | ') }
}

function guardPropertyCounts(property, sourceText) {
  const price = Number(property.longlet_price) || Number(property.sale_price) || 0
  const priceIsLow = price > 0 && price < SUSPICIOUS_PRICE_CEILING

  const beds  = sanitizeCount(property.beds,  sourceText, 'bed(?:room)?s?')
  const baths = sanitizeCount(property.baths, sourceText, 'bath(?:room)?s?|wcs?')

  for (const [key, result] of [['beds', beds], ['baths', baths]]) {
    if (result.value != null && priceIsLow && result.value > PLAUSIBLE_MAX_COUNT) {
      log.warn('uploadListing: implausible count at this price — marking unknown rather than publishing it', {
        field: key, value: result.value, price, confidence: result.confidence,
      })
      result.value = null
      result.confidence = 'none'
    }
  }

  property.beds = beds.value
  property.baths = baths.value
  // Not persisted as a DB column (properties has flat beds/baths scalars,
  // no per-field confidence schema) -- carried on the in-memory object only,
  // for anything downstream in THIS request (e.g. a "⚠ needs review"
  // annotation on the !categorytest dry-run) that wants to know a count was
  // downgraded rather than genuinely absent from the source.
  property._fieldConfidence = { beds: beds.confidence, baths: baths.confidence }
  // the quoted words the number rests on — persisted as provenance after the insert
  property._fieldEvidence = { beds: beds.evidence || null, baths: baths.evidence || null }
  return property
}

function deterministicListingFallback(cleanedText) {
  const text = String(cleanedText || '')
  const phones = [...text.matchAll(/(?:\+|00)?\d[\d ()-]{6,}\d/g)]
    .map(m => normMaltphone(m[0])).filter((p, i, all) => p.length >= 8 && all.indexOf(p) === i)
  if (!phones.length) return null
  const lineValue = label => text.match(new RegExp(`(?:^|\\n)\\s*(?:${label})\\s*[:\\-]\\s*([^\\n]+)`, 'i'))?.[1]?.trim() || ''
  const count = words => Number(text.match(new RegExp(`\\b(\\d{1,2})\\s*(?:${words})\\b`, 'i'))?.[1]) || 0
  const type = text.match(/\b(penthouse|maisonette|apartment|flat|house|villa|studio|commercial|office|retail|warehouse)\b/i)?.[1]?.toLowerCase() || ''
  const euro = [...text.matchAll(/(?:€|EUR\s*)([\d,.]+)/gi)].map(m => Number(m[1].replace(/,/g, ''))).filter(Number.isFinite)
  const price = euro[0] || 0
  const sale = /\b(?:for sale|sale price|selling)\b/i.test(text) || price >= 50000
  const location = lineValue('location|locality|town|area')
  const ownerName = lineValue('owner|contact(?: name)?|landlord')
  const email = text.match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0] || ''
  return {
    owner: { name: ownerName, phones, email },
    property: {
      location, street: lineValue('address|street'), type: type === 'flat' ? 'apartment' : type,
      beds: count('beds?|bedrooms?|br'), baths: count('baths?|bathrooms?'),
      sqm: count('m²|sqm|square metres?|square meters?'),
      longlet_price: sale ? 0 : price, sale_price: sale ? price : 0,
      shortlet_available: /\bshort[ -]?let|short term|holiday let\b/i.test(text),
      shortlet_duration_min_months: null, shortlet_duration_max_months: null,
      available_date: null, description: stripPhonesFromText(stripEmoji(text)), features: [],
    },
  }
}

// Returns { owner, property } or null. Each remote attempt is bounded; if both
// models fail, explicit source facts still create a reviewable draft.
async function extractListing(cleanedText) {
  const ai = getAI()
  if (!cleanedText) return null
  if (!ai) return deterministicListingFallback(cleanedText)
  const prompt = buildExtractPrompt(cleanedText.slice(0, 3000))
  for (const model of ['gemini-2.5-flash', 'gemini-flash-latest']) {
    try {
      const r = await Promise.race([
        ai.models.generateContent({
          model,
          contents: prompt,
          config: { temperature: 0, maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 } },
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('extract timeout after 12s')), 12000)),
      ])
      const j = JSON.parse((r.text || '').replace(/```json|```/g, '').trim())
      if (j && typeof j === 'object' && j.owner && j.property) {
        j.property = guardPropertyCounts(j.property, cleanedText)
        log.info('uploadListing: extracted via Gemini', { model })
        return j
      }
    } catch (e) {
      log.warn('uploadListing extractListing failed', { model, err: e.message })
    }
  }
  const fallback = deterministicListingFallback(cleanedText)
  if (fallback) log.warn('uploadListing: Gemini unavailable — deterministic explicit-facts fallback used')
  return fallback
}

async function matchLocation(name) {
  if (!name) return null
  const resolved = await require('../services/localityResolver').resolveLocality(name)
  return resolved.status === 'RESOLVED' ? resolved.canonical_name : null
}

async function nextRef() {
  return require('../services/propertyRef').nextRef(db)
}

// ── TASK 4 — validation helpers ─────────────────────────────────────────────────
// Normalize each phone to digits; drop <8 digits; Maltese 8-digit (7/9) → prepend 356.
function normPhones(arr) {
  const out = []
  for (const raw of (Array.isArray(arr) ? arr : [])) {
    let d = String(raw).replace(/\D/g, '')
    if (d.length === 8 && /^[79]/.test(d)) d = '356' + d
    if (d.length >= 8 && !out.includes(d)) out.push(d)
  }
  return out
}
// Gemini sometimes mislabels — a name must not carry €/$, 5+ digit numbers, or BR/bed.
function nameIsBad(name) {
  if (!name) return false
  return /[€$]/.test(name) || /\d{5,}/.test(name) || /\bbr\b|bed/i.test(name)
}
function stripEmoji(s) {
  return String(s || '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
// Remove phone-like runs (8+ digits w/ optional separators / leading +) from text.
function stripPhonesFromText(s) {
  return String(s || '')
    .replace(/\+?\d[\d\s().\-]{6,}\d/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim()
}

// ── main webhook entry — SINGLE SHOT ─────────────────────────────────────────────
// Returns true if the message was consumed by this feature (caller stops).
async function handleWebhookMessage({ payload, session, text, isGroup, chatId, senderPhone, hasMedia }) {
  const t = (text || '').trim()
  const lower = t.toLowerCase()

  // ── !agentphone (admin only) — manage agent ↔ phone mapping ────────────────
  if (lower.startsWith('!agentphone')) {
    if (!isAdmin(senderPhone)) { await reply(session, chatId, '❌ Admin only.'); return true }
    await agentPhoneCommand(session, chatId, t)
    return true
  }

  // Never act on the bot's OWN confirmation message (fromMe echo into Notes).
  if (t.includes('✅ Listing #')) return false

  // ── !uploadlisting (case-insensitive, anywhere in the message) → single shot ──
  if (!lower.includes('!uploadlisting')) return false

  // Sender works for Notes-to-self (fromMe → session phone), Group (participant)
  // and DM (from). Falls back to the webhook-derived phone if all else fails.
  let uploaderPhone = await extractSenderPhone(payload, session, isGroup)
  if (!uploaderPhone) uploaderPhone = resolveUploaderPhone(payload, senderPhone, isGroup)
  const agent = await resolveAgent(uploaderPhone)

  // ── TASK 4 diagnostic (before any further return) ─────────────────────────
  log.info('[uploadlisting]', {
    text: t.slice(0, 80),
    from: payload.from,
    participant: payload.participant,
    fromMe: !!payload.fromMe,
    chatId,
    session,
    extracted_sender: uploaderPhone,
    matched_agent: agent?.username || 'NONE',
  })

  // !uploadlisting is OPEN TO ALL — no admin/agent gate. If the sender matches a
  // registered agent → attribute to them. If NOT → fall back to Kevin (admin,
  // default owner of historical data) and DM Kev's default session so the listing
  // can be reassigned via the CRM dropdown.
  let effectiveAgent = agent
  let fallbackToKev = false
  if (!effectiveAgent) {
    fallbackToKev = true
    log.warn(`[uploadlisting] no agent match for sender ${uploaderPhone || '?'}, defaulting to kevin`)
    const kr = await db.query(
      `SELECT id, username, name, display_name, alias, role FROM agents WHERE LOWER(username)='kev' AND active=TRUE LIMIT 1`)
    effectiveAgent = kr.rows[0] || null
    if (!effectiveAgent) {
      log.error('[uploadlisting] kev fallback agent not found — cannot create listing')
      await reply(session, chatId, '⚠️ Upload failed: default agent not configured.')
      return true
    }
  }

  try {
    const result = await processUpload({ payload, session, chatId, text: t, agent: effectiveAgent, senderPhone: uploaderPhone, isGroup })
    if (fallbackToKev && result && result.ref) {
      await alertKev(
        `⚠️ !uploadlisting used by unrecognized sender ${uploaderPhone || '?'} in chat ${chatId}. ` +
        `Listing #${result.ref} created and assigned to Kevin. ` +
        `Use the CRM dropdown to reassign if needed.`)
    }
  } catch (e) {
    log.error('uploadListing process failed', { err: e.message })
    await reply(session, chatId, `⚠️ Upload failed: ${e.message}`)
  }
  return true
}

// Diagnostic error reply: shows what arrived vs what the DB holds.
async function unknownAgentReply(payload, session, isGroup, extractedPhone) {
  let agentLines = '  (could not read agents table)'
  try {
    const r = await db.query(`SELECT username, whatsapp_phones FROM agents WHERE active=TRUE ORDER BY id`)
    agentLines = r.rows
      .map(a => `  • ${a.username}: ${(a.whatsapp_phones || []).join(', ') || '—'}`)
      .join('\n')
  } catch (e) { log.warn('uploadListing unknownAgentReply agents query failed', { err: e.message }) }
  return [
    '❌ Could not identify sender as registered agent.',
    '',
    'Detected:',
    `  • Source: ${sourceLabel(payload, isGroup)}`,
    `  • Session: ${session || '—'}`,
    `  • Sender phone: ${extractedPhone || '—'}`,
    '',
    'Registered agents:',
    agentLines,
    '',
    'If the sender should be an agent, run:',
    `  !agentphone <username> add ${extractedPhone || '<phone>'}`,
  ].join('\n')
}

async function processUpload({ payload, session, chatId, text, agent, senderPhone, isGroup }) {
  const triggerTs = payload.timestamp || payload._data?.t || Math.floor(Date.now() / 1000)

  // Gather content like !post: command msg + same-sender messages in this chat
  // from the last 10 min (excluding already-processed / bot replies / commands).
  const gathered = await gatherContent(payload, session, chatId, isGroup, senderPhone, triggerTs,
    { allUploadImages: true })
  const cleanText = preprocessUploadText(gathered.combinedText)

  // ── diagnostic ──────────────────────────────────────────────────────────────
  log.info('[uploadlisting] gathered', {
    command_msg_id: String(payload.id || payload.key?.id || ''),
    chat_id: chatId,
    sender: senderPhone,
    prior_messages_count: gathered.priorCount,
    text_chars: cleanText.length,
    image_count: gathered.imageItems.length,
    time_window_start: gathered.windowStart,
  })

  if (!cleanText) {
    await reply(session, chatId,
      '❌ No listing content in last 10 minutes.\n' +
      'Send description + owner details + images first, then !uploadlisting.')
    return
  }

  // TASK 4 — single Gemini extraction of owner + property
  const ex = await extractListing(cleanText)
  if (!ex) { await reply(session, chatId, '⚠️ Could not read the listing (extractor unavailable). Please try again in a moment.'); return }
  const o = ex.owner || {}
  const p = ex.property || {}

  // ── TASK 4 validation ──────────────────────────────────────────────────────
  // (5) phones normalized to digits
  const phones = normPhones(o.phones)
  // (1) at least one phone
  if (!phones.length) { await reply(session, chatId, '❌ No phone in message.'); return }

  // (3) name must not carry €/digits/BR/bed → blank it if it does
  let ownerName = String(o.name || '').trim()
  if (nameIsBad(ownerName)) ownerName = ''
  const ownerEmail = (String(o.email || '').trim().match(/[\w.+-]+@[\w.-]+\.\w+/) || [null])[0]

  // property fields (0/empty → null)
  const beds  = Number(p.beds)  > 0 ? Math.round(Number(p.beds))  : null
  const baths = Number(p.baths) > 0 ? Math.round(Number(p.baths)) : null
  const sqm   = Number(p.sqm)   > 0 ? Number(p.sqm)               : null
  const longlet = Number(p.longlet_price) > 0 ? Number(p.longlet_price) : null
  const sale    = Number(p.sale_price)    > 0 ? Number(p.sale_price)    : null
  const shortlet = !!p.shortlet_available
  // Kev, 2026-09-16: lease_type derived from shortlet_available at write
  // time — this used to only exist as a one-time backfill (migration
  // 20260916_argus_match_engine_v3.sql) for rows that already existed; any
  // new upload kept defaulting to 'long_let' regardless of what shortlet
  // actually said (real incident: #2906-9304, shortlet=true but
  // lease_type stayed 'long_let', so it never got the winter/short-let
  // snowflake marking or the !match exclusion that depends on it).
  const leaseType = shortlet ? 'short_let' : 'long_let'
  // RENTAL MODES (2026-09-21): only from explicit wording in the ad; nothing explicit →
  // NULL (derived from lease_type, settable by a person). Never guessed.
  const rentalModesSvc = require('../services/rentalModes')
  const rentalCls = rentalModesSvc.classifyFromText(cleanText)
  const rentalModesVal = rentalCls.modes.length ? rentalCls.modes : null
  const leaseTypeFinal = rentalModesVal ? rentalModesSvc.legacyLeaseType(rentalModesVal) : leaseType
  // CANONICAL FEATURE TAGS (Kev, 2026-09-23) — same contract as handlers/
  // upload.js's own wiring; see featureTags.js and extractionProvenance.js.
  const featureTagsCls = require('../services/featureTags').classifyFromText(cleanText)
  const featureTagsVal = featureTagsCls.tags.length ? featureTagsCls.tags : null
  const availableDateRaw = (typeof p.available_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.available_date))
    ? p.available_date : null
  const availableDate = guardAvailableDate(availableDateRaw)
  // Deterministic — see computeAvailableUntil's own comment. Only computed
  // for a genuine short-let with both a start date and a stated duration;
  // never invented otherwise.
  const availableUntil = shortlet ? computeAvailableUntil(availableDate, p.shortlet_duration_min_months, p.shortlet_duration_max_months) : null
  const ptype = String(p.type || 'apartment').toLowerCase()
  const features = Array.isArray(p.features) ? p.features.filter(Boolean).map(String) : []
  // (4) description: strip emojis AND any phone-like patterns that leaked in
  let description = stripPhonesFromText(stripEmoji(p.description || '')) || null

  // location: exact/fuzzy match; if unmatched keep the raw value but flag for admin
  let town = await matchLocation(p.location)
  let locationUnmatched = false
  if (!town && p.location) { town = String(p.location).trim(); locationUnmatched = true }

  // (2) property must have at least one of location / beds / price
  if (!town && beds == null && longlet == null && sale == null) {
    await reply(session, chatId, '❌ Property details not detected.'); return
  }

  // images — upload the gathered buffers (command msg + prior window) to Cloudinary
  const images = []
  for (const it of gathered.imageItems) {
    const url = await uploadBuffer(it.buffer, it.mimeType)
    if (url) images.push(url)
  }
  const imagesJson = images.map(url => ({ url }))

  // ── owner upsert (keep existing created_by) ──────────────────────────────────
  const primaryPhone = phones[0]
  const existing = await db.query(
    `SELECT id, created_by_agent_id FROM owner_contacts WHERE phone_normalized=$1`, [primaryPhone])
  let ownerId, ownerWasNew = false
  if (existing.rows.length) {
    ownerId = existing.rows[0].id
    await db.query(
      `UPDATE owner_contacts
          SET name  = COALESCE(NULLIF(name,''),  $2),
              email = COALESCE(email, $3),
              emails = CASE WHEN $3 <> '' AND NOT ($3 = ANY(COALESCE(emails,'{}'))) THEN array_append(COALESCE(emails,'{}'), $3) ELSE emails END,
              updated_at = NOW()
        WHERE id=$1`,
      [ownerId, ownerName || '', ownerEmail || ''])
  } else {
    ownerWasNew = true
    const ins = await db.query(
      `INSERT INTO owner_contacts (phone_normalized, name, email, emails, source, created_by_agent_id, created_by_agent_at, status)
       VALUES ($1,$2,$3,$4,'whatsapp_upload',$5,NOW(),'new') RETURNING id`,
      [primaryPhone, ownerName || null, ownerEmail || null,
       ownerEmail ? [ownerEmail] : null, agent.id])
    ownerId = ins.rows[0].id
  }

  // ── property insert (DRAFT: published=FALSE, available_status='available') ────
  // features + extra phones + location flag ride in internal_notes (no dedicated cols).
  const noteParts = []
  if (features.length) noteParts.push(`Features: ${features.join(', ')}`)
  if (phones.length > 1) noteParts.push(`Alt phones: ${phones.slice(1).join(', ')}`)
  if (locationUnmatched) noteParts.push(`⚠ location "${town}" not in locations table — verify`)
  const internalNotes = noteParts.join(' | ') || null

  const ref = await nextRef()
  const initialAvailabilityStatus = availabilityStatus(availableDate)
  const propForCalc = {
    town, property_type: ptype, bedrooms: beds, bathrooms: baths,
    longlet_price: longlet, sale_price: sale,
    available_status: initialAvailabilityStatus, available_date: availableDate,
    description, street: null, viewing_status: 'none', internal_notes: internalNotes,
  }
  const completeness = calcCompleteness(propForCalc, images.length)

  const ins = await db.query(
    `INSERT INTO properties
       (ref, owner_id, property_type, town, bedrooms, bathrooms, size_sqm,
        longlet_price, shortlet, lease_type, sale_price, description, images, published,
        listed_by_agent_id, listed_by_phone, available_status, available_date, available_until,
        viewing_status, internal_notes, completeness_pct, rental_modes, feature_tags)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,FALSE,$14,$15,$16,$17,$18,'none',$19,$20,$21,$22)
     RETURNING id, ref`,
    [ref, ownerId, ptype || null, town || null,
     beds, baths, sqm,
     longlet, shortlet, leaseTypeFinal, sale,
     description, JSON.stringify(imagesJson),
     agent.id, senderPhone || null, initialAvailabilityStatus, availableDate, availableUntil,
     internalNotes, completeness, rentalModesVal, featureTagsVal])
  const propId = ins.rows[0].id

  // LOCALITY RESOLVER WIRING (Kev, 2026-09-23, ARGUS locality hotfix) — same
  // fix and same reasoning as handlers/upload.js's !upload path; see that
  // file's own comment on this block. Soft, non-fatal.
  try {
    const localityResolver = require('../services/localityResolver')
    const loc = await localityResolver.resolveLocality(town)
    await db.query(
      `UPDATE properties SET locality_id = $2, locality_resolution_status = $3 WHERE id = $1`,
      [propId, loc.locality_id || null, loc.status])
  } catch (e) { log.warn('uploadListing: locality resolution failed (non-fatal)', { err: e.message }) }

  // 2026-09-21: evidence for what was extracted (bedrooms/price/photos) and a
  // "do not contact until <date>" typed into the ad, both non-fatal.
  {
    const prov = await require('../services/extractionProvenance').recordUploadProvenance({
      propertyId: propId, text: cleanText, price: longlet, sale, beds, baths,
      fieldConfidence: p._fieldConfidence || {}, fieldEvidence: p._fieldEvidence || {}, imageCount: images.length,
      rentalClassification: rentalCls, featureTagsClassification: featureTagsCls,
    })
    if (prov.warnings.length) {
      await db.query(
        `UPDATE properties SET internal_notes = TRIM(BOTH ' | ' FROM COALESCE(internal_notes,'') || ' | ' || $2) WHERE id = $1`,
        [propId, `⚠ ${prov.warnings.join('; ')}`]).catch(() => {})
    }
    try {
      const sg = require('../services/ownerSendGate')
      const pause = sg.parseContactPause(cleanText)
      if (pause) {
        const ownerWide = /\b(owner|landlord)\b/i.test(pause.note)
        await sg.setContactPause({ scope: ownerWide ? 'owner' : 'property', id: ownerWide ? ownerId : propId,
          until: pause.until, note: pause.note, by: `upload:agent ${agent.id}` })
      }
    } catch (e) { log.warn('uploadlisting: contact pause parse failed', { err: e.message }) }
  }

  // ── activity log ─────────────────────────────────────────────────────────────
  await db.query(
    `INSERT INTO property_activities (property_id, agent_id, activity_type, details, is_significant)
     VALUES ($1,$2,'property_created_via_upload',$3,TRUE)`,
    [propId, agent.id, JSON.stringify({
      source: 'whatsapp', chat: chatId, sender: senderPhone || null,
      ref, owner_id: ownerId, ownerWasNew, images: images.length })])

  await require('../services/softlistOwners').handleUploadedProperty({
    propertyId: propId, ownerId, uploaderAgentId: agent.id,
  }).catch(err => log.warn('softlist owner upload hook failed (non-fatal)', { propId, ownerId, err: err.message }))

  // ── TASK 7 reply in the source chat ──────────────────────────────────────────
  const agentName = agentDisplayName(agent)
  const priceStr = longlet ? `€${Number(longlet).toLocaleString()}/mo`
    : sale ? `€${Number(sale).toLocaleString()} sale` : '—'
  const availStr = availableDate || 'now'

  await reply(session, chatId,
    `✅ Listing #${ref} created as DRAFT by ${agentName}\n\n` +
    `Owner: ${ownerName || phones[0]}\n` +
    `Location: ${town || '—'}\n` +
    `${beds || 0}BR · ${baths || 0}BA · ${priceStr}\n` +
    `Available: ${availStr}\n` +
    `${images.length} image${images.length === 1 ? '' : 's'} attached\n\n` +
    `View: crm.2906.estate/property/${propId}\n` +
    `Publish to website: toggle in CRM (or use !postweb)`)

  // mark this chat's content consumed up to the command time → next !uploadlisting
  // in this chat only gathers messages AFTER now (TASK 5-D, no double upload).
  _lastProcessed.set(chatId, triggerTs)

  log.info('uploadListing: property created', {
    ref, propId, agent: agent.username, ownerId, ownerWasNew, images: images.length, locationUnmatched })

  return { ref, propId }
}

// ── !agentphone admin command ────────────────────────────────────────────────
async function agentPhoneCommand(session, chatId, text) {
  const parts = text.trim().split(/\s+/).slice(1) // drop "!agentphone"
  const sub = (parts[0] || '').toLowerCase()
  if (sub === 'list' || !parts.length) {
    const r = await db.query(`SELECT username, role, whatsapp_phones FROM agents WHERE active=TRUE ORDER BY id`)
    const lines = r.rows.map(a => `• ${a.username} (${a.role}): ${(a.whatsapp_phones || []).join(', ') || '—'}`)
    await reply(session, chatId, '📇 Agent phones:\n' + lines.join('\n'))
    return
  }
  const username = parts[0]
  const action = (parts[1] || '').toLowerCase()
  const phone = normMaltphone(parts[2])
  if (!username || !['add', 'remove'].includes(action) || !phone) {
    await reply(session, chatId, 'Usage: !agentphone <username> add|remove <phone>  |  !agentphone list')
    return
  }
  const ag = await db.query(`SELECT id, whatsapp_phones FROM agents WHERE LOWER(username)=LOWER($1)`, [username])
  if (!ag.rows.length) { await reply(session, chatId, `❌ Agent "${username}" not found.`); return }
  if (action === 'add') {
    await db.query(`UPDATE agents SET whatsapp_phones = (SELECT ARRAY(SELECT DISTINCT unnest(array_append(COALESCE(whatsapp_phones,'{}'),$2)))) WHERE id=$1`, [ag.rows[0].id, phone])
    await reply(session, chatId, `✅ Added ${phone} to ${username}.`)
  } else {
    await db.query(`UPDATE agents SET whatsapp_phones = array_remove(COALESCE(whatsapp_phones,'{}'),$2) WHERE id=$1`, [ag.rows[0].id, phone])
    await reply(session, chatId, `✅ Removed ${phone} from ${username}.`)
  }
}

// Kept for the webhook's media-only passthrough gate. Single-shot has no
// collection sessions, so there is never an active session → always false.
async function hasActiveSessionForChat() { return false }

module.exports = {
  handleWebhookMessage, hasActiveSessionForChat,
  // ── shared helpers, REUSED by handlers/upload.js (additive exports only —
  //    !uploadlisting behavior is untouched) ──────────────────────────────────
  gatherContent, extractListing, preprocessUploadText,
  deterministicListingFallback,
  normPhones, nameIsBad, stripEmoji, stripPhonesFromText,
  matchLocation, nextRef, calcCompleteness,
  resolveAgent, resolveAgentWithColleagues, extractSenderPhone, resolveUploaderPhone, agentDisplayName,
  getMsgImages, getMsgVideos, getMsgMedia, getMsgDocument, uploadBuffer, uploadVideoBuffer, alertKev,
  // Property-count sanity guard (2026-09-15 hotfix) — exported for direct testing.
  guardPropertyCounts, sanitizeCount, findLabeledCounts, findLabeledMentions,
  // Available-date/lease-duration hotfix (2026-09-16, #2906-9304) — exported
  // for direct testing.
  guardAvailableDate, computeAvailableUntil,
}
