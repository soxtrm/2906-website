'use strict'
// ============================================================================
// services/ownerFacts.js — pure fact extraction from ONE owner message.
// ARGUS dynamic facts (Kev, 2026-09-23).
//
// "Tags sind keine Labels mehr, sondern lebende Facts mit Evidence." Every
// owner message is read for every fact the CRM can hold, not just the one the
// bot happened to ask about. This file only READS text: no DB, no clock of its
// own (the caller passes `now` = when the owner sent it), so the whole
// grammar is unit-testable. services/ownerFactEngine.js decides which property
// a fact belongs to and whether it is newer than what the CRM already has.
//
// Deterministic on purpose: a fact written here overwrites canonical CRM state,
// so every value must rest on words that are quoted back as `evidence`.
// Anything ambiguous is left out, never guessed.
//
// Fact shapes:
//   { field: 'pets',                value: 'yes'|'no'|'cats_only'|'no_dogs'|'small_only'|'case_by_case' }
//   { field: 'sharing',             value: true|false }
//   { field: 'subletting',          value: true|false }
//   { field: 'price',               value: <number> }
//   { field: 'available_from',      value: 'YYYY-MM-DD' }
//   { field: 'contact_pause_until', value: 'YYYY-MM-DD' }
//   { field: 'viewings_from',       value: 'YYYY-MM-DD' }
//   { field: 'sharing_price',       value: <number> }   (never the general rent)
//   { field: 'viewing_window',      value: { start: ISO, end: ISO },
//                                   confirmation: 'full_window'|'start_only'|'approximate' }
// each with { evidence, confidence: 'explicit'|'approximate' }.
// ============================================================================
const { maltaParts, maltaToUtc, addDays } = require('../lib/maltaTime')

const DEFAULT_WINDOW_MIN = Number(process.env.BOOKING_DEFAULT_WINDOW_MIN || 90)

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
}
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
const WEEKDAYS = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
}
const WEEKDAY_RE = '(sunday|monday|tuesday|wednesday|thursday|friday|saturday|tues|thurs|thur|weds|sun|mon|tue|wed|thu|fri|sat)'
const NUMWORD = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 }

const clip = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200)
const pad = (n) => String(n).padStart(2, '0')
const ymd = ({ y, m, d }) => `${y}-${pad(m)}-${pad(d)}`
function validDay(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCMonth() === m - 1
}

