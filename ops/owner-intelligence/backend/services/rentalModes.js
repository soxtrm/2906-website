'use strict'
// ============================================================================
// services/rentalModes.js — rental modes (LONG_LET / WINTER_LET / SHORT_LET).
// One source for: what a property's modes ARE, how they are classified from an
// upload, and how they read in the public description.
//
// A property may have SEVERAL modes at once (a Nov–Apr apartment can be a winter
// let and a short let). Modes are separate from availability/status and from
// property type. Nothing is migrated: `properties.rental_modes` is NULL for every
// existing row and the modes are DERIVED from the legacy single `lease_type`
// (or `shortlet`) — so old rows stay valid and read exactly as before. Once
// rental_modes is set explicitly it wins, and `lease_type` is kept in step so the
// older readers (propertySanity, notificationEngine, the CRM shape) keep working.
// ============================================================================

const MODES = ['long_let', 'winter_let', 'short_let']
const LABELS = { long_let: 'Long let', winter_let: 'Winter let', short_let: 'Short let' }

const ALIASES = {
  long: 'long_let', longlet: 'long_let', long_let: 'long_let', 'long-let': 'long_let', 'long let': 'long_let',
  winter: 'winter_let', winterlet: 'winter_let', winter_let: 'winter_let', 'winter-let': 'winter_let', 'winter let': 'winter_let',
  short: 'short_let', shortlet: 'short_let', short_let: 'short_let', 'short-let': 'short_let', 'short let': 'short_let',
}

