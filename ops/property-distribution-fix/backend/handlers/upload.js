'use strict'
// ============================================================================
// !upload — unified upload pipeline (additive; wraps, never replaces
// !uploadlisting / !post / !postweb).
//
// Commands:
//   !upload | !upload1 … !upload9 [force] [group] [noad]
//       The digit is HOW MANY Facebook PAGE posts the listing gets (!upload =
//       no page post at all). Everything else about the upload is identical
//       across variants — see facebookCampaign.POST_OFFSETS_MS for the timing
//       ladder (direct, +10 min, +12h, then every 6h).
//
//       Channel map:
//         !upload       CRM + categories + website + FB GROUPS (9–14). No page.
//         !upload2/5/9  the same, PLUS 2/5/9 Facebook page posts.
//         !upload noad  CRM + categories + website. Zero Facebook, either kind.
//
//       The FB group share is automatic and needs no command. !fbgroups is the
//       manual test / re-push path and warns rather than posting twice.
//       AV CENTRAL group or DM/Notes from a registered agent.
//       Gathers content like !uploadlisting (REUSED, not rewritten), creates
//       the CRM record, sanitizes → properties.public_payload, queues channel
//       rows from upload_channel_config, then distributes to category groups.
//       "noad" kills EVERY Facebook channel for the listing and overrides the
//       digit: no page campaign now, and properties.no_fb makes a later
//       !fbgroups refuse it too. CRM, category groups and the website are
//       unaffected.
//   !uploadstatus <ref>       per-channel publishing status
//   !recategorize <ref>       re-run category distribution (idempotent, admin)
//   !categorytest <ref>       DRY RUN — exact message + target groups (admin)
//   !categorygroups           list the 6 category groups + active flags
//   !price <price> <ref>      change price + repost (categories + both FB channels + board bump) (super-admin)
//   !picup <ref>              reply to photo(s) to append them to an existing CRM listing (super-admin)
//   !bmarket <ref> <date>     back on market from <date> (DD.MM[.YYYY]) + category-group repost (admin)
//
// Every publisher receives ONLY sanitizeForPublic() output. Never raw rows.
// ============================================================================
const db     = require('../db')
const log    = require('../logger')
const waha   = require('../waha')
const config = require('../config')
const sessionRouter = require('../lib/sessionRouter')
const redis = require('../redis')
const { GoogleGenAI } = require('@google/genai')
const { sanitizeForPublic } = require('../services/sanitizer')
const { classifyProperty } = require('../services/categoryClassifier')
const { publishToCategoryGroups, previewCategoryPost } = require('../services/categoryPublisher')
const { availabilityStatus } = require('../services/futureAvailability')
const { formatPostTag, formatPostTagsForAgents } = require('../services/agentTag')
const { resolveColleaguesForPrimary, creditLine } = require('../services/colleagueAgents')
const { scheduleFacebookCampaign, postCountFrom } = require('../services/facebookCampaign')
// Kev, 2026-09-10: FB-automation status (pause/resume/queue/error) moved out
// of WhatsApp — agents saw it there, unprofessional/confusing. Writes only,
// read by the new CRM Status Dashboard (routes/adminWeb.js).
const { recordFbAutomationStatus } = require('../services/fbAutomationStatus')
// The SAME entry point !fbgroups uses — the share logic is not duplicated here.
const fbShare = require('../services/fbShareQueue')
// REUSE the !uploadlisting machinery — gathering, Gemini parse, helpers.
const ul = require('./uploadListing')
const { planImageAssociation } = require('../services/uploadImageAssociation')
const unwatermark = require('../services/unwatermark')
const gptPhotoPipeline = require('../services/gptPhotoPipeline')
const gptUploadCommand = require('../services/gptUploadCommand')
// Pure planner for the viewing-group pipeline (welcome text, location PM,
// group name, participants). The actual WAHA calls happen in createViewingGroup
// below; the planner's contract is pinned in test/viewingGroup.test.js.
const { buildViewingGroupPlan } = require('../services/viewingGroupPlan')
// 2026-08-21, Claude: the requester's REAL private number for !av / !book, not
// whatever chat (often a group) they typed the command in. `senderPhone` above
// can silently be LID-fallback digits (see services/senderIdentity.js) — this
// is the same file that does the real resolution, called fresh here so !av and
// !book can tell "no real phone in this payload" apart from "here it is".
const { realSenderJid, phoneFromJid } = require('../services/senderIdentity')

// Group whitelist for !upload commands. Three modes:
//   * unset / '*' — accept any group chatId (operator's choice: "any group member can run !upload")
//   * env AV_CENTRAL_GROUP=120363...@g.us — accept only that one group (legacy single-team mode)
//   * env AV_CENTRAL_GROUP=* — same as unset
// The previous hardcoded constant `'120363427677403788@g.us'` caused silent
// drops whenever the operator's primary group chatId changed (e.g. WAHA Plus
// session reset, or moving to a different team group). The webhook filter
// in handleWebhookMessage below mirrors this same resolution so the guard
// and the matcher can never disagree.
const AV_CENTRAL_DEFAULT = '120363427677403788@g.us'
const AV_CENTRAL_GROUP = (() => {
  const raw = process.env.AV_CENTRAL_GROUP
  if (raw == null || raw === '') return null           // unset → all groups
  if (raw === '*') return null                         // explicit wildcard → all groups
  return raw                                           // specific group → only that one
})()
// When AV_CENTRAL_GROUP is null we accept any group; the matcher is a no-op.
const isAuthorizedGroup = (chatId) =>
  AV_CENTRAL_GROUP == null || chatId === AV_CENTRAL_GROUP
// Only ONE session acts on group commands — see the guard in
// handleWebhookMessage. Prevents one group message being handled by every
// logged-in session (double uploads / double posts). 'default' is the
// preferred identity and the last-resort value if literally nothing is
// live; pickUploadSession() below is what actually decides at request time
// (Kev, 2026-08-27: !upload must not die just because Default is down).
const SESSION_FOR_GROUPS = 'default'

// Default → Second → Third → Cedric → Jasmine. Reuses waha.pickActiveAdminSession()
// (the same Default→Second→Third fallback chain !av/!book/outreach already run
// on) for the first three rather than re-deriving that logic; Cedric/Jasmine are
// an additive extension on top, tried only when NONE of Kev's three main
// accounts are live. No caching — re-checked on every call, so a recovered
// Default is picked again on the very next command with no restart needed.
const UPLOAD_FALLBACK_PERSONAS = ['Cedric', 'Jasmine']
async function pickUploadSession() {
  const admin = await waha.pickActiveAdminSession()
  if (admin) return admin
  for (const name of UPLOAD_FALLBACK_PERSONAS) {
    try {
      const status = await waha.getSessionStatus(name)
      if (status?.status === 'WORKING' || status?.status === 'CONNECTED') return name
    } catch (err) {
      log.warn('upload: session status check failed', { session: name, err: err.message })
    }
  }
  return SESSION_FOR_GROUPS
}

// pickUploadSession() is deliberately uncached — "re-checked on every call,
// so a recovered Default is picked again on the very next command". That is
// correct ACROSS commands, but wrong WITHIN one: WAHA can redeliver the SAME
// logical group message under a different event type minutes apart (first
// 'message', later a 'message.any' echo/retry — routes/webhook.js's own
// comment on the Redis dedup key explains why that redelivery exists). If a
// session's live status flips between those two deliveries, pickUploadSession()
// resolves to a DIFFERENT winner each time, both gates (this file's and
// webhook.js's) pass, and !upload runs twice for one message — the exact
// "!upload force created #2906-031 AND #2906-032" bug this whole gate exists
// to prevent, just triggered by a status flip instead of by every session
// seeing the message at once.
//
// Observed live 2026-08-27 23:21–23:23 Malta: Kevsecond claimed !upload2's
// message id, then two minutes later — after `default` recovered from a
// STOPPED blip — default claimed the SAME message id again. No duplicate CRM
// row resulted only because createListing()'s own content-based duplicate
// guard happened to catch it; that guard is a safety net for a different
// problem (an agent typing !upload twice by hand) and must not be the only
// thing standing between one flaky session and a double post.
//
// Fix: cache the FIRST resolution per messageId (TTL matches the message
// dedup window below), so every redelivery of one logical message agrees on
// the same winner no matter how many times, or how far apart, WAHA resends
// it. Falls back to the live (uncached) pick on any Redis hiccup or when no
// messageId is available — never worse than before, only stickier when it
// can be.
async function pickUploadSessionSticky(messageId, observedSession = null) {
  if (!messageId) return observedSession || pickUploadSession()
  const key = `groupgate:winner:${messageId}`
  try {
    const cached = await redis.get(key)
    if (cached) return cached
  } catch (err) {
    log.warn('pickUploadSessionSticky: redis get failed, resolving live', { err: err.message })
  }
  const winner = observedSession || await pickUploadSession()
  try {
    // NX: only the first caller's resolution is stored. Re-read afterwards so
    // BOTH the winner (whose value got stored) and any concurrent caller (who
    // lost the NX race) end up returning the SAME, now-settled value.
    await redis.set(key, winner, 'EX', 900, 'NX')
    const settled = await redis.get(key)
    if (settled) return settled
  } catch (err) {
    log.warn('pickUploadSessionSticky: redis set failed, using live resolution', { err: err.message })
  }
  return winner
}

// Divider sent after the last message of an upload cycle, so consecutive
// uploads are visually separated in AV CENTRAL.
const DIVIDER = '...'
// Olga's phone. Opt-in only — set OLGA_ENABLED=1 in the backend env to add her
// to viewing groups. The default path is owner + uploader + property only,
// which is what the operator wants for the in-flight workflow; Olga is
// added when the operator decides a listing should have her eyes on it too.
const OLGA_PHONE = '35679010070'
const CHANNEL_LABELS = {
  crm: 'CRM', website: 'Website', category_groups: 'Categories',
  facebook: 'Facebook Page', fb_groups: 'FB Groups',
  propertymarket: 'PropertyMarket', instagram: 'Instagram',
}
// Everything "noad" switches off — the page campaign AND the group share, which
// are two separate channels. properties.no_fb backs this up for anything that
// tries to start a share later by hand.
const FB_CHANNELS = new Set(['facebook', 'fb_groups'])

const digits = (s) => String(s || '').replace(/\D/g, '')
const adminNumbers = (config.admin?.adminNumbers || []).map(digits)
const isAdmin = (phone) => adminNumbers.includes(digits(phone))
// Centralized case-insensitive WhatsApp account resolution lives in
// services/whatsappResolver.js. This handler reaches it via uploadListing
// (sessionPhone) and via services/auth (isAdminAccount) — both call-sites
// are read-only gates, so the resolver is the single place to read the
// whatsapp_accounts table for the upload/admin path.
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

let _ai = null
function getAI() {
  if (_ai) return _ai
  if (!process.env.GEMINI_API_KEY) return null
  _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  return _ai
}

// Routed through sessionRouter so a reply still reaches the agent even if
// the session the command arrived on (`session`) has since gone down —
// conversation-consistent when possible, failover by SESSIONS_PRIORITY
// otherwise (see lib/sessionRouter.js).
async function reply(session, chatId, text) {
  try { await sessionRouter.sendVia(session, chatId, text) }
  catch (e) { log.warn('upload reply failed', { err: e.message, chatId }) }
}

// ── ref lookup: "2906-247" | "#2906-247" | "247" ─────────────────────────────
async function findByRef(arg) {
  const raw = String(arg || '').trim().replace(/^#/, '')
  if (!raw) return null
  const ref = /^\d{1,6}$/.test(raw) ? `2906-${raw.padStart(3, '0')}` : raw
  const r = await db.query(
    `SELECT id, ref, town, bedrooms, public_payload FROM properties WHERE ref=$1 LIMIT 1`, [ref])
  return r.rows[0] || null
}

// ── multi-listing split (Task 5) — ONE Gemini call ──────────────────────────
async function splitListings(gatheredText) {
  const single = [{ index: 0, raw_text: gatheredText }]
  // no separator lines at all → don't burn a Gemini call
  if (!/^\s*[.\/]{2,}\s*$/m.test(gatheredText)) return single
  const ai = getAI()
  if (!ai) return single
  const prompt =
`This text contains one or more real estate listings, separated by divider lines of dots or slashes. Some blocks may be irrelevant chatter.

Return ONLY a JSON object. Each element of "listings" is one complete listing, containing the property description AND its owner contact block if present. Ignore blocks that are not listings (greetings, comments, unrelated messages).

Format: {"listings": [{"index": 0, "raw_text": "..."}, ...]}

TEXT:
${gatheredText.slice(0, 8000)}`
  for (const model of ['gemini-2.5-flash', 'gemini-flash-latest']) {
    try {
      const r = await Promise.race([
        ai.models.generateContent({
          model, contents: prompt,
          config: { temperature: 0, maxOutputTokens: 4000, thinkingConfig: { thinkingBudget: 0 } },
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('split timeout after 12s')), 12000)),
      ])
      const j = JSON.parse((r.text || '').replace(/```json|```/g, '').trim())
      const list = Array.isArray(j?.listings) ? j.listings.filter(l => l && String(l.raw_text || '').trim()) : []
      if (list.length >= 1) return list.map((l, i) => ({ index: i, raw_text: String(l.raw_text) }))
    } catch (e) { log.warn('upload splitListings failed', { model, err: e.message }) }
  }
  log.warn('upload splitListings exhausted — continuing as one listing')
  return single
}

