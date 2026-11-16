'use strict'
// Owner viewing schedule (ARGUS Owner Portal, Claude 2026-11-16).
//
// Pure functions: validation of the owner's weekly rules and generation of the
// concrete windows and slots they imply. Nothing here touches the database.
//
// The rules are the owner's *intent*. ARGUS keeps ONE calendar:
// `property_viewing_windows` (materialised from these rules, source_type
// 'owner_portal') and `property_viewings` (requests and appointments). This
// module never invents a second store; see ownerPortalStore.js.
//
// Times are wall-clock in Europe/Malta and converted per day, so the CET/CEST
// switch in March and October does not shift an owner's "10:00".

const TZ = 'Europe/Malta'
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const DURATIONS = [10, 15, 20, 30, 60, 120]

class ScheduleError extends Error {
  constructor(code, message) { super(message); this.code = code; this.status = 400 }
}

const minutes = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

function wallParts(ms, tz = TZ) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(new Date(ms)).map(x => [x.type, x.value]))
  return p
}

// 'YYYY-MM-DD' + 'HH:MM' wall-clock in tz → epoch ms (DST-safe, same method as lib/crm/booking.ts maltaToIso).
function zonedToEpoch(date, time, tz = TZ) {
  const [y, m, d] = date.split('-').map(Number)
  const [h, mi] = time.split(':').map(Number)
  const guess = Date.UTC(y, m - 1, d, h, mi)
  const offset = t => {
    const p = wallParts(t, tz)
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(t / 60000) * 60000
  }
  const o1 = offset(guess)
  const t = guess - o1
  const o2 = offset(t)
  return o1 === o2 ? t : guess - o2
}

function dayKey(ms, tz = TZ) {
  const p = wallParts(ms, tz)
  return `${p.year}-${p.month}-${p.day}`
}

function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return t.toISOString().slice(0, 10)
}

const weekday = date => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay() } // 0 = Sunday

const DEFAULT_SCHEDULE = Object.freeze({
  weekly: [], breaks: [], exceptions: [], blocked: [],
  durationMin: 20, bufferMin: 10, noticeHours: 12, horizonDays: 21, approval: 'manual',
})

function range(entry, label) {
  if (!entry || !TIME.test(entry.start || '') || !TIME.test(entry.end || '') || entry.start >= entry.end) throw new ScheduleError('SCHEDULE_INVALID', `${label}: start and end must be HH:MM with start before end`)
  return { start: entry.start, end: entry.end }
}

// Validates and normalises the owner's rules. Unknown keys are refused so a
// typo can never silently widen availability.
function validateSchedule(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ScheduleError('SCHEDULE_INVALID', 'Schedule must be an object')
  const known = ['weekly', 'breaks', 'exceptions', 'blocked', 'durationMin', 'bufferMin', 'noticeHours', 'horizonDays', 'approval']
  const unknown = Object.keys(input).filter(k => !known.includes(k))
  if (unknown.length) throw new ScheduleError('SCHEDULE_INVALID', `Unknown schedule field: ${unknown[0].slice(0, 40)}`)
  const s = { ...DEFAULT_SCHEDULE, ...input }
  const list = (v, max, label) => { if (!Array.isArray(v) || v.length > max) throw new ScheduleError('SCHEDULE_INVALID', `${label} must be a list of at most ${max}`); return v }
  const int = (v, lo, hi, label) => { if (!Number.isInteger(v) || v < lo || v > hi) throw new ScheduleError('SCHEDULE_INVALID', `${label} must be a whole number from ${lo} to ${hi}`); return v }

  const weekly = list(s.weekly, 70, 'weekly').map(w => {
    if (!w || !Number.isInteger(w.day) || w.day < 0 || w.day > 6) throw new ScheduleError('SCHEDULE_INVALID', 'weekly: day must be 0 (Sunday) to 6')
    return { day: w.day, ...range(w, 'weekly') }
  })
  const breaks = list(s.breaks, 70, 'breaks').map(b => {
    const day = b && b.day !== undefined && b.day !== null ? b.day : null
    if (day !== null && (!Number.isInteger(day) || day < 0 || day > 6)) throw new ScheduleError('SCHEDULE_INVALID', 'breaks: day must be 0 to 6 or empty for every day')
    return { day, ...range(b, 'breaks') }
  })
  const exceptions = list(s.exceptions, 366, 'exceptions').map(e => {
    if (!e || !DATE.test(e.date || '')) throw new ScheduleError('SCHEDULE_INVALID', 'exceptions: date must be YYYY-MM-DD')
    if (!['available', 'unavailable'].includes(e.kind)) throw new ScheduleError('SCHEDULE_INVALID', 'exceptions: kind must be available or unavailable')
    if (e.kind === 'available') return { date: e.date, kind: e.kind, ...range(e, 'exceptions') }
    return e.start || e.end ? { date: e.date, kind: e.kind, ...range(e, 'exceptions') } : { date: e.date, kind: e.kind }
  })
  const blocked = list(s.blocked, 100, 'blocked').map(b => {
    if (!b || !DATE.test(b.from || '') || !DATE.test(b.to || '') || b.from > b.to) throw new ScheduleError('SCHEDULE_INVALID', 'blocked: from and to must be YYYY-MM-DD with from ≤ to')
    return { from: b.from, to: b.to, label: b.label ? String(b.label).slice(0, 80) : null }
  })
  const durationMin = s.durationMin
  if (!DURATIONS.includes(durationMin) && !(Number.isInteger(durationMin) && durationMin >= 5 && durationMin <= 240 && durationMin % 5 === 0)) {
    throw new ScheduleError('SCHEDULE_INVALID', 'durationMin must be 10, 15, 20, 30, 60, 120 or a custom multiple of 5 from 5 to 240')
  }
  if (!['manual', 'auto'].includes(s.approval)) throw new ScheduleError('SCHEDULE_INVALID', 'approval must be manual or auto')
  return {
    weekly, breaks, exceptions, blocked, durationMin,
    bufferMin: int(s.bufferMin, 0, 120, 'bufferMin'),
    noticeHours: int(s.noticeHours, 0, 168, 'noticeHours'),
    horizonDays: int(s.horizonDays, 1, 60, 'horizonDays'),
    approval: s.approval,
  }
}

