'use strict'
// ============================================================================
// lib/maltaTime.js — wall-clock time in Malta <-> real instants.
//
// Owners say "Tuesday 4pm" in Malta time. The container runs in UTC, so a
// naive `new Date(y, m, d, 16)` would book 18:00 local in summer. Everything
// the booking engine stores is a timestamptz built through maltaToUtc().
// ============================================================================
const TZ = 'Europe/Malta'

const _fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
})

// Malta wall-clock parts of an instant.
function maltaParts(date = new Date()) {
  const p = {}
  for (const { type, value } of _fmt.formatToParts(date)) p[type] = value
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday]
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second, weekday: wd }
}

// Offset (minutes) Malta is ahead of UTC at a given instant.
function maltaOffsetMin(date) {
  const p = maltaParts(date)
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s)
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000)
}

// Malta wall clock (month 1-12) -> Date instant.
function maltaToUtc(y, m, d, h = 0, mi = 0) {
  const guess = new Date(Date.UTC(y, m - 1, d, h, mi))
  const off1 = maltaOffsetMin(guess)
  const t = new Date(guess.getTime() - off1 * 60000)
  const off2 = maltaOffsetMin(t)   // DST edge: re-evaluate at the real instant
  return off1 === off2 ? t : new Date(guess.getTime() - off2 * 60000)
}

// 'YYYY-MM-DD' of the Malta calendar day an instant falls on.
function maltaDateStr(date = new Date()) {
  const p = maltaParts(date)
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`
}

// Add whole days to a Malta calendar date {y,m,d}.
function addDays({ y, m, d }, n) {
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }
}

module.exports = { TZ, maltaParts, maltaToUtc, maltaDateStr, maltaOffsetMin, addDays }
