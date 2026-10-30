'use strict'
// ============================================================================
// services/reminderParse.js — PURE date/argument parsers for the reminder
// service. No DB, no time-of-day, no env. Extracted from reminderService.js
// so the contract can be pinned in test/reminderParse.test.js without the
// heavy pg/logger/loader graph that reminderService.js pulls in.
//
// Pre-Phase-5 surface (preserved verbatim from reminderService.js):
//   YYYY-MM-DD, +Xdays, tomorrow, next week, next month
//   PHONE DATE NOTE arg parser (the front-end of `!remind PHONE DATE NOTE`)
// Phase-5 additions:
//   Month-only: "in September", "September", "September 2026",
//               "end of August", "Anfang/Mitte/Ende <Monat>"
//   Relative: "in 3 weeks" (in N weeks), "in N months"
//   "by YYYY-MM-DD" alias
//   Same-day relative: "in 5 days"
// ============================================================================

// English + German month names. The list is in a fixed order so the parser
// stops at the first match. Lower-case lookup keeps the call site case-
// insensitive; the caller does not need to normalise the input string.
const MONTHS = {
  january: 0, jan: 0, januar: 0,
  february: 1, feb: 1, februar: 1,
  march: 2, mar: 2, märz: 2, marz: 2,
  april: 3, apr: 3,
  may: 4, mai: 4,
  june: 5, jun: 5, juni: 5,
  july: 6, jul: 6, juli: 6,
  august: 7, aug: 7,
  september: 8, sep: 8, sept: 8,
  october: 9, oct: 9, okt: 9, oktober: 9, otober: 9,
  november: 10, nov: 10,
  december: 11, dec: 11, dez: 11, dezember: 11,
}

function monthIndex(s) {
  const key = String(s || '').toLowerCase().replace(/[ä]/g, 'a').replace(/[ö]/g, 'o').replace(/[ü]/g, 'u').replace(/[ß]/g, 's')
  return Object.prototype.hasOwnProperty.call(MONTHS, key) ? MONTHS[key] : -1
}

function clampDay(year, month, day) {
  // Avoids "Sep 31" silently rolling into Oct 1. We pin to the month's last day.
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return Math.min(day, last)
}

function startOfToday(now) {
  const t = new Date(now || new Date())
  t.setUTCHours(0, 0, 0, 0)
  return t
}

function makeUTCDate(year, month, day) {
  return new Date(Date.UTC(year, month, clampDay(year, month, day)))
}