function subtract(ranges, cut) {
  const out = []
  for (const r of ranges) {
    if (cut.end <= r.start || cut.start >= r.end) { out.push(r); continue }
    if (cut.start > r.start) out.push({ start: r.start, end: cut.start })
    if (cut.end < r.end) out.push({ start: cut.end, end: r.end })
  }
  return out
}

function merge(ranges) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const out = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end)
    else out.push({ ...r })
  }
  return out
}

// Wall-clock minute ranges open on one date, after exceptions, blocks and breaks.
function openMinutes(schedule, date) {
  if (schedule.blocked.some(b => date >= b.from && date <= b.to)) return []
  const day = weekday(date)
  const ex = schedule.exceptions.filter(e => e.date === date)
  let open = merge(schedule.weekly.filter(w => w.day === day).map(w => ({ start: minutes(w.start), end: minutes(w.end) })))
  for (const e of ex.filter(x => x.kind === 'available')) open = merge([...open, { start: minutes(e.start), end: minutes(e.end) }])
  for (const e of ex.filter(x => x.kind === 'unavailable')) {
    open = e.start ? subtract(open, { start: minutes(e.start), end: minutes(e.end) }) : []
  }
  for (const b of schedule.breaks.filter(x => x.day === null || x.day === day)) open = subtract(open, { start: minutes(b.start), end: minutes(b.end) })
  return open
}

// Concrete windows (ISO instants) for the next `days` days from `fromDate`.
// These are what gets written to property_viewing_windows.
function windowsFor(schedule, fromDate, days) {
  const out = []
  for (let i = 0; i < days; i++) {
    const date = addDays(fromDate, i)
    for (const r of openMinutes(schedule, date)) {
      out.push({ date, start: new Date(zonedToEpoch(date, hhmm(r.start))).toISOString(), end: new Date(zonedToEpoch(date, hhmm(r.end))).toISOString() })
    }
  }
  return out
}

// Slots inside the windows. A slot is free only if [start − buffer, end + buffer]
// does not touch a busy interval (held, proposed or confirmed viewings and
// iCal occupancy) and it starts after the notice period.
function slotsFor(schedule, { fromDate, days, busy = [], now = Date.now(), durationMin } = {}) {
  const dur = (durationMin || schedule.durationMin) * 60000
  const buf = schedule.bufferMin * 60000
  const step = dur + buf
  const earliest = now + schedule.noticeHours * 3600000
  const blocks = busy.map(b => ({ start: Date.parse(b.start), end: Date.parse(b.end) })).filter(b => b.end > b.start)
  const out = []
  for (const w of windowsFor(schedule, fromDate, days)) {
    const ws = Date.parse(w.start), we = Date.parse(w.end)
    for (let t = ws; t + dur <= we; t += step) {
      const clash = blocks.some(b => t - buf < b.end && t + dur + buf > b.start)
      const state = t < earliest ? 'too_soon' : clash ? 'busy' : 'free'
      out.push({ date: w.date, start: new Date(t).toISOString(), end: new Date(t + dur).toISOString(), state })
    }
  }
  return out
}

// Is [start, end) inside the owner's open time, respecting buffer and notice?
// Used before an owner (or auto-approval) proposes a slot.
function fitsSchedule(schedule, start, end, { busy = [], now = Date.now() } = {}) {
  const s = Date.parse(start), e = Date.parse(end)
  if (!(e > s)) return { ok: false, reason: 'INVALID_RANGE' }
  if (s < now + schedule.noticeHours * 3600000) return { ok: false, reason: 'NOTICE_TOO_SHORT' }
  const date = dayKey(s)
  const inside = windowsFor(schedule, date, 1).some(w => Date.parse(w.start) <= s && e <= Date.parse(w.end))
  if (!inside) return { ok: false, reason: 'OUTSIDE_AVAILABILITY' }
  const buf = schedule.bufferMin * 60000
  const clash = busy.find(b => s - buf < Date.parse(b.end) && e + buf > Date.parse(b.start))
  if (clash) return { ok: false, reason: 'CONFLICT', conflict: clash }
  return { ok: true }
}

module.exports = {
  TZ, DURATIONS, DEFAULT_SCHEDULE, ScheduleError,
  validateSchedule, windowsFor, slotsFor, fitsSchedule, openMinutes, zonedToEpoch, dayKey, addDays, weekday,
}
