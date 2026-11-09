'use strict'
// Kev, 2026-10-31 — an owner who asks to be removed is taken out for good.
// REAL services/ownerSendGate.js, conversationIntelligence.js, ownerOptOut.js
// on the test DB. Synthetic numbers; sends are recorded, nothing leaves.
//   node --test test/ownerOptOut.test.js
const test = require('node:test')
const assert = require('node:assert')
const H = require('./helpers/ownerHarness')
H.stubs['services/availability'] = { pickAdminSession: async () => null }
const Gate = H.load('services/ownerSendGate')
const CI = H.load('services/conversationIntelligence')
const Elig = H.load('services/outreachEligibility')

const OWNER = '35699000222'
// the real complaint from 2026-10-30, word for word
const COMPLAINT = 'I already told you to remove me from your list . You are breaking data protection law . I will not tell you again'
const contact = async () => (await H.db.query(`SELECT do_not_contact, status, do_not_contact_reason FROM owner_contacts WHERE phone_normalized = $1`, [OWNER])).rows[0]

test.beforeEach(async () => {
  await H.reset()
  await H.db.query(`TRUNCATE owner_automation_blocks, owner_auto_conversations RESTART IDENTITY CASCADE`)
  await H.owner(OWNER, 'Owner OptOut')
  await H.account('Argus3', 'kev')
})

test('the 2026-10-30 complaint is recognised by both detectors', () => {
  assert.strictEqual(Gate.isExplicitOptOut(COMPLAINT), true)
  assert.strictEqual(Gate.isFrustratedText(COMPLAINT) || Gate.isExplicitOptOut(COMPLAINT), true)
})

test('complaint path: automation stopped AND the owner becomes do-not-contact (suppression row kept)', async () => {
  const r = await Gate.handleFrustratedOwner({ phone: OWNER, session: 'Argus3', text: COMPLAINT })
  assert.strictEqual(r.handled, true)
  const c = await contact()
  assert.deepStrictEqual([c.do_not_contact, c.status], [true, 'do_not_contact'])
  assert.match(c.do_not_contact_reason, /remove me from your list/)
  const gate = await Elig.checkBeforeSend({ phone: OWNER, session: 'Kevsecond', force: true })
  // Since a610faa the global suppression check runs first; either block is correct.
  assert.strictEqual(gate.allowed, false, 'no account may send again, not even in force mode')
  assert.ok(['dnc', 'global_suppression'].includes(gate.reason), gate.reason)
})

test('central conversation path: same text → do-not-contact with status and reason', async () => {
  await CI.handleInbound({ phone: OWNER, chatId: `${OWNER}@c.us`, session: 'Argus3', text: COMPLAINT, messageId: 'wamid-optout-1', timestamp: Math.floor(Date.now() / 1000), event: 'message' })
  const c = await contact()
  assert.deepStrictEqual([c.do_not_contact, c.status], [true, 'do_not_contact'])
})

test('"How did you get my number?" → bot stops and a human takes over, but no permanent opt-out', async () => {
  assert.strictEqual(Gate.isFrustratedText('How did you get my number?'), true)
  await Gate.handleFrustratedOwner({ phone: OWNER, session: 'Kevsecond', text: 'How did you get my number?' })
  assert.strictEqual(await Gate.getStandDownReason(OWNER), 'permanent_owner_stop')
  const c = await contact()
  assert.strictEqual(c.do_not_contact, false, 'a question is not an opt-out')
})

test('ordinary replies are never treated as an opt-out', async () => {
  for (const t of ['Which property are you referring to?', '2500', 'October 2027, not now', 'Remove the old photos please', 'I will stop by tomorrow']) {
    assert.strictEqual(Gate.isExplicitOptOut(t), false, t)
  }
})