// Resolve "in September" / "September" / "September 2026" / "end of August".
// Returns a Date at UTC midnight on day 1 (Anfang), 15 (Mitte), or last day (Ende).
// If the named month is already past in the current year and no explicit year
// was given, roll to next year — so "end of August" in September is "Aug 31
// 2027", not "Aug 31 2026".
function parseMonthPhrase(text, now) {
  const norm = s => String(s || '').replace(/[ä]/g, 'a').replace(/[ö]/g, 'o').replace(/[ü]/g, 'u').replace(/[ß]/g, 's')
    // "September/October" (no space) must split into two tokens or NEITHER
    // month is ever recognised — found live 2026-09-02, reminder #90's
    // explicit "keep a note for September/October" was silently missed
    // entirely because monthIndex() never sees a clean "september" token.
    // Restricted to letter/letter so a numeric date like "09/05" is untouched.
    .replace(/([A-Za-zÄÖÜäöüß])\/(?=[A-Za-zÄÖÜäöüß])/g, '$1 ')
  // Strip leading/trailing punctuation from each token ("August." at a
  // sentence end, "24th," before a comma) — found live 2026-09-02: reminder
  // #199 mentions two August dates ("24th August. Rent 1600..." then
  // "Friday 14th August"), and the trailing period on the FIRST "August."
  // made monthIndex() miss it entirely, silently falling through to the
  // SECOND, wrong August mention (the viewing date, not the actual
  // available-from date).
  const tokens = norm(text).split(/\s+/).map(t => t.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))

  // Find the first token that is a genuine month reference. Some month
  // tokens collide with common non-month words/fragments and need a guard
  // the other months don't: only accept them when a day number or a
  // 4-digit year sits directly next to the token ("May 15", "15 May",
  // "May 2026"); otherwise skip this token and keep scanning for a later,
  // real month reference (or return null if there is none).
  //   "may" — common modal verb ("I may have something"). Found live
  //   2026-09-02: reminders #256 ("there may be viewings") and #403 ("I
  //   may have my 2 bedroom") both silently became May 1/May 31 reminders
  //   before this guard existed.
  //   "mar" — Spanish/Catalan "sea", part of common Malta place names
  //   ("Café del Mar", "Mar Azul"). Found live 2026-09-03: reminder #161
  //   ("Ist das da wo Café Del mar und beef Bar sind?", no date mentioned
  //   at all) silently became a March 1 reminder off the "mar" in "Del mar".
  const AMBIGUOUS_MONTH_TOKENS = new Set(['may', 'mar'])
  let m = -1, mIdx = -1
  for (let i = 0; i < tokens.length; i++) {
    const idx = monthIndex(tokens[i])
    if (idx < 0) continue
    if (AMBIGUOUS_MONTH_TOKENS.has(tokens[i])) {
      const prevN = Number(tokens[i - 1])
      const nextTok = tokens[i + 1] || ''
      const dayAdjacent = (Number.isInteger(prevN) && prevN >= 1 && prevN <= 31) || /^\d{1,2}(st|nd|rd|th)?$/.test(nextTok)
      const yearAdjacent = /^\d{4}$/.test(nextTok) || /^\d{4}$/.test(tokens[i - 1] || '')
      if (!dayAdjacent && !yearAdjacent) continue
    }
    m = idx; mIdx = i; break
  }
  if (m < 0) return null

  // Position (anfang/mitte/ende, start/mid/end-of) — ONLY from the token(s)
  // immediately before THIS month occurrence, never a whole-text scan. The
  // previous whole-text substring scan (`/\bend of\s/.test(wholeText)`) set
  // position='end' from an "end" ANYWHERE in the message, including one that
  // had nothing to do with the month found — reminder #403's "I'll know end
  // of next week" flipped an unrelated "may" match to day 31 this way.
  let position = 'start'
  const prev1 = tokens[mIdx - 1]
  const prev2 = tokens[mIdx - 2]
  if (prev1 === 'anfang' || prev1 === 'start' || prev1 === 'begin' || (prev1 === 'of' && (prev2 === 'start' || prev2 === 'beginning'))) position = 'start'
  else if (prev1 === 'mitte' || prev1 === 'mid' || (prev1 === 'of' && prev2 === 'middle')) position = 'mid'
  else if (prev1 === 'ende' || prev1 === 'end' || (prev1 === 'of' && prev2 === 'end')) position = 'end'

  // If a day-of-month number sits in front of the month ("15 August",
  // "3 September", "24th August"), use that exact day. This is the standard
  // European date order; without this, "15 August" silently turned into
  // "Anfang August" (Aug 1) which is wrong. Ordinal suffix stripped — found
  // live 2026-09-02: "24th August" (reminder #199) was NOT recognised as an
  // explicit day because `Number('24th')` is NaN, silently falling back to
  // day 1.
  let explicitDay = null
  const dayMatch = (prev1 || '').match(/^(\d{1,2})(?:st|nd|rd|th)?$/)
  if (dayMatch) {
    const d = Number(dayMatch[1])
    if (d >= 1 && d <= 31) explicitDay = d
  }

  // Resolve year: explicit ONLY when a plausible 4-digit year sits directly
  // next to THIS month occurrence ("September 2026", "2026 September") —
  // NOT anywhere else in the message, and not implausibly far from today.
  // The previous whole-text `text.match(/\b(\d{4})\b/)` grabbed the FIRST
  // 4-digit number anywhere in the message as "the year" — in real owner
  // messages that is almost always a price ("...for 1600 not negotiable")
  // or a time ("viewing from 1530"), never an actual year. Found live
  // 2026-09-02: 11 reminders corrupted this way (years like 1530/1600/1700/
  // 1900/2000), every single one matching a nearby price or time exactly.
  const today = startOfToday(now)
  const yearTok = /^\d{4}$/.test(tokens[mIdx + 1] || '') ? tokens[mIdx + 1]
    : /^\d{4}$/.test(prev1 || '') ? prev1 : null
  const yearCandidate = yearTok ? Number(yearTok) : null
  const explicitYear = (yearCandidate && yearCandidate >= today.getUTCFullYear() && yearCandidate <= today.getUTCFullYear() + 5)
    ? yearCandidate : null

  let year = explicitYear || today.getUTCFullYear()

  // For "end" we want the *last* day of the month. For "mid" the 15th, for
  // "start" the 1st. An explicit day-of-month number always wins.
  let day = explicitDay || (position === 'mid' ? 15 : position === 'end' ? 28 : 1)
  if (position === 'end' && !explicitDay) {
    // Use the day-after-month-start trick to get the last day in UTC.
    const candidate = new Date(Date.UTC(year, m + 1, 0))
    day = candidate.getUTCDate()
  }

  let candidate = makeUTCDate(year, m, day)
  // Kev, 2026-09-02 (found live): a VAGUE month reference ("call me in
  // September" with no explicit day) defaults to day 1 -- so said on any day
  // OTHER than the 1st, that default day has technically already "passed",
  // and the old unconditional roll bumped it a full year ahead (every such
  // reminder landing on 2027, no matter what the owner actually said). Only
  // roll to next year when the whole MONTH is behind us, not just the
  // placeholder day -- an EXPLICIT day ("15 August" already passed) still
  // rolls exactly as before, since that really is a precise, passed date.
  const monthAlreadyPassed = year < today.getUTCFullYear() ||
    (year === today.getUTCFullYear() && m < today.getUTCMonth())
  if (!explicitYear && (explicitDay ? candidate.getTime() < today.getTime() : monthAlreadyPassed)) {
    year += 1
    candidate = makeUTCDate(year, m, day)
  }
  return candidate
}