// A divider makes splitListings ask Gemini to separate records. In a real
// one-listing upload the owner contact is often sent as its own tiny WhatsApp
// message ("Karl +356...") just before the divider. Gemini can correctly find
// one property while discarding that contact-only block as chatter. Recover
// only this unambiguous case: exactly one listing, no phone inside its returned
// text, and one or more explicit phone-bearing source lines. Multi-listing
// batches remain untouched because guessing which owner belongs to which unit
// would be unsafe.
const OWNER_PHONE_LINE_RE = /(?:\+|00)?\d[\d ()-]{6,}\d/
function restoreSingleListingContact(listings, gatheredText) {
  if (!Array.isArray(listings) || listings.length !== 1) return listings
  const raw = String(listings[0]?.raw_text || '')
  if (OWNER_PHONE_LINE_RE.test(raw)) return listings
  const contactLines = [...new Set(String(gatheredText || '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && OWNER_PHONE_LINE_RE.test(line)))]
  if (!contactLines.length) return listings
  return [{ ...listings[0], raw_text: `${raw}\n${contactLines.join('\n')}`.trim() }]
}

// ── image ↔ listing association by source dividers (Task 5) ────────────────
// Use the agent's actual chronological dot/slash divider blocks. Gemini may
// clean or reorder wording inside raw_text, so its first 30 characters are not
// a safe media anchor. A genuinely unsafe mapping blocks BEFORE createListing
// instead of silently attaching every image to property 1.
function associateImages(listings, gathered) {
  return planImageAssociation({
    listings,
    priorMessages: gathered.priorMessages || [],
    priorMessageImages: gathered.priorMessageImages || [],
    commandImages: gathered.commandImageItems || [],
    allImages: gathered.imageItems || [],
  })
}

// ── duplicate guard (60 min, same owner phone + town + beds + price) ────────
// Kev, 2026-09-02: phone+town+beds+price alone is too weak — #2906-9147 and
// #2906-9148 are two genuinely different Sliema units from the same owner
// (a landlord with more than one similarly-priced 2BR), posted 7 minutes
// apart, and got flagged as duplicates of each other purely on that match.
// Structural fields only narrow the CANDIDATES now; a candidate is only
// treated as an actual duplicate when the ad text itself is near-identical
// (a real re-post) OR the street/building name matches too. Two different
// named buildings for the same owner/town/beds/price is never a duplicate,
// no matter how similar the surrounding copy reads.
//
// 0.5 was tried first and rejected: every ad this pipeline generates shares
// the same emoji/template boilerplate ("🛏 Bedrooms", "📞 Contact me to
// arrange a viewing…"), so #2906-9147 vs #2906-9148 — two genuinely
// different Sliema units, real text proven by proof-dedup.js — score 0.784
// on raw word overlap despite describing different buildings entirely. 0.92
// sits comfortably above that boilerplate floor while still catching an
// actual re-post (near-identical text scores ~1.0).
const DUP_TEXT_SIMILARITY_MIN = 0.92
function textSimilarity(a, b) {
  const tokenize = s => new Set(
    String(s || '').toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2))
  const setA = tokenize(a), setB = tokenize(b)
  if (!setA.size || !setB.size) return 0
  let shared = 0
  for (const w of setA) if (setB.has(w)) shared++
  return shared / Math.max(setA.size, setB.size)
}
async function findRecentDuplicate(phone, town, beds, longlet, { street, description } = {}) {
  const r = await db.query(
    `SELECT p.ref, p.street, p.description FROM properties p JOIN owner_contacts oc ON oc.id = p.owner_id
      WHERE oc.phone_normalized = $1
        AND LOWER(COALESCE(p.town,'')) = LOWER(COALESCE($2,''))
        AND COALESCE(p.bedrooms,-1) = COALESCE($3,-1)
        AND COALESCE(p.longlet_price,-1) = COALESCE($4::numeric,-1)
        AND p.created_at > NOW() - INTERVAL '60 minutes'
      ORDER BY p.created_at DESC LIMIT 5`,
    [phone, town || null, beds ?? null, longlet ?? null])
  const newStreet = String(street || '').trim().toLowerCase()
  for (const cand of r.rows) {
    const candStreet = String(cand.street || '').trim().toLowerCase()
    if (candStreet && newStreet && candStreet !== newStreet) continue // different named building/street → different property, full stop
    if (candStreet && newStreet && candStreet === newStreet) return cand.ref // same building/street → same property, text need not match
    if (textSimilarity(description, cand.description) >= DUP_TEXT_SIMILARITY_MIN) return cand.ref
  }
  return null
}

// ── Multi-unit same-post detection (Kev, 2026-09-02) ────────────────────────
// NOT the "portfolio of a block" case (services/autoOwnerConversation.js's
// detectPortfolio -- a different pipeline entirely, owner-chat not !upload,
// and genuinely one grouped entity there). This is specifically: an owner
// names 2 (or a small few) DISTINCT units in ONE continuous !upload post with
// no divider line ("Apartment 3 and 4, both 2 bed 1 bath, 1600 each") — those
// must become 2 SEPARATE CRM/board rows, each showing the real unit number
// when the owner gave one, so the actual count of units is visible rather
// than reading as a single listing.
const MULTI_UNIT_LABEL_RE = /\b(?:apartment|apt\.?|unit|flat)s?\s*(?:no\.?|number)?\s*(\d+[a-z]?|[a-z])\s*(?:and|&|\+)\s*(?:apartment|apt\.?|unit|flat)?\s*(\d+[a-z]?|[a-z])\b/i
const MULTI_UNIT_COUNT_RE = /\b(?:two|2|both)\s+(?:apartments?|units?|flats?)\b/i
function detectMultiUnitLabels(text) {
  const t = String(text || '')
  const m = t.match(MULTI_UNIT_LABEL_RE)
  if (m) return [m[1], m[2]]
  if (MULTI_UNIT_COUNT_RE.test(t)) return ['1', '2']
  return null
}

function extractIntakeMetadata(rawText, extractedProperty = {}, intakeMode = null) {
  const t = String(rawText || '')
  const explicitSale = /\b(?:for\s+sale|selling|purchase|buy)\b/i.test(t)
  const explicitRent = /\b(?:for\s+rent|to\s+let|monthly\s+rent|lease)\b/i.test(t)
  const use = t.match(/\b(office|retail|shop|hospitality|restaurant|bar|warehouse|industrial|storage|showroom|workshop|factory|garage)\b/i)
  const condition = t.match(/\b(finished|unfurnished|furnished|shell|semi-finished|newly finished|renovated|needs renovation)\b/i)
  const tenure = t.match(/\b(freehold|leasehold|ground rent)\b/i)
  const permit = t.match(/\b(?:permit|licen[cs]e)\b[^.!?\n]{0,100}/i)
  const sqm = t.match(/\b(\d{2,5}(?:\.\d+)?)\s*(?:sqm|sq\.?\s*m|m2|m²)\b/i)
  return {
    transaction_type: intakeMode === 'sale' || explicitSale ? 'sale' : (explicitRent ? 'rent' : null),
    commercial_use: intakeMode === 'commercial' ? (use?.[1]?.toLowerCase() || String(extractedProperty.type || '').toLowerCase() || null) : null,
    size_sqm: sqm ? Number(sqm[1]) : (Number(extractedProperty.sqm) || null),
    condition_finish: condition?.[1]?.toLowerCase() || null,
    tenure: tenure?.[1]?.toLowerCase() || null,
    permit_information: permit?.[0]?.trim() || null,
    price_period: explicitRent ? 'month' : null,
    source: 'operator_upload_shortcut',
  }
}

// ── create ONE listing from raw text + images (mirrors !uploadlisting CRM
//    flow exactly; parser/gatherer are REUSED from uploadListing) ────────────
// _unitLabel/_siblingRefs are internal-only (set on the recursive per-unit
// calls below) — never passed by an outside caller.
// structuredRules (Kev, 2026-09-10, Owner Auto-Upload finalize): optional
// { pets_allowed, sharing_allowed, sharing_price, subletting_allowed,
// subletting_price } — CRM/Match-Engine metadata that never comes from
// text extraction (extractListing() below only ever reads the PUBLIC ad
// copy, which deliberately omits negative facts and conditional prices per
// spec point 11/28). Only the owner-auto-upload path passes this today;
// every other caller leaves it undefined and behaviour is unchanged.
async function preparePhotoPackage({ images, photoMode, facts, triggerId }) {
  if (!photoMode) {
    const imageUrls = []
    for (const it of (images || [])) {
      const url = await ul.uploadBuffer(it.buffer, it.mimeType)
      if (url) imageUrls.push(url)
    }
    return { imageUrls, photoResult: null, uploaded: [] }
  }

  const photoResult = await gptPhotoPipeline.processImages({
    images: images || [], facts, mode: photoMode, triggerId, source: 'whatsapp_upload',
  })
  const imageUrls = []
  const uploaded = []
  for (const item of photoResult.items) {
    const sourceUrl = await ul.uploadBuffer(item.sourceBuffer, item.sourceMimeType)
    let editedUrl = null
    if (item.status === 'edited') editedUrl = await ul.uploadBuffer(item.buffer, item.mimeType)
    const finalUrl = editedUrl || sourceUrl
    if (finalUrl) imageUrls.push(finalUrl)
    uploaded.push({ position: item.position, sourceUrl, editedUrl })
  }
  return { imageUrls, photoResult, uploaded }
}

async function updateExistingVisionProperty({ ref, images, facts, photoMode, triggerId, noAd, rawText }) {
  const row = await db.query(
    `SELECT id, ref, town, bedrooms, bathrooms, longlet_price, sale_price, images, public_payload
       FROM properties WHERE ref=$1 LIMIT 1`, [ref])
  const prop = row.rows[0]
  if (!prop) return { duplicate: ref }
  const prepared = await preparePhotoPackage({ images, photoMode, facts, triggerId })
  const oldImages = Array.isArray(prop.images) ? prop.images : []
  const oldPayloadImages = Array.isArray(prop.public_payload?.images) ? prop.public_payload.images : []
  const mergedUrls = [...new Set([...oldPayloadImages, ...prepared.imageUrls])]
  const mergedRows = [...oldImages]
  for (const url of prepared.imageUrls) if (!mergedRows.some(item => item?.url === url)) mergedRows.push({ url })
  const publicPayload = { ...(prop.public_payload || {}), images: mergedUrls }
  await db.query(
    `UPDATE properties SET images=$2::jsonb, public_payload=$3::jsonb, updated_at=NOW() WHERE id=$1`,
    [prop.id, JSON.stringify(mergedRows), JSON.stringify(publicPayload)])
  await gptPhotoPipeline.persistResult({ result: prepared.photoResult, propertyId: prop.id, uploaded: prepared.uploaded })
  require('../services/websiteSync').syncPropertyToWebsite(prop.id)
    .catch(err => log.warn('gptuploadv: existing property website sync failed', { ref, err: err.message }))
  const channelRows = await db.query(`SELECT DISTINCT channel FROM property_publishing_status WHERE property_id=$1`, [prop.id])
  const channels = channelRows.rows.map(item => item.channel).filter(ch => !(noAd && FB_CHANNELS.has(ch)))
  return {
    propId: prop.id, ref: prop.ref, town: prop.town, beds: prop.bedrooms, baths: prop.bathrooms,
    longlet: prop.longlet_price, sale: prop.sale_price, imageCount: mergedUrls.length, videoCount: 0,
    channels, publicPayload, noAd: !!noAd, rawText, existingUpdate: true,
    photoSummary: prepared.photoResult,
  }
}

async function createListing({ rawText, images, videos, agent, senderPhone, chatId, session, variant, force, noAd, _unitLabel, _siblingRefs, structuredRules, intakeMode, photoMode, photoTriggerId }) {
  // Only the TOP-level call checks for multi-unit — a recursive per-unit call
  // already carries _unitLabel and must run the normal single-listing path
  // below on ITS OWN behalf, not re-detect and recurse infinitely.
  if (!_unitLabel) {
    const labels = detectMultiUnitLabels(rawText)
    if (labels) {
      // force:true on both — without it, unit B's own findRecentDuplicate
      // call sees unit A (same phone/town/beds/price, created seconds ago)
      // and refuses it as a near-duplicate, which is exactly wrong here: two
      // real, distinct units are the whole point.
      const a = await createListing({ rawText, images, videos, agent, senderPhone, chatId, session, variant, force: true, noAd, _unitLabel: labels[0], intakeMode, photoMode, photoTriggerId: photoTriggerId && `${photoTriggerId}:unit:${labels[0]}` })
      if (a.error || a.duplicate) return a
      const b = await createListing({ rawText, images, videos, agent, senderPhone, chatId, session, variant, force: true, noAd, _unitLabel: labels[1], intakeMode, photoMode, photoTriggerId: photoTriggerId && `${photoTriggerId}:unit:${labels[1]}` })
      if (b.error || b.duplicate) return b
      const note = (other) => `Multi-unit post — also see #${other.ref} (Apartment ${other._unitLabel}).`
      await db.query(
        `UPDATE properties SET internal_notes = TRIM(BOTH ' | ' FROM COALESCE(internal_notes,'') || ' | ' || $2) WHERE id = $1`,
        [a.propId, note({ ref: b.ref, _unitLabel: labels[1] })])
      await db.query(
        `UPDATE properties SET internal_notes = TRIM(BOTH ' | ' FROM COALESCE(internal_notes,'') || ' | ' || $2) WHERE id = $1`,
        [b.propId, note({ ref: a.ref, _unitLabel: labels[0] })])
      return { ...a, multiUnit: true, units: [a, b] }
    }
  }

  const ex = await ul.extractListing(rawText)
  if (!ex) return { error: 'extractor unavailable' }
  const o = ex.owner || {}
  const p = ex.property || {}

  // Long ads are truncated to 3,000 characters for the detail extractor.
  // A standalone owner line commonly follows the description, so it can sit
  // beyond that limit even though the gatherer and listing splitter retained
  // it. Read only a complete contact-shaped source line as a deterministic
  // fallback; this does not infer an owner from property numbers or prices.
  const explicitContact = String(rawText || '')
    .split('\n').map(line => parseOwnerContact(line.trim())).filter(Boolean).at(-1) || null
  const phones = ul.normPhones([
    ...(Array.isArray(o.phones) ? o.phones : []),
    explicitContact?.phone,
  ].filter(Boolean))
  if (!phones.length) return { error: 'no owner phone detected' }

  let ownerName = String(o.name || explicitContact?.name || '').trim()
  if (ul.nameIsBad(ownerName)) ownerName = ''
  const ownerEmail = (String(o.email || '').trim().match(/[\w.+-]+@[\w.-]+\.\w+/) || [null])[0]

  const beds  = Number(p.beds)  > 0 ? Math.round(Number(p.beds))  : null
  const baths = Number(p.baths) > 0 ? Math.round(Number(p.baths)) : null
  const sqm   = Number(p.sqm)   > 0 ? Number(p.sqm)               : null
  let longlet = Number(p.longlet_price) > 0 ? Number(p.longlet_price) : null
  let sale    = Number(p.sale_price)    > 0 ? Number(p.sale_price)    : null
  if (intakeMode === 'sale' && !sale && longlet) { sale = longlet; longlet = null }
  // Kev, 2026-10-19 (#2906-9502, Olga: "3500€ asking price" → a €3,500 SALE).
  // Nothing in Malta sells for under €20,000: a "sale" price that low is the
  // monthly rent, whatever the ad called it.
  if (intakeMode !== 'sale' && sale && sale < 20000 && !longlet) { longlet = sale; sale = null }
  const shortlet = !!p.shortlet_available
  // Kev, 2026-09-16 (real incident #2906-9304 — this is THE live !upload/
  // !upload5/auto-publish path, the one that actually created that
  // listing): same fixes as uploadListing.js's extraction post-processing
  // — lease_type derived from shortlet at write time (was defaulting to
  // 'long_let' regardless), and available_date/available_until run through
  // the same guards so a wrong-year date never gets published un-flagged.
  const leaseType = shortlet ? 'short_let' : 'long_let'
  // RENTAL MODES (2026-09-21): set ONLY from explicit wording in the ad ("winter let",
  // "short let", "long term" …); several may apply. Nothing explicit → left unset (NULL:
  // modes then derive from lease_type as before, and a person can set them). Never guessed.
  const rentalModesSvc = require('../services/rentalModes')
  const rentalCls = rentalModesSvc.classifyFromText(rawText)
  const rentalModesVal = rentalCls.modes.length ? rentalCls.modes : null
  const leaseTypeFinal = rentalModesVal ? rentalModesSvc.legacyLeaseType(rentalModesVal) : leaseType
  // CANONICAL FEATURE TAGS (Kev, 2026-09-23, ARGUS property intelligence):
  // same "explicit wording only, never guessed" contract as rental modes
  // above, scanned against the SAME full rawText — before any shortening/
  // sanitizing, per Kev's explicit spec point 1 (the sanitized public
  // description strips exactly the kind of detail a feature mention lives
  // in). Nothing found → left NULL, distinct from '{}' (extracted, found
  // nothing) — see featureTags.js's own header note.
  const featureTagsCls = require('../services/featureTags').classifyFromText(rawText)
  const featureTagsVal = featureTagsCls.tags.length ? featureTagsCls.tags : null
  const availableDateRaw = (typeof p.available_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.available_date)) ? p.available_date : null
  const availableDate = ul.guardAvailableDate(availableDateRaw)
  const availableUntil = shortlet ? ul.computeAvailableUntil(availableDate, p.shortlet_duration_min_months, p.shortlet_duration_max_months) : null
  const ptype = intakeMode === 'commercial' ? 'commercial' : String(p.type || 'apartment').toLowerCase()
  const intakeMetadata = intakeMode ? extractIntakeMetadata(rawText, p, intakeMode) : null
  if (intakeMetadata?.transaction_type === 'sale' && !sale && longlet) { sale = longlet; longlet = null }
  const features = Array.isArray(p.features) ? p.features.filter(Boolean).map(String) : []
  let description = ul.stripPhonesFromText(ul.stripEmoji(p.description || '')) || null
  // Kev, 2026-09-02 (multi-unit same-post): prefixed straight into the
  // stored description so the unit number is visible anywhere the
  // description itself is shown (CRM detail, board modal, a public post) —
  // no separate UI change needed. "Apartment 3" when the owner gave a real
  // number, "Unit 1"/"Unit 2" for the unnumbered ("2 apartments") case.
  if (_unitLabel) {
    const isRealNumber = MULTI_UNIT_LABEL_RE.test(rawText)
    const prefix = `${isRealNumber ? 'Apartment' : 'Unit'} ${_unitLabel} — `
    description = description ? prefix + description : prefix.trim()
  }
  // Kev, 2026-09-02: a genuine street-level address (house/building number +
  // street), distinct from the general town/area in `p.location` above.
  // CRM-only — its value is never itself made public (see sanitizeForPublic
  // call below, street stays null there; same leak-check the rest of this
  // file already enforces for street/apt) — and its presence/absence never
  // gates which channels a listing goes to; only image/video presence does.
  const street = String(p.street || '').trim() || null

  let town = await ul.matchLocation(p.location)
  let locationUnmatched = false
  if (!town && p.location) { town = String(p.location).trim(); locationUnmatched = true }

  if (!town && beds == null && longlet == null && sale == null) return { error: 'property details not detected' }

  // ── IDEMPOTENCY / duplicate guard ──────────────────────────────────────────
  if (!force) {
    const dupRef = await findRecentDuplicate(phones[0], town, beds, longlet, { street, description })
    if (dupRef && photoMode === 'vision') {
      return updateExistingVisionProperty({
        ref: dupRef, images, facts: p, photoMode, triggerId: photoTriggerId,
        noAd, rawText,
      })
    }
    if (dupRef) return { duplicate: dupRef }
  }

  // Optional preparation happens before the first canonical property write;
  // standard !upload still executes the unchanged one-upload-per-image path.
  const preparedPhotos = await preparePhotoPackage({
    images, photoMode, facts: p, triggerId: photoTriggerId,
  })
  const imageUrls = preparedPhotos.imageUrls
  // videos → Cloudinary, resource_type 'video'. Stored on the row, NOT in
  // public_payload: the sanitizer owns that object and a media URL has nothing
  // to sanitize. Every video-capable channel reads properties.videos.
  const videoUrls = []
  for (const it of (videos || [])) {
    const url = await ul.uploadVideoBuffer(it.buffer, it.mimeType)
    if (url) videoUrls.push(url)
  }

  // ── owner upsert (identical to !uploadlisting) ─────────────────────────────
  const primaryPhone = phones[0]
  const existing = await db.query(`SELECT id FROM owner_contacts WHERE phone_normalized=$1`, [primaryPhone])
  let ownerId
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
    const ins = await db.query(
      `INSERT INTO owner_contacts (phone_normalized, name, email, emails, source, created_by_agent_id, created_by_agent_at, status)
       VALUES ($1,$2,$3,$4,'whatsapp_upload',$5,NOW(),'new') RETURNING id`,
      [primaryPhone, ownerName || null, ownerEmail || null, ownerEmail ? [ownerEmail] : null, agent.id])
    ownerId = ins.rows[0].id
  }

  // ── property insert (identical to !uploadlisting DRAFT flow) ───────────────
  const noteParts = []
  if (features.length) noteParts.push(`Features: ${features.join(', ')}`)
  if (phones.length > 1) noteParts.push(`Alt phones: ${phones.slice(1).join(', ')}`)
  if (locationUnmatched) noteParts.push(`⚠ location "${town}" not in locations table — verify`)
  if (intakeMode === 'sale') noteParts.push('Operator intake: SALES draft; missing sales fields remain UNKNOWN')
  if (intakeMode === 'commercial') noteParts.push('Operator intake: COMMERCIAL draft; transaction type and intended use are separate in chat_extracted_fields')
  const internalNotes = noteParts.join(' | ') || null

  const ref = await ul.nextRef()
  const initialAvailabilityStatus = availabilityStatus(availableDate)
  const completeness = ul.calcCompleteness({
    town, property_type: ptype, bedrooms: beds, bathrooms: baths,
    longlet_price: longlet, sale_price: sale, available_status: initialAvailabilityStatus,
    available_date: availableDate, description, street, viewing_status: 'none',
    internal_notes: internalNotes,
  }, imageUrls.length)

  // Kev, 2026-09-01 (Architecture: system_online / website_listed / market
  // eligible, three separate layers now — see services/matchEngine.js and
  // services/websiteSync.js). `published` used to be hardcoded FALSE on
  // every upload, full stop — nothing in this file ever flipped it, so a
  // listing only ever went public via a manual CRM toggle or the one-off
  // scripts/website_publish_eligible.js catch-up script. Same bar
  // websiteSync.isPublishReady() applies to every OTHER publish path (real
  // photos + a real description) is applied here too, at the moment those
  // facts are first known, instead of leaving every fresh upload sitting
  // unpublished indefinitely by default. `system_online` is unconditional —
  // an upload with zero photos is still immediately usable by matching,
  // SwipeLinks and !match; it just doesn't go public yet.
  const websiteReady = !intakeMode && imageUrls.length > 0 && (description || '').trim().length >= 20

  const rules = structuredRules || {}
  const ins = await db.query(
    `INSERT INTO properties
       (ref, owner_id, property_type, town, street, apt, bedrooms, bathrooms, size_sqm,
        longlet_price, shortlet, sale_price, description, images, published,
        system_online, listed_by_agent_id, listed_by_phone, available_status, available_date,
        viewing_status, internal_notes, completeness_pct, videos, no_fb,
        pets_allowed, sharing_allowed, sharing_price, subletting_allowed, subletting_price,
        subletting_considered, subletting_note, lease_type, available_until, rental_modes, feature_tags,
        is_staging, chat_extracted_fields)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,TRUE,$16,$17,$18,$19,'none',$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36)
     RETURNING id, ref`,
    [ref, ownerId, ptype || null, town || null, street, _unitLabel || null, beds, baths, sqm,
     longlet, shortlet, sale, description, JSON.stringify(imageUrls.map(url => ({ url }))), websiteReady,
     agent.id, senderPhone || null, initialAvailabilityStatus, availableDate, internalNotes, completeness,
     JSON.stringify(videoUrls.map(url => ({ url }))), !!noAd,
     rules.pets_allowed ?? null, rules.sharing_allowed ?? null, rules.sharing_price ?? null,
     rules.subletting_allowed ?? null, rules.subletting_price ?? null,
     rules.subletting_considered ?? null, rules.subletting_note ?? null,
     leaseTypeFinal, availableUntil, rentalModesVal, featureTagsVal, !!intakeMode,
     JSON.stringify(intakeMetadata ? { ...intakeMetadata,
       transaction_type: intakeMetadata.transaction_type || (sale ? 'sale' : (longlet ? 'rent' : null)),
       purchase_price: intakeMetadata.transaction_type === 'sale' ? sale : null,
     } : {})])
  const propId = ins.rows[0].id

  if (preparedPhotos.photoResult) {
    await gptPhotoPipeline.persistResult({
      result: preparedPhotos.photoResult, propertyId: propId, uploaded: preparedPhotos.uploaded,
    })
  }

  // LOCALITY RESOLVER WIRING (Kev, 2026-09-23, ARGUS locality hotfix): every
  // property from here on gets its canonical locality_id/resolution_status
  // stamped via services/localityResolver.js — the SAME resolver the board
  // already uses (boardLocality/annotateBoardCards). Root cause of a
  // 44-property gap (ids 28699+, everything since 2026-09-18): the resolver
  // was built and used for one-off backfill scripts + the board's read-side
  // view, but nothing ever called it at property-creation time. Soft,
  // non-fatal — a resolver hiccup must never break the upload itself.
  try {
    const localityResolver = require('../services/localityResolver')
    const loc = await localityResolver.resolveLocality(town)
    await db.query(
      `UPDATE properties SET locality_id = $2, locality_resolution_status = $3 WHERE id = $1`,
      [propId, loc.locality_id || null, loc.status])
  } catch (e) { log.warn('upload: locality resolution failed (non-fatal)', { err: e.message }) }

  // 2026-09-21: evidence for what was extracted (bedrooms/price/photos) and a
  // "do not contact until <date>" typed into the ad, both non-fatal.
  {
    const prov = await require('../services/extractionProvenance').recordUploadProvenance({
      propertyId: propId, text: rawText, price: longlet, sale, beds, baths,
      fieldConfidence: p._fieldConfidence || {}, fieldEvidence: p._fieldEvidence || {}, imageCount: imageUrls.length,
      rentalClassification: rentalCls, featureTagsClassification: featureTagsCls,
    })
    if (prov.warnings.length) {
      await db.query(
        `UPDATE properties SET internal_notes = TRIM(BOTH ' | ' FROM COALESCE(internal_notes,'') || ' | ' || $2) WHERE id = $1`,
        [propId, `⚠ ${prov.warnings.join('; ')}`]).catch(() => {})
    }
    try {
      const sg = require('../services/ownerSendGate')
      const pause = sg.parseContactPause(rawText)
      if (pause) {
        const ownerWide = /\b(owner|landlord)\b/i.test(pause.note)
        await sg.setContactPause({ scope: ownerWide ? 'owner' : 'property', id: ownerWide ? ownerId : propId,
          until: pause.until, note: pause.note, by: `upload:agent ${agent.id}` })
      }
    } catch (e) { log.warn('upload: contact pause parse failed', { err: e.message }) }
  }

  await db.query(
    `INSERT INTO property_activities (property_id, agent_id, activity_type, details, is_significant)
     VALUES ($1,$2,'property_created_via_upload',$3,TRUE)`,
    [propId, agent.id, JSON.stringify({
      source: 'whatsapp', command: '!' + variant + (noAd ? ' noad' : ''),
      chat: chatId, sender: senderPhone || null,
      ref, owner_id: ownerId, images: imageUrls.length, videos: videoUrls.length,
      no_fb: !!noAd })])

  await require('../services/softlistOwners').handleUploadedProperty({
    propertyId: propId, ownerId, uploaderAgentId: agent.id,
  }).catch(err => log.warn('softlist owner upload hook failed (non-fatal)', { propId, ownerId, err: err.message }))

  // A completed operator upload supersedes any still-running owner intake for
  // the same verified phone.  Cancel its delayed question/publish jobs before
  // this command returns; the final send gate also observes the terminal
  // status if a worker was already executing.
  await require('../services/autoOwnerConversation').completeConversationAfterOperatorUpload({
    ownerId, phone: primaryPhone, propertyId: propId, ref,
  }).catch(err => log.warn('upload: owner collection close failed (non-fatal)', {
    propId, ref, err: err.message,
  }))

  // OG-4 (Kev, 2026-09-04): "!upload" is one of the three Karteikarte
  // creation triggers. Fire-and-forget, never blocks the actual upload.
  require('../services/ownerPreferenceProfile').maybeCreateFromUpload(ownerId)
    .catch(err => log.warn('ownerPreferenceProfile hook (upload) failed', { err: err.message }))

  // ── SANITIZE → properties.public_payload (later channels reuse it) ─────────
  // TWO descriptions, on purpose:
  //   description        → Gemini's flattened plain text (emoji-stripped) for
  //                        CRM, website and PropertyMarket.
  //   description_social → the ad EXACTLY as it was written, owner block
  //                        removed by the sanitizer. Facebook and the category
  //                        groups post this: it came from AI already formatted
  //                        for social, so reformatting it only makes it worse.
  const publicPayload = sanitizeForPublic({
    ref_id: ref, type: ptype, town, beds, baths, sqm,
    longlet_price: longlet, sale_price: sale, shortlet_available: shortlet,
    available_date: availableDate, available_status: initialAvailabilityStatus,
    description, description_social: rawText,
    features, images: imageUrls, street: null, apt: null,
  }, { phones, name: ownerName, email: ownerEmail })
  await db.query(`UPDATE properties SET public_payload=$1 WHERE id=$2`, [JSON.stringify(publicPayload), propId])

  // ── system_online side effects (Kev, 2026-09-01) ────────────────────────────
  // Every upload is system_online from the INSERT above — these three used to
  // fire ONLY off routes/crm.js's manual "Published (LIVE)" toggle, so a
  // listing sat unmatched and un-swipeable until an agent remembered to flip
  // it public. All three are best-effort / fire-and-forget: a hiccup here
  // must never fail the upload the owner/agent is waiting on a reply for.
  if (websiteReady) {
    // Mirrors routes/crm.js's own publish hook exactly (sync THEN
    // matchPropertyToClients) — websiteReady above already used the same
    // isPublishReady() bar, so this call is expected to succeed, not a
    // second independent gate.
    require('../services/websiteSync').syncPropertyToWebsite(propId)
      .catch(err => log.warn('upload: website sync failed', { propId, ref, err: err.message }))
  }
  if (!intakeMode) {
    require('../services/matchEngine').matchPropertyToClients(propId)
      .catch(err => log.warn('upload: match-on-upload failed', { propId, ref, err: err.message }))
    require('../services/shareLinks').getOrCreatePropertyLink(propId)
      .catch(err => log.warn('upload: swipe-link create failed', { propId, ref, err: err.message }))
  }
  // ARGUS Agent Notification Engine (Kev, 2026-09-16): PROPERTY_CREATED —
  // same fire-and-forget shape as the two calls above. Base Inventory /
  // not-yet-market-eligible uploads are filtered out inside the engine
  // itself (isMarketEligible check), so a bulk website-ingest import never
  // fires 100+ notifications on its own (spec Part B section 15).
  if (!intakeMode) require('../services/notificationEngine').evaluateSavedSearchesForProperty(propId, 'PROPERTY_CREATED')
    .catch(err => log.warn('upload: saved-search notify failed', { propId, ref, err: err.message }))
  // CLIENTGROUPS -- NEW MATCH TRIGGER (Kev, 2026-09-04): "a newly uploaded
  // property matching an active Client Profile should become an Assistant
  // event." Same fire-and-forget shape as the two calls above — never
  // sends anything itself, only brings an eligible clientgroup's next
  // proactive check forward; every existing gate (cooldown, quiet hours,
  // human-active, daily cap) still applies when that check actually fires.
  if (!intakeMode) require('../services/clientAssistant').onNewPropertyAvailable(propId)
    .catch(err => log.warn('upload: clientgroups match-trigger failed', { propId, ref, err: err.message }))

  // ── channel queue rows from upload_channel_config ──────────────────────────
  // Every variant 1–9 has its own rows, but a variant with none must not
  // silently publish nowhere — fall back to the base 'upload' row set.
  let chR = await db.query(
    `SELECT channel FROM upload_channel_config WHERE command_variant=$1 AND enabled=TRUE`, [variant])
  if (!chR.rows.length && variant !== 'upload') {
    log.warn('upload: no channel config for variant, using base upload config', { variant })
    chR = await db.query(
      `SELECT channel FROM upload_channel_config WHERE command_variant='upload' AND enabled=TRUE`)
  }
  // "noad" strips every Facebook channel here, so no publishing row is ever
  // created for it — !uploadstatus shows the listing as genuinely FB-free
  // rather than "pending forever".
  const hasMedia = imageUrls.length > 0 || videoUrls.length > 0
  const channels = (intakeMode ? ['crm'] : chR.rows.map(r => r.channel))
    .filter(ch => !(noAd && FB_CHANNELS.has(ch)))
    // A listing with NO images and NO videos strips the FB channels for the
    // same reason noad does: Facebook has nothing to show, so every FB channel
    // would queue a post that can only fail. crm / website / category_groups
    // are deliberately NOT filtered - the CRM row is the record of the listing
    // and the WhatsApp category groups post a text-only ad happily. The
    // services enforce this too (fbMediaGuard), so a hand-run !fbgroups on the
    // same listing skips as well; this filter is what keeps the status board
    // honest instead of showing FB pending forever.
    .filter(ch => !(!hasMedia && FB_CHANNELS.has(ch)))
  // Kev, 2026-09-02 (reverted same day): a "no exact street → skip Facebook +
  // category_groups" filter briefly lived here. It broke the normal case, not
  // the edge case — almost no upload carries a house/building number, so it
  // silently limited nearly every listing (with photos!) to CRM + website
  // only (#2906-9149 first caught it: 4BR/3BA/10 photos, "Queued: website"
  // and nothing else). The actual privacy bar — street/apt must never appear
  // in outgoing text — was already enforced independently by
  // sanitizeForPublic() (street/apt always null in public_payload) and by
  // categoryFormatter's findAddress()/assertNoOwnerDataLeak() checks on the
  // rendered message. Gating the whole channel on the address being known was
  // an extra, wrong layer on top of that, not a needed one.
  if (!hasMedia && !noAd) {
    log.info('upload: no images and no videos, facebook channels skipped',
      { ref, propId, channels })
  }
  for (const ch of channels) {
    // crm + website: both written synchronously by the upload pipeline
    // (properties.published = TRUE is set before channels are queued, and
    // CRM ingestion via createColdList runs in this same flow). Everything
    // else (FB variants, category_groups) is queued.
    const status = (ch === 'crm' || ch === 'website') ? 'posted' : 'pending'
    // posted_at computed here, NOT via `CASE WHEN $3='posted'` — reusing $3 in
    // both the status column and a comparison makes Postgres deduce two
    // different types for one parameter ("inconsistent types deduced for $3").
    const postedAt = status === 'posted' ? new Date() : null
    await db.query(
      `INSERT INTO property_publishing_status (property_id, channel, target_ref, status, posted_at)
       VALUES ($1,$2,'',$3,$4)
       ON CONFLICT (property_id, channel, target_ref) DO NOTHING`,
      [propId, ch, status, postedAt])
  }

  // ownerName / ownerPhone are additive — the optional "group" keyword needs
  // them to name the viewing group and add the owner as a member.
  // rawText is forwarded to the viewing-group so the agent's own message
  // (already cleaned of stray dots above) lands in the group verbatim — the
  // sanitised description_social is reserved for the CRM / FB page /
  // category-group channels.
  return { propId, ref, town, beds, baths, longlet, sale,
           imageCount: imageUrls.length, videoCount: videoUrls.length,
           channels, publicPayload, noAd: !!noAd,
           ownerName, ownerPhone: primaryPhone, rawText,
           photoSummary: preparedPhotos.photoResult }
}

