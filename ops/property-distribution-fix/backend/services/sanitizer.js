'use strict'
// ============================================================================
// sanitizer.js — the sanitization FIREWALL between internal data and ANY
// external channel (WhatsApp category groups, website, Facebook, PM, IG).
//
// RULE (enforced across the whole upload pipeline):
//   Every publisher module receives ONLY the output of sanitizeForPublic().
//   Publishers must never receive the raw property row or the owner row.
//
// Owner data and precise location NEVER leave this function.
// Better to fail loudly than to leak owner data.
// ============================================================================

const { KEV_WA_PHONE } = require('./kevContact')

const PHONE_RE_G = /\+?\d[\d\s\-()]{6,}\d/g          // phone-like runs (strip)
const PHONE_RE   = /\+?\d[\d\s\-()]{7,}/             // phone-like (assert)
const EMAIL_RE_G = /[\w.+-]+@[\w.-]+\.\w+/g          // emails (strip)
const EMAIL_RE   = /@[\w.-]+\.\w+/                   // emails (assert)

// Kev's own public business number (see kevContact.js) — the one number an
// agent is EXPECTED to type into an ad's text ("📞 Contact me... 99811819")
// so WhatsApp auto-links it blue in the notes chat. Matches with or without
// the +356 country code and with optional spaces/dashes between digits, so
// it is stripped as a "safe" pattern before the phone-leak assertion below —
// same treatment as ref ids/URLs/dates. Any OTHER number (the owner's) still
// trips the assertion.
const kevDigits = KEV_WA_PHONE.slice(-8)
const KEV_NUMBER_RE = new RegExp(
  '\\+?(356[\\s-]?)?' + kevDigits.split('').join('[\\s-]?'), 'g')

