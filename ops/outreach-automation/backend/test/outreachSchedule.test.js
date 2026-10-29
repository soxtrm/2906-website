'use strict'
// Kev, 2026-10-29: send window, greeting period and DST for outreach.
//   node --test test/outreachSchedule.test.js
const test = require('node:test')
const assert = require('node:assert')
const S = require('../services/outreachSchedule')

const at = (date, time) => S.maltaLocalToUTC(date, time)

test('send window 08:30–19:30 Malta, cutoff exclusive (spec 15)', () => {
  const day = '2026-11-03'
  const cases = [
    ['08:29', false], ['08:30', true], ['11:59', true], ['12:00', true],
    ['17:59', true], ['18:00', true], ['19:29', true], ['19:30', false], ['20:30', false],
  ]
  for (const [time, allowed] of cases) assert.strictEqual(S.isSendAllowed(at(day, time)), allowed, time)
})

test('greeting period follows the send instant (spec 15)', () => {
  const day = '2026-11-03'
  const cases = [
    ['08:30', 'morning'], ['11:59', 'morning'], ['12:00', 'afternoon'],
    ['17:59', 'afternoon'], ['18:00', 'evening'], ['19:29', 'evening'],
  ]
  for (const [time, period] of cases) assert.strictEqual(S.greetingPeriod(at(day, time)), period, time)
})

test('prepared 11:30, sent 12:05 → afternoon; prepared evening, sent next morning → morning', () => {
  const prepared = 'Good morning! Kevin here. Have a lovely day!'
  const sent = S.normalizeGreeting(prepared, at('2026-11-03', '12:05'))
  assert.strictEqual(sent.text, 'Good afternoon! Kevin here. Have a lovely afternoon!')
  const evening = 'Good evening! Kevin here. Wishing you a pleasant evening!'
  const nextMorning = S.normalizeGreeting(evening, at('2026-11-04', '08:41'))
  assert.strictEqual(nextMorning.text, 'Good morning! Kevin here. Have a lovely day!')
})

test('never "Have a lovely evening" at 11:00, never "Good night" as opening', () => {
  const r = S.normalizeGreeting('Good night! Quick question. Have a lovely evening!', at('2026-11-03', '11:00'))
  assert.strictEqual(r.text, 'Good morning! Quick question. Have a lovely day!')
  assert.ok(!/evening|night/i.test(r.text))
})

test('body text untouched; texts without greeting stay as they are', () => {
  const body = 'Hi {name}, I have clients looking for a 2-bed in Sliema this evening.'
  const r = S.normalizeGreeting(body, at('2026-11-03', '09:00'))
  assert.strictEqual(r.text, body)
  assert.strictEqual(r.changed, false)
})

test('next window start: before 08:30 → today, from 19:30 → tomorrow, inside → now', () => {
  assert.strictEqual(S.nextSendWindowStart(at('2026-11-03', '06:10')).toISOString(), at('2026-11-03', '08:30').toISOString())
  assert.strictEqual(S.nextSendWindowStart(at('2026-11-03', '19:30')).toISOString(), at('2026-11-04', '08:30').toISOString())
  assert.strictEqual(S.nextSendWindowStart(at('2026-11-03', '23:50')).toISOString(), at('2026-11-04', '08:30').toISOString())
  const inside = at('2026-11-03', '10:00')
  assert.strictEqual(S.nextSendWindowStart(inside).toISOString(), inside.toISOString())
})

test('Europe/Malta DST: 08:30 is 06:30Z in summer, 07:30Z in winter; the window moves with it', () => {
  // 2026-10-25: clocks go back 03:00 CEST → 02:00 CET.
  assert.strictEqual(at('2026-10-24', '08:30').toISOString(), '2026-10-24T06:30:00.000Z') // CEST +2
  assert.strictEqual(at('2026-10-26', '08:30').toISOString(), '2026-10-26T07:30:00.000Z') // CET +1
  // 2027-03-28: clocks go forward 02:00 CET → 03:00 CEST.
  assert.strictEqual(at('2027-03-27', '19:30').toISOString(), '2027-03-27T18:30:00.000Z')
  assert.strictEqual(at('2027-03-29', '19:30').toISOString(), '2027-03-29T17:30:00.000Z')
  // The same UTC clock time is outside the window in winter but inside in summer.
  assert.strictEqual(S.isSendAllowed(new Date('2026-10-24T17:20:00Z')), true)   // 19:20 CEST
  assert.strictEqual(S.isSendAllowed(new Date('2026-10-26T18:40:00Z')), false)  // 19:40 CET
  assert.strictEqual(S.greetingPeriod(new Date('2026-10-26T10:59:00Z')), 'morning') // 11:59 CET
})

test('auto start time is a stable morning slot per account+day, varies across days', () => {
  const a = S.autoStartTime(8, '2026-11-03')
  assert.strictEqual(a, S.autoStartTime(8, '2026-11-03'))
  const times = new Set(['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'].map(d => S.autoStartTime(8, d)))
  assert.ok(times.size > 1, 'should vary across days')
  for (const t of times) {
    const [h, m] = t.split(':').map(Number)
    assert.ok(h * 60 + m >= 8 * 60 + 30 && h * 60 + m <= 9 * 60 + 15, t)
  }
})
