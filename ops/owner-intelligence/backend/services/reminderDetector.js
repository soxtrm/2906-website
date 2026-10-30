'use strict'
// ============================================================================
// services/reminderDetector.js — content-based reminder detection.
//
// Scans a free-text WhatsApp message for an embedded reminder phrase and
// returns a `{ matched, dueAt, phrase, remainder }` object — or null when
// nothing looks like a reminder.
//
// This module is PURE: no DB, no network, no time-of-day beyond the optional
// `now` injected for tests. The calendar arithmetic is delegated to
// services/reminderParse.parseMonthPhrase so we don't re-derive the
// Anfang/Mitte/Ende rule.
//
// Phrases recognised:
//   • English: "in September", "end August", "end of August",
//              "Anfang/Mitte/Ende <Month>" (German phase words)
//   • English: "15 August", "3 September" (explicit day-of-month)
//   • German:  "schreib mir ... wieder"  (re-write me again)
//              "schreib mir ... nochmal" (write me once more)
//              Both forms accept an EMBEDDED date phrase; when present the
//              embedded date wins. When no date is present, dueAt=null and
//              the caller can apply a 7-day default fallback.
// ============================================================================

const { parseMonthPhrase, parseRelativePhrase, parseHolidayPhrase, parseReminderDate } = require('./reminderParse')

// German "schreib mir ... wieder/nochmal" pattern. The "schreib" verb is the
// only positive signal — plain "wieder" alone is too common to be useful
// (would match most polite replies). The negative lookbehind avoids
// matching "... schreib sobald du kannst".
const SCHREIB_RE = /\bschreib\s+mir\b[^.\n!?]{0,80}?\b(wieder|nochmal)\b/i

// A date on its own is not a reminder. Owner chats contain ordinary plans
// ("next week I will be abroad", "let's meet next week") and treating those as
// property follow-ups produces confusing, context-free outreach. Keep the
// detector deterministic: a reminder needs either an explicit request to
// contact us again or a property/listing commitment around the date.
// Kev, 2026-10-30: owners also say "check back next month", "let me know
// closer to the end of the month", "follow up after the weekend".
const CONTACT_AGAIN_RE = /\b(?:contact|message|text|write|call|remind|reach\s+out|get\s+back\s+to)\s+(?:me|us)?\b|\bcheck\s+(?:back|again)\b|\blet\s+me\s+know\b|\bfollow\s+up\b|\btouch\s+base\b|\bask\s+(?:me\s+)?again\b/i
const PROPERTY_CONTEXT_RE = /\b(?:property|flat|apartment|house|villa|maisonette|penthouse|listing|market|rent(?:ed|al)?|tenants?|lease|available|availability|viewing|photo(?:s)?|picture(?:s)?|detail(?:s)?|key(?:s)?|price|bedroom(?:s)?|bathroom(?:s)?|document(?:s)?)\b/i
const PROPERTY_ACTION_RE = /\b(?:send|share|provide|list|market|rent|release|confirm|update|know|ready|available|vacant|free|view|show|come(?:s)?\s+on|decide|renew|move\s+out|leave)\b/i
const SOCIAL_OR_TRAVEL_RE = /\b(?:abroad|holiday|vacation|travell?ing|travel|coffee|lunch|dinner|party|meet\s+up|friends?)\b/i

function isBusinessReminderIntent(text) {
  const raw = String(text || '').trim()
  if (!raw) return false
  if (SCHREIB_RE.test(raw) || CONTACT_AGAIN_RE.test(raw)) return true
  if (PROPERTY_CONTEXT_RE.test(raw) && PROPERTY_ACTION_RE.test(raw)) return true
  // "The flat is rented until September" is already a complete business
  // fact even without an explicit future-tense action verb.
  if (/\b(?:property|flat|apartment|house|villa|listing)\b/i.test(raw)
      && /\b(?:rented\s+(?:out\s+)?(?:until|till)|available\s+(?:from|in|on)|on\s+the\s+market)\b/i.test(raw)) return true
  if (SOCIAL_OR_TRAVEL_RE.test(raw)) return false
  return false
}

// What the owner said about availability — never upgraded: "might",
// "depending on the tenants" stays tentative (Kev, 2026-10-30).
function classifyAvailability(text) {
  const s = String(text || '')
  if (/\b(?:no\s+longer|not)\s+available\b|\b(?:already\s+)?rented\s+out\b|\bsold\b/i.test(s)) return 'unavailable'
  if (/\btenants?\b[^.]{0,60}\b(?:decide|renew|leave|stay|move\s+out)\b|\bdepend(?:s|ing)?\s+on\b[^.]{0,40}\btenants?\b/i.test(s)) return 'awaiting_tenant_decision'
  if (/\b(?:might|may|maybe|possibly|perhaps|could|hopefully|probably|not\s+sure)\b/i.test(s)) return 'possibly_available'
  if (/\bavailable\s+(?:now|immediately|right\s+away)\b/i.test(s)) return 'available_now'
  if (/\bavailable\s+(?:from|on|as\s+of)\b/i.test(s)) return 'available_from_date'
  if (CONTACT_AGAIN_RE.test(s)) return 'contact_later'
  return 'unknown'
}