// Resolve "in N weeks" / "in N months" / "in N days".
function parseRelativePhrase(text, now) {
  const m = String(text || '').match(/\bin\s+(\d{1,3})\s+(day|days|week|weeks|month|months)\b/i)
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2].toLowerCase()
  const base = startOfToday(now)
  if (unit.startsWith('day'))   base.setUTCDate(base.getUTCDate() + n)
  else if (unit.startsWith('week'))  base.setUTCDate(base.getUTCDate() + 7 * n)
  else if (unit.startsWith('month')) base.setUTCMonth(base.getUTCMonth() + n)
  return base
}

// Named-holiday phrases ("around Christmas", "Weihnachten") -> Dec 25, same
// "roll to next year if already passed" convention parseMonthPhrase uses.
// Added 2026-09-02 per Kev's !outreminder test catalog ("around Christmas").
function parseHolidayPhrase(text, now) {
  if (!/\b(christmas|xmas|weihnachten)\b/i.test(String(text || ''))) return null
  const today = startOfToday(now)
  let year = today.getUTCFullYear()
  let candidate = makeUTCDate(year, 11, 25)
  if (candidate.getTime() < today.getTime()) candidate = makeUTCDate(year + 1, 11, 25)
  return candidate
}

// Public: the same signature as the old parseReminderDate(s), plus an optional
// { now } option for deterministic tests. Returns a Date (UTC midnight) or null.
function parseReminderDate(s, opts) {
  const raw = String(s || '').toLowerCase().trim()
  if (!raw) return null
  const now = (opts && opts.now) || new Date()

  // 1) Pre-Phase-5: short literal tokens
  if (raw === 'tomorrow') {
    const d = startOfToday(now); d.setUTCDate(d.getUTCDate() + 1); return d
  }
  if (raw === 'next week')  { const d = startOfToday(now); d.setUTCDate(d.getUTCDate() + 7); return d }
  if (raw === 'next month') { const d = startOfToday(now); d.setUTCMonth(d.getUTCMonth() + 1); return d }

  // 2) Pre-Phase-5: +Xdays
  const plus = raw.match(/^\+(\d+)\s*days?$/)
  if (plus) {
    const d = startOfToday(now); d.setUTCDate(d.getUTCDate() + Number(plus[1])); return d
  }

  // 3) Pre-Phase-5: YYYY-MM-DD
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) {
    const y = Number(iso[1]), m = Number(iso[2]) - 1, d = Number(iso[3])
    if (m < 0 || m > 11 || d < 1 || d > 31) return null
    return makeUTCDate(y, m, d)
  }

  // European numeric date used by agents in WhatsApp: DD.MM.YY / DD.MM.YYYY.
  // Validate by round-tripping because Date.UTC otherwise normalises invalid
  // input such as 31.02 into March instead of rejecting it.
  const dotted = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/)
  if (dotted) {
    const d = Number(dotted[1]), m = Number(dotted[2]) - 1
    const y = dotted[3].length === 2 ? 2000 + Number(dotted[3]) : Number(dotted[3])
    const parsed = makeUTCDate(y, m, d)
    if (parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== m || parsed.getUTCDate() !== d) return null
    return parsed
  }

  // 4) "by YYYY-MM-DD" — strip "by" and recurse on the ISO.
  const byIso = raw.match(/^by\s+(\d{4})-(\d{2})-(\d{2})$/)
  if (byIso) return parseReminderDate(byIso[1] + '-' + byIso[2] + '-' + byIso[3], opts)

  // 5) Phase 5: month phrase
  const m1 = parseMonthPhrase(raw, now)
  if (m1) return m1

  // 6) Phase 5: relative "in N days/weeks/months"
  const m2 = parseRelativePhrase(raw, now)
  if (m2) return m2

  // 7) Named holiday ("around Christmas")
  const m3 = parseHolidayPhrase(raw, now)
  if (m3) return m3

  return null
}

