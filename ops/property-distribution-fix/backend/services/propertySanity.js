'use strict'
// ============================================================================
// services/propertySanity.js — ONE shared property-fact validator (Phase 1,
// ARGUS stabilization pass, 2026-09-17).
//
// Never throws, never mutates, never silently substitutes a value.
// Distinguishes:
//   KNOWN_VALUE  — a plausible, usable number/date/enum
//   UNKNOWN      — nothing usable; callers must NOT guess a default
//   SUSPICIOUS   — a value that parsed fine but looks wrong for context
//                  (28 bathrooms, a year where a price should be, an
//                  absurd sqm). This is a SANITY TRIGGER, not proof the
//                  value is wrong — a genuinely large property is real; the
//                  caller decides whether to block, flag for review, or
//                  just log it. UNKNOWN is always preferred over a WRONG
//                  guessed value.
//   LOW_CONFIDENCE — parsed and usable, but from a weaker signal (an
//                  unrecognized enum token, e.g.) that a human should see.
//
// Deliberately does NOT resolve the beds-vs-bedrooms ambiguity itself —
// categoryClassifier.js's bedroomStatus() already owns that distinction
// (KNOWN_VALUE/UNKNOWN/CONFLICTING/LOW_CONFIDENCE) for routing purposes.
// This module is the general canonical-fact sanity layer meant to be
// called from every ingestion path: owner-chat intake, website ingestion,
// manual CRM edit, agent upload (!upload/!upload5), property publishing,
// Base Inventory promotion, Match Engine eligibility.
//
// Semantic rule enforced throughout: Beds != Bedrooms, Rooms != Bedrooms,
// Guests != Bedrooms, Persons != Bedrooms — callers must pass the field
// they actually mean; this module never reads a 'guests'/'persons'/'rooms'
// key as a bedroom count.
// ============================================================================

function validateBedrooms(value) {
  if (value === null || value === undefined || value === '') return { status: 'UNKNOWN', value: null }
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return { status: 'UNKNOWN', value: null, note: 'non-numeric bedrooms value discarded' }
  if (n > 12) return { status: 'SUSPICIOUS', value: n, note: `${n} bedrooms is unusually high — re-check source context before trusting` }
  return { status: 'KNOWN_VALUE', value: n }
}

// Room sanity (spec item 6): bedrooms/bathrooms > 5 on a normal residential
// monthly rent (< €5,000) is a SANITY TRIGGER, not automatic rejection. An
// explicit, reliable source saying "6 bedrooms" is allowed through as
// SUSPICIOUS (still usable), never silently downgraded or blocked here —
// callers (e.g. the publish gate) decide whether SUSPICIOUS blocks.
function validateBathrooms(value, { monthlyRent } = {}) {
  if (value === null || value === undefined || value === '') return { status: 'UNKNOWN', value: null }
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return { status: 'UNKNOWN', value: null, note: 'non-numeric bathrooms value discarded' }
  const rent = Number(monthlyRent) || 0
  if (n > 5 && rent > 0 && rent < 5000) {
    return { status: 'SUSPICIOUS', value: n, note: `${n} bathrooms on a €${rent}/mo listing is unusual — re-check source context; UNKNOWN is safer than a guessed 1 or 2` }
  }
  return { status: 'KNOWN_VALUE', value: n }
}

// Year/date values must never silently become a price — the classic
// extraction bug (e.g. "2026" or an ISO date fragment parsed as €).
//
// NOTE on the year-range trap: an earlier version of this function flagged
// any bare 1900-2100 value as "looks like a year". That's actively wrong
// for THIS market — €1,900-2,100/month is squarely inside normal-to-luxury
// Malta rent territory (categoryClassifier.js's own luxury threshold is
// exactly €2,000/€2,500) — so it would have flagged a large fraction of
// genuinely correct prices as suspicious, training everyone to ignore the
// warning. Caught by this module's own regression test before ever
// shipping. A bare number cannot reliably distinguish "€2026/month" from
// "the year 2026" without the SOURCE TEXT context (was it next to a
// currency symbol? a date word?) — that disambiguation belongs in the
// specific extraction pipeline (owner-chat NLU, website scrapers), which
// has that context; this generic validator only catches values far outside
// any plausible price, not this fundamentally ambiguous middle ground.
function validatePrice(value, { unit = 'month' } = {}) {
  if (value === null || value === undefined || value === '') return { status: 'UNKNOWN', value: null }
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return { status: 'UNKNOWN', value: null, note: 'non-numeric or non-positive price discarded' }
  if (unit === 'month' && n > 20000) return { status: 'SUSPICIOUS', value: n, note: `€${n}/month is unusually high — verify` }
  if (unit === 'night'  && n > 2000)  return { status: 'SUSPICIOUS', value: n, note: `€${n}/night is unusually high — verify` }
  return { status: 'KNOWN_VALUE', value: n }
}

