'use strict'
// ============================================================================
// categoryFormatter.js — format a property for a category-group message.
//
// formatForCategoryGroup(publicPayload) → string
//
// ONE parameter only — enforced by signature. This module has NO access to the
// property row or the owner row, so it structurally cannot read a phone, an
// email, a street or an apartment number: it only ever reads the whitelisted
// public fields listed in PUBLIC_FIELDS below.
//
// Before returning, it ASSERTS on the final string:
//   phone pattern found → throw
//   email found         → throw
// Failing loudly is correct. A leaked owner number is worse than no post.
//
// street/apt: the one-parameter rule means the exact street/apt strings are not
// available here (they live on the property row). sanitizeForPublic() already
// strips them and throws if they survive into public_payload. As defence in
// depth, assertNoOwnerDataLeak() is exported for the publisher — which DOES
// hold the row — to re-check the FINAL rendered message against the real
// street/apt right before sending. See categoryPublisher.js.
// ============================================================================

const { assertNoLeaks, findAddress, findMapsLink } = require('./sanitizer')
// Kev, 2026-09-09 (KANONISCHES PROPERTY-TEMPLATE spec, STIL-REGELN: "NIEMALS
// Bindestriche/Gedankenstriche"). This filter already existed (STYLE-1) but
// was only ever applied at conversational-send time (owner/client replies) --
// clientAssistant.js's propertyFactLine() happened to be covered because ITS
// caller wraps every send in stripEmDash, but categoryPublisher.js (WhatsApp
// property groups), fbShareQueue.js (FB group share), facebookCampaign.js (FB
// Page posts) and agentApartmentRequest.js (agenttag caption) all call this
// module directly and never ran the result through it. Applying it once here,
// on the final rendered string in the one function every one of those five
// callers shares, closes that gap for all of them at once instead of
// patching each publisher individually.
const { stripEmDash } = require('./styleLearning')
const { leaseLine } = require('./rentalModes')

// The only fields this formatter is allowed to read out of the payload.
const PUBLIC_FIELDS = [
  'ref_id', 'type', 'town', 'beds', 'baths', 'sqm',
  'longlet_price', 'sale_price', 'available_date',
  // Owner-Kadenz #4 (Kev, 2026-09-10) — longlet termination date, the
  // board's "Bis" button. A listing lifecycle fact, not owner data, same
  // class as available_date already on this list.
  'available_until',
  // Rental modes (2026-09-21) — listing lifecycle facts, same class as available_until
  'rental_modes', 'lease_type', 'shortlet',
  'description_social', 'description_public',
  'features',
]

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function fmtPrice(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return null
  // thousands separator, no decimals: 2500 → 2,500
  return v.toLocaleString('en-GB', { maximumFractionDigits: 0 })
}

// Fallback one-liner for the rare payload with no description at all. Without
// this an empty description would post nothing but a ref stamp.
function fallbackHeadline(p) {
  const town  = p.town || 'Malta'
  const beds  = Number(p.beds) || 0
  const type  = String(p.type || '').toLowerCase()
  const bedsTxt = (beds === 0 || type === 'studio')
    ? 'Studio'
    : `${beds} bedroom${beds === 1 ? '' : 's'}`
  const longlet = fmtPrice(p.longlet_price)
  const sale    = fmtPrice(p.sale_price)
  const price = longlet ? ` — €${longlet}/month` : sale ? ` — €${sale}` : ''
  return `${bedsTxt} in ${town}${price}`
}

// Kev, 2026-09-07 (source-of-truth bug: an agent moved a listing's date in
// the dashboard, but every repost kept showing the OLD month because the ad
// text was frozen at upload time — see categoryPublisher.js loadProperty,
// which now reads `available_date` fresh off the properties row on every
// call instead of only the frozen public_payload snapshot). The raw ad copy
// itself is still posted AS-IS (see the comment on formatForCategoryGroup
// below — reformatting a human-written ad is still the wrong move), but the
// one authoritative fact this file CAN state correctly, computed fresh on
// every render rather than baked in once, is added as its own line so a
// stale date in the original copy is never the only thing a reader sees.
function availabilityLine(availableDate) {
  if (!availableDate) return null
  const d = new Date(availableDate)
  if (Number.isNaN(d.getTime())) return null
  if (d.getTime() <= Date.now()) return null // already available — nothing to add
  const formatted = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  return `📅 Available from ${formatted}`
}

// Kev, 2026-09-16 (WINTER tag, spec item 2): a longlet with a set
// termination date ("Bis" button, Owner-Kadenz #4) was going out with the
// exact same wording as a normal, year-round longlet — agents reading only
// the public ad copy had no way to tell. Same live-computed-on-every-render
// principle as availabilityLine() above (never baked into frozen ad text),
// month-only per Kev's own "until April" example — a season fact for
// whoever's reading, not a to-the-day deadline. No hyphen (STYLE-1).
function winterLine(availableUntil) {
  // kept for callers that only have the date; the wording lives in ONE place now
  // (services/rentalModes.js:leaseLine — also handles winter/short modes)
  return leaseLine({ available_until: availableUntil })
}

