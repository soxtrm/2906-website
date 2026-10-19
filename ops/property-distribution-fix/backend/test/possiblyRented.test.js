'use strict'
// Kev, 2026-10-19: an owner's "it's rented" (reply to an availability check, or
// unprompted) no longer takes the listing off the board. It becomes "Rented?":
// pending_check with a "Possibly rented" reason, website / groups / Facebook
// untouched until an agent confirms. Drives the REAL availability.js; I/O stubbed.
//   node test/possiblyRented.test.js [path/to/availability.js]
const assert = require('assert')
const path = require('path')
const Module = require('module')

const sql = []
const boardCalls = []
const sends = []
const inert = new Proxy(function () {}, { get: (_, k) => (k === 'then' ? undefined : inert), apply: () => inert, construct: () => inert })
const db = {
  query: async (q, p = []) => {
    sql.push({ q: q.replace(/\s+/g, ' '), p })
    if (/SELECT 1 FROM properties/.test(q)) return { rows: [{ '?column?': 1 }] }
    if (/SELECT ac\.id\s+FROM availability_checks/.test(q)) return { rows: [{ id: 77 }] }
    if (/UPDATE properties\s+SET available_status = 'pending_check'/.test(q)) return { rows: [{ id: p[0] }] }
    if (/RETURNING/.test(q)) return { rows: [{ id: p[0] }] }
    return { rows: [] }
  },
}
const stubs = {
  '../db': db,
  '../logger': { info() {}, warn() {}, error() {}, debug() {} },
  '../config': { admin: { botNumber: '35699811819' }, waha: { session1: 'default' } },
  '../waha': new Proxy({}, { get: () => async (...a) => { sends.push(a); return {} } }),
  './humanDelay': { queueOwnerMessage: async () => ({ queued: true }), humanPauseMs: () => 0 },
  './boardAction': new Proxy({}, { get: (_, name) => (...a) => { boardCalls.push(name); return { ok: true, update: { sql: 'UPDATE properties SET available_status = \'rented\' RETURNING id', params: [] }, activity: { sql: 'SELECT 1', params: [] } } } }),
}
const original = Module._load
Module._load = function (request) {
  if (stubs[request]) return stubs[request]
  if (request.startsWith('.') || ['ioredis', 'bullmq', 'axios', '@google/genai', 'openai'].includes(request)) return inert
  return original.apply(this, arguments)
}
const av = require(process.argv[2] || path.join(__dirname, '../services/availability.js'))

let passed = 0, failed = 0
const run = async (name, fn) => { try { await fn(); console.log(`  ok   ${name}`); passed++ } catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++ } }
const reset = () => { sql.length = 0; boardCalls.length = 0; sends.length = 0 }
const assertRentedQuestion = (activityType) => {
  assert.ok(!boardCalls.includes('markRecentlyRented'), 'never marks it rented on the classifier alone')
  const upd = sql.find(s => /SET available_status = 'pending_check'/.test(s.q))
  assert.ok(upd, 'listing goes to pending_check')
  assert.match(upd.p[1], /^Possibly rented — owner said: "/, 'reason carries the "Possibly rented" prefix the board keys on')
  assert.ok(sql.some(s => /INSERT INTO property_activities/.test(s.q) && s.p[1] === activityType), `activity ${activityType} logged`)
  assert.ok(!sql.some(s => /published = FALSE/.test(s.q)), 'website stays published')
  assert.ok(!sends.some(a => /now rented/i.test(String(a[2] || ''))), 'no "now rented" correction in the groups')
}

;(async () => {
  await run('unprompted "it is rented" → Rented? (not rented)', async () => {
    reset()
    const out = await av.applyRentedVerdictFromOwnerChat({ propertyId: 501, ownerId: 9, ref: '2906-9501', ownerSession: 'default', ownerChat: '35699811819@c.us', replyMsgId: null, replyText: 'Hi, the flat is rented now' })
    assert.deepEqual(out, { applied: true })
    assertRentedQuestion('possibly_rented_via_owner_chat')
  })
  await run('reply to the availability check "rented" → Rented? (not rented)', async () => {
    reset()
    assert.ok(av.__onRented, 'onRented exported for tests')
    await av.__onRented({ id: 77, property_id: 501, ref: '2906-9501', available_status: 'available', reply_text: 'Rented sorry', account_session: 'default' }, { ownerSession: 'default', ownerChat: '35699811819@c.us', replyMsgId: 'm1' })
    assertRentedQuestion('possibly_rented_via_av')
  })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})()
