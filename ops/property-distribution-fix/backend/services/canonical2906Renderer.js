'use strict'
// services/canonical2906Renderer.js — CANONICAL 2906 LISTING RENDERER
// (Owner Auto-Upload finalize, Kev, 2026-09-10).
//
// Replaces the free-form "AI, write a nice listing" approach that used to
// live entirely inside fbPostFetch.js's polishDescription() prompt for the
// owner-auto-upload path. That prompt worked, but it hard-coded the whole
// template as English instructions to an LLM -- including, concretely, a
// rule telling the model to write "🚫 No Pets" / "🚫 No Sharing" straight
// into the marketing copy whenever the owner said no. That is exactly the
// negative-answer-pollution bug Kev's regression spec calls out: a NO to
// "would you consider sharing" is CRM metadata, never a selling point.
//
// Design (Kev's own explicit instruction, 2026-09-10): a deterministic
// renderer with FIXED slots. The model is responsible for exactly two
// things -- one short intro paragraph and one short closing paragraph.
// Everything else (which facts become bullets, their order, their emoji,
// price placement, availability/viewing wording, omission of negatives) is
// plain code, so the final AV CENTRAL message is byte-for-byte the same
// shape no matter how a particular Gemini call behaves that day.
//
// Idempotency (spec point 31/32): normalizePropertyDraft() + a fact
// fingerprint let a caller reuse a previously-generated intro/closing pair
// when nothing relevant changed, and force a fresh one the moment it does --
// callers persist `canonicalFields` back onto the conversation's checklist
// (this module itself never touches the DB, on purpose, so it stays a pure
// function set that can be unit-tested without a live Gemini key or a DB).

const log = require('../logger')

let _ai = null
function getAI() {
  if (_ai) return _ai
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return null
  const { GoogleGenAI } = require('@google/genai')
  _ai = new GoogleGenAI({ apiKey })
  return _ai
}

// ── 1. normalize ─────────────────────────────────────────────────────────
// Maps the owner-conversation `checklist` shape (autoOwnerConversation.js)
// into the flat draft shape this renderer works from. Never invents a
// value -- anything not genuinely known stays null/false, exactly per the
// "never guess" rule the rest of that file already follows.
// Kev, 2026-10-22 (P0, draft #29496): a price that is not VERIFIED (inferred
// from shorthand, out of the normal range, or never stated) is not printed as
// a fact. Same verification states autoOwnerConversation records.
function priceVerificationOf(c) {
  if (c.price == null) return 'MISSING'
  if (c._price_evidence && c._price_evidence.verification) return c._price_evidence.verification
  return (Array.isArray(c.notes) ? c.notes : []).some(n => /Malta shorthand|please verify/i.test(n)) ? 'NEEDS_REVIEW' : 'VERIFIED'
}

function normalizePropertyDraft(checklist) {
  const c = checklist || {}
  const priceVerification = priceVerificationOf(c)
  return {
    town: c.town || null,
    property_category: c.property_category || null,
    bedrooms: c.bedrooms != null ? Number(c.bedrooms) : null,
    bathrooms: c.bathrooms != null ? Number(c.bathrooms) : null,
    general_price: c.price != null && priceVerification === 'VERIFIED' ? Number(c.price) : null,
    price_verification: priceVerification,
    date_clarification: c._date_clarification || null,
    sharing_allowed: c.sharing === 'yes',
    sharing_price: c.sharing_price != null ? Number(c.sharing_price) : null,
    subletting_allowed: c.subletting === 'yes',
    subletting_price: c.subletting_price != null ? Number(c.subletting_price) : null,
    pets_allowed: c.pets === 'yes',
    available_date: c.available_date || null,
    // limited-term facts (2026-09-21): a draft that knows its end date / rental
    // modes says so in the availability block, same wording as every other output
    available_until: c.available_until || null,
    rental_modes: c.rental_modes || null,
    viewable_date: c.viewable_date || null,
    notes: Array.isArray(c.notes) ? c.notes : [],
    address: c.address || null,
    photo_count: Array.isArray(c._photos) ? c._photos.length : 0,
  }
}