// ── follow-up message after async category distribution (Task 4) ─────────────
function formatDistributionResult(ref, pub) {
  if (pub?.skippedReason === 'future_availability') {
    return `🕓 #${ref} saved to CRM and website. Property Chat is paused until closer to ${pub.availableDate}.`
  }
  const posted  = pub.results.filter(r => r.status === 'posted')
  const skipped = pub.results.filter(r => r.status === 'already_posted')
  const failed  = pub.results.filter(r => r.status === 'failed')
  const total = pub.results.length
  if (!total) return `📂 #${ref} — no matching category group (${pub.reasoning || 'no rules matched'})`

  // One property = one group, so the happy path is a single line (less spam).
  if (!failed.length && !skipped.length && posted.length === 1) {
    return `📂 #${ref} → ${posted[0].display_name}`
  }
  if (!failed.length && !posted.length && skipped.length === 1) {
    return `📂 #${ref} → ${skipped[0].display_name} (already posted)`
  }

  // Anything unusual keeps the full per-group breakdown.
  const lines = []
  lines.push(failed.length
    ? `📂 #${ref} distributed: ${posted.length}/${total}`
    : `📂 #${ref} distributed:`)
  for (const r of posted)  lines.push(`✅ ${r.display_name}`)
  for (const r of skipped) lines.push(`⏭️ ${r.display_name} (already posted)`)
  for (const r of failed)  lines.push(`❌ ${r.display_name} — ${String(r.error || '').slice(0, 80)}`)
  if (failed.length) {
    lines.push('')
    lines.push(`Retry: !recategorize ${ref}`)
  }
  return lines.join('\n')
}

// Divider closing an upload cycle — its own message so it reads as a separator.
async function sendDivider(session, chatId) {
  try { await reply(session, chatId, DIVIDER) }
  catch (e) { log.warn('upload: divider send failed', { err: e.message }) }
}

async function runCategoryDistribution(session, chatId, propId, ref) {
  try {
    // Same identity throughout: `session` here is already whichever account
    // pickUploadSession() designated primary for this exact upload (the
    // gate above only lets this function get called at all when session
    // matches that pick) — passing it through means the category-group
    // posts, the reaction, and the command handling all read as ONE account,
    // never a mismatched hand-off mid-listing.
    const pub = await publishToCategoryGroups(propId, { session })
    // NEW: keep the aggregate tracker honest. All-success → posted,
    // any-failure → failed with the first error captured. markChannel only
    // updates the AGGREGATE row (target_ref=''); per-group child rows are
    // already written by the publisher with their own status.
    if (pub?.skippedReason === 'future_availability') {
      await markChannel(propId, 'category_groups', 'skipped', 'future_availability')
    } else if (pub && Array.isArray(pub.results) && pub.results.length) {
      const ok = pub.results.filter(r => r.status === 'posted').length
      const fail = pub.results.find(r => r.status === 'failed')
      if (fail && ok === 0) {
        await markChannel(propId, 'category_groups', 'failed', fail.error || 'unknown')
      } else {
        await markChannel(propId, 'category_groups', 'posted', null)
      }
    } else {
      // No candidate groups matched the property's keys — record the
      // real reason instead of leaving the row stuck on 'pending' forever.
      await markChannel(propId, 'category_groups', 'failed', 'no_active_groups_for_keys')
    }
    await reply(session, chatId, formatDistributionResult(ref, pub))
    // Kev, 2026-08-31: returned so a non-WhatsApp caller (the Schedule
    // Board's AV-date-confirm button) can see which groups actually got
    // posted and follow up into the SAME ones -- every existing caller
    // (!price, !upload) already ignored the return value, so this is
    // purely additive.
    return pub
  } catch (e) {
    log.error('upload: category distribution failed', { ref, err: e.message })
    await markChannel(propId, 'category_groups', 'failed', e.message)
    // Kev, 2026-10-22 (P1, Olga #2906-9507/9515): a missing category is not a
    // crash — ask the uploader ONE concise question with the valid answers.
    // A reply "3" to this message (or !recategorize REF 3) resolves it.
    if (/needs manual categorisation/i.test(e.message)) {
      await reply(session, chatId,
        `❓ #${ref} needs a category before it goes to the groups — the bedroom count is unknown.\n` +
        `Reply to this message with 1, 2, 3 or 4 (bedrooms) — or C (commercial) / LUX (villa/luxury, needs an admin).\n` +
        `Same as: !recategorize ${ref} 3`)
      return null
    }
    await ul.alertKev(`❌ Category distribution failed for #${ref}\n${e.message}\n${(e.stack || '').split('\n').slice(0, 4).join('\n')}`)
    await reply(session, chatId, `⚠️ #${ref} category distribution failed — Kev has the details. Retry: !recategorize ${ref}`)
    return null
  }
}

// ── optional "group" keyword — WhatsApp viewing group ────────────────────────
// GOWS DOES support group creation: POST /api/{session}/groups, verified
// 2026-07-30 (participants come back with Error=0). The creating account is
// unavoidably a member, so the group is created AS THE SENDER's own session when
// one exists — that keeps membership to exactly owner + Olga + sender. WAHA
// session names are case-sensitive and don't always match whatsapp_accounts
// ('Kevthirdd' vs 'kevthirdd'), so resolve the name from WAHA, not the DB.
// WAHA Plus GOWS returns a fresh group JID from /api/{session}/groups that
// is NOT yet visible to /api/sendText for up to 30 s. The first call
// lands with 422 "Session ... does not exist"; a follow-up after a short
// wait succeeds. Without this wrapper the upload logs an error and the
// group is born with no welcome text or forward. We poll instead of
// counting attempts because the settle window is per-group, not
// per-request, and can vary 0-30 s.
async function sendWithGroupSettle(sendFn, {
  maxWaitMs = 30_000,
  pollMs     = 800,
} = {}) {
  const deadline = Date.now() + maxWaitMs
  let lastErr = null
  while (Date.now() < deadline) {
    try {
      return await sendFn()
    } catch (err) {
      lastErr = err
      const msg = String((err && err.message) || err)
      const isSettle = /Session .* does not exist/i.test(msg) || /\b422\b/.test(msg)
      if (!isSettle) throw err
      await new Promise(r => setTimeout(r, pollMs))
    }
  }
  throw lastErr || new Error('sendWithGroupSettle: timed out after ' + maxWaitMs + 'ms')
}

async function wahaSessionForPhone(phone) {
  const want = digits(phone)
  if (!want) return null
  try {
    const base = (config.waha?.url || 'http://waha:3000').replace(/\/$/, '')
    const res = await fetch(`${base}/api/sessions`, {
      headers: { 'X-Api-Key': config.waha?.apiKey || '' },
    })
    if (!res.ok) return null
    const list = await res.json()
    for (const s of (Array.isArray(list) ? list : [])) {
      if (s?.status !== 'WORKING') continue
      if (digits(String(s?.me?.id || '')) === want) return s.name
    }
  } catch (e) {
    log.warn('upload: WAHA session lookup for group creation failed', { err: e.message })
  }
  return null
}

// Creates the viewing group for one listing and records it as a channel row.
// Throws on failure — the caller keeps the upload alive.
//
// Phase 5: the actual side effects (createGroup + welcomeText + forwardText +
// location PM) are now driven by the pure planner in services/viewingGroupPlan.
// Olga is opt-in via OLGA_ENABLED=1 (or olgaEnabled: true on the planner
// call), so the default is the lightweight owner+uploader+property path.
async function createViewingGroup({ c, uploaderPhone, groupOptions = null }) {
  const senderSession  = await wahaSessionForPhone(uploaderPhone)
  const creatorSession = senderSession || SESSION_FOR_GROUPS
  const creatorPhone   = digits(senderSession ? uploaderPhone : config.admin?.botNumber)

  const plan = buildViewingGroupPlan({
    c, uploaderPhone,
    requesterPhone: groupOptions?.requesterPhone,
    requesterName: groupOptions?.requesterName,
    timeoutCreated: groupOptions?.timeoutCreated === true,
  })
  // The creator is already in the group — asking WAHA to add it again errors.
  const toAdd = plan.participants.filter(p => p !== creatorPhone)
  const name = plan.name

  const created = await waha.createGroup(creatorSession, name, toAdd)
  const groupId = created?.JID || created?.jid
  if (!groupId) throw new Error('createViewingGroup: WAHA returned no group JID')

  // Record the new group as a publishing row so !uploadstatus surfaces it.
  await db.query(
    `INSERT INTO property_publishing_status
       (property_id, channel, target_ref, status, posted_at, run_index)
     VALUES ($1,'viewing_group',$2,'posted',NOW(),1)
     ON CONFLICT (property_id, channel, target_ref) DO UPDATE
       SET status='posted', posted_at=NOW(), updated_at=NOW()`,
    [c.propId, groupId])

  // WAHA returns the post-create participant list. Anyone who came back with
  // a non-zero Error is reported so the operator can manually re-invite.
  const failed = (created.Participants || [])
    .filter(p => Number(p?.Error || 0) !== 0)
    .map(p => `${p.PhoneNumber || p.JID} (err ${p.Error})`)

  // Welcome + forward. The welcome is the first thing the owner sees when
  // they enter; the forward is the listing itself, posted in the group so
  // members can scroll back to it later. WAHA Plus GOWS rejects
  // /api/sendText with 422 "Session does not exist" for the first
  // ~300-500 ms after a successful createGroup (the JID is not yet
  // visible to /sendText even though /groups/info shows it). A short
  // wait-and-retry makes the welcome land in every group, not just the
  // lucky ones.
  const sendOpts = { session: creatorSession, chatId: groupId }
  // Track the welcome send separately so the operator can !uploadstatus
  // to see whether the welcome actually went out, not just whether the
  // viewing_group row was inserted (which happens BEFORE the welcome).
  const welcomeTracker = { sent: false, error: null }
  const sentWelcome = await sendWithGroupSettle(() =>
    waha.sendText(sendOpts.session, sendOpts.chatId, plan.welcomeText))
    .then(r => { welcomeTracker.sent = true; return r })
    .catch(e => { welcomeTracker.error = String(e.message || e).slice(0, 200); throw e })
  const sentForward = await sendWithGroupSettle(() =>
    waha.sendText(sendOpts.session, sendOpts.chatId, plan.forwardText))

  // Persist the welcome-send outcome to property_publishing_status.
  await db.query(
    `UPDATE property_publishing_status
       SET welcome_sent = $1, welcome_error = $2, welcome_sent_at = CASE WHEN $1 THEN NOW() ELSE NULL END,
           updated_at = NOW()
     WHERE property_id = $3 AND channel = 'viewing_group' AND target_ref = $4`,
    [welcomeTracker.sent, welcomeTracker.error, c.propId, groupId])
  // Lead image, if any. WAHA Plus accepts base64 image sends; the URL is the
  // CRM public_payload image[0] when sanitized.
  // created() in createListing() does NOT pass imageItems through, so
  // the planner cannot read the lead photo. The lead image is sent on a
  // best-effort basis — c.imageCount is the only signal we have. If
  // c.publicPayload.images[0] is a Cloudinary URL we re-download it as
  // base64 so the lead image is sent.
  if (c.publicPayload && Array.isArray(c.publicPayload.images) && c.publicPayload.images[0]) {
    try {
      const url = c.publicPayload.images[0]
      const res = await fetch(url)
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer())
        const mime = res.headers.get('content-type') || 'image/jpeg'
        await waha.sendImage(creatorSession, groupId, buf, mime, '')
      }
    } catch (err) {
      log.warn('upload: viewing group lead image failed', { err: err.message, ref: c.ref })
    }
  }

  // Private location message to the owner ONLY. The exact street/apt are
  // sensitive — they go on a 1:1 chat, never in the group. If the property
  // has no street on file the planner returns null and we skip.
  if (plan.locationMessage) {
    try {
      await waha.sendText(creatorSession, plan.locationMessage.to, plan.locationMessage.text)
    } catch (err) {
      log.warn('upload: owner location PM failed', { err: err.message, ref: c.ref })
    }
  }

  log.info('upload: viewing group created', {
    ref: c.ref, groupId, name, creatorSession,
    expectedMembers: toAdd.length + 1, inResponse: (created.Participants || []).length,
    failed: failed.length ? failed : undefined,
    welcomePosted: true, forwardPosted: true, locationPmPosted: !!plan.locationMessage })
  return { groupId, name, failed, locationPmPosted: !!plan.locationMessage }
}

