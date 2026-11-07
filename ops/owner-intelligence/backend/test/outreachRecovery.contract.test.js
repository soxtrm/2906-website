'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const H = require('./helpers/ownerHarness')

const OptOut = H.load('services/ownerOptOut')
const Auto = H.load('services/autoOwnerConversation')
const Schedule = H.load('services/outreachSchedule')

test('suppression identity is deterministic, minimum-data and account-independent', () => {
  const a = OptOut.identityHash('+356 9900 0222')
  const b = OptOut.identityHash('35699000222')
  assert.equal(a, b)
  assert.match(a, /^[a-f0-9]{64}$/)
  assert.equal(a.includes('99000222'), false)
  assert.equal(OptOut.requestTypeFor('remove my data from your database'), 'ERASURE')
  assert.equal(OptOut.requestTypeFor('do not contact me'), 'STOP_CONTACT')
})

test('AI reply delay defaults to 120–180 seconds and never draws outside the range', () => {
  assert.deepEqual(Auto.normalizeReplyDelay(undefined, undefined), { min:120, max:180 })
  assert.equal(Auto.drawReplyDelayMs({ min:120,max:180 }, () => 0), 120000)
  assert.equal(Auto.drawReplyDelayMs({ min:120,max:180 }, () => 0.999999), 180000)
})

test('14-day preview preserves baseline and uses +15 minute progression', () => {
  const p = Schedule.buildSchedulePreview({ baseDate:'2026-11-07',baseTime:'14:55',days:4 })
  assert.deepEqual(p.days.map(d => d.time), ['14:55','15:10','15:25','15:40'])
  assert.equal(p.timezone, 'Europe/Malta')
})

test('cutoff produces an explicit cooldown then resets to the baseline', () => {
  const p = Schedule.buildSchedulePreview({ baseDate:'2026-11-07',baseTime:'18:45',days:4,dailyShiftMinutes:15 })
  assert.deepEqual(p.days.map(d => [d.status,d.time]), [
    ['eligible','18:45'],['eligible','19:00'],['cooldown',null],['eligible','18:45'],
  ])
})

test('migration and routes expose privacy workflow, pending reply time and preview', () => {
  const migration = fs.readFileSync(path.join(H.ROOT,'migrations','20261107_outreach_recovery.sql'),'utf8')
  assert.match(migration,/global_contact_suppressions/)
  assert.match(migration,/owner_privacy_requests/)
  assert.match(migration,/scheduled_response_at/)
  const route = fs.readFileSync(path.join(H.ROOT,'routes','crm.js'),'utf8')
  assert.match(route,/outreach\/schedule\/preview/)
  assert.match(route,/outreach\/safety/)
})