// ── 2. validate ──────────────────────────────────────────────────────────
// A usable listing, not 100% database completeness (spec point 5): the one
// hard requirement is a locality AND (a price OR a bed/bath count) -- the
// same MUST-field bar the owner-conversation flow already enforces before
// it ever reaches "checklist complete", so in practice this should always
// pass; it exists so a caller never posts a broken/empty card if it does not.
function validatePropertyDraft(draft) {
  const missing = []
  if (!draft.town) missing.push('town')
  if (draft.general_price == null && draft.bedrooms == null) missing.push('price_or_bedrooms')
  return { ok: missing.length === 0, missing }
}

// ── 3. headline ──────────────────────────────────────────────────────────
const PROPERTY_TYPE_RE = /\b(duplex penthouse|penthouse|maisonette|villa|bungalow)\b/i
function detectPropertyTypeLabel(draft) {
  const text = draft.notes.join(' ')
  const m = text.match(PROPERTY_TYPE_RE)
  if (!m) return null
  const t = m[1].toLowerCase()
  return t.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

const AMENITY_KEYWORDS = [
  { key: 'pool', re: /\bpool\b/i, label: 'Pool' },
  { key: 'gym', re: /\bgym\b/i, label: 'Gym' },
  { key: 'terrace', re: /\b(large|big|spacious)\s+terrace\b/i, label: 'Large Terrace' },
  { key: 'sea_view', re: /\bsea\s*views?\b/i, label: 'Sea Views' },
]

// Priority per spec point 16: property type first, then an exceptional
// amenity, then a view -- max 2, and skipped entirely rather than padded
// with a generic word (AC/kitchen/etc. explicitly excluded from the headline).
function selectHeadlineFeatures(draft) {
  const picked = []
  const typeLabel = detectPropertyTypeLabel(draft)
  if (typeLabel) picked.push(typeLabel)
  const text = draft.notes.join(' ')
  const foundAmenities = AMENITY_KEYWORDS.filter(a => a.re.test(text)).map(a => a.label)
  if (picked.length < 2 && foundAmenities.length >= 2 && foundAmenities.includes('Pool') && foundAmenities.includes('Gym')) {
    picked.push('Pool & Gym')
  } else {
    for (const label of foundAmenities) {
      if (picked.length >= 2) break
      if (!picked.includes(label)) picked.push(label)
    }
  }
  return picked.slice(0, 2)
}

function pluralize(n, word) { return `${n} ${word}${Number(n) === 1 ? '' : 's'}` }

function buildHeadline(draft) {
  const parts = []
  if (draft.bedrooms != null) parts.push(pluralize(draft.bedrooms, 'Bedroom'))
  if (draft.bathrooms != null) parts.push(pluralize(draft.bathrooms, 'Bathroom'))
  const extras = selectHeadlineFeatures(draft)
  const base = parts.join(' - ') || 'Property'
  return extras.length ? `${base} - ${extras.join(' & ')}` : base
}

// ── 4. feature lines (spec point 18/19 — positive facts only, fixed order) ──
function buildFeatureLines(draft) {
  const lines = []
  if (draft.bedrooms != null) lines.push(`🛏 ${pluralize(draft.bedrooms, 'Bedroom')}`)
  if (draft.bathrooms != null) lines.push(`🛁 ${pluralize(draft.bathrooms, 'Bathroom')}`)
  const typeLabel = detectPropertyTypeLabel(draft)
  if (typeLabel) lines.push(`🏡 ${typeLabel}`)
  const text = draft.notes.join(' ')
  if (/\b(a\/?c|air[- ]?condition(?:ed|ing)?)\b/i.test(text)) lines.push('❄️ Air-Conditioned')
  if (/\bfurnished\b/i.test(text)) lines.push('🛋 Furnished')
  if (/\bbalcony\b/i.test(text)) lines.push('🌿 Balcony')
  if (/\bgarden\b/i.test(text)) lines.push('🌿 Garden')
  if (AMENITY_KEYWORDS.find(a => a.key === 'terrace').re.test(text)) lines.push('🌅 Large Terrace')
  if (AMENITY_KEYWORDS.find(a => a.key === 'sea_view').re.test(text)) lines.push('🌊 Sea Views')
  if (AMENITY_KEYWORDS.find(a => a.key === 'pool').re.test(text)) lines.push('🏊 Access to Communal Swimming Pool')
  if (AMENITY_KEYWORDS.find(a => a.key === 'gym').re.test(text)) lines.push('🏋️ Access to Communal Gym')
  if (draft.town) lines.push(`📍 ${draft.town}`)
  // Rules — ONLY the positive form, ONLY when true. A `false`/unknown value
  // is never rendered here in any wording: this is the exact fix for the
  // "No subletting." / "🚫 No Pets" pollution bug (spec point 3/18).
  if (draft.pets_allowed) lines.push('🐶 Pets Considered')
  if (draft.sharing_allowed) lines.push('👥 Sharing Considered')
  return lines
}

// ── 5. availability / viewing (spec point 22/23) ────────────────────────
// P0 2026-10-22: a held-back (past) date or one that is itself a past
// month+year is never advertised — "Available from July!" for a July that is
// over was published for #29496.
function isPastMonthYear(value, at = new Date()) {
  const m = String(value || '').toLowerCase().match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*(?:['’]\s*(\d{2})|(\d{4}))\b/)
  if (!m) return false
  const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[1])
  const year = m[3] ? Number(m[3]) : 2000 + Number(m[2])
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', year: 'numeric', month: 'numeric' }).formatToParts(at)
  const nowY = Number(parts.find(p => p.type === 'year').value), nowM = Number(parts.find(p => p.type === 'month').value) - 1
  return year * 12 + month < nowY * 12 + nowM
}

function renderAvailability(draft) {
  if ((draft.date_clarification || {}).available_date || isPastMonthYear(draft.available_date)) return '🗓️ Availability to be confirmed'
  const v = String(draft.available_date || '').trim()
  if (!v) return '🟢 Coming Available Soon!'
  if (/^(now|asap|immediately)$/i.test(v)) return '🟢 Available Now!'
  return `🟢 Available from ${v}!`
}

function renderViewing(draft) {
  if ((draft.date_clarification || {}).viewable_date || isPastMonthYear(draft.viewable_date)) return null
  const v = String(draft.viewable_date || '').trim()
  if (!v) return null // no viewing info known — never invent one (spec point 23)
  if (/^(now|asap|immediately)$/i.test(v)) return '👀 Viewings Available Now!'
  return `👀 Viewings from ${v}!`
}

// ── 6. price line (spec point 15 — ALWAYS the general price, never a
// conditional one, no matter how much higher the sharing/subletting price is) ──
function formatMoney(n) { return `€${Number(n).toLocaleString('en-US')}` }

// ── 7. fact fingerprint — drives idempotent regeneration (spec point 31/32) ──
function factFingerprint(draft) {
  return JSON.stringify([
    draft.town, draft.property_category, draft.bedrooms, draft.bathrooms,
    draft.general_price, draft.sharing_allowed, draft.pets_allowed,
    draft.available_date, draft.available_until, draft.rental_modes, draft.viewable_date, draft.notes.join('|'),
  ])
}

const BANNED_PHRASES_RE = /(nestled|unparalleled|meticulously curated|where luxury meets|dream home awaits|sanctuary)/i

// P0 2026-10-22: marketing prose may only restate supported facts. The old
// fallback always claimed "a great opportunity ... at an excellent price" —
// printed for #29496 whose price was never stated. Price/value claims are
// never allowed (the price line is the only place a price appears); feature
// claims need a matching owner fact; appearance claims need photos.
const PRICE_CLAIM_RE = /\b(excellent|great|unbeatable|amazing|fantastic|competitive|affordable|reasonable|attractive)\s+(?:price|value|deal|rent)\b|\b(bargain|great value|value for money|exceptional opportunity|great opportunity|rare opportunity|opportunity)\b/i
const UNSUPPORTED_FEATURE_CLAIMS = [
  { re: /\b(luxur(?:y|ious)|premium|high[- ]end|exclusive)\b/i, supported: () => false },
  { re: /\b(?:swimming\s+)?pool\b/i, supported: d => /\bpool\b/i.test(d.notes.join(' ')) },
  { re: /\bsea\s*views?\b|\bseafront\b|\bsea\b/i, supported: d => /\bsea\b/i.test(d.notes.join(' ')) },
  { re: /\bpenthouse\b/i, supported: d => /\bpenthouse\b/i.test(d.notes.join(' ')) },
  { re: /\bvilla\b/i, supported: d => /\bvilla\b/i.test(d.notes.join(' ')) },
  { re: /\bgarden\b/i, supported: d => /\bgarden\b/i.test(d.notes.join(' ')) },
  { re: /\bterrace\b/i, supported: d => /\bterrace\b/i.test(d.notes.join(' ')) },
  { re: /\bfurnished\b/i, supported: d => /\bfurnished\b/i.test(d.notes.join(' ')) },
]
const APPEARANCE_CLAIM_RE = /\b(stunning|beautiful|gorgeous|bright|modern|stylish|elegant|spectacular|immaculate|newly renovated|renovated)\b/i
function narrativeClaimProblems(narrative, draft) {
  const text = `${narrative.intro} ${narrative.closing}`
  const problems = []
  if (PRICE_CLAIM_RE.test(text)) problems.push('price_or_value_claim')
  for (const claim of UNSUPPORTED_FEATURE_CLAIMS) if (claim.re.test(text) && !claim.supported(draft)) problems.push(`unsupported:${claim.re.source.slice(0, 24)}`)
  if (!draft.photo_count && APPEARANCE_CLAIM_RE.test(text)) problems.push('appearance_claim_without_photos')
  return problems
}

function fallbackNarrative(draft) {
  const bedsLabel = draft.bedrooms != null ? `${draft.bedrooms}-bedroom` : ''
  const typeLabel = (detectPropertyTypeLabel(draft) || 'property').toLowerCase()
  return {
    intro: `Looking for a home in ${draft.town}? This ${bedsLabel} ${typeLabel} is offered for long-term rent.`.replace(/\s+/g, ' '),
    closing: `Get in touch for the full details of this ${typeLabel} in ${draft.town}.`,
  }
}

// The AI's ONLY job: two short paragraphs, from ONLY the facts handed to
// it. It never sees the render template, never chooses emoji, never
// decides what counts as a bullet — that separation is the whole point
// (spec point 34, "build this as code, not only as a prompt").
async function generateNarrativeContent(draft) {
  const ai = getAI()
  if (!ai) return fallbackNarrative(draft)

  const facts = {
    locality: draft.town,
    property_type: detectPropertyTypeLabel(draft) || (draft.property_category === 'commercial' ? 'commercial property' : 'apartment'),
    bedrooms: draft.bedrooms,
    bathrooms: draft.bathrooms,
    positive_amenities: AMENITY_KEYWORDS.filter(a => a.re.test(draft.notes.join(' '))).map(a => a.label),
    has_photos: draft.photo_count > 0,
  }
  const prompt = `Write copy for a Malta property rental ad. Return ONLY strict JSON, no markdown fences, shape exactly:
{"intro": "...", "closing": "..."}

FACTS (use ONLY these — never invent a specific amenity, view, or descriptor not listed here):
${JSON.stringify(facts)}

RULES:
- intro: ONE paragraph, 2 sentences, ~30-55 words. Pattern: "Looking for {proposition}? This {property_type} in {locality} offers {2-4 strongest supported benefits}."
- closing: ONE sentence, 20-35 words, starting conceptually as a summary line (no new facts).
- Tone: clear, warm, WhatsApp-friendly real-estate marketing. Describe only the FACTS above; every claim must be traceable to one of them.
- NEVER claim luxury, premium, high-end, exclusive, a pool, a sea view, a penthouse, a villa, a garden or a terrace unless that exact fact is listed above.
- If has_photos is false, NEVER describe how the property looks (no stunning, beautiful, bright, modern, stylish, renovated).
- NEVER call it an opportunity, a bargain, good value or a good price.
- NEVER write generic AI luxury phrases: "nestled", "unparalleled", "meticulously curated", "where luxury meets lifestyle", "your dream home awaits", "sanctuary".
- NEVER mention pets, sharing, subletting, price, or any rule/restriction — those are never part of the marketing prose.
- NEVER use a hyphen/dash/en dash/em dash anywhere.
- Output the JSON on a single line. No literal line breaks inside the intro/closing string values.`

  for (const model of ['gemini-2.5-flash', 'gemini-flash-latest']) {
    try {
      // Kev, 2026-09-10 (found live: "Unterminated string in JSON" on
      // basically every call) -- gemini-2.5-flash's "thinking" spend eats
      // into maxOutputTokens the same way fbPostFetch.js's polish call
      // already learned the hard way (its own 2026-09-09 comment), and the
      // model reliably writes a literal newline inside the intro/closing
      // string instead of escaping it as \n -- both raise this same parse
      // error. 800 leaves real headroom for a two-sentence + one-sentence
      // response; collapsing raw newlines before parsing fixes the rest.
      const r = await ai.models.generateContent({ model, contents: prompt, config: { temperature: 0.4, maxOutputTokens: 800 } })
      const text = (r.text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').replace(/[\r\n]+/g, ' ').trim()
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed.intro === 'string' && typeof parsed.closing === 'string' &&
          parsed.intro.trim() && parsed.closing.trim() && !BANNED_PHRASES_RE.test(parsed.intro) && !BANNED_PHRASES_RE.test(parsed.closing)) {
        const candidate = { intro: parsed.intro.trim(), closing: parsed.closing.trim() }
        const problems = narrativeClaimProblems(candidate, draft)
        if (!problems.length) return candidate
        log.warn('canonical2906Renderer: narrative made unsupported claims, retrying/falling back', { model, problems })
        continue
      }
      log.warn('canonical2906Renderer: narrative response failed validation, retrying/falling back', { model })
    } catch (e) {
      log.warn('canonical2906Renderer: narrative generation failed', { model, err: e.message })
    }
  }
  return fallbackNarrative(draft)
}

// ── 8. the renderer itself ──────────────────────────────────────────────
// `cachedCanonical` (optional): { fingerprint, intro, closing } persisted by
// the caller from a previous render — reused verbatim when the fingerprint
// still matches, so re-rendering after an unrelated field write (e.g. a
// photo arriving) never redesigns the prose (idempotent, spec point 31).
async function render2906Listing(checklist, { cachedCanonical = null } = {}) {
  const draft = normalizePropertyDraft(checklist)
  const validation = validatePropertyDraft(draft)
  if (!validation.ok) return { ok: false, missing: validation.missing }

  const fingerprint = factFingerprint(draft)
  let narrative
  if (cachedCanonical && cachedCanonical.fingerprint === fingerprint && cachedCanonical.intro && cachedCanonical.closing
      && !narrativeClaimProblems(cachedCanonical, draft).length) {   // a cached text from before the claim check is regenerated
    narrative = { intro: cachedCanonical.intro, closing: cachedCanonical.closing }
  } else {
    narrative = await generateNarrativeContent(draft)
  }

  const headerLines = [`📍 ${draft.town}`]
  if (draft.general_price != null) headerLines.push(`💰 ${formatMoney(draft.general_price)}/month`)
  else headerLines.push('💰 Price to be confirmed')

  const featureLines = buildFeatureLines(draft)
  const availabilityBlock = [renderAvailability(draft), require('./rentalModes').leaseLine(draft), renderViewing(draft)].filter(Boolean)

  const sections = [
    headerLines.join('\n'),
    `✨ ${buildHeadline(draft)} ✨`,
    narrative.intro,
    featureLines.join('\n'),
    `💎 ${narrative.closing}`,
    availabilityBlock.join('\n'),
    '📞 Contact me to book a viewing or get more details!',
  ].filter(section => section && section.trim())

  return {
    ok: true,
    text: sections.join('\n\n'),
    canonicalFields: { fingerprint, intro: narrative.intro, closing: narrative.closing },
  }
}

module.exports = {
  normalizePropertyDraft,
  validatePropertyDraft,
  selectHeadlineFeatures,
  buildFeatureLines,
  renderAvailability,
  renderViewing,
  render2906Listing,
}