// ── dates ───────────────────────────────────────────────────────────────────
// First date mentioned in `s`, relative to `now` (Malta calendar).
// Returns { y, m, d, evidence, index, dayOnly: true } or null.
function parseDate(s, now) {
  const text = String(s || '')
  const today = maltaParts(now)
  const cands = []
  const withYear = (m, d, yRaw) => {
    let y = yRaw ? Number(yRaw.length === 2 ? '20' + yRaw : yRaw) : today.y
    if (!yRaw) {
      // "15 October" said in December means next October.
      const cand = Date.UTC(y, m - 1, d), t0 = Date.UTC(today.y, today.m - 1, today.d)
      if (cand < t0 - 60 * 86400000) y += 1
    }
    return validDay(y, m, d) ? { y, m, d } : null
  }
  let r
  const re1 = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?${MONTH_RE}\\b\\.?(?:\\s*,?\\s*(\\d{4}))?`, 'ig')
  while ((r = re1.exec(text))) {
    const v = withYear(MONTHS[r[2].toLowerCase().slice(0, r[2].toLowerCase().startsWith('sept') ? 4 : 3)] || MONTHS[r[2].toLowerCase()], Number(r[1]), r[3])
    if (v) cands.push({ ...v, index: r.index, evidence: r[0] })
  }
  const re2 = new RegExp(`\\b${MONTH_RE}\\.?\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\b(?:\\s*,?\\s*(\\d{4}))?`, 'ig')
  while ((r = re2.exec(text))) {
    const mk = r[1].toLowerCase()
    const v = withYear(MONTHS[mk] || MONTHS[mk.slice(0, 3)], Number(r[2]), r[3])
    if (v) cands.push({ ...v, index: r.index, evidence: r[0] })
  }
  // 15/10, 15.10.2026 — day first (Malta). A time like 4.30pm is excluded by
  // the am/pm lookahead and by month validation.
  const re3 = /\b(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?\b(?!\s*(?:am|pm|h\b|hrs?\b|o'?clock))/ig
  while ((r = re3.exec(text))) {
    const v = withYear(Number(r[2]), Number(r[1]), r[3])
    if (v) cands.push({ ...v, index: r.index, evidence: r[0] })
  }
  const re4 = /\b(today|tonight|tomorrow|day after tomorrow)\b/ig
  while ((r = re4.exec(text))) {
    const w = r[1].toLowerCase()
    const n = w === 'tomorrow' ? 1 : w === 'day after tomorrow' ? 2 : 0
    cands.push({ ...addDays(today, n), index: r.index, evidence: r[0] })
  }
  const re5 = new RegExp(`\\b(next\\s+|this\\s+(?:coming\\s+)?|coming\\s+)?${WEEKDAY_RE}\\b`, 'ig')
  while ((r = re5.exec(text))) {
    const wd = WEEKDAYS[r[2].toLowerCase()]
    let diff = (wd - today.weekday + 7) % 7
    if (diff === 0 && r[1] && /next/i.test(r[1])) diff = 7
    cands.push({ ...addDays(today, diff), index: r.index, evidence: r[0], weekday: true })
  }
  // "in 2 weeks", "in a month", "in 10 days"
  const re6 = /\bin\s+(\d{1,2}|a|an|one|two|three|four|five|six)\s+(day|week|month)s?\b/ig
  while ((r = re6.exec(text))) {
    const n = NUMWORD[r[1].toLowerCase()] || Number(r[1])
    const unit = r[2].toLowerCase()
    let v
    if (unit === 'month') {
      const t = new Date(Date.UTC(today.y, today.m - 1 + n, today.d))
      v = { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }
    } else v = addDays(today, unit === 'week' ? n * 7 : n)
    cands.push({ ...v, index: r.index, evidence: r[0], relative: true })
  }
  if (!cands.length) return null
  cands.sort((a, b) => a.index - b.index)
  return cands[0]
}

// ── times ───────────────────────────────────────────────────────────────────
function to24(h, ampm, assumePmSmall) {
  h = Number(h)
  if (ampm) {
    const pm = /p/i.test(ampm)
    if (h === 12) return pm ? 12 : 0
    return pm ? h + 12 : h
  }
  // no am/pm: viewings happen in daytime, so "4" or "at 6" is afternoon
  if (assumePmSmall && h >= 1 && h <= 7) return h + 12
  return h
}

// First time or time range in `s`. Returns { sh, sm, eh, em, evidence, index, approximate } or null.
function parseTime(s) {
  const text = String(s || '')
  let r
  // ranges: 4-6pm, 4pm-6pm, 16:00-18:00, from 4 to 6, between 4 and 6pm
  const range = /\b(?:(from|between)\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s*(?:-|–|—|to|till|until|and)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?!\s*(?:bed|br|bath|people|persons|min|minutes|months?|weeks?|days?|years?|[\/.]))/ig
  while ((r = range.exec(text))) {
    const [, lead, h1, m1, ap1, h2, m2, ap2] = r
    const strong = ap1 || ap2 || m1 || m2 || lead
    if (!strong) continue
    if (/and/i.test(r[0]) && !/between/i.test(lead || '')) continue
    const e24 = to24(h2, ap2 || null, !ap2)
    let s24 = to24(h1, ap1 || (ap2 && Number(h1) <= Number(h2) ? ap2 : null), !ap1 && !ap2)
    if (s24 > 23 || e24 > 24) continue
    const sm = Number(m1 || 0), em = Number(m2 || 0)
    if (s24 * 60 + sm >= e24 * 60 + em) continue
    return { sh: s24, sm, eh: e24, em, evidence: r[0].trim(), index: r.index }
  }
  const single = /\b(?:at\s+|@\s*|around\s+|from\s+|after\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)(?![a-z])/ig
  if ((r = single.exec(text))) {
    const h = to24(r[1], r[3], false)
    if (h <= 23) return { sh: h, sm: Number(r[2] || 0), evidence: r[0].trim(), index: r.index }
  }
  const clock = /\b([01]?\d|2[0-3]):([0-5]\d)\b/g
  if ((r = clock.exec(text))) return { sh: Number(r[1]), sm: Number(r[2]), evidence: r[0], index: r.index }
  const bareAt = /\b(?:at|@|around)\s+(\d{1,2})(?![\d:.\/%€]|\s*(?:st|nd|rd|th|bed|people|min|euro|eur)\b)/ig
  if ((r = bareAt.exec(text))) {
    const h = to24(r[1], null, true)
    if (h >= 8 && h <= 21) return { sh: h, sm: 0, evidence: r[0].trim(), index: r.index }
  }
  if ((r = /\b(noon|midday)\b/i.exec(text))) return { sh: 12, sm: 0, evidence: r[0], index: r.index }
  const parts = { morning: [9, 30, 12, 0], afternoon: [14, 0, 17, 0], evening: [17, 0, 19, 0] }
  if ((r = /\b(morning|afternoon|evening)\b/i.exec(text))) {
    const [sh, sm, eh, em] = parts[r[1].toLowerCase()]
    return { sh, sm, eh, em, evidence: r[0], index: r.index, approximate: true }
  }
  return null
}

// ── viewing availability ────────────────────────────────────────────────────
const VIEW_CUE = /\b(view(?:ing)?s?|visit(?:s|ing)?|show(?:ing|ings)?\s|to\s+show|see\s+(?:it|the\s+(?:flat|apartment|place|property|house|room))|come\s+(?:and|to)\s+see|come\s+(?:by|over|round)|pass\s+by|meet|appointment|keys?)\b/i
const NEG_VIEW = /\b(no|not|can'?t|cannot|won'?t|unable|impossible)\b[^.!?\n]{0,30}\b(view|visit|show)/i
const FROM_CUE = /\b(from|after|starting(?:\s+from)?|as\s+of|not\s+before|until|till|before|onwards?|beginning)\b/i
// A reply that is nothing but a day and a time ("Tuesday 4pm", "ok tomorrow at 5")
const BARE_SLOT = /^\s*(?:ok(?:ay)?|yes|sure|fine|perfect|great|good|alright|yeah|yep)?[\s,!.]*(?:(?:on|this|next|coming)\s+)?[a-z0-9 .\/:\-–]{2,40}[\s!.]*$/i

function splitClauses(text) {
  return String(text || '').split(/\n+|;|\.\s+(?=[A-Z])|,\s*(?:and\s+)?(?=(?:on\s+|next\s+|this\s+)?(?:mon|tue|wed|thu|fri|sat|sun|tomorrow|today|\d{1,2}(?:st|nd|rd|th)?\s))|\s+(?:and|or|also)\s+(?=(?:on\s+|next\s+|this\s+)?(?:mon|tue|wed|thu|fri|sat|sun|tomorrow|today|\d{1,2}(?:st|nd|rd|th)?\s+[a-z]))/i)
    .map(s => s.trim()).filter(Boolean)
}

function extractViewing(text, now) {
  const out = []
  const whole = String(text || '')
  const cue = VIEW_CUE.test(whole)
  const bare = whole.length <= 45 && BARE_SLOT.test(whole)
  if (!cue && !bare) return out
  const negated = NEG_VIEW.test(whole)
  let lastDate = null
  for (const clause of splitClauses(whole)) {
    const date = parseDate(clause, now) || null
    const time = parseTime(clause)
    const useDate = date || (time && lastDate) || null
    if (date) lastDate = date
    // "viewings from 15 October" / "no viewings until the 15th" / "viewings possible after 3/10"
    // (needs a real viewing word — "available from 1 November" is a move-in
    // date, not a viewing date; a bare "Tuesday 4pm" reply only makes windows)
    if (cue && date && !date.relative && FROM_CUE.test(clause.slice(0, date.index + 1)) && (!time || negated)) {
      const lead = clause.slice(0, date.index).match(/\b(after)\s*$/i)
      const d = lead ? addDays(date, 1) : date
      out.push({ field: 'viewings_from', value: ymd(d), evidence: clip(clause), confidence: 'explicit' })
      continue
    }
    if (negated) continue
    if (useDate && time) {
      const start = maltaToUtc(useDate.y, useDate.m, useDate.d, time.sh, time.sm)
      if (start.getTime() < now.getTime() - 30 * 60000) continue      // already in the past
      const end = time.eh != null
        ? maltaToUtc(useDate.y, useDate.m, useDate.d, time.eh, time.em)
        : new Date(start.getTime() + DEFAULT_WINDOW_MIN * 60000)
      out.push({
        field: 'viewing_window',
        value: { start: start.toISOString(), end: end.toISOString() },
        evidence: clip(clause), confidence: time.approximate ? 'approximate' : 'explicit',
        // What the owner actually confirmed (acceptance pass 2026-09-24):
        // "4–6pm" = the whole range; "4pm" = only the start (the 90 minutes
        // after it are OUR planning block, proposed until the owner agrees);
        // "afternoon" = nothing exact.
        confirmation: time.approximate ? 'approximate' : (time.eh != null ? 'full_window' : 'start_only'),
      })
      continue
    }
    // "viewings on Tuesday" (a day, no hour) — bookable from that day, owner sets the hour
    if (date && cue && !time && !date.relative) {
      out.push({ field: 'viewings_from', value: ymd(date), evidence: clip(clause), confidence: 'approximate' })
    }
  }
  return out
}

// ── policy facts ────────────────────────────────────────────────────────────
function firstMatch(text, patterns) {
  for (const re of patterns) { const m = re.exec(text); if (m) return m }
  return null
}

function extractPets(t) {
  const P = '(?:pets?|dogs?|cats?|animals?)'
  const catsOnly = firstMatch(t, [
    /\b(?:only\s+cats?|cats?\s+only)\b/i,
    /\bcats?\s+(?:are\s+|is\s+)?(?:ok|okay|fine|allowed|welcome)\b[^.!?\n]{0,30}\bno\s+dogs?\b/i,
    /\bno\s+dogs?\b[^.!?\n]{0,30}\bcats?\s+(?:are\s+|is\s+)?(?:ok|okay|fine|allowed|welcome)\b/i,
  ])
  if (catsOnly) return { value: 'cats_only', evidence: catsOnly[0] }
  const small = firstMatch(t, [/\bsmall\s+(?:pets?|dogs?)\s+(?:only|ok|okay|fine|allowed|are\s+ok)\b/i, /\bonly\s+small\s+(?:pets?|dogs?)\b/i])
  if (small) return { value: 'small_only', evidence: small[0] }
  const no = firstMatch(t, [
    new RegExp(`\\bno\\s+${P}\\b`, 'i'),
    new RegExp(`\\b${P}\\s+(?:are\\s+|is\\s+)?(?:not\\s+(?:allowed|accepted|permitted|possible|ok|okay|welcome)|prohibited|forbidden|a\\s+no)\\b`, 'i'),
    /\bnot\s+pet[\s-]?friendly\b/i,
    new RegExp(`\\b(?:don'?t|do\\s+not|doesn'?t|cannot|can'?t|won'?t)\\s+(?:allow|accept|take|want)\\s+(?:any\\s+)?${P}`, 'i'),
  ])
  if (no) {
    if (/\bno\s+dogs?\b/i.test(no[0]) && !/\bcats?\b/i.test(no[0])) return { value: 'no_dogs', evidence: no[0] }
    return { value: 'no', evidence: no[0] }
  }
  const cbc = firstMatch(t, [
    new RegExp(`\\b${P}\\b[^.!?\\n]{0,40}\\b(?:depends|case\\s+by\\s+case|to\\s+be\\s+discussed|negotiable|can\\s+(?:be\\s+)?discuss\\w*|maybe|possibly|let\\s+me\\s+know\\s+what)`, 'i'),
    new RegExp(`\\b(?:depends\\s+on|case\\s+by\\s+case)\\b[^.!?\\n]{0,30}\\b${P}\\b`, 'i'),
  ])
  if (cbc) return { value: 'case_by_case', evidence: cbc[0] }
  const yes = firstMatch(t, [
    /(?<!not\s)\bpet[\s-]?friendly\b/i,
    new RegExp(`\\b${P}\\s+(?:are\\s+|is\\s+)?(?:ok|okay|fine|allowed|welcome|accepted|no\\s+problem)\\b`, 'i'),
    new RegExp(`\\b(?:accept|allow)s?\\s+${P}\\b`, 'i'),
  ])
  if (yes) return { value: 'yes', evidence: yes[0] }
  return null
}

function extractYesNo(t, noun) {
  const no = firstMatch(t, [
    new RegExp(`\\bno\\s+(?:${noun})\\b`, 'i'),
    new RegExp(`\\b(?:${noun})\\s+(?:is\\s+|are\\s+)?(?:not\\s+(?:allowed|possible|ok|okay|accepted|permitted)|prohibited|forbidden)\\b`, 'i'),
    new RegExp(`\\bnot\\s+(?:for|suitable\\s+for|open\\s+to)\\s+(?:${noun})\\b`, 'i'),
    new RegExp(`\\b(?:don'?t|do\\s+not|doesn'?t|won'?t)\\s+(?:want|accept|allow)\\s+(?:any\\s+)?(?:${noun})\\b`, 'i'),
  ])
  if (no) return { value: false, evidence: no[0] }
  const yes = firstMatch(t, [
    new RegExp(`\\b(?:${noun})\\s+(?:is\\s+|are\\s+)?(?:ok|okay|fine|allowed|possible|accepted|welcome|no\\s+problem)\\b`, 'i'),
    new RegExp(`\\b(?:accept|allow|open\\s+to)s?\\s+(?:${noun})\\b`, 'i'),
  ])
  if (yes) return { value: true, evidence: yes[0] }
  return null
}

