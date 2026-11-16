'use strict'
// Pure tests: owner schedule rules and the viewing state machine. No database.
const test = require('node:test')
const assert = require('node:assert/strict')
const S = require('../services/ownerSchedule')
const V = require('../services/viewingStates')

const base = {
  weekly: [{ day: 1, start: '10:00', end: '13:00' }, { day: 1, start: '15:00', end: '18:00' }, { day: 3, start: '09:00', end: '12:00' }],
  breaks: [{ day: null, start: '11:00', end: '11:30' }],
  exceptions: [], blocked: [], durationMin: 30, bufferMin: 10, noticeHours: 0, horizonDays: 14, approval: 'manual',
}

test('validation refuses unknown fields, bad durations and reversed times', () => {
  assert.throws(() => S.validateSchedule({ ...base, everyday: true }), /Unknown schedule field/)
  assert.throws(() => S.validateSchedule({ ...base, durationMin: 7 }), /durationMin/)
  assert.throws(() => S.validateSchedule({ ...base, weekly: [{ day: 1, start: '12:00', end: '10:00' }] }), /start before end/)
  assert.throws(() => S.validateSchedule({ ...base, approval: 'always' }), /approval/)
  for (const d of [10, 15, 20, 30, 60, 120, 45]) assert.equal(S.validateSchedule({ ...base, durationMin: d }).durationMin, d)
  assert.deepEqual(S.validateSchedule({}).weekly, [])
})

test('weekly windows, daily break and Malta wall clock in winter (CET)', () => {
  const s = S.validateSchedule(base)
  // 2026-11-16 is a Monday.
  const w = S.windowsFor(s, '2026-11-16', 1)
  assert.deepEqual(w.map(x => [x.start, x.end]), [
    ['2026-11-16T09:00:00.000Z', '2026-11-16T10:00:00.000Z'], // 10:00–11:00 Malta
    ['2026-11-16T10:30:00.000Z', '2026-11-16T12:00:00.000Z'], // 11:30–13:00
    ['2026-11-16T14:00:00.000Z', '2026-11-16T17:00:00.000Z'], // 15:00–18:00
  ])
  assert.equal(S.windowsFor(s, '2026-11-17', 1).length, 0) // Tuesday: nothing
})

test('summer time (CEST) keeps the owner\'s 10:00', () => {
  const s = S.validateSchedule(base)
  const w = S.windowsFor(s, '2026-07-06', 1) // Monday in summer
  assert.equal(w[0].start, '2026-07-06T08:00:00.000Z')
  // The DST switch day (Sun 2026-03-29) does not shift a Wednesday rule after it.
  assert.equal(S.windowsFor(s, '2026-04-01', 1)[0].start, '2026-04-01T07:00:00.000Z')
})

test('exceptions and blocked dates', () => {
  const s = S.validateSchedule({ ...base,
    exceptions: [{ date: '2026-11-16', kind: 'unavailable', start: '15:00', end: '16:00' }, { date: '2026-11-17', kind: 'available', start: '18:00', end: '19:00' }, { date: '2026-11-18', kind: 'unavailable' }],
    blocked: [{ from: '2026-11-23', to: '2026-11-30', label: 'Holiday' }] })
  assert.equal(S.windowsFor(s, '2026-11-16', 1).at(-1).start, '2026-11-16T15:00:00.000Z') // 16:00–18:00 remains
  assert.equal(S.windowsFor(s, '2026-11-17', 1)[0].start, '2026-11-17T17:00:00.000Z')
  assert.equal(S.windowsFor(s, '2026-11-18', 1).length, 0) // whole-day exception
  assert.equal(S.windowsFor(s, '2026-11-23', 8).length, 0) // holiday week
})