// ── automatic FB group share ────────────────────────────────────────────────
// Runs at the END of the upload cycle, in the same async block as the category
// distribution, so it never delays the AV CENTRAL confirmation.
//
// startRun() only STARTS the run: it validates, freezes the group selection and
// enqueues the first job. The 9–14 groups are then worked one at a time by the
// fb-groups worker over the next ~15–40 minutes.
//
// Nothing in here may fail the upload. The CRM record already exists and the
// listing is already in the category groups by this point; a Facebook problem
// is a notification, not a rollback. That includes the leak guard: startRun
// builds the message from the sanitized public_payload and returns an error
// rather than throwing, so a listing that trips the firewall is SKIPPED and
// reported — it never reaches a group and never breaks the upload.
// `notify` is an injection seam so the deploy test can exercise this function
// for real — refusals, alerts, channel marks and all — without messaging
// anyone. Production always uses the defaults.
async function autoShareToGroups({ created, session, chatId, noAd, notify }) {
  const toChat  = notify?.chat || ((text) => reply(session, chatId, text))
  const toNotes = notify?.kev  || ((text) => ul.alertKev(text))
  if (noAd) return
  // Errors that are EXPECTED and KNOWN (proxy dead, FB logged out, no internet)
  // get a single warn — not a Notes alert. These aren't a regression; they're
  // the current state of the world. Once the operator sees the warn in the
  // logs, the fix path is documented in SHEETS-SETUP.md / kimi-debug.
  const isExpected = (msg) => /proxy|session.*not.*logged|network|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|407|401/i.test(String(msg || ''))
  for (const c of created) {
    if (!c.channels.includes('fb_groups')) continue
    try {
      const res = await fbShare.startRun({
        ref: c.ref, requesterChatId: chatId, requesterSession: session,
        source: 'upload',   // force stays false: !upload never overrides the guard
      })

      if (res.alreadyShared) {
        log.warn('upload: auto-share skipped, already shared', { ref: c.ref, runId: res.runId })
        await toChat(`ℹ️ #${c.ref} — already shared (run #${res.runId}), not re-posting`)
        continue
      }

      // No images and no videos: startRun refuses BEFORE the browser. Not an
      // error and not a failure — the upload worked, FB simply has nothing to
      // post. One quiet line, no Notes alert, no channel marked failed (the
      // fb_groups row was never created for a media-less listing).
      if (res.skipped === 'no_media') {
        log.info('upload: auto-share skipped, no images and no videos', { ref: c.ref })
        continue
      }

      if (res.error) {
        // Leak guard, no active groups, FB logged out, rented, noad — all land
        // here as a plain string. Mark the channel failed so the scheduler
        // doesn't requeue it, but DON'T spam Notes for the known infrastructure
        // issues — the operator already knows (or can grep the logs).
        const expected = isExpected(res.error)
        if (expected) {
          log.warn('upload: auto-share skipped (expected infra error)', { ref: c.ref, err: String(res.error).slice(0, 80) })
        } else {
          log.error('upload: auto-share NOT started', { ref: c.ref, err: res.error })
        }
        await markChannel(c.propId, 'fb_groups', 'failed', res.error)
        if (!expected) {
          await toNotes(
            `⚠️ #${c.ref} — FB group share did NOT start\n\n${res.error}\n\n` +
            `The upload itself went through (CRM + categories + website).\n` +
            `Retry when fixed: !fbgroups ${c.ref}\n` +
            `Re-import cookies: scripts/fb_login_import.js or run \`!fbgroupslogin\``)
        }
        continue
      }

      // ONE line, and that is the last this chat hears about it. The run
      // itself reports nothing on finish (see reportsToChat in fbShareQueue) —
      // ten listings a day would otherwise bury AV CENTRAL in status updates.
      // Detail on demand: !fbgroups <ref> status.
      await toChat(`📢 #${c.ref} — Facebook share queued`)
      log.info('upload: auto-share started', { ref: c.ref, runId: res.runId, groups: res.total })
    } catch (e) {
      // Only an unexpected throw reaches this — startRun returns errors.
      const expected = isExpected(e.message)
      if (expected) {
        log.warn('upload: auto-share threw expected infra error', { ref: c.ref, err: String(e.message).slice(0, 80) })
      } else {
        log.error('upload: auto-share crashed', { ref: c.ref, err: e.message })
      }
      try { await markChannel(c.propId, 'fb_groups', 'failed', e.message) } catch {}
      if (!expected) {
        await toNotes(`⚠️ #${c.ref} — FB group share crashed\n${e.message}\n\nUpload itself is fine.`)
      }
    }
  }
}

async function markChannel(propId, channel, status, err) {
  await db.query(
    `UPDATE property_publishing_status
        SET status=$3, last_error=$4, updated_at=NOW()
      WHERE property_id=$1 AND channel=$2 AND target_ref=''`,
    [propId, channel, status, String(err || '').slice(0, 2000)])
}