function extractPrice(t) {
  const NUM = '(\\d{1,2}[,.]\\d{3}|\\d{3,5})(?:\\s*[kK]\\b)?'
  const m = firstMatch(t, [
    new RegExp(`\\b(?:new\\s+price|the\\s+price|price|the\\s+rent|rent|asking)\\s*(?:is|will\\s+be|would\\s+be|now|is\\s+now|reduced\\s+to|lowered\\s+to|increased\\s+to|goes\\s+(?:up|down)\\s+to|:|=|of)\\s*(?:€|eur(?:os?)?)?\\s*${NUM}`, 'i'),
    new RegExp(`\\b(?:reduce|lower|drop|increase|raise|put)d?\\s+(?:it\\s+|the\\s+price\\s+|the\\s+rent\\s+)?(?:down\\s+|up\\s+)?to\\s*(?:€|eur(?:os?)?)?\\s*${NUM}`, 'i'),
    new RegExp(`(?:€|eur(?:os?)?)\\s*${NUM}\\s*(?:per\\s+month|a\\s+month|monthly|pm|p\\.m\\.)?\\s*(?:now|instead|from\\s+now)\\b`, 'i'),
  ])
  if (!m) return null
  if (/deposit/i.test(t.slice(Math.max(0, m.index - 25), m.index + m[0].length))) return null
  let n = Number(String(m[1]).replace(/[,.]/g, ''))
  if (/k\b/i.test(m[0].slice(-2))) n *= 1000
  if (!(n >= 150 && n <= 30000)) return null
  return { value: n, evidence: m[0] }
}