// The lease facts a description must reflect, read LIVE from the property row —
// never from the frozen public_payload snapshot (2026-09-21). Every output path
// that renders from a payload (category groups, Facebook page + groups, the
// agent-request caption, the website sync) merges this over it, so a "Bis" date or
// a rental mode set AFTER upload still reaches the text. Only keys the row actually
// carries are returned, so a caller whose SELECT lacks a column changes nothing.
function liveLeasePatch(row) {
  const out = {}
  if (!row) return out
  for (const k of ['available_until', 'rental_modes', 'lease_type', 'shortlet']) if (row[k] !== undefined) out[k] = row[k]
  return out
}

// Two-package property-group output (Kev, 2026-09-08). Restriction lines
// ("🚫 No Pets", "🚫 No Sharing", "🚫 Not Pet Friendly") are how every
// existing ad already writes this — confirmed against real live listings
// (2906-150 and others) before picking the pattern, not assumed. They move
// out of the public package entirely and into the agent-only one built by
// formatAgentPackage below; this function strips them, nothing else in the
// ad copy is touched.
const RESTRICTION_LINE_RE = /^\s*🚫.*$/gm
function splitRestrictions(text) {
  const raw = String(text || '')
  const restrictions = (raw.match(RESTRICTION_LINE_RE) || []).map(l => l.trim()).filter(Boolean)
  const body = raw.replace(RESTRICTION_LINE_RE, '').replace(/\n{3,}/g, '\n\n').trim()
  return { body, restrictions }
}

// The description is written for social media already — post it AS-IS and only
// stamp the ref underneath. No 📍/💰/✨ template, no feature bullets: reformatting
// a human-written ad makes it worse, not better. The availability line below
// is the one exception — it is computed fresh from the live property record on
// every call, never copied from the frozen ad text, specifically so it cannot
// go stale the way the ad copy's own wording can.
//
// description_social is the ad EXACTLY as it arrived (emojis and layout intact,
// owner block removed) and is what social channels want. description_public is
// the flattened plain-text version built for CRM / website / PropertyMarket —
// used here only as a fallback when no social text survived sanitization.
//
// Kev, 2026-09-08: this function is shared by FIVE callers — categoryPublisher.js
// (WhatsApp property groups), fbShareQueue.js (FB group direct-share),
// facebookCampaign.js (FB Page posts) and agentApartmentRequest.js (the
// agenttag caption) — and the two-package property-group split (restriction
// lines moved to a second, agent-only message) is explicitly scoped to
// property groups ONLY ("Website, CRM-Beschreibung, Facebook bleiben
// UNVERÄNDERT"). Restriction-stripping therefore does NOT happen in here —
// it would silently strip "No Pets"/"No Sharing" off every FB post and
// agenttag caption too. categoryPublisher.js does its own
// splitRestrictions() pass on the raw text before it ever reaches this
// function, so what arrives here for the WhatsApp property-group path is
// already restriction-free; every other caller still gets the ad text
// completely untouched, exactly as before.
function formatForCategoryGroup(publicPayload) {
  // Read ONLY whitelisted fields — anything else in the payload is ignored.
  const p = {}
  for (const f of PUBLIC_FIELDS) p[f] = (publicPayload || {})[f]

  const desc = String(p.description_social || '').trim() ||
               String(p.description_public || '').trim()
  const body = desc || fallbackHeadline(p)

  const lines = [body]
  const avail = availabilityLine(p.available_date)
  if (avail) lines.push('', avail)
  const winter = leaseLine(p)
  if (winter) lines.push('', winter)
  if (p.ref_id) lines.push('', `REF #${p.ref_id}`)

  const message = stripEmDash(lines.join('\n').replace(/\n{3,}/g, '\n\n').trim())

  // ── hard leak assertions on the FINAL string — throw, never return a leak ──
  try {
    assertNoLeaks(message, 'category group message')
  } catch (e) {
    throw new Error(`categoryFormatter: ${e.message}`)
  }
  // Every channel renders through here, so this one line is what makes the
  // address firewall cover category groups, the website and Facebook equally —
  // rather than only whichever publisher remembered to re-check.
  const addr = findAddress(message)
  if (addr) {
    throw new Error(`categoryFormatter: address "${addr}" in category group message`)
  }
  // Kev, 2026-09-10: same rule as the address above, extended to Google Maps
  // links / raw coordinates — a pin is exactly as precise as a street. This
  // is defence in depth: sanitizeForPublic() already strips these out of
  // description_social/public at upload time, but a listing uploaded before
  // this fix could still carry one baked into its frozen public_payload —
  // fail loudly here rather than let it reach the public package.
  const mapsLink = findMapsLink(message)
  if (mapsLink) {
    throw new Error(`categoryFormatter: maps link "${mapsLink}" in category group message`)
  }

  return message
}