// ── owner-contact fallback helpers (draft context hotfix, 2026-09-23) ───────
// "!upload Philip +35699234320" → { name: 'Philip', phone: '35699234320' }.
// Only the command line's own trailing text counts, and only when it is
// nothing but a name and a phone (or just a phone). A bare numeric id
// ("!upload6 4835") is too short to be a phone, so it never matches.
function parseOwnerContact(commandText) {
  const tail = String(commandText || '')
    .replace(/^\s*!(?:gptuploadv|gptupload|upload)\s*[1-9]?\b/i, '')
    .replace(/^(?:\s+(?:S|C|force|group|noad)\b)+/i, '')
    .trim()
  if (!tail) return null
  const m = tail.match(/^([\p{L}][\p{L} .'’-]{0,40}?)?\s*[:,-]?\s*(\+?\(?\d[\d\s()-]{6,18}\d)\s*$/u)
  if (!m) return null
  const digits = m[2].replace(/\D/g, '')
  if (digits.length < 8 || digits.length > 15) return null
  return { name: (m[1] || '').trim().replace(/[:,-]+$/, '').trim() || null, phone: digits, raw: m[0].trim() }
}

function parseUploadCommand(text) {
  return gptUploadCommand.parseUploadCommand(text)
}

function stripContactFromText(text, contact) {
  if (!contact || !contact.raw) return String(text || '')
  return String(text || '').split(contact.raw).join(' ').trim()
}

// Deliberately loose: is there a property ad in this text, beyond a contact
// line? Price or bedroom count or a property-type word, plus enough length.
function looksLikeListingText(text) {
  const s = String(text || '')
  if (s.replace(/\s+/g, ' ').trim().length < 40) return false
  const signals = [
    /€\s?\d|\b\d{3,5}\s?(?:eur|euro|€)/i,
    /\b\d+\s?(?:bed|bdr|br|bedroom)/i,
    /\b(?:apartment|flat|studio|maisonette|penthouse|villa|house|room|duplex|townhouse)\b/i,
  ].filter(re => re.test(s)).length
  return signals >= 2
}

// Staged owner-conversation drafts nobody has claimed yet, newest first.
// _testHooks.draftPhonePrefix: tests scope the lookup to their own throwaway
// rows instead of touching real drafts. Always null in production.
const _testHooks = { draftPhonePrefix: null }
async function findUnresolvedDrafts(hours = 6) {
  const r = await db.query(
    `SELECT id, status, checklist FROM owner_auto_conversations
      WHERE status IN ('ready_for_kev','awaiting_auto_publish')
        AND updated_at > NOW() - ($1 || ' hours')::interval
        AND ($2::text IS NULL OR phone LIKE $2 || '%')
      ORDER BY updated_at DESC LIMIT 8`, [String(hours), _testHooks.draftPhonePrefix])
  return r.rows.map(row => {
    const c = row.checklist || {}
    const bits = [c.town, c.bedrooms != null ? `${c.bedrooms}BR` : null, c.price != null ? `€${c.price}` : null].filter(Boolean)
    return { id: row.id, status: row.status, label: bits.join(' · ') || 'draft' }
  })
}

// Pure decision for a command with no explicit draft match. `drafts` null →
// "do I need the draft list?" ('lookup'); an array → the final answer.
//   fresh  — no owner contact, or the gathered text already holds a listing:
//            stage it through the normal pipeline (contact rides in the text)
//   claim  — contact only, exactly one unresolved draft → attach to it
//   ask    — contact only, several drafts → ask which
//   none   — contact only, nothing to attach to
function planContactFallback(commandText, cleanText, drafts) {
  const contact = parseOwnerContact(commandText)
  if (!contact || looksLikeListingText(stripContactFromText(cleanText, contact))) return { action: 'fresh', contact }
  if (drafts == null) return { action: 'lookup', contact }
  if (drafts.length === 1) return { action: 'claim', contact, draft: drafts[0] }
  if (drafts.length > 1) return { action: 'ask', contact, drafts }
  return { action: 'none', contact }
}

// ── !upload main flow ────────────────────────────────────────────────────────
async function cmdUpload({ payload, session, chatId, isGroup, text, variantSuffix, force, wantsGroup, noAd, intakeMode, photoMode }) {
  const variant = 'upload' + (variantSuffix || '')
  // The digit is the TOTAL Facebook post count. No digit → 0 (no facebook).
  // Pass variantSuffix through unchanged: '' must resolve to 0, not 1.
  // "noad" beats the digit — it is the explicit "no Facebook at all" switch.
  const fbPosts = noAd ? 0 : postCountFrom(variantSuffix)
  const triggerTs = payload.timestamp || payload._data?.t || Math.floor(Date.now() / 1000)

  let uploaderPhone = await ul.extractSenderPhone(payload, session, isGroup)
  if (!uploaderPhone) uploaderPhone = ul.resolveUploaderPhone(payload, '', isGroup)

  // context gate: any group the operator marked as authorised, OR any group
    // when AV_CENTRAL_GROUP is unset / '*'. DMs keep the agent/admin gate below.
    if (isGroup && !isAuthorizedGroup(chatId)) {
      log.warn('upload: ignored — group is not authorised for !upload', {
        chatId, variant, hint: AV_CENTRAL_GROUP ? 'set AV_CENTRAL_GROUP=* to allow any group' : null,
      })
      return false
    }
  let agent = await ul.resolveAgent(uploaderPhone)
  if (!isGroup && !agent && !isAdmin(uploaderPhone)) {
    log.warn('upload: ignored — sender is neither registered agent nor admin', {
      uploaderPhone, session, chatId, variant,
      hint: 'a @lid here instead of a phone means the session phone could not be resolved',
    })
    return false
  }
  if (!agent) {
    const kr = await db.query(`SELECT id, username, name, display_name, alias, role, post_tag FROM agents WHERE LOWER(username)='kev' AND active=TRUE LIMIT 1`)
    agent = kr.rows[0]
    if (!agent) { await reply(session, chatId, '⚠️ Upload failed: default agent not configured.'); return true }
  }

  let step = 'gather'
  try {
    // 1-2. REUSE !uploadlisting gathering (window + images). Not rewritten.
    // A property upload must preserve the complete photo batch. Other
    // gatherContent callers retain their bounded 15-image behaviour.
    const gathered = await ul.gatherContent(payload, session, chatId, isGroup, uploaderPhone, triggerTs,
      { allUploadImages: true })
    let cleanText = (gathered.combinedText || '')
    cleanText = gptUploadCommand.stripUploadCommands(cleanText)
      .replace(/\n{3,}/g, '\n\n').trim()
    if (!cleanText) {
      await reply(session, chatId, '❌ No listing content in last 10 minutes.\nSend description + owner details + images first, then !upload.')
      return true
    }

    // UNWRAP STAGING HOTFIX (Kev, 2026-09-23), tightened 2026-09-23 (UNWRAP
    // SAFETY pass) — root cause of "unwrap output appears twice" / "!upload
    // creates a second property": when the owner-conversation checklist
    // finishes, writeDraftProperty already inserted a real, ref-less draft
    // property row, and postChecklistCompleteToAvCentral posted ITS OWN
    // images + provenance text + "!upload<N> to approve" card into this very
    // group (see autoOwnerConversation.js). The code used to treat THAT
    // bot-generated post as fresh raw listing content: gatherContent scooped
    // it up, splitListings/createListing re-ran Gemini extraction over a
    // provenance card that was never a real ad, and every photo got
    // re-uploaded to Cloudinary a second time — a genuine second property,
    // with the original draft left orphaned.
    //
    // The first fix (same day) matched the staging bundle by owner phone
    // substring in the gathered text within a 30-minute window — Kev's own
    // safety call: that can match the WRONG pending draft, or any unrelated
    // message that happens to mention the same phone. Replaced with exact
    // targeting only: a WhatsApp reply to the exact "Property Draft ready"
    // card (postChecklistCompleteToAvCentral now persists that message's id
    // as checklist._review_message_id), or an explicit conversation id typed
    // after the command ("!upload6 4835"). No reply and no id → this block
    // does nothing and the command falls through to the normal fresh-content
    // pipeline below, same as in any other group.
    //
    // Claimable drafts now sit at status='ready_for_kev', not
    // 'awaiting_auto_publish' — armAutoPublish no longer arms a timer for
    // this group at all (see its own 2026-09-23 UNWRAP SAFETY comment), so
    // that status never occurs for real Unwrap traffic any more; matched
    // anyway for any pre-existing row from before that change.
    if (isGroup) {
      const { quotedFromPayload } = require('../lib/quotedMessage')
      const { id: quotedMessageId } = quotedFromPayload(payload)
      const commandPrefix = text.match(/^!(?:(?:gptuploadv|gptupload)\s*[1-9]?|upload[1-9]?)(?:\s+[SC])?\b/i)
      const explicitIdMatch = commandPrefix ? text.slice(commandPrefix[0].length).match(/^\s+(\d{2,})\b/) : null
      const explicitId = explicitIdMatch ? Number(explicitIdMatch[1]) : null

      // DRAFT CONTEXT HOTFIX (Kev, 2026-09-23): replying to the property text
      // and typing "!upload Philip +35699234320" carries a quoted message id —
      // the property text, NOT a "Property Draft ready" card — and this block
      // answered "Couldn't find a staged draft" and stopped, even though the
      // listing was sitting right there in the last 10 minutes. An explicit
      // reply-to-draft still wins, but a quote that isn't a draft card is no
      // longer fatal: the command falls back to (1) exactly one unresolved
      // draft when the message carries only an owner contact, (2) the fresh
      // listing just sent (staged by the normal pipeline below, the owner
      // contact riding along in the same text), (3) a which-one question when
      // several drafts are pending. A typo'd numeric id is still an error.
      let matched = null
      if (quotedMessageId || explicitId) {
        const r = await db.query(
          `SELECT id, status FROM owner_auto_conversations
            WHERE (checklist->>'_review_message_id' = $1 OR id = $2)
              AND updated_at > NOW() - INTERVAL '48 hours'
            ORDER BY updated_at DESC LIMIT 1`,
          [quotedMessageId, explicitId])
        matched = r.rows[0] || null
        if (!matched && explicitId) {
          await reply(session, chatId,
            `❌ Couldn't find a staged draft for id ${explicitId}. Reply directly to the "Property Draft ready" card, or check the id.`)
          return true
        }
      }

      let fallbackContact = null
      if (!matched) {
        let plan = planContactFallback(text, cleanText, null)
        if (plan.action === 'lookup') plan = planContactFallback(text, cleanText, await findUnresolvedDrafts())
        const contact = plan.contact
        if (plan.action === 'claim') {
          matched = plan.draft
          fallbackContact = contact
        } else if (plan.action === 'ask') {
          await reply(session, chatId,
            `❓ ${plan.drafts.length} staged drafts are waiting — which one is ${contact.name || contact.phone}'s? Reply to its "Property Draft ready" card with !${variant}, or send !${variant} <id>:\n` +
            plan.drafts.map(d => `• ${d.id} — ${d.label}`).join('\n'))
          return true
        } else if (plan.action === 'none') {
          await reply(session, chatId,
            `❌ No property text in the last 10 minutes and no staged draft to attach ${contact.name || contact.phone} to. Send the listing first, then !${variant} ${contact.name || ''} ${contact.phone}`.replace(/\s+/g, ' '))
          return true
        }
        // action 'fresh': a listing was just sent (or there is no contact) —
        // falls through to the normal pipeline, which stages it with the
        // owner contact already inside the gathered text.
      }

      if (matched) {
        if (fallbackContact) {
          await db.query(
            `UPDATE owner_auto_conversations
                SET checklist = jsonb_set(COALESCE(checklist,'{}'::jsonb), '{_attached_contact}', $2::jsonb, true)
              WHERE id = $1`,
            [matched.id, JSON.stringify(fallbackContact)]
          ).catch(e => log.warn('upload: could not record attached owner contact', { err: e.message }))
        }
        if (matched.status !== 'ready_for_kev' && matched.status !== 'awaiting_auto_publish') {
          // Already claimed — refuse rather than create a genuine duplicate publish.
          await reply(session, chatId,
            `ℹ️ This draft was already ${matched.status === 'auto_published' ? 'published' : matched.status} — ignoring !${variant} to avoid a duplicate. Check AV CENTRAL/CRM for the listing.`)
          return true
        }
        const { runAutoPublishJob } = require('../services/autoOwnerConversation')
        await runAutoPublishJob(matched.id, { explicitClaim: true })   // an explicit !upload claim of the draft
        // runAutoPublishJob's own alertKev confirmation lands in Kev's DM
        // (same place the automatic-timer path already sends it) — this
        // extra line just confirms in the chat where the command was
        // actually typed, so the reply isn't only visible somewhere else.
        await reply(session, chatId, `✅ Claimed the staged draft and published it. Check your DM for the #ref confirmation.`)
        await sendDivider(session, chatId)
        return true
      }
    }

    // Task 5 — split into one or more listings (single Gemini call)
    step = 'split'
    const listings = restoreSingleListingContact(await splitListings(cleanText), cleanText)

    step = 'associate-images'
    const assoc = associateImages(listings, gathered)
    if (assoc.ambiguous) {
      log.warn('upload: blocked unsafe multi-property image assignment', {
        listings: listings.length,
        images: (gathered.imageItems || []).length,
        reason: assoc.reason,
      })
      await reply(session, chatId,
        `❌ Upload stopped before creating any properties because the ${listings.length} property blocks and ${(gathered.imageItems || []).length} images could not be matched safely.\n` +
        `${assoc.reason || 'The image order is ambiguous.'}\n\n` +
        `Send each property's text and photos together, put a message containing only .... between properties, then run !${variant} again.`)
      return true
    }

    step = 'create'
    if (photoMode) {
      const total = (gathered.imageItems || []).length
      const count = Math.min(total, gptPhotoPipeline.MAX_EDIT_IMAGES)
      // Internal chat only. Photos beyond the limit are still uploaded, as
      // originals - say so up front instead of silently leaving them unedited.
      const overLimit = total > count ? `\nMaximum ${gptPhotoPipeline.MAX_EDIT_IMAGES} images supported for gptupload - ${total - count} more kept as original.` : ''
      await reply(session, chatId,
        `${photoMode === 'vision' ? 'VISION + GPT PHOTO PROCESSING' : 'GPT PHOTO PROCESSING'}\n0 / ${count} complete${overLimit}`)
    }
    const created = []
    const dupes = []
    const errors = []
    for (let i = 0; i < listings.length; i++) {
      if (i > 0) await sleep(3000 + Math.floor(Math.random() * 2000))   // 3–5 s, don't hammer Gemini
      const rawText = listings[i].raw_text
        .split('\n').filter(l => !/^\s*[.\/]+\s*$/.test(l)).join('\n').trim()
      // Videos are not position-associated the way images are: a walkthrough
      // clip has no reliable anchor in the text, so with several listings in one
      // batch every clip goes to the FIRST one. Image assignment is independent
      // and already proved safe above.
      // (A pending owner-conversation draft, if this batch matched one, was
      // already claimed and returned above — this loop only ever runs for
      // genuinely fresh content now, so there is no structuredRules source
      // to merge in here.)
      const res = await createListing({
        rawText, images: assoc.perListing[i] || [],
        videos: i === 0 ? (gathered.videoItems || []) : [],
        agent, senderPhone: uploaderPhone,
        chatId, session, variant, force, noAd: noAd || !!intakeMode, intakeMode, photoMode,
        photoTriggerId: `${String(payload.id || payload.key?.id || triggerTs)}:${i}`,
      })
      // A batch can split one ad into two chunks; the second then "duplicates"
      // the listing created a moment ago. That is not a skipped duplicate —
      // reporting it ("1 duplicate skipped (#2906-9502)" right under the new
      // #2906-9502) only made agents think it was uploaded twice.
      if (res.duplicate) { if (!created.some(c => c.ref === res.duplicate)) dupes.push(res.duplicate) }
      else if (res.error) errors.push(`listing ${i + 1}: ${res.error}`)
      else {
        // (ReferenceError fix, 2026-09-23: a leftover `if (matchedConvo)` block
        // stood here after the staged-draft claim was moved above and the
        // variable was removed — it threw AFTER createListing succeeded, so a
        // fresh upload made the property but never sent its confirmation.)
        created.push(res)
      }
    }

    if (!created.length && dupes.length) {
      await reply(session, chatId, `⚠️ Looks like a duplicate of #${dupes[0]}. Reply !${variant} force to create anyway.`)
      return true
    }
    if (!created.length) {
      await reply(session, chatId, `❌ No listings created.\n${errors.join('\n') || 'Could not parse the content.'}`)
      return true
    }

    // ── reply ──────────────────────────────────────────────────────────────
    step = 'reply'
    // Colleague cross-credit (Kev + Olga by default; overridden by COLLEAGUE_AGENTS env).
    // Resolves asynchronously but with the agent we already loaded, so a missing
    // colleague number is still a no-op (returns []).
    const colleagues = await resolveColleaguesForPrimary(agent).catch(() => [])
    const creditAgents = [agent, ...colleagues].filter(Boolean)
    // Who the bot recognised — single tag for one agent, compound for several.
    // Empty for untagged agents (Kev), which keeps the confirmation unchanged.
    const tag = creditAgents.length > 1 ? formatPostTagsForAgents(creditAgents) : formatPostTag(agent.post_tag)
    const tagSuffix = tag ? ` ${tag}` : ''
    if (created.length === 1) {
      const c = created[0]
      const price = c.longlet ? `€${c.longlet}` : (c.sale ? `€${c.sale} sale` : '—')
      // facebook shows its post count, so a wrong variant is visible here
      // before post 1 goes out.
      const queued = c.channels.filter(ch => ch !== 'crm')
        .filter(ch => ch !== 'facebook' || fbPosts > 0)   // no digit → no page line
        .map(ch => {
          if (ch === 'facebook')  return `fb page ×${fbPosts}`
          if (ch === 'fb_groups') return `fb groups ×${fbShare.RUN_SIZE_MIN}-${fbShare.RUN_SIZE_MIN + fbShare.RUN_SIZE_SPREAD}`
          return ch
        })
      const media = `${c.imageCount} image${c.imageCount === 1 ? '' : 's'}` +
        (c.videoCount ? ` · ${c.videoCount} video${c.videoCount === 1 ? '' : 's'}` : '')
      await reply(session, chatId,
        `✅ #${c.ref} → CRM${tagSuffix}${c.existingUpdate ? ' (existing property updated)' : ''}\n` +
        (c.multiUnit ? `Multi-unit post — also created ${c.units.map(u => '#' + u.ref).filter(r => r !== '#' + c.ref).join(', ')}, both cross-referenced.\n` : '') +
        `${c.town || '—'} · ${c.beds || '?'}BR/${c.baths || '?'}BA · ${price}\n` +
        `${media}\n` +
        (c.photoSummary ? `GPT PIMP ${c.photoSummary.editedCount}/${Math.min(c.photoSummary.sourceCount, gptPhotoPipeline.MAX_EDIT_IMAGES)} complete${c.photoSummary.fallbackCount ? ` · ${c.photoSummary.fallbackCount} original fallback` : ''}${c.photoSummary.lowerResolutionCount ? ` · ${c.photoSummary.lowerResolutionCount} lower-res, review` : ''}${c.photoSummary.overLimitCount ? ` · ${c.photoSummary.overLimitCount} over limit kept original` : ''}${c.photoSummary.audit?.hero_candidates?.length ? ` · hero candidate ${c.photoSummary.audit.hero_candidates[0] + 1}` : ''}\n` : '') +
        `\n` +
        (noAd ? `🚫 noad — no Facebook at all (no page post, no group share)\n` : '') +
        (!noAd && !c.imageCount && !c.videoCount
          ? `🚫 no images/videos — Facebook skipped (CRM + categories still went)\n` : '') +
        `Queued: ${queued.length ? queued.join(', ') : '(none — CRM only)'}\n` +
        `crm.2906.estate/property/${c.propId}` +
        (dupes.length ? `\n\n⚠️ ${dupes.length} duplicate skipped (#${dupes.join(', #')})` : '') +
        (errors.length ? `\n⚠️ ${errors.join('; ')}` : ''))
    } else {
      const lines = [`✅ ${created.length} properties uploaded${tagSuffix}`]
      if (noAd) lines.push('🚫 noad — no Facebook at all (no page post, no group share)')
      for (const c of created) {
        let keys = []
        try { keys = (await classifyProperty(c.publicPayload)).keys } catch {}
        const price = c.longlet ? `€${c.longlet}` : (c.sale ? `€${c.sale}` : '—')
        lines.push(`#${c.ref} ${c.town || '—'} ${c.beds || 0}BR ${price} → ${keys.join(', ') || '—'}`)
      }
      if (dupes.length)  lines.push(`⚠️ duplicates skipped: #${dupes.join(', #')}`)
      if (errors.length) lines.push(`⚠️ ${errors.join('; ')}`)
      await reply(session, chatId, lines.join('\n'))
    }

    if (intakeMode) {
      await reply(session, chatId,
        `📝 ${intakeMode === 'sale' ? 'Sales' : 'Commercial'} draft saved internally. Missing catalog fields remain UNKNOWN; nothing was auto-published.`)
      await sendDivider(session, chatId)
      return true
    }

    // ── facebook page campaign — fbPosts posts, queued not posted here ──────
    // Scheduled after the CRM record + confirmation so post 1 (delay 0) fires
    // immediately. A Facebook failure must never fail an upload that already
    // created the CRM record, so each property is caught individually.
    for (const c of created) {
      // noAd already stripped 'facebook' from c.channels; the explicit check
      // keeps the intent readable at the call site that actually posts.
      if (noAd || !c.channels.includes('facebook')) continue
      try {
        const camp = await scheduleFacebookCampaign(c.propId, fbPosts)
        if (camp.skipped) {
          log.info('upload: fb campaign skipped', { ref: c.ref, reason: camp.skipped })
        } else {
          log.info('upload: fb campaign scheduled', { ref: c.ref, posts: camp.scheduled })
        }
      } catch (e) {
        log.error('upload: fb campaign scheduling failed', { ref: c.ref, err: e.message })
        await reply(session, chatId, `⚠️ #${c.ref} — Facebook not scheduled: ${e.message}`)
      }
    }

    // ── optional viewing group ("group" keyword) ────────────────────────────
    // Runs after CRM + confirmation + facebook, and must never fail the upload.
    if (wantsGroup) {
      for (const c of created) {
        try {
          const g = await createViewingGroup({ c, uploaderPhone })
          const warn = g.failed.length ? `\n⚠️ not added: ${g.failed.join(', ')}` : ''
          await reply(session, chatId, `👥 Viewing group created: ${g.name}${warn}`)
        } catch (e) {
          // sendWithGroupSettle already retries 30s for the GOWS "Session does
          // not exist" race; if we STILL land here it's a real failure. Surface
          // a short warning to the operator so they know the WELCOME didn't go
          // out (the viewing_group row in the DB is marked 'posted' BEFORE
          // the welcome fires, so the row status alone is misleading).
          const errShort = String(e.message || e).slice(0, 120)
          log.warn('upload: viewing group welcome failed', { ref: c.ref, err: errShort })
          await reply(session, chatId,
            `⚠️ #${c.ref} — viewing group was created but the welcome was NOT sent.\n` +
            `Reason: ${errShort}\n` +
            `Re-send: !uploadstatus ${c.ref}`)
        }
      }
    }

    // ── async category distribution — never blocks the reply ────────────────
    // The divider is sent LAST, once the whole cycle is finished, so it always
    // marks the end of this upload in the group.
    // The FB group share rides in the same async block, AFTER the categories:
    // it must run whether or not this variant has the category channel, and it
    // must never hold up the confirmation above.
    //
    // ROLE GATE — only Kevin-family sessions (default, Kevsecond, Kevthirdd,
    // Jasmine, Cedric) broadcast to the WA category groups. An agent upload
    // (Olga, Adrian, etc.) still writes the CRM row and still runs the
    // Facebook share, but the WA category-group broadcast is skipped: the
    // chart-d add row is tagged so the operator sees WHY the listing has no
    // category_published row. The whitelist is config.waha.kevinAccounts
    // (env KEVIN_ACCOUNTS) so account changes here are operator-driven, not
    // code-driven.
    // Category broadcast: prefer the listing's listed_by_agent_id (Kev-family
    // means broadcast). Fall back to the uploader's session mapping. The
    // publisher itself runs as 'default' session regardless, so the only
    // thing we need to gate is whether the listed agent is a Kevin agent.
    //
    // NOTE: read listed_by_agent_id from the DB (not the createListing return
    // object — that object historically omitted the field, breaking this gate
    // for every upload since the refactor). The DB row IS the source of truth.
    const listedAgentIdRow = await db.query(
      `SELECT listed_by_agent_id FROM properties WHERE id = $1 LIMIT 1`,
      [created[0].propId])
    const listedAgentId = listedAgentIdRow.rows[0]?.listed_by_agent_id || null
    const kevinAccounts = (config.waha?.kevinAccounts || []).map(s => String(s || '').toLowerCase())
    const wantsCategories = created[0].channels.includes('category_groups')
    // The broadcast is safe to run for any listing whose LISTED agent is a
    // Kevin agent. (Before this fix the gate used the uploader's session,
    // which can be null even on a Kevin phone because session name resolution
    // in WAHA returns different IDs than the JD owner phone expects.)
    // Kev, 2026-10-19: Olga (agent 2) lists under her own name AND posts to the
    // category groups like Kevin's accounts. CATEGORY_BROADCAST_AGENT_IDS (env,
    // comma separated) is the list of listed agents whose uploads broadcast.
    const broadcastAgentIds = String(process.env.CATEGORY_BROADCAST_AGENT_IDS || '1,2')
      .split(',').map(s => Number(s.trim())).filter(Number.isFinite)
    const isKevinListing = !!(listedAgentId && kevinAccounts.length === 0) ||
                           (listedAgentId === 1) || // Kev is agent id 1
                           broadcastAgentIds.includes(Number(listedAgentId)) ||
                           kevinAccounts.length === 0 // empty whitelist => permissive
    const skipCategoryBroadcast = wantsCategories && !isKevinListing
    if (skipCategoryBroadcast) {
      log.info('upload: category broadcast SKIPPED (non-Kevin listed agent)', {
        ref: created[0].ref, listedAgentId, kevinAccounts })
    }
    ;(async () => {
      if (wantsCategories && !skipCategoryBroadcast) {
        for (const c of created) {
          await runCategoryDistribution(session, chatId, c.propId, c.ref)
          await sleep(4000)
        }
      } else if (skipCategoryBroadcast) {
        // Inform the chat that the WA category broadcast was skipped — the
        // CRM row and FB share still went, but the category_groups channel
        // is intentionally not fired for an agent upload.
        await reply(session, chatId,
          `📂 Category broadcast skipped (uploader session "${uploaderSession}" is not a Kevin account) — CRM + website + Facebook share still went.`)
      }
      await autoShareToGroups({ created, session, chatId, noAd })
      await sendDivider(session, chatId)
    })().catch(async (e) => {
      log.error('upload: async distribution crashed', { err: e.message })
      await sendDivider(session, chatId)
    })
    return true
  } catch (e) {
    log.error('upload failed', { step, err: e.message })
    await ul.alertKev(`❌ !${variant} failed at step ${step}\nChat: ${chatId}\n${e.message}\n${(e.stack || '').split('\n').slice(0, 5).join('\n')}`)
    await reply(session, chatId, `⚠️ upload failed at step ${step} — details sent to your notes.`)
    return true
  }
}

// ── !fbgroups [status|stop|restart|kick|force <ref>] (Phase 6) ──────────────
const { parseFbgroupsCommand } = require('../services/fbgroupsCommand')
async function cmdFbgroups(session, chatId, arg) {
  const parsed = parseFbgroupsCommand(arg)
  if (parsed.kind === 'invalid') {
    await reply(session, chatId, '❌ ' + parsed.reason + '\n\nUsage: !fbgroups [status|stop|restart|kick|force <ref>]')
    return
  }
  if (parsed.kind === 'stop') {
    await db.query(`UPDATE fb_backlog_state SET enabled=FALSE, stopped_reason=$1, updated_at=NOW() WHERE id=TRUE`,
      ['admin stop via !fbgroups stop at ' + new Date().toISOString()])
    await reply(session, chatId, '🛑 FB backlog stopped. Use !fbgroups restart to resume.')
    return
  }
  if (parsed.kind === 'restart') {
    await db.query(`UPDATE fb_backlog_state SET enabled=TRUE, stopped_reason=NULL, updated_at=NOW() WHERE id=TRUE`)
    await reply(session, chatId, '✅ FB backlog re-enabled.')
    return
  }
  if (parsed.kind === 'kick') {
    try {
      const fb = require('../services/fbShareBacklog')
      await fb.queueKick({ reason: 'admin_kick' })
      await reply(session, chatId, '🚀 Kick queued.')
    } catch (err) {
      await reply(session, chatId, '❌ kick failed: ' + err.message)
    }
    return
  }
  if (parsed.kind === 'force') {
    const prop = await findByRef(parsed.ref)
    if (!prop) { await reply(session, chatId, `❌ Property "${parsed.ref}" not found.`); return }
    // Force only re-arms FAILED runs — successful or already-running ones are left alone.
    const r = await db.query(
      `UPDATE fb_share_runs SET status='queued', posted_count=0, failed_count=0,
         last_error=NULL, paused_reason=NULL, started_at=NULL, finished_at=NULL
         WHERE property_id=$1 AND status IN ('failed','cancelled')
         RETURNING id`, [prop.id])
    const rearmed = r.rows.length
    if (rearmed === 0) {
      await reply(session, chatId, `ℹ️ #${parsed.ref} has no failed runs to re-arm.`)
    } else {
      await reply(session, chatId, `🔁 #${parsed.ref} — re-armed ${rearmed} failed run(s).`)
      try {
        const fb = require('../services/fbShareBacklog')
        await fb.queueKick({ reason: 'admin_force_' + parsed.ref })
      } catch {}
    }
    return
  }
  if (parsed.kind === 'status') {
    if (parsed.ref) return cmdUploadStatus(session, chatId, parsed.ref)
    // overall backlog summary
    const r = await db.query(
      `SELECT enabled, stopped_reason, gap_minutes FROM fb_backlog_state WHERE id=TRUE`)
    const state = r.rows[0] || {}
    const queued = await db.query(`SELECT COUNT(*)::int AS n FROM fb_share_backlog WHERE status='queued'`)
    const running = await db.query(`SELECT COUNT(*)::int AS n FROM fb_share_runs WHERE status IN ('running','paused')`)
    const recent = await db.query(`SELECT ref, status, posted_count, total_groups, started_at
                                    FROM fb_share_runs ORDER BY started_at DESC NULLS LAST LIMIT 3`)
    const lines = [
      `📦 FB Backlog: ${state.enabled ? '✅ ENABLED' : '🛑 STOPPED'}` + (state.stopped_reason ? ` — ${state.stopped_reason}` : ''),
      `   gap ${state.gap_minutes || 0} min · queued ${queued.rows[0].n} · active ${running.rows[0].n}`,
    ]
    if (recent.rows.length) {
      lines.push('', 'Recent runs:')
      for (const r of recent.rows) {
        const time = r.started_at ? new Date(r.started_at).toISOString().slice(11, 16) : '—'
        lines.push(`   ${r.status === 'done' ? '✅' : r.status === 'cancelled' ? '⚠️' : r.status === 'paused' ? '⏸' : '▶'} #${r.ref} ${r.posted_count}/${r.total_groups} ${time}`)
      }
    }
    lines.push('', 'Subcommands: status [ref] | stop | restart | kick | force <ref>')
    await reply(session, chatId, lines.join('\n'))
    return
  }
}

// ── !uploadstatus <ref> (Phase 5) ────────────────────────────────────────────
async function cmdUploadStatus(session, chatId, arg) {
  const prop = await findByRef(arg)
  if (!prop) { await reply(session, chatId, `❌ Property "${arg}" not found. Usage: !uploadstatus 2906-247`); return }
  const r = await db.query(
    `SELECT channel, target_ref, status, posted_at, scheduled_for, last_error
       FROM property_publishing_status WHERE property_id=$1 ORDER BY channel, run_index, id`, [prop.id])
  const byCh = new Map()
  for (const row of r.rows) {
    if (!byCh.has(row.channel)) byCh.set(row.channel, [])
    byCh.get(row.channel).push(row)
  }
  const hhmm = (d) => d ? new Date(d).toISOString().slice(11, 16) : ''
  const lines = [`#${prop.ref} — ${prop.town || '—'} ${prop.bedrooms || 0}BR`]
  if (!byCh.size) lines.push('(no publishing rows — was this created with !upload?)')
  let anyPosted = false, anyPending = false, anyFailed = false
  for (const [ch, rows] of byCh) {
    const label = (CHANNEL_LABELS[ch] || ch).padEnd(13)
    const posted = rows.filter(x => x.status === 'posted')
    const failed = rows.filter(x => x.status === 'failed')
    if (posted.length) anyPosted = true
    if (rows.some(x => ['pending', 'scheduled'].includes(x.status))) anyPending = true
    if (failed.length) anyFailed = true
    if (ch === 'category_groups' && rows.some(x => x.target_ref)) {
      const real = rows.filter(x => x.target_ref)
      lines.push(`${real.every(x => x.status === 'posted') ? '✅' : (failed.length ? '❌' : '⏳')} ${label} ${real.filter(x => x.status === 'posted').length}/${real.length} posted`)
    } else if (ch === 'facebook') {
      const next = rows.find(x => x.status === 'scheduled' && x.scheduled_for)
      lines.push(`${posted.length ? '✅' : '⏳'} ${label} ${posted.length}/${rows.length} posted, next ${next ? hhmm(next.scheduled_for) : '—'}`)
    } else {
      const row = rows[0]
      const icon = row.status === 'posted' ? '✅' : row.status === 'failed' ? '❌' : '⏳'
      const info = row.status === 'posted' ? `created ${hhmm(row.posted_at)}`
        : row.status === 'failed' ? `failed — ${String(row.last_error || '').slice(0, 50)}` : row.status
      lines.push(`${icon} ${label} ${info}`)
    }
  }
  const overall = anyFailed ? 'has failures' : anyPending ? (anyPosted ? 'partially published' : 'pending') : 'fully published'
  lines.push('', `Status: ${overall}`)
  await reply(session, chatId, lines.join('\n'))
}

// ── !sessions (admin) — WAHA status + today's send counts per session ───────
async function cmdSessions(session, chatId) {
  const rows = await sessionRouter.getStatusReport()
  const lines = ['📶 *Sessions:*', '']
  for (const r of rows) {
    lines.push(`${r.working ? '✅' : '🛑'} ${r.session} — ${r.sentToday} sent today`)
  }
  await reply(session, chatId, lines.join('\n'))
}

// ── !categorygroups ──────────────────────────────────────────────────────────
async function cmdCategoryGroups(session, chatId) {
  const r = await db.query(`SELECT key, group_id, display_name, priority, active FROM category_groups ORDER BY priority, key`)
  if (!r.rows.length) { await reply(session, chatId, '❌ category_groups table is empty.'); return }
  const RULES = {
    bed1:     'beds ≤ 1 or studio',
    bed2:     'beds = 2',
    bed3:     'beds ≥ 3',
    villas:   'type = house/villa (replaces bedroom bucket)',
    luxury:   'longlet ≥ €2500, or beds ≤ 1 and ≥ €2000',
    seafront: 'genuinely seafront (AI-checked)',
  }
  const lines = ['📂 *Category groups:*', '']
  for (const g of r.rows) {
    lines.push(`${g.active ? '✅' : '🚫'} *${g.display_name}* (${g.key})`)
    lines.push(`   ${g.group_id}`)
    lines.push(`   rule: ${RULES[g.key] || '—'}`)
  }
  await reply(session, chatId, lines.join('\n'))
}

// ── !categorytest <ref> (DRY RUN) ───────────────────────────────────────────
async function cmdCategoryTest(session, chatId, arg) {
  const prop = await findByRef(arg)
  if (!prop) { await reply(session, chatId, `❌ Property "${arg}" not found. Usage: !categorytest 2906-247`); return }
  try {
    const pre = await previewCategoryPost(prop.id)
    const leakOk = pre.leakCheck === 'passed'
    const lines = [
      `🧪 DRY RUN #${pre.ref} — nothing was sent`, '',
      `Classification: ${pre.keys.join(', ') || '(no groups)'}`,
      `Reasoning: ${pre.reasoning}`, '',
      `Target groups:`,
      ...(pre.groups.length
        ? pre.groups.map(g => `  • ${g.display_name} (${g.group_id})${g.already_posted ? ' ⏭️ already posted' : ''}`)
        : ['  (none)']),
      '', `Images that would be sent: ${pre.imageCount}`,
      `Leak check: ${leakOk ? '✅ passed (no phone / email / street / apt)' : '❌ ' + pre.leakCheck}`,
      '', '──── exact message ────', pre.message || '(not rendered — leak check failed)',
    ]
    await reply(session, chatId, lines.join('\n'))
  } catch (e) {
    await reply(session, chatId, `❌ Dry run failed: ${e.message}`)
  }
}

// ── !recategorize <ref> ──────────────────────────────────────────────────────
// !recategorize REF [1|2|3|4|C|LUX] (Kev, 2026-09-23, ARGUS category hotfix).
// Root cause this replaces: !recategorize with no override token just
// re-ran the SAME auto-classification that already failed (see
// #2906-9343 — bedrooms extracted as unknown, so distribution kept
// throwing "needs manual categorisation" every single retry). The optional
// final token is an EXPLICIT, deterministic override — never re-interpreted
// by AI — using the exact same setCategoryOverride()/OVERRIDE_KEYS
// machinery !categorize (adminCommands.js) already has, so this is the
// second entry point onto ONE mechanism, not a second implementation.
// Setting the override touches ONLY category_override* — never bedrooms/
// price/type, per Kev's explicit "do not change factual data" rule.
// Kev, 2026-10-22 (P1): the uploader resolves their own draft's category.
// Bedroom categories (1-4) are routine; commercial/luxury (C, LUX) change the
// distribution destination and stay with an admin — only that step is
// escalated, never the whole upload.
const SPECIAL_CATEGORY_TOKENS = new Set(['c', 'commercial', 'lux', 'luxury'])
async function recategorizeAsOperator({ session, chatId, payload, isGroup, senderForAuth, argLine }) {
  const perms = require('../services/agentPermissions')
  const realPhone = phoneFromJid(realSenderJid(payload, isGroup)) || null
  const operator = await perms.resolveOperator([senderForAuth, realPhone], { isAdmin })
  if (!operator.kind) return false   // not ours: external chats never change inventory, no reply
  const parts = String(argLine || '').trim().split(/\s+/).filter(Boolean)
  const prop = parts[0] ? await findByRef(parts[0]) : null
  if (operator.kind !== 'admin') {
    const token = parts[1] ? parts[1].toLowerCase() : null
    const action = token && SPECIAL_CATEGORY_TOKENS.has(token) ? 'set_special_category' : 'set_bedroom_category'
    const scope = prop ? await perms.propertyScope(prop.id) : null
    const decision = perms.authorize(operator, action, scope)
    if (!decision.allow) {
      await reply(session, chatId, `❌ #${prop?.ref || parts[0] || '?'} — ${decision.message}`)
      if (decision.reason === 'needs_admin' && prop) {
        await ul.alertKev(`🗂️ ${operator.agent?.name || 'An agent'} asked for category ${String(token).toUpperCase()} on #${prop.ref} — needs an admin: !recategorize ${prop.ref} ${token}`).catch(() => {})
      }
      return true
    }
  }
  await cmdRecategorize(session, chatId, argLine, { agentId: operator.agent?.id || null, actor: operator.agent?.name || 'admin' })
  return true
}

async function cmdRecategorize(session, chatId, argLine, { agentId = null, actor = 'admin' } = {}) {
  const parts = String(argLine || '').trim().split(/\s+/).filter(Boolean)
  const refToken = parts[0]
  const catToken = parts[1] ? parts[1].toLowerCase() : null
  const prop = await findByRef(refToken)
  if (!prop) {
    await reply(session, chatId, `❌ Property "${refToken || ''}" not found. Usage: !recategorize 2906-247 [1|2|3|4|C|LUX]`)
    return
  }

  if (catToken) {
    const { setCategoryOverride, RECATEGORIZE_TOKEN_MAP } = require('../services/categoryPublisher')
    const key = RECATEGORIZE_TOKEN_MAP[catToken]
    if (!key) {
      await reply(session, chatId, `❌ Unknown category "${catToken}". Use: 1, 2, 3, 4, C, or LUX.`)
      return
    }
    try {
      await setCategoryOverride(prop.id, key, agentId, `!recategorize by ${actor}`)
    } catch (e) {
      await reply(session, chatId, `❌ ${e.message}`)
      return
    }
    await reply(session, chatId, `✅ #${prop.ref} → manual category override: ${key.toUpperCase()}. Re-running distribution…`)
  } else {
    await reply(session, chatId, `🔄 Re-running category distribution for #${prop.ref}…`)
  }
  await runCategoryDistribution(session, chatId, prop.id, prop.ref)
  await sendDivider(session, chatId)
}

// Kev, 2026-09-10 (price-stale-in-repost bug): !price already updated
// properties.longlet_price/sale_price AND public_payload[field] correctly —
// confirmed, the reply text and the DB value were right. What stayed wrong
// was description_social/description_public themselves: those are the
// human-written ad PROSE (posted AS-IS everywhere, see categoryFormatter's
// own comment on why it never reformats an ad), and the prose still said
// "€3,000/month" in plain text because nothing ever touched that string —
// same root-cause SHAPE as 2026-09-07's available_date bug (a frozen
// public_payload snapshot never getting refreshed), but a DIFFERENT fix,
// because the date bug's fix (compute fresh, append as its own line) would
// leave two conflicting price mentions in the same message if applied here —
// the frozen prose already states a price inline. The correct fix is to
// update the frozen prose itself, in place, the moment the price changes —
// which !price uniquely can do exactly right, because it already knows both
// the exact old number and the exact new one (no guessing/parsing needed).
// Anchored on '€' so this can never touch an unrelated bare number (sqm,
// floor, ref) elsewhere in the ad copy.
//
// Checked whether beds/baths/features have the same stale-content class:
// no — there is no !beds/!baths/!features (or any CRM route) that mutates
// those columns after upload, so nothing ever changes under them the way
// price does via !price. Only price needed this.
//
// This runs once, here, at the moment the price actually changes — every
// later repost trigger (!bmarket, !recategorize, the timer auto-publish)
// just reads the already-corrected public_payload off the row, so none of
// them need a copy of this fix.
// (2026-09-24) The price step itself now lives in services/priceChange.js so an
// owner's chat statement changes a price exactly the way !price does. It also
// fixes a latent bug: longlet_price is `numeric`, which pg returns as a STRING,
// so the old Number.isFinite(oldPrice) guard was always false and the ad prose
// was never actually rewritten.
const { applyCanonicalPrice } = require('../services/priceChange')

// ── !price <new_price> <ref> ─────────────────────────────────────────────────
// Super-admin only (Kev). Every price change — up OR down, Kev also uses this
// deliberately as a status-update / repost trigger — re-runs exactly the
// distribution a fresh !upload would: category-group repost, both Facebook
// channels, and a Schedule-Board bump. Nothing below is a new pipeline; every
// step calls the same function !upload / !recategorize / !fbgroups already
// use — only the trigger (a price change) is new.
async function cmdPrice({ session, chatId, senderPhone, arg }) {
  const USAGE = 'Usage: !price <new_price> <ref>\nExample: !price 1500 902'
  const parts = String(arg || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length < 2) { await reply(session, chatId, `❌ ${USAGE}`); return }

  const newPrice = Number(String(parts[0]).replace(/[^\d.]/g, ''))
  if (!Number.isFinite(newPrice) || newPrice <= 0) {
    await reply(session, chatId, `❌ "${parts[0]}" is not a valid price.\n${USAGE}`); return
  }
  const refArg = parts.slice(1).join(' ')
  const prop = await findByRef(refArg)
  if (!prop) { await reply(session, chatId, `❌ Property "${refArg}" not found.\n${USAGE}`); return }

  const row = await db.query(
    `SELECT id, ref, longlet_price, sale_price, public_payload FROM properties WHERE id=$1`, [prop.id])
  const p = row.rows[0]
  if (!p.public_payload) {
    await reply(session, chatId, `❌ #${p.ref} has no public_payload yet — run !upload for it first, then !price.`)
    return
  }

  // 1. CRM price update — the shared canonical step (services/priceChange.js):
  // column + public_payload + the frozen ad prose in place. created_at is
  // bumped too — the Schedule-Board's default "newest" sort is keyed on
  // created_at, so THIS is what moves the card to the top, which is what Kev
  // wants a price change / deliberate repost to do. The original upload
  // timestamp stays on record in property_activities.
  const P = require('./priority')
  const agentId = await P.agentIdForPhone(senderPhone)
  const { field, oldPrice } = await applyCanonicalPrice(p.id, newPrice, {
    agentId, source: 'whatsapp', details: { command: '!price', chat: chatId }, bumpCreatedAt: true,
  })

  await reply(session, chatId,
    `✅ #${p.ref} price → €${newPrice.toLocaleString()}${field === 'sale_price' ? '' : '/mo'}` +
    (oldPrice ? ` (was €${Number(oldPrice).toLocaleString()})` : '') +
    `\n🔄 Reposting to categories + Facebook…`)

  // 2+3+4 run async so the chat isn't blocked on category sends (8-15s per
  // group) + FB scheduling — same "never block the reply" shape !upload uses.
  ;(async () => {
    // 2. Category-group repost. alreadyPosted() in categoryPublisher.js skips
    // any group already marked 'posted' for this property, so those rows are
    // flipped first — nothing is deleted, only superseded (Kev's own
    // "nothing is deleted" convention, see services/boardAction.js) — so the
    // SAME groups get the new-price message again, exactly like a fresh
    // !upload would.
    await db.query(
      `UPDATE property_publishing_status SET status='superseded', updated_at=NOW()
        WHERE property_id=$1 AND channel='category_groups' AND status='posted'`, [p.id])
    await runCategoryDistribution(session, chatId, p.id, p.ref)

    // 3. Facebook Page post. scheduleFacebookCampaign() is already idempotent
    // via ON CONFLICT (property_id, channel, target_ref) — calling it again
    // resets the SAME page#1..N rows back to 'scheduled' and re-queues them.
    // No new mechanism, same entry point !upload's own page-post step uses.
    try {
      const camp = await scheduleFacebookCampaign(p.id)
      if (camp.skipped) {
        await recordFbAutomationStatus('fb_page_post', 'warn', `#${p.ref} — Facebook page post skipped: ${camp.skipped}`, { ref: p.ref })
      } else {
        await recordFbAutomationStatus('fb_page_post', 'info', `#${p.ref} — Facebook page post re-scheduled (${camp.scheduled}×).`, { ref: p.ref })
      }
    } catch (e) {
      log.error('price: fb campaign scheduling failed', { ref: p.ref, err: e.message })
      await recordFbAutomationStatus('fb_page_post', 'error', `#${p.ref} — Facebook page post NOT scheduled: ${e.message}`, { ref: p.ref })
    }

    // 4. Facebook group share. force:true is startRun()'s own built-in
    // "re-share anyway" override — the exact one its own refusal message
    // already points callers at ("!fbgroups <ref> force") — so this is not a
    // new mechanism either, just the existing one invoked on purpose.
    try {
      const shareRes = await fbShare.startRun({
        ref: p.ref, requesterChatId: chatId, requesterSession: session,
        source: 'manual', force: true,
      })
      if (shareRes.error) {
        await recordFbAutomationStatus('fb_group_share', 'warn', `#${p.ref} — Facebook group share not started: ${shareRes.error}`, { ref: p.ref })
      } else {
        await recordFbAutomationStatus('fb_group_share', 'info', `#${p.ref} — Facebook group share queued (run #${shareRes.runId}).`, { ref: p.ref, meta: { runId: shareRes.runId } })
      }
    } catch (e) {
      log.error('price: fb group share failed', { ref: p.ref, err: e.message })
      await recordFbAutomationStatus('fb_group_share', 'error', `#${p.ref} — Facebook group share crashed: ${e.message}`, { ref: p.ref })
    }

    await sendDivider(session, chatId)
  })().catch(async (e) => {
    log.error('price: async repost crashed', { ref: p.ref, err: e.message })
    await ul.alertKev(`❌ !price repost crashed for #${p.ref}\n${e.message}`)
    await sendDivider(session, chatId)
  })
}

// ── !bmarket <ref> <date> — "back on market" ─────────────────────────────────
// Date: DD.MM or DD.MM.YYYY, European day-first order ("02.09" = 2 September —
// matches the example, and today's actual date the day this was written).
// No existing parser covers this: !price takes a price NUMBER, not a date, and
// the board's own av-date-confirm route (routes/crmScheduleBoard.js) never
// parses free text at all — the board's date-picker already sends a real date
// via PATCH before that route runs. Built fresh, but reusing the one
// convention that DOES already exist for a bare day/month with no year
// (services/reminderParse.js's parseMonthPhrase): roll to next year if the
// date has already passed this year.
function parseBmarketDate(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})\.(\d{1,2})\.?(\d{4})?$/)
  if (!m) return null
  const day = Number(m[1]), month = Number(m[2]) - 1
  if (month < 0 || month > 11 || day < 1) return null
  let year = m[3] ? Number(m[3]) : new Date().getUTCFullYear()
  const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  if (day > lastDayOfMonth) return null
  let candidate = new Date(Date.UTC(year, month, day))
  const today = new Date()
  const todayUTC = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
  if (!m[3] && candidate.getTime() < todayUTC.getTime()) {
    year += 1
    candidate = new Date(Date.UTC(year, month, day))
  }
  return candidate.toISOString().slice(0, 10) // YYYY-MM-DD, properties.available_date's own format
}

