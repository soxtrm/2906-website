'use strict'
// ============================================================================
// services/outreachSchedule.js — the ONE place that knows outreach clock rules
// (Kev, 2026-10-29).
//
// Before this module the time rules were scattered: the planner chained each
// auto day to the previous one (+16 min) on top of a 24h15 gate measured from
// the END of the previous run, so start times walked later every day until
// batches started at 19:49 and 20:19 (batches #348, #350, Gabriela). Nothing
// enforced a daily cutoff, and greetings were frozen into the plan text when
// it was prepared, not when it was sent.
//
// Rules (Europe/Malta, DST-aware via Intl, never fixed offsets):
//   - New outreach messages may only START in [08:30, 19:30). 19:30 is a hard
//     cutoff for every path: armed plans, runs, rechecks, recovery.
//   - Greeting period comes from the actual send instant:
//       08:00–11:59 morning · 12:00–17:59 afternoon · 18:00–23:59 evening
//   - Free-text messages get their opening greeting and closing wish rewritten
//     to the send-time period immediately before dispatch.
// ============================================================================

const TZ = 'Europe/Malta'
const WINDOW_START_MIN = 8 * 60 + 30   // 08:30
const WINDOW_END_MIN = 19 * 60 + 30    // 19:30 (exclusive)
// Daily auto start is jittered inside the first part of the window so it
// does not look scripted, but always starts in the morning.
const AUTO_START_EARLIEST_MIN = WINDOW_START_MIN
const AUTO_START_LATEST_MIN = 9 * 60 + 15

const partsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})

function maltaParts(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date)
  const p = Object.fromEntries(partsFmt.formatToParts(d).map(x => [x.type, x.value]))
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second),
    minutes: Number(p.hour) * 60 + Number(p.minute),
  }
}

const maltaDateStr = (date = new Date()) => maltaParts(date).date

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// Malta wall-clock (date + HH:MM) → the real UTC instant. Searches the two
// possible offsets (+01/+02) so DST days resolve correctly. A wall time that
// does not exist (the spring-forward gap 02:00–02:59) resolves to the first
// valid minute after it; outreach never schedules there anyway.
function maltaLocalToUTC(dateStr, timeStr) {
  const [h, m] = String(timeStr).split(':').map(Number)
  const wanted = h * 60 + m
  for (const offsetHours of [1, 2]) {
    const guess = new Date(`${dateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`)
    guess.setUTCHours(guess.getUTCHours() - offsetHours)
    const p = maltaParts(guess)
    if (p.date === dateStr && p.minutes === wanted) return guess
  }
  const fallback = new Date(`${dateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`)
  fallback.setUTCHours(fallback.getUTCHours() - 1)
  return fallback
}

function isSendAllowed(now = new Date()) {
  const { minutes } = maltaParts(now)
  return minutes >= WINDOW_START_MIN && minutes < WINDOW_END_MIN
}

// The next instant at which a new message may start. Inside the window that
// is `now`; before 08:30 it is today 08:30; from 19:30 it is tomorrow 08:30.
function nextSendWindowStart(now = new Date()) {
  const p = maltaParts(now)
  if (p.minutes >= WINDOW_START_MIN && p.minutes < WINDOW_END_MIN) return new Date(now)
  const day = p.minutes < WINDOW_START_MIN ? p.date : addDays(p.date, 1)
  return maltaLocalToUTC(day, '08:30')
}

function windowEndFor(now = new Date()) {
  return maltaLocalToUTC(maltaParts(now).date, '19:30')
}

function greetingPeriod(now = new Date()) {
  const { hour } = maltaParts(now)
  if (hour >= 8 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 18) return 'afternoon'
  if (hour >= 18) return 'evening'
  return null // 00:00–07:59 — outreach never starts here
}

// Morning start for an auto-prepared day: deterministic per (account, date) so
// a reload or a second Save All shows the same time, but different across days.
function autoStartTime(accountId, dateStr) {
  let hash = 2166136261
  for (const ch of `${accountId}:${dateStr}`) { hash ^= ch.charCodeAt(0); hash = Math.imul(hash, 16777619) >>> 0 }
  const span = AUTO_START_LATEST_MIN - AUTO_START_EARLIEST_MIN
  const minutes = AUTO_START_EARLIEST_MIN + (hash % (span + 1))
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

// ── Send-time greeting/closing for FREE-TEXT messages ────────────────────
// Persona-library templates are chosen per period (outreachTemplates.js).
// Free text (manual plans, older drafts) is corrected here: only a leading
// greeting and well-known closing wishes are touched, nothing in the body.
const OPENING = {
  morning: 'Good morning',
  afternoon: 'Good afternoon',
  evening: 'Good evening',
}
const CLOSING = {
  morning: 'Have a lovely day!',
  afternoon: 'Have a lovely afternoon!',
  evening: 'Wishing you a pleasant evening!',
}
const OPENING_RE = /^(\s*)(good\s+(?:morning|afternoon|evening|night|day)|morning|afternoon|evening)\b/i
const CLOSING_RE = /(have\s+a\s+(?:lovely|nice|great|wonderful|good|pleasant|beautiful)\s+(?:day|morning|afternoon|evening|night|weekend)|enjoy\s+(?:your|the)\s+(?:day|morning|afternoon|evening|night)|wishing\s+you\s+a\s+(?:lovely|nice|great|wonderful|good|pleasant)\s+(?:day|morning|afternoon|evening|night)|good\s*night)([!.]*)\s*$/i

function normalizeGreeting(text, now = new Date()) {
  const period = greetingPeriod(now)
  const original = String(text || '')
  if (!period || !original.trim()) return { text: original, period, changed: false }
  let out = original.replace(OPENING_RE, (_, lead, word) => {
    const target = OPENING[period]
    return lead + (word[0] === word[0].toUpperCase() ? target : target.toLowerCase())
  })
  out = out.replace(CLOSING_RE, () => CLOSING[period])
  return { text: out, period, changed: out !== original }
}

module.exports = {
  TZ, WINDOW_START_MIN, WINDOW_END_MIN, AUTO_START_EARLIEST_MIN, AUTO_START_LATEST_MIN,
  maltaParts, maltaDateStr, addDays, maltaLocalToUTC,
  isSendAllowed, nextSendWindowStart, windowEndFor, greetingPeriod, autoStartTime,
  normalizeGreeting, OPENING, CLOSING,
}