// Compact availability label for Package 2 ("Now" / "Early/Mid/End <Month>")
// — Kev's own worked example ("Available: End November") for a date late in
// the month; the day-of-month simply buckets which third of the month it
// falls in. Same live-computed-on-every-render principle as
// availabilityLine() above — never copied from frozen ad text.
// Kev, 2026-09-08 (real bug, live on #2906-9193): a NULL date used to fall
// back to "Now" -- factually wrong when nothing has actually been confirmed
// (Kev's own words: "wenn keine einheiten da sind, das macht ja kein
// sinn"). Missing data reads as "Soon" instead; a genuinely-set date in the
// past still correctly means "available since then" -> "Now" (that branch
// is unchanged) -- this only touches the "we don't actually know" case.
// Reused for BOTH available_date and viewing_date (see buildAgentMessage in
// categoryPublisher.js) -- the label logic itself is identical for either
// kind of date, no need for a second copy.
function availableLabel(availableDate) {
  if (!availableDate) return 'Soon'
  const d = new Date(availableDate)
  if (Number.isNaN(d.getTime())) return 'Soon'
  if (d.getTime() <= Date.now()) return 'Now'
  const day = d.getUTCDate()
  const part = day <= 10 ? 'Early' : day <= 20 ? 'Mid' : 'End'
  const month = d.toLocaleDateString('en-GB', { month: 'long' })
  return `${part} ${month}`
}

// ── Package 2: agent-only details (Kev, 2026-09-08) ─────────────────────────
// The one deliberate exception to this file's "no owner data" contract —
// EXPLICITLY carries the real address, by design, and is ONLY ever handed
// to categoryPublisher.js for the property-group send (the audience is the
// same agents already in that group). Never call this for the website/CRM
// public description/Facebook — those keep the single locality-only package
// formatForCategoryGroup above already produces. Callers pass the address
// pre-resolved (exact street, or the locality fallback) — this function
// does not decide that choice, categoryPublisher.js does, since it is the
// one holding the property row.
function formatAgentPackage({ ref_id, restrictions = [], address, viewingsLabel, availableLabel, mapsLinks = [] }) {
  const lines = []
  if (restrictions.length) lines.push(...restrictions, '')
  if (address) lines.push(`📍 ${address}`, '')
  // Kev, 2026-09-10: a maps link the owner pasted into the ad — pulled out of
  // the public text by sanitizeForPublic's maps-link firewall (services/
  // sanitizer.js) — lands here, never in Package 1. Same audience/rationale
  // as the real address two lines above.
  for (const link of mapsLinks) lines.push(`🗺️ ${link}`)
  if (mapsLinks.length) lines.push('')
  const bits = []
  if (viewingsLabel) bits.push(`Viewings: ${viewingsLabel}`)
  if (availableLabel) bits.push(`Available: ${availableLabel}`)
  if (bits.length) lines.push(bits.join(' / '))
  if (ref_id) lines.push('', `#${ref_id}`)

  const message = stripEmDash(lines.join('\n').replace(/\n{3,}/g, '\n\n').trim())

  // Same phone/email guard as the public package — address is intentional
  // here, but an owner's private phone/email must never leak into this
  // package either, same bar as everywhere else.
  try {
    assertNoLeaks(message, 'category group agent-details message')
  } catch (e) {
    throw new Error(`categoryFormatter: ${e.message}`)
  }
  return message
}

// Defence in depth for the publisher, which holds the property row.
//
// The `secrets` loop below used to be the whole check, and it was worthless:
// callers pass { street: row.street, apt: row.apt }, and both columns are NULL
// on every row in the live DB, so every value was shorter than 3 chars and the
// loop did nothing. Listings carrying "📍 66, Triq Sir Frederick, Gzira" sailed
// straight through it.
//
// So the PRIMARY check is now a pattern scan of the outgoing text itself, which
// needs nothing from the DB. The exact-secret loop stays as a bonus for callers
// that do have the columns populated — but nothing depends on them any more.
function assertNoOwnerDataLeak(message, secrets = {}) {
  const s = String(message || '')
  assertNoLeaks(s, 'category group message')

  const addr = findAddress(s)
  if (addr) {
    throw new Error(`categoryFormatter: address leaked into category group message: "${addr}"`)
  }

  for (const [label, value] of Object.entries(secrets)) {
    const sec = String(value || '').trim()
    // Kev, 2026-09-02: this used to substring-match the RAW secret against
    // the message, full stop — and that fired on #2906-9147 ("Belmonte
    // Heights") every single time !recategorize retried it, identically. The
    // owner's own ad text names the building ("penthouse in Belmonte
    // Heights") — completely normal Malta listing copy, not a leak. A bare
    // building/complex name carries no house/unit number, so it does not
    // point at a specific door the way a real street address does. Gate the
    // substring check on the secret ITSELF reading as a genuine address
    // (findAddress — the same street-noun/number pattern used on the message
    // above) so a real "66, Triq Sir Frederick"-style street is still
    // caught, but a landmark name the ad already mentions publicly is not.
    if (sec.length >= 3 && findAddress(sec) && new RegExp(escapeRegExp(sec), 'i').test(s)) {
      throw new Error(`categoryFormatter: ${label} leaked into category group message`)
    }
  }
  return true
}

module.exports = { formatForCategoryGroup, formatAgentPackage, splitRestrictions, availableLabel, assertNoOwnerDataLeak, PUBLIC_FIELDS, availabilityLine, winterLine, liveLeasePatch }