// Admin/super-admin only, same gate as !price/!recategorize. Does NOT touch
// Facebook — mirrors exactly what routes/crmScheduleBoard.js's own
// av-date-confirm button does (category-group repost only), not !price's
// broader FB+category repost, per Kev's spec naming that button specifically.
// !wupload — run every photo from the last 10 minutes through the free
// Gemini watermark check, then (only when one is actually found)
// Unwatermark.ai's paid removal. Images always go out with NO caption
// (Kev, 2026-09-08: "ich will kein text zum bild attached, Bilder first,
// dann text desc"), followed by one plain-text summary — never a listing,
// never touches properties/public_payload/categories at all.
async function cmdWupload({ payload, session, chatId, isGroup, senderPhone }) {
  const gathered = await ul.gatherContent(payload, session, chatId, isGroup, senderPhone, Math.floor(Date.now() / 1000))
  const images = gathered.imageItems || []
  if (!images.length) {
    await reply(session, chatId, '⚠️ No photos found in the last 10 minutes.')
    return
  }
  let cleanedCount = 0
  let failedCount = 0
  for (const img of images) {
    try {
      const result = await unwatermark.cleanImageIfWatermarked(img.buffer, img.mimeType)
      if (result.wasWatermarked) cleanedCount++
      await waha.sendImage(session, chatId, result.buffer.toString('base64'), result.mimeType, '')
    } catch (e) {
      failedCount++
      log.warn('cmdWupload: image failed', { err: e.message })
    }
  }
  const lines = [`✅ Processed ${images.length} photo(s).`, `🧼 ${cleanedCount} watermark(s) removed.`]
  if (failedCount) lines.push(`⚠️ ${failedCount} failed — sent unchanged or skipped.`)
  await reply(session, chatId, lines.join(' '))
}

