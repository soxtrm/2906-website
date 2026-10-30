'use strict'
// Kev, 2026-10-30 — P0-3: while an agent handles an owner through the board
// relay, automated owner replies stand down (REAL services/ownerSendGate.js
// on the test DB). Agent actions themselves are still allowed.
//   node --test test/agentChat.test.js
const test = require('node:test')
const assert = require('node:assert')
const H = require('./helpers/ownerHarness')
const Gate = H.load('services/ownerSendGate')

const OWNER = '35699000555'
let propertyId

async function relay({ status = 'relaying', updatedHoursAgo = 0, chat = `${OWNER}@c.us` } = {}) {
  await H.db.query(
    `INSERT INTO book_relay_threads (property_id, ref, owner_chat_id, status, agent_name, agent_chat_id, agent_phone, agent_session, owner_session, owner_id, created_at, updated_at)
     VALUES ($4, '2906-9520', $1, $2, 'Jason', '35699000999@c.us', '35699000999', 'Argus1', 'Kevsecond', NULL, NOW(), NOW() - ($3 || ' hours')::interval)`, [chat, status, String(updatedHoursAgo), propertyId])
}

test.beforeEach(async () => {
  await H.reset()
  await H.db.query(`TRUNCATE book_relay_threads, owner_auto_conversations, owner_assistant_state, owner_automation_blocks RESTART IDENTITY CASCADE`)
  const owner = await H.owner(OWNER)
  await H.db.query(`DELETE FROM properties WHERE ref = '2906-9520'`)
  propertyId = (await H.db.query(`INSERT INTO properties (ref, owner_id, town) VALUES ('2906-9520', $1, 'St Julians') RETURNING id`, [owner.id])).rows[0].id
})

test('no relay → no stand-down', async () => {
  assert.strictEqual(await Gate.getStandDownReason(OWNER), null)
})

test('an active board relay (agent Jason writing to the owner) → automated replies stand down', async () => {
  await relay()
  assert.strictEqual(await Gate.getStandDownReason(OWNER), 'human_active')
  const automated = await Gate.checkOwnerSend({ phone: OWNER, kind: 'reply', automated: true })
  assert.strictEqual(automated.allow, false)
  assert.strictEqual(automated.reason, 'human_active')
})

test('the agent\'s own relay / viewing messages still go through', async () => {
  await relay()
  const viaRelay = await Gate.checkOwnerSend({ phone: OWNER, kind: 'relay' })
  assert.strictEqual(viaRelay.allow, true, JSON.stringify(viaRelay))
})

test('a closed relay, or one idle beyond the human window (40 h), hands the chat back to automation', async () => {
  await relay({ status: 'closed' })
  assert.strictEqual(await Gate.getStandDownReason(OWNER), null)
  await H.db.query(`TRUNCATE book_relay_threads CASCADE`)
  await relay({ updatedHoursAgo: 41 })
  assert.strictEqual(await Gate.getStandDownReason(OWNER), null)
})

test('stronger reasons keep precedence over the relay', async () => {
  await relay()
  await H.db.query(`INSERT INTO owner_automation_blocks (phone_normalized, reason, active) VALUES ($1, 'asked to stop', TRUE)`, [OWNER])
  assert.strictEqual(await Gate.getStandDownReason(OWNER), 'permanent_owner_stop')
})