function extractAvailableFrom(t, now) {
  const m = /\b(?:available|free|vacant|empty|ready|moving\s+in|move[\s-]?in)\s+(?:again\s+)?(?:from|as\s+of|after|starting(?:\s+from)?|on|by|beginning(?:\s+of)?)\s+([^.!?\n]{2,40})/i.exec(t)
  if (!m) return null
  const d = parseDate(m[1], now)
  if (!d || d.index > 12) return null
  return { value: ymd(d), evidence: m[0] }
}

function extractContactPause(t, now) {
  const m = firstMatch(t, [
    /\b(?:please\s+)?(?:don'?t|do\s+not|no\s+need\s+to)\s+(?:contact|message|text|call|write|disturb)\s+(?:me\s+|us\s+)?(?:until|till|before)\s+([^.!?\n]{2,40})/i,
    /\b(?:i'?m|i\s+am|we\s+are|we'?re|i'?ll\s+be|we'?ll\s+be)\s+(?:abroad|away|travelling|traveling|on\s+holiday|on\s+vacation|out\s+of\s+(?:malta|the\s+country|town)|in\s+hospital|busy)\s+(?:until|till|for\s+the\s+next)?\s*([^.!?\n]{2,40})/i,
    /\b(?:contact|message|write|text|call)\s+(?:me|us)\s+(?:again\s+)?((?:after|from|in|on|next)\s+[^.!?\n]{2,40})/i,
  ])
  if (!m) return null
  const d = parseDate(m[1], now)
  if (!d || d.index > 16) return null
  return { value: ymd(d), evidence: m[0] }
}

// ── public ──────────────────────────────────────────────────────────────────
function extractFacts(text, now = new Date()) {
  const t = String(text || '').trim()
  if (!t || t.startsWith('!')) return []
  const facts = []
  const push = (field, r, confidence = 'explicit') => {
    if (r) facts.push({ field, value: r.value, evidence: clip(r.evidence), confidence })
  }
  push('pets', extractPets(t))
  push('sharing', extractYesNo(t, 'sharing|sharers|flat[\\s-]?sharing|shared\\s+living'))
  push('subletting', extractYesNo(t, 'sub[\\s-]?letting|sub[\\s-]?lets?|sub[\\s-]?renting'))
  // A price stated for sharing ("€500 per person if shared", "sharing price
  // 1200") is a conditional price, never the general rent.
  const price = extractPrice(t)
  if (price) {
    const around = t.slice(Math.max(0, t.indexOf(price.evidence) - 40), t.indexOf(price.evidence) + price.evidence.length + 40)
    if (/\bshar(?:e|ed|ing|ers?)\b|\bper\s+(?:person|room|bed|head)\b|\beach\b|\bpp\b/i.test(around)) push('sharing_price', price)
    else push('price', price)
  }
  push('available_from', extractAvailableFrom(t, now))
  push('contact_pause_until', extractContactPause(t, now))
  facts.push(...extractViewing(t, now))
  return facts
}

module.exports = { extractFacts, parseDate, parseTime, extractViewing, DEFAULT_WINDOW_MIN }