async function cmdBmarket({ session, chatId, senderPhone, arg }) {
  const USAGE = 'Usage: !bmarket <ref> <date>\nExample: !bmarket 9147 02.09'
  const parts = String(arg || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length < 2) { await reply(session, chatId, `❌ ${USAGE}`); return }

  const refArg = parts[0]
  const dateArg = parts[1]
  const isoDate = parseBmarketDate(dateArg)
  if (!isoDate) {
    await reply(session, chatId, `❌ Could not parse date "${dateArg}". Use DD.MM or DD.MM.YYYY, e.g. 02.09 or 02.09.2026.\n${USAGE}`)
    return
  }

  const prop = await findByRef(refArg)
  if (!prop) { await reply(session, chatId, `❌ Property "${refArg}" not found.\n${USAGE}`); return }
  if (!prop.public_payload) {
    await reply(session, chatId, `❌ #${prop.ref} has no public_payload yet — run !upload for it first, then !bmarket.`)
    return
  }

  const statusRow = await db.query(`SELECT available_status FROM properties WHERE id=$1`, [prop.id])
  const oldStatus = statusRow.rows[0]?.available_status || null

  const P = require('./priority')
  const agentId = await P.agentIdForPhone(senderPhone)

  // Same state-machine the Schedule Board's own "Return to market" button
  // uses (services/boardAction.js) — never hand-write available_status here.
  // The guard inside only fires the transition (and logs the activity) when
  // the property wasn't ALREADY 'available'; available_date below is set
  // unconditionally either way, since re-confirming a date on an already-
  // available listing is a legitimate use of this command too.
  const boardAction = require('../services/boardAction')
  const plan = await boardAction.returnToMarket({
    propertyId: prop.id, agentId, reason: `Back on market via !bmarket (from ${isoDate})`,
    oldStatus, changedBy: 'agent',
  })
  if (!plan.ok) { await reply(session, chatId, `❌ ${plan.reason}`); return }

  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query(plan.update.sql, plan.update.params)   // no-op if already 'available' — fine
    await client.query(plan.activity.sql, plan.activity.params)
    await client.query(
      `UPDATE properties SET available_date=$2, created_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [prop.id, isoDate])
    await client.query('COMMIT')
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    throw e
  } finally {
    client.release()
  }

  const dateLabel = new Date(isoDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
  await reply(session, chatId, `✅ #${prop.ref} back on market from ${dateLabel} — reposting to its category group now.`)

  // Repost async, same "never block the reply" shape !price/av-date-confirm
  // use — category-group sends run 8-15s each.
  ;(async () => {
    await db.query(
      `UPDATE property_publishing_status SET status='superseded', updated_at=NOW()
        WHERE property_id=$1 AND channel='category_groups' AND status='posted'`, [prop.id])
    // runCategoryDistribution is exactly what !upload / !recategorize / !price
    // / the board's av-date-confirm button already call — no new pipeline.
    // `session` is whatever account this !bmarket command itself arrived on;
    // the actual send calls inside route through lib/sessionRouter, which is
    // what gives every WAHA send here its Default→Kevsecond→kevthirdd→
    // Cedric→Jasmine fallback, not anything this command needs to orchestrate.
    const pub = await runCategoryDistribution(session, chatId, prop.id, prop.ref)
    const postedGroups = (pub?.results || []).filter(r => r.status === 'posted')
    if (!postedGroups.length) return

    // Same short, human-toned follow-up shape av-date-confirm sends under its
    // repost, not a system message.
    const followUp = `Back on market from ${dateLabel}.`
    for (const g of postedGroups) {
      try {
        await waha.sendText(session, g.group_id, followUp)
      } catch (e) {
        log.warn('bmarket: follow-up send failed', { ref: prop.ref, group: g.group_id, err: e.message })
      }
    }
  })().catch(async (e) => {
    log.error('bmarket: async repost crashed', { ref: prop.ref, err: e.message })
    await ul.alertKev(`❌ !bmarket repost crashed for #${prop.ref}\n${e.message}`)
  })
}

// ── !undo [ref] — reverse an owner-checklist auto-publish ──────────────────
// Kev, 2026-09-09 (timer-buffer correction): the safety net for the
// auto-publish flow. Deliberately scoped to ONLY listings that flow itself
// created (checked via AUTO_PUBLISH_MARKER in internal_notes, written by
// runAutoPublishJob) — this is not a general "delete any property" command,
// on purpose, so a typo'd ref can't archive an unrelated real listing.
// No ref given → the most recent auto-publish in the last 24h.
// Reuses the exact same archive path the CRM board's own "Archive" button
// uses (services/boardAction.js + boardFeedback.announceStatusChange) so the
// category groups + any waiting agents are told exactly like a manual
// archive would tell them. Facebook page posts are NOT retracted — WAHA/the
// Graph token here were never proven able to delete a live FB post, so this
// says so plainly instead of silently leaving a stale post up unmentioned.
async function runArchivePlan(plan) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const upd = await client.query(plan.update.sql, plan.update.params)
    if (!upd.rows.length) { await client.query('ROLLBACK'); return { changed: false, row: null } }
    await client.query(plan.activity.sql, plan.activity.params)
    await client.query('COMMIT')
    return { changed: true, row: upd.rows[0] }
  } catch (e) {
    try { await client.query('ROLLBACK') } catch { /* connection already gone */ }
    throw e
  } finally {
    client.release()
  }
}

async function cmdUndo({ session, chatId, senderPhone, arg }) {
  const boardAction = require('../services/boardAction')
  const boardFeedback = require('../services/boardFeedback')
  const websiteSync = require('../services/websiteSync')
  const { AUTO_PUBLISH_MARKER } = require('../services/autoOwnerConversation')

  let prop
  const ref = (arg || '').trim()
  if (ref) {
    const r = await db.query(`SELECT * FROM properties WHERE ref = $1`, [ref])
    prop = r.rows[0]
    if (!prop) { await reply(session, chatId, `❌ #${ref} not found.`); return true }
    if (!(prop.internal_notes || '').includes(AUTO_PUBLISH_MARKER)) {
      await reply(session, chatId, `⚠️ #${prop.ref} wasn't auto-published by the checklist timer — !undo only reverses that flow. Use the CRM board to archive it manually.`)
      return true
    }
  } else {
    const r = await db.query(
      `SELECT * FROM properties WHERE internal_notes LIKE $1
         AND available_status != 'archived' AND created_at > NOW() - INTERVAL '24 hours'
       ORDER BY created_at DESC LIMIT 1`,
      [`%${AUTO_PUBLISH_MARKER}%`])
    prop = r.rows[0]
    if (!prop) { await reply(session, chatId, '❌ No recent auto-published listing found to undo (last 24h). Try !undo <ref>.'); return true }
  }

  if (prop.available_status === 'archived') {
    await reply(session, chatId, `⚠️ #${prop.ref} is already archived.`)
    return true
  }

  const P = require('./priority')
  let agentId = await P.agentIdForPhone(senderPhone)
  if (!agentId) {
    const kr = await db.query(`SELECT id FROM agents WHERE LOWER(username)='kev' AND active=TRUE LIMIT 1`)
    agentId = kr.rows[0]?.id || null
  }

  try {
    const plan = await boardAction.archive({
      propertyId: prop.id, agentId, reason: 'Auto-publish undone via !undo',
      oldStatus: prop.available_status || null, changedBy: 'agent',
    })
    if (!plan.ok) { await reply(session, chatId, `❌ Undo failed: ${plan.reason}`); return true }
    const { changed } = await runArchivePlan(plan)
    if (!changed) { await reply(session, chatId, `⚠️ #${prop.ref} is already archived.`); return true }

    await boardFeedback.announceStatusChange({
      propertyId: prop.id, ref: prop.ref, kind: 'archived',
      reason: 'Auto-publish undone via !undo', actor: senderPhone,
    }).catch(e => log.warn('undo: announceStatusChange failed', { err: e.message }))
    await websiteSync.unpublishFromWebsite(prop.ref).catch(e => log.warn('undo: website unpublish failed', { err: e.message }))

    await reply(session, chatId,
      `✅ #${prop.ref} undone — archived, off the website, category groups notified.\n⚠️ Any Facebook page post must still be removed by hand — that part isn't reversible from here.`)
  } catch (e) {
    log.error('undo: crashed', { ref: prop.ref, err: e.message })
    await ul.alertKev(`❌ !undo crashed for #${prop.ref}\n${e.message}`)
    await reply(session, chatId, `❌ Undo failed: ${e.message}`)
  }
  return true
}

// ── !picup <ref> — pick up photos that a !upload didn't take cleanly ────────
const MAX_PICUP_IMAGES = 15

// WhatsApp only lets a reply quote ONE message, but the operator usually just
// sent a whole batch of photos and quoted one of them — so this walks outward
// from the quoted message through recent chat history, collecting every
// CONSECUTIVE image message from the SAME sender, stopping at the first
// non-image message, a sender change, or the !picup command message itself.
// Returns [] if nothing was quoted, or the quoted message isn't an image.
// A line made of 2+ dots (and nothing else) is a separator — same convention
// !post's own content-clustering already uses (services/fbPost.js
// isDotSeparator). Kev, 2026-08-28: !picup's real usage is "send the photos
// (optionally closed off with a dot line, exactly like every other upload
// flow here), then just type !picup <ref> right after — no reply, no quote."
// Requiring an explicit WhatsApp reply-quote was the actual bug; this is the
// fix, not a tweak to the quote path (which stays, for whoever does quote).
function isDotSeparator(text) {
  return /^\.{2,}\s*$/.test(String(text || '').trim())
}

async function gatherQuotedPhotos({ session, chatId, payload, isGroup, uploaderPhone }) {
  let msgs = []
  try { msgs = await waha.getChatMessagesWithMedia(session, chatId, 60) }
  catch (e) { log.warn('picup: getChatMessagesWithMedia failed', { err: e.message }); msgs = [] }

  const idOf = (m) => String(m.id || m.key?.id || '')
  const tsOf = (m) => m.timestamp || m._data?.t || 0
  const bodyOf = (m) => m.body || m.caption || m._data?.body || m._data?.caption || ''
  const isImageMsg = (m) => {
    const mime = m.media?.mimetype || m.mediaData?.mimetype || m._data?.mediaData?.mimetype || ''
    return mime.startsWith('image/') || !!(m.media?.url || m.mediaData?.data || m._data?.mediaData?.data)
  }
  const sameSender = (a, b) => a.fromMe === b.fromMe &&
    String(a.participant || a.author || '') === String(b.participant || b.author || '')

  const byTime = msgs.slice().sort((a, b) => tsOf(a) - tsOf(b))
  const cmdId = String(payload.id || payload.key?.id || '')

  // ── path 1: a real WhatsApp reply-quote on one of the photos ─────────────
  // Verified live-GOWS field (see services/bookRelay.js:quotedInfo() and
  // services/propertyIntake.js, both of which already key off this same id).
  const quotedId = payload?._data?.quotedStanzaID || payload?.quotedMessageId || payload?.quotedMsgId || null
  const walkFrom = (idx, anchor) => {
    const picked = isImageMsg(anchor) ? [anchor] : []
    for (let i = idx - 1; i >= 0 && picked.length < MAX_PICUP_IMAGES; i--) {
      const m = byTime[i]
      if (idOf(m) === cmdId || isDotSeparator(bodyOf(m)) || !sameSender(m, anchor) || !isImageMsg(m)) break
      picked.unshift(m)
    }
    for (let i = idx + 1; i < byTime.length && picked.length < MAX_PICUP_IMAGES; i++) {
      const m = byTime[i]
      if (idOf(m) === cmdId || isDotSeparator(bodyOf(m)) || !sameSender(m, anchor) || !isImageMsg(m)) break
      picked.push(m)
    }
    return picked
  }

  let picked = []
  if (quotedId) {
    const qIdx = byTime.findIndex(m => idOf(m) === String(quotedId))
    if (qIdx !== -1) picked = walkFrom(qIdx, byTime[qIdx])
  }

  if (picked.length) {
    const images = []
    for (const m of picked) images.push(...await ul.getMsgImages(m))
    return { images: images.slice(0, MAX_PICUP_IMAGES), truncated: images.length > MAX_PICUP_IMAGES }
  }

  // ── path 2: no quote at all — just "photos, then the command" ───────────
  // Kev, 2026-08-28 (2nd pass): the walkFrom-based version of this path
  // (same idea as path 1, anchored on the command instead of a quote) still
  // missed real usage, because it stops dead at the FIRST message that isn't
  // an image from the exact same participant id — and AV CENTRAL is a busy
  // group where the bot's own confirmation replies (also fromMe:true, since
  // they go out through one of Kev's own numbers) routinely land between a
  // photo batch and the command that follows it. One interleaved line and
  // the walk finds zero photos.
  //
  // Fix: reuse !upload's own gather (uploadListing.gatherContent) instead of
  // reinventing a second, stricter one. It is TIME-WINDOWED (last 10 min,
  // WINDOW_SECONDS) and sender-filtered rather than adjacency-filtered — a
  // bot reply or another agent's line in between is just not a match, not a
  // stop condition. This is the exact mechanism !upload's own photo capture
  // already relies on in the same group, proven there.
  const triggerTs = payload.timestamp || payload._data?.t || Math.floor(Date.now() / 1000)
  let gathered
  try {
    gathered = await ul.gatherContent(payload, session, chatId, isGroup, uploaderPhone, triggerTs)
  } catch (e) {
    log.warn('picup: gatherContent failed', { err: e.message })
    return { images: [], truncated: false }
  }
  const raw = gathered.imageItemsRawCount ?? (gathered.imageItems || []).length
  return {
    images: (gathered.imageItems || []).slice(0, MAX_PICUP_IMAGES),
    truncated: raw > MAX_PICUP_IMAGES,
  }
}

// Reply to the photo message(s) with "!picup <ref>". Additive only: photos
// are APPENDED to whatever the CRM property already has, never replacing
// them — this is a fix-up for an upload that didn't take the photos cleanly,
// not a re-shoot. Super-admin only. Uses the SAME image path !upload uses
// (ul.getMsgImages → ul.uploadBuffer → Cloudinary), just applied to an
// existing ref instead of a brand-new one.
async function cmdPicup({ session, chatId, senderPhone, payload, arg, isGroup }) {
  const refArg = String(arg || '').trim()
  const USAGE = 'Usage: reply to the photo(s) with "!picup <ref>"\nExample: !picup 902'
  if (!refArg) { await reply(session, chatId, `❌ ${USAGE}`); return }

  const prop = await findByRef(refArg)
  if (!prop) { await reply(session, chatId, `❌ Property "${refArg}" not found.\n${USAGE}`); return }

  let uploaderPhone = await ul.extractSenderPhone(payload, session, isGroup)
  if (!uploaderPhone) uploaderPhone = ul.resolveUploaderPhone(payload, senderPhone || '', isGroup)
  const { images, truncated } = await gatherQuotedPhotos({ session, chatId, payload, isGroup, uploaderPhone })
  if (!images.length) {
    await reply(session, chatId,
      `❌ No photo found to pick up. Reply directly to the photo message(s), then send "!picup ${refArg}".`)
    return
  }

  // Kev, 2026-09-03: every real !picup checked in property_activities hit
  // the MAX_PICUP_IMAGES cap exactly (100% of 4 samples) with no signal that
  // anything was dropped — an agent had no way to tell "15" from "exactly
  // 15 photos" vs "15, capped, there were more". Now explicit.
  const cappedNote = truncated ? ` (capped at ${MAX_PICUP_IMAGES} — send !picup ${refArg} again to pick up the rest)` : ''
  await reply(session, chatId, `📸 #${prop.ref} — found ${images.length} photo(s)${cappedNote}, uploading…`)

  const urls = []
  for (const it of images) {
    const url = await ul.uploadBuffer(it.buffer, it.mimeType)
    if (url) urls.push(url)
  }
  if (!urls.length) {
    await reply(session, chatId, `❌ #${prop.ref} — photo upload to Cloudinary failed for all ${images.length} image(s).`)
    return
  }

  const row = await db.query(`SELECT images, public_payload FROM properties WHERE id=$1`, [prop.id])
  const p = row.rows[0]
  // properties.images is [{url}], public_payload.images is [url,...] (plain
  // strings — see services/sanitizer.js:sanitizeForPublic) — the same two
  // shapes handlers/upload.js:createListing() writes on a fresh !upload, so
  // this appends in those same two shapes rather than inventing a third.
  const existingImages = Array.isArray(p.images) ? p.images
    : (typeof p.images === 'string' ? JSON.parse(p.images || '[]') : [])
  const existingPayloadImages = Array.isArray(p.public_payload?.images) ? p.public_payload.images : []
  const mergedImages = [...existingImages, ...urls.map(url => ({ url }))]
  const newPayload = { ...(p.public_payload || {}), images: [...existingPayloadImages, ...urls] }

  await db.query(
    `UPDATE properties SET images = $2::jsonb, public_payload = $3::jsonb, updated_at = NOW() WHERE id = $1`,
    [prop.id, JSON.stringify(mergedImages), JSON.stringify(newPayload)])

  const P = require('./priority')
  const agentId = await P.agentIdForPhone(senderPhone)
  await db.query(
    `INSERT INTO property_activities (property_id, agent_id, activity_type, details, is_significant)
     VALUES ($1, $2, 'photos_added_via_picup', $3::jsonb, TRUE)`,
    [prop.id, agentId, JSON.stringify({
      source: 'whatsapp', command: '!picup', added: urls.length,
      total_after: mergedImages.length, chat: chatId,
      timestamp: new Date().toISOString(),
    })])

  await reply(session, chatId,
    `✅ #${prop.ref} — ${urls.length} photo(s) added (${mergedImages.length} total now).`)
}