// Public: arg parser. Same shape as the old one in reminderService.js so
// callers do not need to change. Pulls DATE out as one, two, or three tokens
// (e.g. "2026-09-15" is one, "in September" is two, "end of August" is three).
// Note text is everything that follows the date.
//
// A "leading modifier" like "in", "by", "end of", "anfang", "mitte", "ende"
// can sit in front of the actual date token. We try the slice as-is, then
// strip a single leading modifier and try again. Whichever matches first
// becomes the date, and the rest is the note. We never consume the phone
// token (always tokens[0]).
function parseRemindArgs(argText) {
  const tokens = String(argText || '').trim().split(/\s+/)
  if (tokens.length < 3) return null

  // Token 0: phone
  const rawPhone = tokens[0].replace(/[^\d]/g, '')
  if (!rawPhone) return null
  const phone = /^\d{8}$/.test(rawPhone) ? '356' + rawPhone : rawPhone
  if (!/^\d{7,15}$/.test(phone)) return null

  // Strip a leading "in" / "by" / "am" / "um" from a candidate slice before
  // trying to parse it. This keeps the original "in September" → Sep 1 path
  // working without forcing the date-grammar to also handle "in".
  const LEADING_MODIFIER = /^\s*(in|by|am|um|für|for)\s+/i

  let dateObj = null
  let noteStart = 1
  // We try each window length from 3 down to 1. A 3-token window with a
  // leading modifier gets the modifier stripped for the parse attempt.
  // When the stripped form wins, the consumed slice is shorter by exactly
  // one token — the leading modifier — so noteStart adjusts accordingly.
  for (let n = 3; n >= 1; n--) {
    if (tokens.length < 1 + n + 1) continue  // need at least phone + n + note
    const slice = tokens.slice(1, 1 + n).join(' ')
    const stripped = slice.replace(LEADING_MODIFIER, '').trim()
    const strippedIsShorter = (stripped !== slice)
    // If we stripped something, also try the stripped version first; then
    // fall back to the un-stripped version. Either way we know the note
    // boundary by counting tokens consumed.
    const tries = strippedIsShorter
      ? [{ text: stripped, consumed: n - 1 }, { text: slice, consumed: n }]
      : [{ text: slice, consumed: n }]
    for (const t of tries) {
      const d = parseReminderDate(t.text)
      if (d) {
        dateObj = d
        noteStart = 1 + t.consumed
        break
      }
    }
    if (dateObj) break
  }

  if (!dateObj) return null

  const note = tokens.slice(noteStart).join(' ').trim()
  if (!note) return null
  return { phone, date: dateObj, note }
}

module.exports = {
  parseReminderDate,
  parseRemindArgs,
  parseMonthPhrase,
  parseRelativePhrase,
  parseHolidayPhrase,
  monthIndex,
}