test('slots respect duration, buffer, notice and busy viewings', () => {
  const s = S.validateSchedule({ ...base, breaks: [], weekly: [{ day: 1, start: '10:00', end: '12:00' }], noticeHours: 2 })
  const now = Date.parse('2026-11-16T08:30:00Z') // 09:30 Malta → earliest 11:30
  const busy = [{ start: '2026-11-16T09:40:00Z', end: '2026-11-16T10:10:00Z' }] // 10:40–11:10 Malta
  const slots = S.slotsFor(s, { fromDate: '2026-11-16', days: 1, busy, now })
  assert.deepEqual(slots.map(x => [x.start.slice(11, 16), x.state]), [
    ['09:00', 'too_soon'], ['09:40', 'too_soon'], ['10:20', 'too_soon'],
  ])
  const later = S.slotsFor(s, { fromDate: '2026-11-16', days: 1, busy, now: Date.parse('2026-11-15T00:00:00Z') })
  assert.deepEqual(later.map(x => x.state), ['free', 'busy', 'free']) // 11:20 − 10 min buffer touches 11:10 exactly: allowed
})

test('fitsSchedule rejects outside time, short notice and conflicts', () => {
  const s = S.validateSchedule({ ...base, breaks: [] })
  const now = Date.parse('2026-11-10T00:00:00Z')
  assert.deepEqual(S.fitsSchedule(s, '2026-11-16T09:00:00Z', '2026-11-16T09:30:00Z', { now }), { ok: true })
  assert.equal(S.fitsSchedule(s, '2026-11-16T12:30:00Z', '2026-11-16T13:00:00Z', { now }).reason, 'OUTSIDE_AVAILABILITY')
  assert.equal(S.fitsSchedule(s, '2026-11-16T09:00:00Z', '2026-11-16T09:30:00Z', { now: Date.parse('2026-11-16T08:00:00Z') }).ok, true)
  assert.equal(S.fitsSchedule({ ...s, noticeHours: 24 }, '2026-11-16T09:00:00Z', '2026-11-16T09:30:00Z', { now: Date.parse('2026-11-16T08:00:00Z') }).reason, 'NOTICE_TOO_SHORT')
  assert.equal(S.fitsSchedule(s, '2026-11-16T09:00:00Z', '2026-11-16T09:30:00Z', { now, busy: [{ start: '2026-11-16T09:35:00Z', end: '2026-11-16T10:00:00Z' }] }).reason, 'CONFLICT')
})

test('state machine: confirmed only after owner proposal and agent reconfirmation', () => {
  let st = 'REQUESTED'
  assert.throws(() => V.transition(st, 'confirm', 'agent'), /Cannot confirm/)
  assert.throws(() => V.transition(st, 'propose', 'agent'), e => e.code === 'NOT_ALLOWED')
  st = V.transition(st, 'propose', 'owner'); assert.equal(st, 'OWNER_SLOT_PROPOSED'); assert.equal(V.legacyStatus(st), 'pending')
  st = V.transition(st, 'ack_checking', 'agent'); assert.equal(st, 'AGENT_CLIENT_CONFIRMATION_PENDING'); assert.equal(V.legacyStatus(st), 'pending')
  assert.throws(() => V.transition(st, 'confirm', 'owner'), e => e.code === 'NOT_ALLOWED')
  st = V.transition(st, 'confirm', 'agent'); assert.equal(st, 'CONFIRMED'); assert.equal(V.legacyStatus(st), 'confirmed')
  assert.equal(V.transition(st, 'complete', 'agent'), 'COMPLETED')
  assert.equal(V.transition('RESCHEDULE_REQUESTED', 'propose', 'system'), 'OWNER_SLOT_PROPOSED')
  for (const f of V.FINAL) assert.throws(() => V.transition(f, 'cancel', 'owner'))
  assert.match(V.proposalMessage({ ref: 'A123', startsAt: '2026-11-20T15:00:00Z' }), /^Viewing slot proposed for #A123 on Fri 20 Nov at 4:00 PM\. Please confirm availability with your client and reconfirm in ARGUS\.$/)
})