// ── webhook entry — returns true when consumed ───────────────────────────────
async function handleWebhookMessage({ payload, session, text, isGroup, chatId, senderPhone }) {
  const t = (text || '').trim()
  if (!t) return false
  const lower = t.toLowerCase()

  // ── ONE SESSION ONLY for group commands ────────────────────────────────────
  // Every logged-in session that sits in AV CENTRAL receives the SAME group
  // message, so without this guard each one runs the whole upload: that is why
  // !upload force created #2906-031 AND #2906-032 and posted the listing twice
  // into Luxury. Redis dedup can't catch it — sessions report different message
  // ids for one message (real number vs @lid participant).
  // Kev, 2026-08-27: this used to hard-require session === 'default', which
  // meant Default being down/SCAN_QR_CODE blocked !upload outright even
  // though four other logged-in sessions saw the exact same group message.
  // Now it's whichever ONE session pickUploadSessionSticky() currently
  // designates as primary — still exactly one acts (no double-upload
  // regression), it just is not permanently pinned to a session that might
  // be dead.
  // Kev, 2026-08-28: pickUploadSession() alone re-resolves live on every
  // call, so a status flip between this message's first delivery and a
  // later redelivery (WAHA's own message/message.any retry) could pick a
  // DIFFERENT winner each time and let two sessions both run !upload for the
  // same logical message — see pickUploadSessionSticky()'s own comment for
  // the exact incident. Sticky by messageId closes that.
  // DMs / Notes-to-self are unaffected (isGroup === false).
  const messageId = payload?.id || payload?.key?.id || null
  const groupLogicalId = isGroup ? gptUploadCommand.groupCommandDedupKey({
    chatId,
    actorId: realSenderJid(payload, true) || payload?.participant || payload?.author,
    timestamp: payload?.timestamp,
    text: t,
  }) : null
  if (isGroup && session !== (await pickUploadSessionSticky(groupLogicalId || messageId, session))) {
    log.debug('upload: ignoring group command on non-primary session', { session, cmd: t.slice(0, 20) })
    return false
  }

  // never react to our own confirmations
  if (/✅ #2906-|🧪 DRY RUN|📂 #/.test(t)) return false

  // ── Pending-confirm catch-alls ──────────────────────────────────────────────
  // These MUST run before the `!`-prefix requirement below, and that is the
  // whole fix: the guard used to be the first line of this function, so a plain
  // `Yes` returned at once and the two catch-alls further down (which carried a
  // comment claiming they ran first) were unreachable. Effect: !av and !book
  // both armed a confirm prompt that could never be answered — !av asked "Reply
  // Yes to send" and then ignored "Yes" forever. That is the step-3 funnel break;
  // it was never a Redis hang.
  //
  // Cheap and safe to run on every message: each is an in-memory Map lookup
  // keyed by chatId that returns false immediately when nothing is pending, and
  // consumes ONLY yes / y / no / n / cancel. Any other text — including
  // !upload — falls straight through to the dispatchers below.
  {
    const { cmdAvConfirm } = require('./av')
    if (await cmdAvConfirm({ session, chatId, senderPhone, text: t })) return true
  }
  {
    const { cmdBookConfirm } = require('./book')
    if (await cmdBookConfirm({ session, chatId, senderPhone, text: t })) return true
  }
  {
    const { cmdAskConfirm } = require('./ask')
    if (await cmdAskConfirm({ session, chatId, text: t })) return true
  }
  {
    const { cmdChatConfirm } = require('./chat')
    if (await cmdChatConfirm({ session, chatId, text: t })) return true
  }
  // Booking details typed as a free-text reply to the bot's !book question —
  // Kev's "book without repeating the command". Consumes only when a relay
  // thread for this chat is actually waiting for details.
  {
    const bookRelay = require('../services/bookRelay')
    if (await bookRelay.handleAgentMessage({ session, chatId, senderPhone, text: t, payload })) return true
  }

  // Kev, 2026-10-22 (P1): "3" (or "C"/"LUX") sent as a reply to the bot's
  // "❓ #REF needs a category" question resolves that draft — same permission
  // check as !recategorize. Anything else falls through untouched.
  {
    const answer = t.match(/^(?:([1-4])(?:\s*bed(?:room)?s?)?|(c|commercial|lux|luxury))\.?$/i)
    if (answer) {
      const { quotedFromPayload } = require('../lib/quotedMessage')
      const q = String(quotedFromPayload(payload).body || '').match(/#(2906-\d{2,6}) needs a category/i)
      if (q) {
        const who = await ul.extractSenderPhone(payload, session, isGroup) || senderPhone || ''
        const handled = await recategorizeAsOperator({ session, chatId, payload, isGroup, senderForAuth: who,
          argLine: `${q[1]} ${(answer[1] || answer[2]).toLowerCase()}` })
        if (handled) return true
      }
    }
  }

  if (!t.startsWith('!')) return false

  const senderForAuth = await ul.extractSenderPhone(payload, session, isGroup) || senderPhone || ''

  if (/^!sessions\b/i.test(t)) {
    if (!isAdmin(senderForAuth)) { await reply(session, chatId, '❌ Admin only.'); return true }
    await cmdSessions(session, chatId)
    return true
  }
  if (/^!categorygroups\b/i.test(t)) {
    if (!isAdmin(senderForAuth) && !(await ul.resolveAgent(senderForAuth))) return false
    await cmdCategoryGroups(session, chatId)
    return true
  }
  if (/^!fbgroups\b/i.test(t)) {
    if (!isAdmin(senderForAuth)) { await reply(session, chatId, '❌ Admin only.'); return true }
    await cmdFbgroups(session, chatId, t.replace(/^!fbgroups\s*/i, ''))
    return true
  }
  if (/^!book\b/i.test(t)) {
    if (!isAdmin(senderForAuth) && !(await ul.resolveAgent(senderForAuth))) return false
    const { cmdBook } = require('./book')
    // 4th arg is additive context for the relay branch (bare !book <ref>);
    // the positional signature the old call used is unchanged.
    await cmdBook(session, chatId, t.replace(/^!book\s*/i, ''), {
      senderPhone: senderForAuth || senderPhone || '',
      senderName:  payload?.pushName || '',
      messageId:   payload?.id || null,
      // Real private number for the relay's owner→agent leg — see the !av
      // dispatch above for why this is re-derived instead of reusing
      // senderForAuth (which may be LID-fallback digits, not a phone).
      realSenderPhone: phoneFromJid(realSenderJid(payload, isGroup)) || null,
    })
    return true
  }
  // !ask — the mobile-friendly path to the Board's own Ask button. Gate is
  // wider than !book's (isAdmin OR ANY active board agent, not just one of
  // Kev's own WAHA-bound numbers): the Board's Ask button is not admin-only
  // either, and services/ownerAsk.js:resolveAgentByPhone (not
  // ul.resolveAgent, which only matches Kev's own session numbers) is what
  // actually finds a board-only agent by their registered notify_whatsapp.
  if (/^!ask\b/i.test(t)) {
    const realSenderPhone = phoneFromJid(realSenderJid(payload, isGroup)) || null
    const { cmdAsk } = require('./ask')
    await cmdAsk(session, chatId, t.replace(/^!ask\s*/i, ''), {
      senderPhone: senderForAuth || senderPhone || '',
      realSenderPhone,
      payload,
    })
    return true
  }
  // !chat — "activate your dashboard chat" with the owner of a listing.
  // Same gate as !ask (isAdmin OR any active board agent via notify_whatsapp)
  // — Katya/Olga have no WAHA session of their own. See handlers/chat.js.
  if (/^!chat\b/i.test(t)) {
    const { resolveAgentByPhone } = require('../services/ownerAsk')
    const realSenderPhone = phoneFromJid(realSenderJid(payload, isGroup)) || null
    const chatPhone = realSenderPhone || senderForAuth || senderPhone || ''
    if (!isAdmin(senderForAuth) && !(await resolveAgentByPhone(chatPhone))) return false
    const { cmdChat } = require('./chat')
    await cmdChat(session, chatId, t.replace(/^!chat\s*/i, ''), {
      senderPhone: senderForAuth || senderPhone || '',
      realSenderPhone,
    })
    return true
  }
  // (Yes/No reply for pending !book is consumed by cmdBookConfirm above.)
  if (/^!viewings\b/i.test(t)) {
    if (!isAdmin(senderForAuth) && !(await ul.resolveAgent(senderForAuth))) return false
    const { cmdViewings } = require('./viewings')
    await cmdViewings(session, chatId, t.replace(/^!viewings\s*/i, ''))
    return true
  }
  if (/^!reminder\b/i.test(t)) {
    if (!isAdmin(senderForAuth) && !(await ul.resolveAgent(senderForAuth))) return false
    const { cmdReminder } = require('./reminder')
    // messageId: so the scheduled T-18d/T-2d fire can quote-reply the
    // original !reminder command message (Kev, 2026-08-26).
    await cmdReminder(session, chatId, t.replace(/^!reminder\s*/i, ''), payload?.id || null)
    return true
  }
  if (/^!uploadstatus\b/i.test(t)) {
    // Kev, 2026-09-08 (Agent-Command-Cleanup, confirmed decision): admin
    // only — was open to any resolved agent, same as every listing's
    // per-channel publishing detail. Same "Admin only." reply shape
    // !recategorize right below already uses (return true, not false —
    // an unauthorized hit here should not fall through to any other
    // dispatcher misreading the command).
    if (!isAdmin(senderForAuth)) { await reply(session, chatId, '❌ Admin only.'); return true }
    await cmdUploadStatus(session, chatId, t.split(/\s+/)[1] || '')
    return true
  }
  if (/^!recategorize\b/i.test(t)) {
    // Kev, 2026-09-23 (ARGUS category hotfix): used to pass only t.split()[1]
    // (the ref) — an explicit category token after it (the whole point of
    // "!recategorize REF 2") was silently discarded. cmdRecategorize now
    // parses both itself.
    // Kev, 2026-10-22: no longer admin-only — the uploader/assigned agent may
    // set a bedroom category on their own property (see agentPermissions).
    return recategorizeAsOperator({ session, chatId, payload, isGroup, senderForAuth, argLine: t.replace(/^!recategorize\s*/i, '') })
  }
  if (/^!categorytest\b/i.test(t)) {
    if (!isAdmin(senderForAuth)) { await reply(session, chatId, '❌ Admin only.'); return true }
    await cmdCategoryTest(session, chatId, t.split(/\s+/)[1] || '')
    return true
  }
  // !price / !picup — super-admin only (Kev), NOT agents, unlike the
  // isAdmin-OR-agent gate every other lifecycle command above uses.
  if (/^!price\b/i.test(t)) {
    if (!isAdmin(senderForAuth)) { await reply(session, chatId, '❌ Admin only.'); return true }
    await cmdPrice({ session, chatId, senderPhone: senderForAuth, arg: t.replace(/^!price\s*/i, '') })
    return true
  }
  // Explicit date commands. They deliberately differ: !avdate synchronises
  // the canonical move-in date without distribution; !viewdate additionally
  // authorises the existing category repost after the date write succeeds.
  if (/^!(avdate|viewdate)\b/i.test(t)) {
    if (!isAdmin(senderForAuth) && !(await ul.resolveAgent(senderForAuth))) return false
    const kind = /^!avdate\b/i.test(t) ? 'available' : 'viewing'
    await require('./propertyDates').command({
      kind, session, chatId, senderPhone: senderForAuth || senderPhone || '', payload,
      arg: t.replace(/^!(?:avdate|viewdate)\s*/i, ''),
    })
    return true
  }
  if (/^!picup\b/i.test(t)) {
    if (!isAdmin(senderForAuth)) { await reply(session, chatId, '❌ Admin only.'); return true }
    await cmdPicup({ session, chatId, senderPhone: senderForAuth, payload, arg: t.replace(/^!picup\s*/i, ''), isGroup })
    return true
  }
  // !bmarket <ref> <date> — "back on market", admin/super-admin only, same
  // gate as !price (Kev: analog zu !price/!recategorize).
  if (/^!bmarket\b/i.test(t)) {
    if (!isAdmin(senderForAuth)) { await reply(session, chatId, '❌ Admin only.'); return true }
    await cmdBmarket({ session, chatId, senderPhone: senderForAuth, arg: t.replace(/^!bmarket\s*/i, '') })
    return true
  }
  // !wupload — Unwatermark.ai integration (Kev, 2026-09-08). Deliberately
  // standalone from !upload/createListing -- "die Owner sachen werden ja
  // garnicht immer properties haben": sometimes there's a photo to clean up
  // with no listing attached at all. Reuses gatherContent()'s EXACT same
  // "last 10 minutes, same sender" image-gathering !upload itself uses, so
  // this command's photo scope always matches what !upload would have
  // picked up for the same window.
  if (/^!wupload\b/i.test(t)) {
    if (!isAdmin(senderForAuth)) { await reply(session, chatId, '❌ Admin only.'); return true }
    await cmdWupload({ payload, session, chatId, isGroup, senderPhone: senderForAuth })
    return true
  }
  // !undo [ref] — reverse an owner-checklist auto-publish (Kev, 2026-09-09).
  if (/^!undo\b/i.test(t)) {
    if (!isAdmin(senderForAuth)) { await reply(session, chatId, '❌ Admin only.'); return true }
    await cmdUndo({ session, chatId, senderPhone: senderForAuth, arg: t.replace(/^!undo\s*/i, '') })
    return true
  }

  // !upload / !upload1 … !upload9 [force] — the digit is the FB post count.
  // (\b after the digit keeps !uploadlisting and !uploadstatus out)
  const parsedUpload = parseUploadCommand(t)
  const m = parsedUpload ? [t, parsedUpload.variantSuffix] : null
  if (m && !lower.startsWith('!uploadlisting') && !lower.startsWith('!uploadstatus')) {
    const force = /\bforce\b/i.test(t.slice(0, 40))
    // "group" anywhere in the command line → also create a WhatsApp viewing
    // group. Scoped to the first 40 chars like `force`, so the word appearing in
    // a listing description can't trigger it by accident.
    const wantsGroup = /\bgroup\b/i.test(t.slice(0, 40))
    // "noad" → zero Facebook for this listing: no page campaign, no group
    // share, not now and not later. Same 40-char scope as the other keywords.
    // It OVERRIDES the digit, so "!upload5 noad" posts to Facebook 0 times.
    const noAd = /\bnoad\b/i.test(t.slice(0, 40))
    return cmdUpload({ payload, session, chatId, isGroup, text: t,
      variantSuffix: parsedUpload.variantSuffix, intakeMode: parsedUpload.intakeMode,
      photoMode: parsedUpload.photoMode,
      force, wantsGroup, noAd: noAd || !!parsedUpload.intakeMode })
  }

  // (The two pending-confirm catch-alls used to sit here. They are now at the
  //  top of this function, above the `!`-prefix guard, because down here they
  //  could only ever see text that already started with '!' — i.e. never a
  //  plain `Yes`.)

// !av <ref> — confirm-then-send owner availability check (uses the
  // website-button path). Pending Yes/No consumtion is handled by the
  // handler on the next incoming message.
  if (/^!av\b/i.test(t)) {
    // Logged because this is the gate every "!av did nothing" report died at.
    // Returning FALSE here does not stop the message: routes/webhook.js falls
    // through to the availability hook, whose runAvCommand() has NO auth gate
    // and messages the owner directly with no confirm step. So a failed auth
    // here is not a rejection — it is a different, less safe code path.
    const _avAuthOk = isAdmin(senderForAuth) || !!(await ul.resolveAgent(senderForAuth))
    log.info('upload: !av dispatch', {
      session, authOk: _avAuthOk, senderForAuth: String(senderForAuth || '').slice(-4) || null,
      isGroup: !!isGroup, cmd: t.slice(0, 24),
    })
    if (!_avAuthOk) return false
    const { cmdAv } = require('./av')
    const arg = t.replace(/^!av\s*/i, '')
    if (arg) {
      // The requester's real private number, LID-resolved fresh from the raw
      // payload — null when WhatsApp gave us no phone alt at all (see the
      // require at the top of this file). Kev 2026-08-21: this, never chatId,
      // is what the owner's eventual answer gets routed to.
      const realSenderPhone = phoneFromJid(realSenderJid(payload, isGroup)) || null
      await cmdAv({
        session,
        chatId,
        senderName: payload.pushName || senderPhone,
        senderPhone,
        realSenderPhone,
        arg,
        // Carried so availability.js:reactOnRequest() can put the owner's
        // verdict (👍 / 👎) straight onto the agent's own !av message.
        messageId: payload?.id || null,
      })
    } else {
      await waha.sendText(session, chatId,
        'Usage: !av <ref>\nExample: !av 077 or !av 2906-077')
    }
    return true
  }

  // ── Phase 3: priority + lifecycle commands ────────────────────────────────
  // Placed before the generic !-dispatchers below and before !help so the
  // more specific patterns win. None of these messages an owner, so the gate
  // is the normal admin-or-agent one with no confirm step.
  // ARGUS OWNER + PROPERTY STATE FINAL PASS, item 4: `!available` is the
  // spec's own name for what this codebase already built as `!return`
  // (boardAction.returnToMarket — restores the ref, republishes, clears the
  // rented/archived state). Same handler, not a second implementation —
  // added as a plain alias so both names work.
  // Kev, 2026-10-22 (P1): the gate is the permission matrix in
  // services/agentPermissions.js — admin/core agents on every property, board
  // agents on properties they listed or are assigned to, everyone else
  // ignored (no reply to external chats). The old gate (ul.resolveAgent, an
  // exact whatsapp_phones match) silently dropped board agents' commands.
  // !rented: admins keep their existing path (adminCommands → rentedDetector);
  // agents get the SAME rentedDetector handler here after the scope check.
  if (/^!(priority|archive|markrecentlyrented|return|available|rented)\b/i.test(t)) {
    const cmd = t.match(/^!(priority|archive|markrecentlyrented|return|available|rented)\b/i)[1].toLowerCase()
    const perms = require('../services/agentPermissions')
    const realPhone = phoneFromJid(realSenderJid(payload, isGroup)) || null
    const operator = await perms.resolveOperator([senderForAuth, realPhone], { isAdmin })
    if (!operator.kind) return false
    if (cmd === 'rented' && operator.kind === 'admin') return false   // unchanged admin path
    let resolvedRef = null
    if (operator.kind !== 'admin') {
      const rd = require('../services/rentedDetector')
      const { quotedFromPayload } = require('../lib/quotedMessage')
      const { id: quotedMessageId, body: quotedBody } = quotedFromPayload(payload)
      const target = await rd.resolveRentedTarget({
        text: `!rented ${t.replace(/^!\w+\s*/i, '')}`, quotedMessageId, quotedBody, chatId,
        mode: cmd === 'rented' ? undefined : 'available',
      })
      if (!target || target.ambiguous) {
        await reply(session, chatId, target?.ambiguous
          ? `❓ More than one listing matches — send !${cmd} with the exact ref.`
          : `❌ Usage: !${cmd} <ref>  or reply to the listing message with !${cmd}`)
        return true
      }
      const scope = await perms.propertyScope(target.property_id)
      const action = cmd === 'rented' ? 'mark_rented' : cmd === 'available' || cmd === 'return' ? 'mark_available' : 'lifecycle'
      const decision = perms.authorize(operator, action, scope)
      if (!decision.allow) { await reply(session, chatId, `❌ #${target.ref} — ${decision.message}`); return true }
      if (cmd === 'rented') {
        await rd.handleRentedCommand(payload, session, senderForAuth || realPhone)
        return true
      }
      resolvedRef = target.ref   // a quoted-reply command carries no ref of its own
    }
    const P = require('./priority')
    const arg = t.replace(/^!\w+\s*/i, '') || resolvedRef || ''
    const fn = cmd === 'priority' ? P.cmdPriority
      : cmd === 'archive' ? P.cmdArchive
      : cmd === 'markrecentlyrented' ? P.cmdMarkRecentlyRented
      : P.cmdReturnToMarket
    await fn({ session, chatId, senderPhone: senderForAuth || senderPhone, arg })
    return true
  }

  // !help / !commands — show every WhatsApp command in one place.
  if (/^!(help|commands)\b/i.test(t)) {
    const { cmdHelp } = require('./help')
    await cmdHelp(session, chatId, t, isAdmin(senderForAuth))
    return true
  }

  return false
}

// wahaSessionForPhone is exported for services/listingAgentNotify.js, which
// has always required it from here — it was simply never on this list, so
// every schedule-board relay threw "wahaSessionForPhone is not a function"
// inside a try/catch and silently fell back to the 'default' session.
module.exports = {
  parseOwnerContact, parseUploadCommand, extractIntakeMetadata, looksLikeListingText, findUnresolvedDrafts, planContactFallback, restoreSingleListingContact, cmdUpload, _testHooks, // draft-context hotfix (2026-09-23), test access
  handleWebhookMessage, autoShareToGroups, FB_CHANNELS, wahaSessionForPhone, runCategoryDistribution, markChannel,
  // ARGUS category hotfix (2026-09-23): exported for direct testing of the
  // !recategorize REF [1|2|3|4|C|LUX] override syntax — same "direct
  // Level-2 call instead of simulating a full webhook payload" reasoning as
  // createListing/cmdBmarket below.
  cmdRecategorize,
  // Kev, 2026-09-02: exported for test/multi-unit-upload-proof.js, same
  // reason createViewingGroup below is exported — a direct Level-2 call
  // instead of simulating a full webhook payload.
  createListing,
  // Board Phase 2 (Kev, 2026-08-27): routes/crmScheduleBoard.js POST
  // .../create-group reuses this exact group-creation + welcome-message
  // tool instead of building a second one — see that route for why.
  createViewingGroup,
  // Kev, 2026-08-28: routes/webhook.js's OWN group-traffic gate (the one that
  // runs BEFORE this handler is even called) was still hard-checking
  // session === 'default' with no fallback at all, discarding !upload's group
  // message before this file's already-fixed pickUploadSession() ever got a
  // chance to run. Exporting it so webhook.js's gate resolves the SAME
  // session this file does, instead of a second, stricter, unfixed literal.
  pickUploadSession,
  // Kev, 2026-08-28: the sticky-by-messageId wrapper (see its own comment) —
  // webhook.js's gate must call THIS, not pickUploadSession() directly, or
  // the two gates can disagree with each other exactly the way they used to
  // disagree with the literal 'default' check.
  pickUploadSessionSticky,
  // Kev, 2026-09-02: exported for a direct Level-2 proof of !bmarket, same
  // reason createListing/runCategoryDistribution above are exported — a real
  // function call instead of simulating a full webhook payload.
  cmdBmarket, parseBmarketDate,
  // FB-Owner-Save-Tool (Kev, 2026-09-08): reused verbatim for its own
  // phone+text-shaped dedup instead of a second, drifting copy of the same
  // 0.92 boilerplate-proof threshold — see that file's own header comment.
  textSimilarity,
  // FB Direct From Owner Convert & TODO (Kev, 2026-09-08, v2): the escalated
  // owner card posts into the SAME AV CENTRAL group !upload already reads
  // from, so this constant must be the one single source of truth for that
  // JID — never a second, potentially drifting literal. AV_CENTRAL_GROUP
  // itself is null in this deployment's current unset/multi-team mode (any
  // group may run !upload) — that is correct for the ACCEPTANCE gate, but
  // "where do I proactively post an escalation" needs a real, specific
  // group, so AV_CENTRAL_DEFAULT (the known default) is exported too.
  AV_CENTRAL_GROUP,
  AV_CENTRAL_DEFAULT,
}