// array | JSON string | comma string → ordered, de-duplicated, valid modes only
function normalizeModes(input) {
  let arr = input
  if (typeof input === 'string') {
    const s = input.trim()
    if (!s) return []
    try { const j = JSON.parse(s); arr = Array.isArray(j) ? j : s.split(',') } catch { arr = s.replace(/^{|}$/g, '').split(',') }
  }
  if (!Array.isArray(arr)) return []
  const set = new Set(arr.map(x => ALIASES[String(x || '').trim().toLowerCase().replace(/"/g, '')]).filter(Boolean))
  return MODES.filter(m => set.has(m))
}

// Kev, 2026-09-23: "Wenn etwas Winter-Property ist, ist sie auch immer gleich
// Short, halt nur zu verschiedenen Zeiten" — a winter let is let to winter
// tenants off-season and runs as a short let in season (Malta: April–November).
// So winter_let IMPLIES short_let for every reader that asks what a property
// can be booked as (board tabs/filters, the calendar connect for dual-use
// listings). The public ad line (leaseLine) keeps reading only what was
// explicitly set, so no live ad text changes by itself.
const SHORT_LET_SEASON = { fromMonth: 4, toMonth: 11 }   // April–November
const WINTER_LET_SEASON = { fromMonth: 12, toMonth: 3 }  // the rest of the year

// What the row is, whether or not rental_modes was ever set.
function effectiveModes(row, { implied = true } = {}) {
  const r = row || {}
  const explicit = normalizeModes(r.rental_modes)
  const base = explicit.length ? explicit
    : [ALIASES[String(r.lease_type || '').toLowerCase()] || (r.shortlet ? 'short_let' : 'long_let')]
  if (implied && base.includes('winter_let') && !base.includes('short_let')) return normalizeModes([...base, 'short_let'])
  return base
}

// Is this property double-used (winter + short)? Those are the ones whose
// external calendars (Airbnb / Booking.com iCal) must be connected.
function isDualUse(row) {
  const m = effectiveModes(row)
  return m.includes('short_let') && (m.includes('winter_let') || m.includes('long_let'))
}

// Which mode a winter/short property is CLASSIFIED as in a given month (1-12).
// Classification only — it never means the owner confirmed short-stay
// availability, rates or booking permission for that month.
function seasonModeFor(row, month) {
  const m = effectiveModes(row)
  if (!m.includes('winter_let')) return m[0]
  const inShort = month >= SHORT_LET_SEASON.fromMonth && month <= SHORT_LET_SEASON.toMonth
  return inShort ? 'short_let' : 'winter_let'
}

// The single legacy value for readers that only know one: the broadest mode wins
// (long > winter > short), so a property that is winter AND short stays on the
// board (only a pure short let is hidden there — Kev, 2026-09-16).
function legacyLeaseType(modes) {
  const m = normalizeModes(modes)
  if (m.includes('long_let')) return 'long_let'
  if (m.includes('winter_let')) return 'winter_let'
  if (m.includes('short_let')) return 'short_let'
  return 'long_let'
}

// SQL for "the effective modes of alias a" — same derivation as effectiveModes().
function sqlEffectiveModes(a = 'p') {
  const base = `COALESCE(NULLIF(${a}.rental_modes, '{}'::text[]), ARRAY[COALESCE(${a}.lease_type, CASE WHEN ${a}.shortlet THEN 'short_let' ELSE 'long_let' END)])`
  // winter_let implies short_let (see effectiveModes)
  return `(CASE WHEN ${base} @> ARRAY['winter_let']::text[] AND NOT ${base} @> ARRAY['short_let']::text[]
                THEN ${base} || ARRAY['short_let']::text[] ELSE ${base} END)`
}
// SQL for a list filter: rows whose effective modes include the requested one
function sqlHasMode(a, paramIdx) { return `${sqlEffectiveModes(a)} @> ARRAY[$${paramIdx}]::text[]` }

// ── classification from EXPLICIT evidence only ──────────────────────────────
// Returns { modes, evidence: { mode: '<the words>' } }. Nothing matched → modes
// [] (left unset for a person to set; never guessed). A negated mention ("no short
// lets", "not a winter let") is not evidence for the mode.
const NEG_BEFORE = /\b(?:no|not|without|never|non|isn'?t|aren'?t|don'?t)\s+(?:a\s+|an\s+|any\s+|for\s+)?$/i
const RULES = {
  winter_let: [
    /\bwinter[\s-]*(?:lets?|letting|rentals?|rent|leases?|contracts?|season|months?|period)\b/ig,
    /\b(?:let|rent(?:al)?|lease)\w*\s+(?:for|over|during|through|in)\s+(?:the\s+)?winter\b/ig,
    // Owner/agent ads often describe the season without naming it: "from
    // now until April".  This is explicit limited winter-season evidence,
    // not a generic end date.  Requiring "from now" (or "available now")
    // plus a normal winter cut-off month avoids turning an ordinary
    // "available until April" sentence into WINTER by accident.
    /\b(?:available\s+)?from\s+now\s+(?:through|until|till|to)\s+(?:the\s+)?(?:end\s+of\s+)?(?:march|april|may)\b/ig,
    /\bavailable\s+now\s+(?:through|until|till|to)\s+(?:the\s+)?(?:end\s+of\s+)?(?:march|april|may)\b/ig,
  ],
  short_let: [
    /\bshort[\s-]*(?:lets?|letting)\b/ig,
    /\bshort[\s-]*term\s+(?:lets?|rentals?|rent|leases?|stays?)\b/ig,
    /\bholiday\s+(?:lets?|rentals?|apartments?|flats?)\b/ig,
    /\b(?:per\s+night|nightly|weekly\s+rate|daily\s+rate|airbnb)\b/ig,
  ],
  long_let: [
    /\blong[\s-]*(?:term|lets?|letting)\b/ig,
    /\b(?:12|twelve)[\s-]*months?\b/ig,
    /\b(?:1|one)[\s-]*year\b/ig,
    /\b(?:yearly|annual)\s+(?:contract|lease|let|rent)\b/ig,
  ],
}
function classifyFromText(text) {
  const t = String(text || '')
  const modes = [], evidence = {}
  for (const mode of MODES) {
    for (const re of RULES[mode]) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(t))) {
        const before = t.slice(Math.max(0, m.index - 22), m.index)
        if (NEG_BEFORE.test(before)) continue
        modes.push(mode)
        evidence[mode] = t.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20).replace(/\s+/g, ' ').trim()
        break
      }
      if (evidence[mode]) break
    }
  }
  return { modes, evidence }
}

// ── the public description line ─────────────────────────────────────────────
// No hyphen (STYLE-1). A dated end always reads "until <Month>" — that is the
// fact agents were missing. With NO date, only a mode that is not plain long let
// says anything.
function monthName(until) {
  if (!until) return null
  const d = until instanceof Date ? until : new Date(String(until).length === 10 ? `${until}T00:00:00Z` : until)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' })
}
function leaseLine(row) {
  const modes = effectiveModes(row, { implied: false })
  const month = monthName(row && row.available_until)
  const winter = modes.includes('winter_let'), short = modes.includes('short_let'), long = modes.includes('long_let')
  if (month) {
    if (winter && short) return `❄️ Winter let and short let, available until ${month}`
    if (short && !winter && !long) return `🕒 Short let, available until ${month}`
    return `❄️ Winter let, available until ${month}`          // any dated end = a limited term (legacy behaviour kept)
  }
  if (long) return winter ? '❄️ Also available as a winter let' : null
  if (winter && short) return '❄️ Winter let and short let'
  if (winter) return '❄️ Winter let'
  if (short) return '🕒 Short let'
  return null
}

module.exports = {
  MODES, LABELS, normalizeModes, effectiveModes, legacyLeaseType, isDualUse, seasonModeFor,
  SHORT_LET_SEASON, WINTER_LET_SEASON,
  sqlEffectiveModes, sqlHasMode, classifyFromText, leaseLine, monthName,
}