function isoDate(d) {
  if (!d) return null
  if (typeof d === 'string') return d.length >= 10 ? d.slice(0, 10) : d
  return d.toISOString().slice(0, 10)
}

// Internal helper: scan the message for an embedded month or relative
// phrase and return { dueAt, phrase } — or null. We pick the FIRST match so
// the operator's intent isn't quietly stolen by a later phrase in the
// message.
// "in two months" → "in 2 months" for parseRelativePhrase (digits only).
const NUMBER_WORDS = { one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, couple: 2, few: 3 }
function digitsForWords(text) {
  return String(text).replace(/\bin\s+(?:a\s+)?(one|a|an|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple|few)(\s+of)?\s+(day|days|week|weeks|month|months)\b/gi,
    (_, w, _of, unit) => `in ${NUMBER_WORDS[w.toLowerCase()]} ${unit}`)
}

function endOfMonth(now) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))
  return d
}

function scanDatePhrase(text, now) {
  // 1) "in N weeks/months/days" — short-circuit because it's exact.
  const numeric = digitsForWords(text)
  const rel = parseRelativePhrase(numeric, now)
  if (rel) {
    const unit = numeric.match(/in\s+\d{1,3}\s+(day|days|week|weeks|month|months)/i)
    return { dueAt: isoDate(rel), phrase: unit[0], precision: /month/i.test(unit[1]) ? 'month' : /week/i.test(unit[1]) ? 'week' : 'day' }
  }

  // "after the weekend" → the coming Monday; "(closer to / towards) the end
  // of the month" → the last week of this month (Kev, 2026-10-30).
  const weekend = text.match(/\bafter\s+the\s+weekend\b/i)
  if (weekend) {
    const base = new Date(now)
    base.setUTCHours(0, 0, 0, 0)
    let days = (1 - base.getUTCDay() + 7) % 7
    if (days === 0) days = 7
    base.setUTCDate(base.getUTCDate() + days)
    return { dueAt: isoDate(base), phrase: weekend[0], precision: 'day' }
  }
  const monthEnd = text.match(/\b(?:closer\s+to|towards?|by|at|around|near)?\s*the\s+end\s+of\s+(?:the|this)\s+month\b/i)
  if (monthEnd) {
    const end = endOfMonth(now)
    const start = new Date(end); start.setUTCDate(end.getUTCDate() - 6)
    const today = new Date(now); today.setUTCHours(0, 0, 0, 0)
    const due = start < today ? today : start
    return { dueAt: isoDate(due), windowEnd: isoDate(end), phrase: monthEnd[0].trim(), precision: 'week' }
  }

  // Kev, 2026-09-01 (catalog test): "contact me next month" / "try me in 2
  // weeks" (already covered above) / "call me next week" -- an embedded
  // "next week"/"next month", not just an exact-string match, which is all
  // parseReminderDate's own 'next month'/'next week' branch covers.
  const nextM = text.match(/\bnext\s+(week|month)\b/i)
  if (nextM) {
    const unit = nextM[1].toLowerCase()
    const base = new Date(now)
    base.setUTCHours(0, 0, 0, 0)
    if (unit === 'week') base.setUTCDate(base.getUTCDate() + 7)
    else base.setUTCMonth(base.getUTCMonth() + 1)
    return { dueAt: isoDate(base), phrase: nextM[0], precision: unit }
  }

  // Owner commitments are often phrased with a weekday ("I will send the
  // photos on Monday") or "tomorrow". reminderParse intentionally only
  // accepts those words as standalone command arguments, so handle their
  // embedded conversational form here.
  const tomorrow = text.match(/\b(?:tomorrow|morgen)\b/i)
  if (tomorrow) {
    const base = new Date(now)
    base.setUTCHours(0, 0, 0, 0)
    base.setUTCDate(base.getUTCDate() + 1)
    return { dueAt: isoDate(base), phrase: tomorrow[0] }
  }
  const weekday = text.match(/\b(?:on\s+|am\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)\b/i)
  if (weekday) {
    const key = weekday[1].toLowerCase()
    const weekdayNumber = {
      sunday: 0, sonntag: 0, monday: 1, montag: 1, tuesday: 2, dienstag: 2,
      wednesday: 3, mittwoch: 3, thursday: 4, donnerstag: 4,
      friday: 5, freitag: 5, saturday: 6, samstag: 6,
    }[key]
    const base = new Date(now)
    base.setUTCHours(0, 0, 0, 0)
    let days = (weekdayNumber - base.getUTCDay() + 7) % 7
    if (days === 0) days = 7
    base.setUTCDate(base.getUTCDate() + days)
    return { dueAt: isoDate(base), phrase: weekday[0].trim() }
  }

  // Named holiday ("around Christmas") — Kev's 2026-09-02 test catalog.
  const holiday = parseHolidayPhrase(text, now)
  if (holiday) {
    const m = text.match(/\b(around|near|by)?\s*(christmas|xmas|weihnachten)\b/i)
    return { dueAt: isoDate(holiday), phrase: (m ? m[0] : 'christmas').trim() }
  }

  // 2) Month phrase (covers "in September", "end of August",
  //    "Anfang/Mitte/Ende <Month>", "15 August", "September 2026").
  const month = parseMonthPhrase(text, now)
  if (month) {
    // Capture the phrase we matched. parseMonthPhrase doesn't return the
    // substring; re-scan with a small grammar. We accept the longest of
    // ("in" + month) or (phase-word + month) or (explicit-day + month).
    const inHit = text.match(/\bin\s+([A-Za-zÄÖÜäöüß]+)(?:\s+(\d{4}))?/i)
    const phaseHit = text.match(/\b(anfang|mitte|ende|start\s+of|end\s+of|middle\s+of|begin|mid|end|beginn(?:en)?|start)\s+([A-Za-zÄÖÜäöüß]+)(?:\s+(\d{4}))?/i)
    const explicitHit = text.match(/\b(\d{1,2})\s+([A-Za-zÄÖÜäöüß]+)(?:\s+(\d{4}))?/i)
    let phrase = null
    if (inHit) phrase = `in ${inHit[1]}${inHit[2] ? ' ' + inHit[2] : ''}`
    else if (phaseHit) phrase = `${phaseHit[1]} ${phaseHit[2]}${phaseHit[3] ? ' ' + phaseHit[3] : ''}`
    else if (explicitHit) phrase = `${explicitHit[1]} ${explicitHit[2]}${explicitHit[3] ? ' ' + explicitHit[3] : ''}`
    else phrase = (text.match(/[A-Za-zÄÖÜäöüß]+(?:\s+\d{4})?/i) || [''])[0]
    // A bare month ("in January") is a month, not the 1st: keep the window
    // so nobody reads it as the owner's exact date (Kev, 2026-10-30).
    const explicitDay = explicitHit && !inHit && !phaseHit
    const monthEndDate = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0))
    return explicitDay
      ? { dueAt: isoDate(month), phrase, precision: 'day' }
      : { dueAt: isoDate(month), windowEnd: phaseHit ? null : isoDate(monthEndDate), phrase, precision: phaseHit ? 'part_of_month' : 'month' }
  }

  return null
}

