'use strict'
// Kev, 2026-10-19: "man kann es nicht bedienen, weil der Owner gerade dran ist".
// The board's Still available? / Ask was refused for 40 h after anybody typed in
// the owner chat ("a person is handling this owner right now"). Bot stand-downs
// must not block an agent's own explicit action; DNC and a complaint still do.
// Drives the REAL services/ownerSendGate.js; DB stubbed.
const assert = require('assert')
const path = require('path')
const Module = require('module')
let state = { autoStatus: 'human_paused', dnc: false }
const db = {
  query: async (q) => {
    if (/FROM owner_auto_conversations/.test(q)) return { rows: state.autoStatus ? [{ status: state.autoStatus, automation_disabled: false, updated_at: new Date() }] : [] }
    if (/FROM owner_assistant_state/.test(q)) return { rows: [] }
    if (/FROM owner_automation_blocks/.test(q)) return { rows: [] }
    if (/do_not_contact/.test(q)) return { rows: state.dnc ? [{ '?column?': 1 }] : [] }
    if (/settings WHERE key = 'owner_automation_mode'/.test(q)) return { rows: [{ value: 'LIVE' }] }
    if (/SELECT available_status FROM properties/.test(q)) return { rows: [{ available_status: 'available' }] }
    return { rows: [] }
  },
}
const original = Module._load
Module._load = function (r) {
  if (r === '../db') return db
  if (r === '../logger') return { info() {}, warn() {}, error() {}, debug() {} }
  return original.apply(this, arguments)
}
const gate = require(process.argv[2] || path.join(__dirname, '../services/ownerSendGate.js'))
const phone = '35699811819'
let passed = 0, failed = 0
const run = async (name, fn) => { try { await fn(); console.log(`  ok   ${name}`); passed++ } catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++ } }

;(async () => {
  await run('board Still available? while a human was in the chat → allowed', async () => {
    state = { autoStatus: 'human_paused', dnc: false }
    assert.deepEqual(await gate.checkOwnerSend({ phone, propertyId: 1, kind: 'check', automated: false }), { allow: true })
  })
  await run('automatic reachout in the same state → still blocked', async () => {
    assert.equal((await gate.checkOwnerSend({ phone, propertyId: 1, kind: 'check', automated: true })).allow, false)
  })
  await run('agent check after !ca (cancelled_chat) → allowed', async () => {
    state = { autoStatus: 'cancelled_chat', dnc: false }
    assert.equal((await gate.checkOwnerSend({ phone, propertyId: 1, kind: 'check', automated: false })).allow, true)
  })
  await run('owner complained (human_review_required) → blocked, with a clear reason', async () => {
    state = { autoStatus: 'human_review_required', dnc: false }
    const r = await gate.checkOwnerSend({ phone, propertyId: 1, kind: 'check', automated: false })
    assert.equal(r.allow, false)
    assert.match(gate.describeBlock(r.reason), /complained/)
  })
  await run('do-not-contact → blocked for everybody', async () => {
    state = { autoStatus: null, dnc: true }
    assert.equal((await gate.checkOwnerSend({ phone, propertyId: 1, kind: 'check', automated: false })).allow, false)
  })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})()