// Patterns that legitimately contain long digit runs in a public payload.
// Stripped BEFORE the phone-leak assertion so they never false-positive:
//   - Kev's own public number (the one number ads are meant to show)
//   - URLs (Cloudinary image URLs carry version timestamps like v1719834412)
//   - ISO dates ("2026-07-01", timestamps)
//   - our ref ids ("2906-247")
//   - price/sqm JSON number fields
function stripSafePatterns(s) {
  return String(s || '')
    .replace(KEV_NUMBER_RE, ' ')                                          // Kev's own number
    .replace(/https?:\/\/[^\s"',\\]+/g, ' ')                              // URLs
    .replace(/\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?/g, ' ')                   // ISO dates
    .replace(/\b2906[-\s]?\d{1,6}\b/g, ' ')                               // ref ids
    .replace(/"(longlet_price|sale_price|sqm|beds|baths)"\s*:\s*\d+(\.\d+)?/g, ' ')
    // Written-out prices / price ranges / sizes. These live in description_social,
    // which keeps the ad text exactly as written — and "1500 - 2000" is otherwise
    // phone-shaped, which would fail the assertion below on a perfectly good ad.
    .replace(/[€$£]\s?[\d.,]+(\s*(?:-|–|to)\s*[€$£]?\s?[\d.,]+)?/gi, ' ')  // €1500 / €1500 - €2000
    .replace(/\b[\d.,]+\s?(?:eur|euro|euros|usd|k)\b/gi, ' ')              // 1800 EUR
    .replace(/\b[\d.,]+\s?(?:sqm|sq\.?\s?m|m2|m²)\b/gi, ' ')               // 120 sqm
}

// True when every remaining long digit-run is accounted for by safe patterns
// (prices, dates, refs, URLs) — i.e. nothing phone-like survives.
function containsOnlyPriceNumbers(serialized) {
  return !PHONE_RE.test(stripSafePatterns(serialized))
}

// Assert a public-facing STRING (payload JSON or a formatted group message)
// carries no phone / email. Throws — failing loudly is correct here.
function assertNoLeaks(text, context = 'public payload') {
  const s = String(text || '')
  if (PHONE_RE.test(s) && !containsOnlyPriceNumbers(s)) {
    throw new Error(`SANITIZER: possible phone number leaked into ${context}`)
  }
  if (EMAIL_RE.test(stripSafePatterns(s))) {
    throw new Error(`SANITIZER: email leaked into ${context}`)
  }
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── address firewall ─────────────────────────────────────────────────────────
// The TOWN is public. The street, house number and flat number are not.
//
// This works on the TEXT, not on properties.street / properties.apt. Those
// columns are NULL on every row in the live DB, which is precisely why the old
// exact-substring guard waved through listings carrying a full address inside
// description_social ("📍 66, Triq Sir Frederick, Gzira").
//
// One detector, used in two places: stripAddresses() removes every match at
// build time, and findAddress() re-checks the finished message before sending.
// Same regex for both, so anything the stripper removes can never trip the
// guard, and anything the guard catches is text that never went through here.

// Maltese street nouns, prefix form: "Triq Il-Ħemel", "Sqaq Nru 2".
// "Telgħet" added 2026-08-29 (#2906-upload): "Telgħet Birkirkara" survived a
// pin line whole because it carries no recognised prefix — a real address,
// not a landmark.
const ST_MT = String.raw`triq|trejqa|sqaq|vjal|misra[ħh]|pjazza|wesg[ħh]a|telg[ħh]et`
// English street nouns, suffix form: "Sir Frederick Street".
// Deliberately WITHOUT "close", "court" and "hill" — "Sliema close to the sea"
// would read as an address and cost us the town, which is allowed to stay.
const ST_EN = String.raw`street|road|avenue|lane|square`
// A word that can be part of a street name. Two branches on purpose:
//   - a short abbreviation WITH its dot ("St.", "Nru.")
//   - any other word WITHOUT a trailing dot
// so a match stops at a sentence end. Letting a long word keep its dot made
// "…prestigious Triq Il-Ħemel. The property offers 150sqm…" swallow the next
// sentence. No comma in either branch either, so "Triq Sir Frederick, Gzira"
// can never run into the town.
const NAMEWORD = String.raw`(?:[\p{L}][\p{L}'’\-]{0,2}\.|[\p{L}][\p{L}'’\-]*)`

const ADDRESS_CORE = [
  // "66, Triq Sir Frederick" · "triq il miklem malti mscala"
  String.raw`(?:\d{1,4}\s*,?\s*)?\b(?:${ST_MT})\b(?:\s+${NAMEWORD}){0,4}`,
  // "39 Sir Frederick Street" · "St Albert Street"
  String.raw`(?:\d{1,4}\s*,?\s*)?\b(?:${NAMEWORD}\s+){1,4}(?:${ST_EN})\b`,
  // "flat 5" · "apt. 3" · "block 2"
  String.raw`\b(?:flat|apt|apartment|maisonette|unit|block)\s*\.?\s*(?:no\.?|nru\.?|#)?\s*\d+[a-z]?\b`,
  // "house no 7"
  String.raw`\b(?:house|hse)\s*(?:no\.?|nru\.?|number|#)\s*\d+[a-z]?\b`,
].join('|')

// Cutting only the street out of "…in Swieqi, located on the quiet and
// prestigious Triq Il-Ħemel." leaves a dangling clause, so the removal reaches
// back over an introducing phrase when there is one.
const ADDRESS_WITH_LEAD =
  String.raw`(?:(?:,\s*)?\b(?:located|situated|set|found)\b\s+(?:on|at|in)\s+(?:the\s+)?(?:${NAMEWORD}\s+){0,4})?(?:${ADDRESS_CORE})`

// ── guard-only address patterns ─────────────────────────────────────────────
// Both ADDRESS_CORE street rules need a SUFFIX to fire: a Maltese street word
// (Triq…) or an English one (Street/Road/…). Malta is full of streets that are
// neither — "The Strand", "The Exiles" — where the name IS the street. And the
// house-number part is `\d{1,4}`, so the very common Maltese "number/flat" form
// does not read as one token.
//
// Result, found live on 2026-08-02: "📍 172/1, The Strand, Gzira" — house AND
// flat number — passed the firewall untouched and went out on #2906-052's Page
// posts.
//
// These extra patterns are deliberately NOT added to ADDRESS_CORE: that string
// also drives stripAddresses(), and a rule matching a leading newline would eat
// line breaks out of every ad. Making only the guard stricter cannot corrupt
// text — the worst case is a listing refused for a human to look at, which is
// the right way to fail here.
const GUARD_ONLY_ADDRESS = [
  // "172/1," · "66 / 3," — a house/flat pair followed by a comma. Nothing in
  // normal ad copy looks like this; prices carry a currency and bed counts do
  // not take a slash.
  String.raw`\b\d{1,4}\s*/\s*\d{1,3}\s*,`,
  // "172/1, The Strand" — a suffix-less street name, but ONLY behind a house
  // number. Bare "The …" cannot be the rule: half of Malta's landmarks are
  // named that way, and "close to The Point" (the Tigné mall) is legitimate
  // marketing copy, not an address. The number is what makes it one.
  // Tried BEFORE the plain comma-cutoff pattern below: alternation picks the
  // first branch that matches at a given start position, so on a pin line
  // ("📍 172, The Strand, Gzira") the plain pattern used to fire first and
  // stop at the comma, leaving "The Strand, Gzira" — the exact 2026-08-02
  // leak this guard was written for — untouched. The optional leading 📍
  // lets this branch win that race on pin lines too.
  String.raw`(?:📍\s*)?\d{1,4}(?:\s*/\s*\d{1,3})?\s*,\s*The\s+\p{Lu}[\p{L}'’\-]*`,
  // A pin line that opens with a street number: "📍 172, The Strand". The
  // optional flat/apt infix covers "📍 205 Apt 1B, …" (2026-08-29 #2906-upload)
  // — without it, "Apt 1B" sits between the number and the comma and the
  // number+comma never matches, so the house number survives untouched.
  String.raw`📍\s*\d{1,4}(?:\s*/\s*\d{1,3})?(?:\s*(?:flat|apt|apartment|maisonette|unit|block)\.?\s*(?:no\.?|nru\.?|#)?\s*\d+[a-z]?)?\s*,`,
  // "📍 Luxor, 234" / "📍 Blue Harbour Residence, 17" — a suffix-less
  // building or residence name followed by a unit/house number. Restrict this
  // to pin lines so ordinary prose and measurements remain valid ad copy.
  String.raw`📍\s*\p{L}[\p{L}'’\-]*(?:\s+\p{L}[\p{L}'’\-]*){0,3}\s*,\s*\d{1,4}\b`,
  // "📍 The Strand" — a suffix-less street name with NO number on a pin line.
  // Caught only on pin lines so ordinary prose ("close to The Point")
  // remains valid ad copy. One of these can hide an entire postcode.
  String.raw`📍\s*The\s+\p{Lu}[\p{L}'’\-]+(?:\s+[\p{Lu}][\p{L}'’\-]+){0,3}\b`,
].join('|')

// Returns the first address-looking snippet, or null. Used by the guard.
function findAddress(text) {
  const s = String(text || '')
  const m = new RegExp(ADDRESS_CORE, 'giu').exec(s)
  if (m) return m[0].trim()
  const g = new RegExp(GUARD_ONLY_ADDRESS, 'giu').exec(s)
  return g ? g[0].trim() : null
}

// ── maps-link firewall ───────────────────────────────────────────────────────
// Kev, 2026-09-10: a pasted Google Maps link (or raw lat/lng pin) points at
// the exact door the same way a street address does — same rule, same
// enforcement point. Never let one survive into the public package; it
// belongs only in Package 2 (agent-only), same as the real street address.
const MAPS_LINK_RE = String.raw`(?:https?:\/\/)?(?:www\.)?(?:maps\.google\.[a-z.]{2,6}\/[^\s]*|google\.[a-z.]{2,6}\/maps\/[^\s]*|goo\.gl\/maps\/[^\s]+|maps\.app\.goo\.gl\/[^\s]+)`
// "35.8989, 14.4941" — a signed decimal lat (≤2 int digits) + signed decimal
// lng (≤3 int digits), comma-separated. Tight enough (3+ decimal places
// required on both sides) that a price range or phone-safe digit run never
// collides with it.
const COORD_RE = String.raw`[-+]?\d{1,2}\.\d{3,8}\s*,\s*[-+]?\d{1,3}\.\d{3,8}`

// First maps-link-or-coordinate snippet, or null. Used by the guard.
function findMapsLink(text) {
  const s = String(text || '')
  const m = new RegExp(MAPS_LINK_RE, 'i').exec(s)
  if (m) return m[0].trim()
  const c = new RegExp(COORD_RE).exec(s)
  return c ? c[0].trim() : null
}

// Remove every maps-link/coordinate match, returning the cleaned text plus
// whatever was removed (so callers can carry it into Package 2 instead of
// just discarding it).
function stripMapsLinks(text) {
  const src = String(text || '')
  if (!src.trim()) return { text: src, removed: [] }
  const removed = []
  let out = src.replace(new RegExp(MAPS_LINK_RE, 'gi'), (m) => { removed.push(m.trim()); return ' ' })
  out = out.replace(new RegExp(COORD_RE, 'g'), (m) => { removed.push(m.trim()); return ' ' })
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return { text: out, removed }
}

// Repair the punctuation a removal leaves behind.
function tidyLine(s) {
  return String(s)
    // "…in Gzira, located ." → "…in Gzira."
    .replace(/\b(?:located|situated|set|found)\b(?:\s+(?:on|at|in))?(?:\s+the)?\s*(?=$|[,.;])/gi, '')
    // "📍 , Gzira" → "📍 Gzira"  (before spaces are collapsed onto the comma)
    .replace(/^([^\p{L}\d]*?)\s*[,;:]+\s*/u, '$1 ')
    // Orphaned house number: "39 flat 5 triq …. Modern 2-bedroom …" loses the
    // street and flat but keeps its "39.". Only a number followed by a dot or
    // comma is removed, so a legitimate "3 Bedrooms" opener is untouched — and
    // this only ever runs on a line an address was already cut out of.
    .replace(/^\s*\d{1,4}\s*[.,]\s*/, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    // "Luxor, St Albert Street, Gzira" → "Luxor,, Gzira" once the street is cut
    .replace(/,[\s,]*,/g, ',')
    .replace(/,\s*(?:and|&)\s+/gi, ', ')
    .replace(/([,;:])\s*([.!?])/g, '$2')
    .replace(/\.{2,}/g, '.')
    .replace(/[\s,;:]+$/, '')
    .trim()
}

// Junk separator lines: ".,..", "...", "---", "//". Emoji-only lines are NOT
// in this class and survive.
const JUNK_LINE_RE = /^[\s.,;:!?\-_/\\|*~\p{Extended_Pictographic}]+$/u

// Ad text is typed with typographic apostrophes ("St Paul’s Bay") while the
// town column holds the straight form ("St Paul's Bay"). Without folding them
// together the town match fails and such a line loses its town entirely.
function normQuotes(s) {
  return String(s || '').replace(/[’‘‛´`]/g, "'")
}

// Remove every address match, line by line, keeping the town.
function stripAddresses(text, town) {
  const src = String(text || '')
  if (!src.trim()) return src
  const re = new RegExp(ADDRESS_WITH_LEAD, 'giu')
  // The pin-only stripper keeps `Fort Cambridge`, `The Point`, and other landmark
  // mentions in body copy untouched. It only fires on lines that carry the 📍
  // pin glyph, because real-world ad copy opens with descriptive lines like
  // "Within walking distance of Fort Cambridge" — those are landmarks, not
  // addresses, and the operator wants them to remain in the description.
  const townStr = String(town || '').trim()
  const guardRe = new RegExp(GUARD_ONLY_ADDRESS, 'giu')

  const rows = []
  for (const line of src.split('\n')) {
    if (!line.trim()) { rows.push({ text: '', modified: false }); continue }
    if (JUNK_LINE_RE.test(line)) continue

    let cleaned = line
    let modified = false

    // 1) Pin lines always get the guard patterns stripped, regardless of
    //    whether the line carries a street suffix. Without this, "📍 Luxor, 234"
    //    survives intact and trips the post-strip findAddress() guard.
    if (/📍/.test(line)) {
      guardRe.lastIndex = 0
      cleaned = cleaned.replace(guardRe, ' ')
      modified = true
    }

    // 2) Any line may carry the broader "located on/in" address.
    re.lastIndex = 0
    if (re.test(cleaned)) {
      re.lastIndex = 0
      cleaned = cleaned.replace(re, ' ')
      modified = true
    }

    if (!modified) { rows.push({ text: line, modified: false }); continue }

    cleaned = tidyLine(cleaned)

    if (!/\p{L}/u.test(cleaned)) {
      // Only punctuation left. If the line carried the town, keep just that —
      // "📍 66, Triq Sir Frederick" with no town has nothing worth keeping.
      if (townStr &&
          new RegExp(`\\b${escapeRegExp(normQuotes(townStr))}\\b`, 'i').test(normQuotes(line))) {
        const prefix = (line.match(/^[^\p{L}\d]*/u) || [''])[0].replace(/[\s,;.]+$/, '')
        rows.push({ text: `${prefix} ${townStr}`.trim(), modified: true })
      }
      continue
    }
    rows.push({ text: cleaned, modified: true })
  }

  // A rewritten "📍 66, Triq Sir Frederick, Gzira" becomes "📍 Gzira", which the
  // ad usually already has as its first line. Drop only such rewrites, never an
  // untouched line.
  const seen = new Set()
  const kept = []
  for (const r of rows) {
    const key = r.text.trim().toLowerCase()
    if (r.modified && key && seen.has(key)) continue
    if (key) seen.add(key)
    kept.push(r.text)
  }

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/[\s,;:]+$/, '').trim()
}

// description_public: start from property.description, strip phone-like
// patterns, emails, and the exact street / apt substrings if set.
// Returns { text, mapsLinks } — mapsLinks is whatever the maps-link firewall
// pulled out, so the caller can forward it into Package 2 instead of just
// dropping it on the floor.
function buildPublicDescription(description, street, apt, town) {
  let d = String(description || '')
  d = d.replace(PHONE_RE_G, ' ')
  d = d.replace(EMAIL_RE_G, ' ')
  for (const secret of [street, apt]) {
    const sec = String(secret || '').trim()
    if (sec.length >= 3) {
      d = d.replace(new RegExp(escapeRegExp(sec), 'gi'), ' ')
    }
  }
  // The website reads description_public, so it needs the same address firewall
  // as the social text — the exact-substring loop above does nothing when the
  // street/apt columns are empty.
  d = stripAddresses(d, town)
  const { text: noLinks, removed } = stripMapsLinks(d)
  d = noLinks
  return { text: d.replace(/[ \t]{2,}/g, ' ').replace(/ *\n */g, '\n').trim(), mapsLinks: removed }
}

// ── description_social ───────────────────────────────────────────────────────
// The ad text EXACTLY as it arrived — emojis, line breaks and layout intact —
// with the owner block removed. Facebook and the WhatsApp category groups post
// this; CRM / website / PropertyMarket keep description_public above, which is
// the flattened plain-text version. Same rule as !post: publish what was
// written, minus the owner's private data. Never reformat an ad that was
// written for social media in the first place.
//
// Removal is LINE-BASED: a line carrying a contact label, an email, a bot
// command or one of the OWNER'S OWN phone numbers is dropped whole — half a
// contact line reads worse than none. The owner phones are passed in (already
// extracted) rather than guessed, so prices and sizes survive untouched.
const CONTACT_LABEL_RE =
  /^[\s*_~>-]*(owner|landlord|contact|contacts|tel|telephone|mob|mobile|phone|number|no\.|whats?app|wa|email|e-mail|mail|call|agent|agency)\b\s*[:\-–—]?/i

// "35679123456" → matches "+356 7912 3456", "356-79123456", "79123456".
// Built from the significant tail (last 8 digits) so the country code is
// optional, with any separator allowed between digits.
function ownerPhoneRegexes(phones) {
  const out = []
  for (const raw of (Array.isArray(phones) ? phones : [])) {
    const d = String(raw || '').replace(/\D/g, '')
    if (d.length < 7) continue
    const tail = d.slice(-8)
    out.push(new RegExp(tail.split('').join('[\\s.\\-()]{0,2}'), 'g'))
  }
  return out
}

function buildSocialDescription(raw, street, apt, ownerName, ownerPhones, town) {
  const text = String(raw || '')
  if (!text.trim()) return ''
  const name = String(ownerName || '').trim()
  const phoneRes = ownerPhoneRegexes(ownerPhones)
  const nameOnly = (s) => s.replace(/[^\p{L}\s]/gu, '').replace(/\s+/g, ' ').trim().toLowerCase()

  const kept = []
  for (const line of text.split('\n')) {
    const l = line.trim()
    if (!l) { kept.push(''); continue }
    if (JUNK_LINE_RE.test(l)) continue                           // ".,..", "...", "---" separator
    if (l.startsWith('!')) continue                              // bot command line
    if (CONTACT_LABEL_RE.test(l)) continue                       // "Owner: …", "Tel …"
    if (EMAIL_RE.test(l)) continue                               // any email on the line
    if (phoneRes.some(re => { re.lastIndex = 0; return re.test(l) })) continue   // owner's number
    if (name.length >= 3 && nameOnly(l) === nameOnly(name)) continue             // bare owner name
    kept.push(line)
  }

  let d = kept.join('\n')
  // street / apt anywhere; owner name only as a whole word (so an owner called
  // "Ann" does not gut "Announcement").
  for (const secret of [street, apt]) {
    const sec = String(secret || '').trim()
    if (sec.length >= 3) d = d.replace(new RegExp(escapeRegExp(sec), 'gi'), ' ')
  }
  if (name.length >= 3) d = d.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, 'gi'), ' ')

  // Street / house no. / flat no. out, town kept. Independent of street/apt
  // being set, which they are not on any live row.
  d = stripAddresses(d, town)
  const { text: noLinks, removed: mapsLinks } = stripMapsLinks(d)
  d = noLinks

  d = d.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()

  // Last gate. A social description is a nice-to-have: if anything phone- or
  // email-shaped survived, return NOTHING so the caller degrades to
  // description_public. Throwing here would abort an upload that already has a
  // CRM record, and publishing it would leak — so neither is an option.
  try { assertNoLeaks(d, 'social description') } catch { return { text: '', mapsLinks: [] } }
  return { text: d, mapsLinks }
}

// ── THE firewall ─────────────────────────────────────────────────────────────
// property: the property row (or a merged object with the same field names —
//   both DB names (bedrooms/bathrooms/size_sqm/property_type/ref) and
//   pipeline names (beds/baths/sqm/type/ref_id) are accepted).
// owner: nothing from it is ever RENDERED. Its name/phones are read for one
//   purpose only — removing them from description_social, the same narrow
//   "read the secret to prove it's gone" exception as street/apt. It also
//   exists so callers can't "forget" they are holding owner data.
function sanitizeForPublic(property, owner) { // eslint-disable-line no-unused-vars
  const p = property || {}
  const street = p.street || p.location_street || null
  const apt    = p.apt    || p.location_apt    || null

  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null }

  const features = Array.isArray(p.features) ? p.features.filter(Boolean).map(String) : []
  const imagesRaw = Array.isArray(p.images) ? p.images
    : (typeof p.images === 'string' ? (() => { try { return JSON.parse(p.images) } catch { return [] } })() : [])
  const images = imagesRaw
    .map(i => (typeof i === 'string' ? i : (i && i.url) || null))
    .filter(u => typeof u === 'string' && /^https?:\/\//.test(u))

  const availableDate = (typeof p.available_date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(p.available_date))
    ? p.available_date.slice(0, 10)
    : (p.available_date instanceof Date ? p.available_date.toISOString().slice(0, 10) : null)

  const pub = buildPublicDescription(p.description, street, apt, p.town)
  // owner.name / owner.phones are read for REMOVAL ONLY — the same narrow
  // exception the street/apt assertions below use. Nothing from owner is
  // ever rendered.
  const soc = buildSocialDescription(
    p.description_social, street, apt, owner?.name, owner?.phones, p.town)

  const result = {
    ref_id: p.ref_id || p.ref || null,
    type:   String(p.type || p.property_type || 'apartment').toLowerCase(),
    town:   p.town || null,                        // town only — NOT street, NOT apt no.
    beds:   num(p.beds  ?? p.bedrooms),
    baths:  num(p.baths ?? p.bathrooms),
    sqm:    num(p.sqm   ?? p.size_sqm),
    longlet_price:      num(p.longlet_price),
    sale_price:         num(p.sale_price),
    shortlet_available: !!(p.shortlet_available ?? p.shortlet),
    available_date:     availableDate,
    available_status:   p.available_status || 'available',
    // Social/group channels post this when present (see categoryFormatter).
    description_public: pub.text,
    description_social: soc.text,
    features,
    images,
    // Any Google Maps link / raw coordinate the owner pasted, pulled out of
    // the ad text by the maps-link firewall above — NOT in categoryFormatter's
    // PUBLIC_FIELDS whitelist, so the public package structurally cannot read
    // it. categoryPublisher.js reads this to carry it into Package 2
    // (agent-only), the same place the real street address lives.
    maps_links: [...new Set([...pub.mapsLinks, ...soc.mapsLinks])],
  }

  // ── hard leak assertions — throw, never return a leaking payload ───────────
  const serialized = JSON.stringify(result)
  if (PHONE_RE.test(serialized) && !containsOnlyPriceNumbers(serialized)) {
    throw new Error('SANITIZER: possible phone number leaked into public payload')
  }
  if (EMAIL_RE.test(stripSafePatterns(serialized))) {
    throw new Error('SANITIZER: email leaked into public payload')
  }
  // Address / maps-link patterns in the built text. This is the check that
  // actually bites: the exact-substring loop below is a no-op whenever
  // street/apt are unset, and in the live DB they always are.
  for (const [field, text] of [
    ['description_social', result.description_social],
    ['description_public', result.description_public],
  ]) {
    const addr = findAddress(text)
    if (addr) {
      throw new Error(`SANITIZER: address "${addr}" survived into ${field}`)
    }
    const mapsLink = findMapsLink(text)
    if (mapsLink) {
      throw new Error(`SANITIZER: maps link "${mapsLink}" survived into ${field}`)
    }
  }

  // street/apt must not survive anywhere in the payload
  for (const secret of [street, apt]) {
    const sec = String(secret || '').trim()
    if (sec.length >= 3 && serialized.toLowerCase().includes(sec.toLowerCase())) {
      throw new Error('SANITIZER: street/apt leaked into public payload')
    }
  }

  return result
}

module.exports = {
  sanitizeForPublic, assertNoLeaks, containsOnlyPriceNumbers, stripSafePatterns,
  buildSocialDescription, buildPublicDescription,
  findAddress, stripAddresses,
  findMapsLink, stripMapsLinks,
}