function validateDate(value) {
  if (!value) return { status: 'UNKNOWN', value: null }
  const d = new Date(value)
  if (isNaN(d.getTime())) return { status: 'UNKNOWN', value: null, note: 'unparseable date discarded' }
  const now = new Date()
  const yearsOut = (d.getTime() - now.getTime()) / (365.25 * 24 * 3600 * 1000)
  if (yearsOut > 3 || yearsOut < -3) {
    return { status: 'SUSPICIOUS', value: d.toISOString().slice(0, 10), note: 'date is more than 3 years from today — verify it was not mis-parsed' }
  }
  return { status: 'KNOWN_VALUE', value: d.toISOString().slice(0, 10) }
}

function validateSqm(value) {
  if (value === null || value === undefined || value === '') return { status: 'UNKNOWN', value: null }
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return { status: 'UNKNOWN', value: null }
  if (n < 15 || n > 1000) return { status: 'SUSPICIOUS', value: n, note: `${n} sqm is unusual for a residential rental — verify` }
  return { status: 'KNOWN_VALUE', value: n }
}

const LEASE_TYPES = new Set(['long_let', 'winter_let', 'short_let', 'flexible'])
function validateLeaseType(value) {
  if (!value) return { status: 'UNKNOWN', value: null }
  const v = String(value).toLowerCase().trim()
  if (!LEASE_TYPES.has(v)) return { status: 'SUSPICIOUS', value: v, note: `unrecognized lease type "${v}"` }
  return { status: 'KNOWN_VALUE', value: v }
}

const PROPERTY_TYPES = new Set([
  'apartment', 'flat', 'studio', 'penthouse', 'maisonette', 'duplex',
  'villa', 'house', 'bungalow', 'townhouse', 'detached', 'farmhouse',
])
function validatePropertyType(value) {
  if (!value) return { status: 'UNKNOWN', value: null }
  const v = String(value).toLowerCase().trim()
  if (!PROPERTY_TYPES.has(v)) return { status: 'LOW_CONFIDENCE', value: v, note: `unrecognized property type "${v}" — not in the known type list, but not blocked` }
  return { status: 'KNOWN_VALUE', value: v }
}

// Validates a property-like payload and returns a report. Read-only —
// callers decide what to do with SUSPICIOUS/UNKNOWN results (block, flag
// for Base-Inventory-style review, or just surface a warning).
function validateProperty(payload) {
  const p = payload || {}
  const price = validatePrice(p.longlet_price ?? p.price, { unit: p.price_unit || 'month' })
  const fields = {
    bedrooms: validateBedrooms(p.bedrooms ?? p.beds),
    bathrooms: validateBathrooms(p.bathrooms, { monthlyRent: price.value }),
    price,
    sqm: validateSqm(p.size_sqm ?? p.sqm),
    availableDate: validateDate(p.available_date),
    leaseType: validateLeaseType(p.lease_type),
    propertyType: validatePropertyType(p.property_type ?? p.type),
  }
  const suspicious = Object.entries(fields).filter(([, r]) => r.status === 'SUSPICIOUS').map(([k]) => k)
  const unknown = Object.entries(fields).filter(([, r]) => r.status === 'UNKNOWN').map(([k]) => k)
  return { fields, suspicious, unknown, hasSuspicious: suspicious.length > 0 }
}

module.exports = {
  validateBedrooms, validateBathrooms, validatePrice, validateDate, validateSqm,
  validateLeaseType, validatePropertyType, validateProperty,
}