// Public. Returns:
//   { matched: true,  dueAt: 'YYYY-MM-DD'|null, phrase: '<matched substring>', remainder: '<text>' }
//   { matched: false, ... } (we return null instead — see callers)
//
// The remainder is the text MINUS the matched phrase, so the caller can
// use it as the "note" body when persisting the reminder row.
function detectReminderPhrase(text, opts) {
  const raw = String(text || '').trim()
  if (!raw) return null

  const now = (opts && opts.now) || new Date()

  if (!isBusinessReminderIntent(raw)) return null

  // 1) "schreib mir ... wieder/nochmal" wins outright. We then look for an
  //    embedded date inside the same message — if found, that's dueAt.
  //    If not, dueAt is null and the caller decides.
  const availability = classifyAvailability(raw)
  const schreibHit = raw.match(SCHREIB_RE)
  if (schreibHit) {
    const datePart = scanDatePhrase(raw, now)
    return {
      matched: true,
      dueAt: datePart ? datePart.dueAt : null,
      windowEnd: datePart ? datePart.windowEnd || null : null,
      precision: datePart ? datePart.precision || 'day' : null,
      availability,
      phrase: schreibHit[0],
      remainder: (raw.slice(0, schreibHit.index) + ' ' + raw.slice(schreibHit.index + schreibHit[0].length)).trim(),
    }
  }

  // 2) Bare month/relative phrase — match if a date phrase is found.
  const datePart = scanDatePhrase(raw, now)
  if (datePart) {
    return {
      matched: true,
      dueAt: datePart.dueAt,
      windowEnd: datePart.windowEnd || null,
      precision: datePart.precision || 'day',
      availability,
      phrase: datePart.phrase,
      remainder: raw,
    }
  }

  return null
}

module.exports = {
  detectReminderPhrase,
  isBusinessReminderIntent,
  classifyAvailability,
  // exposed for tests
  _scanDatePhrase: scanDatePhrase,
  SCHREIB_RE,
}
