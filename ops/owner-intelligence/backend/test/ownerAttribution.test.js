'use strict'
// Kev, 2026-10-31 — owner ↔ agent attribution acceptance tests on the test DB,
// REAL services/ownerAttribution.js + ownerSendGate + the chat-start trigger.
// Synthetic owners and accounts only.
//   node --test test/ownerAttribution.test.js
const test = require('node:test')
const assert = require('node:assert')
const H = require('./helpers/ownerHarness')
const A = H.load('services/ownerAttribution')

const OWNER = '35699000444'
let owner
const ago = h => new Date(Date.now() - h * 3600000)

async function label(session, { createdH = 100, sentH = null, replyH = null, source = 'outreach' } = {}) {
  await H.db.query(
    `INSERT INTO owner_account_labels (contact_id, account_session, label, source, created_at, last_we_sent_at, last_reply_at, total_msgs_out, total_msgs_in)
     VALUES ($1, $2, 'cold', $3, $4, $5, $6, 1, $7)`,
    [owner.id, session, source, ago(createdH), sentH == null ? null : ago(sentH), replyH == null ? null : ago(replyH), replyH == null ? 0 : 1])
}
const attr = async () => (await A.loadFor([owner.id])).get(owner.id)

test.beforeEach(async () => {
  await H.reset()
  await H.db.query(`TRUNCATE owner_account_labels, owner_chat_events, owner_assignment_events, book_relay_threads, owner_auto_conversations RESTART IDENTITY CASCADE`)
  await H.db.query(`DELETE FROM agents WHERE username LIKE 'attr-%'`)
  for (const [s, p] of [['Cedric', 'cedric'], ['Olga', 'olga'], ['default', 'kev'], ['Kevsecond', 'kev'], ['Mystery', null]]) await H.account(s, p)
  owner = await H.owner(OWNER, 'Owner Attr')
})

test('contacted from the Cedric account → "Contacted by Cedric", right account, initiator and last sender; not Olga, not Kevin', async () => {
  await label('Cedric', { createdH: 50, sentH: 50 })
  const a = await attr()
  assert.deepStrictEqual([a.contactedBy.person, a.contactedBy.account], ['Cedric', 'Cedric'])
  assert.deepStrictEqual([a.lastMessageBy.person, a.lastMessageBy.account], ['Cedric', 'Cedric'])
  assert.strictEqual(a.accounts.length, 1)
  assert.doesNotMatch(JSON.stringify(a), /Olga|Kevin/)
  assert.strictEqual(a.status, 'awaiting_owner')
})

test('two agents at different times → both histories, initiator kept, last sender updated, identity conflict flagged', async () => {
  await label('Cedric', { createdH: 300, sentH: 200 })
  await label('Kevsecond', { createdH: 20, sentH: 10 })
  const a = await attr()
  assert.deepStrictEqual(a.accounts.map(x => [x.account, x.person]).sort(), [['Cedric', 'Cedric'], ['Kevsecond', 'Kevin']])
  assert.strictEqual(a.contactedBy.person, 'Cedric', 'the first contact is not overwritten by the later one')
  assert.strictEqual(a.lastMessageBy.person, 'Kevin')
  assert.deepStrictEqual(a.identityConflict.sort(), ['Cedric', 'Kevin'])
})

test('owner replied after our last message → Agent action needed / reply needed, on the account the owner wrote to', async () => {
  await label('Cedric', { createdH: 40, sentH: 30, replyH: 2 })
  const a = await attr()
  assert.deepStrictEqual([a.status, a.replyNeeded, a.lastOwnerReply.account], ['agent_action_needed', true, 'Cedric'])
})

test('no fake activity: an old outgoing message is "No response", nobody is "handling"; a live board relay is a human takeover by that agent', async () => {
  await label('default', { createdH: 400, sentH: 300 })
  let a = await attr()
  assert.deepStrictEqual([a.status, a.handlingNow], ['no_response', null])
  const prop = (await H.db.query(`INSERT INTO properties (ref, owner_id, town) VALUES ('2906-T201', $1, 'Mellieha') RETURNING id`, [owner.id])).rows[0]
  await H.db.query(`DELETE FROM properties WHERE ref = '2906-T201' AND id <> $1`, [prop.id])
  await label('Cedric', { createdH: 3, sentH: 1 })
  await H.db.query(
    `INSERT INTO book_relay_threads (property_id, ref, owner_id, owner_chat_id, status, agent_name, agent_chat_id, agent_session, updated_at)
     VALUES ($1, '2906-T201', $2, $3, 'relaying', 'Jason', '35699000999@c.us', 'Argus1', NOW())`, [prop.id, owner.id, `${OWNER}@c.us`])
  a = await attr()
  assert.strictEqual(a.status, 'human_takeover')
  assert.deepStrictEqual([a.handlingNow.name, a.handlingNow.via], ['Jason', 'board relay'])
  await H.db.query(`DELETE FROM book_relay_threads`)
  await H.db.query(`DELETE FROM properties WHERE ref = '2906-T201'`)
})

test('an account without persona or bound agent is UNKNOWN, never a guessed agent', async () => {
  await label('Mystery', { createdH: 10, sentH: 5 })
  const a = await attr()
  assert.strictEqual(a.contactedBy.person, 'UNKNOWN')
})

test('an agent bound to an account is named instead of the persona', async () => {
  await H.db.query(`INSERT INTO agents (username, name, role, active, whatsapp_session) VALUES ('attr-tanja', 'Tanja', 'agent', TRUE, 'Kevsecond')`)
  await label('Kevsecond', { createdH: 10, sentH: 5 })
  assert.strictEqual((await attr()).contactedBy.person, 'Tanja')
})

test('manual reassignment is audited and never erases the earlier handler', async () => {
  const admin = (await H.db.query(`INSERT INTO agents (username, name, role, active) VALUES ('attr-admin', 'Admin', 'admin', TRUE) RETURNING *`)).rows[0]
  const tanja = (await H.db.query(`INSERT INTO agents (username, name, role, active) VALUES ('attr-tanja2', 'Tanja', 'agent', TRUE) RETURNING *`)).rows[0]
  await label('Cedric', { createdH: 10, sentH: 5 })
  let a = await A.assign(owner.id, { session: 'Cedric', reason: 'Cedric started it', actor: admin })
  assert.deepStrictEqual([a.assignedTo.person, a.assignedTo.account], ['Cedric', 'Cedric'])
  a = await A.assign(owner.id, { agentId: tanja.id, reason: 'handover', actor: admin })
  assert.strictEqual(a.assignedTo.person, 'Tanja')
  const events = (await H.db.query(`SELECT from_session, to_agent_id, to_session, actor_name FROM owner_assignment_events WHERE contact_id = $1 ORDER BY id`, [owner.id])).rows
  assert.deepStrictEqual(events, [
    { from_session: null, to_agent_id: null, to_session: 'Cedric', actor_name: 'Admin' },
    { from_session: 'Cedric', to_agent_id: tanja.id, to_session: null, actor_name: 'Admin' },
  ])
  assert.strictEqual(a.contactedBy.person, 'Cedric', 'initiator unchanged by assignment')
})

test('"new owner chat started" is recorded for every account that opens a conversation (trigger)', async () => {
  await label('Cedric', { createdH: 10, sentH: 9, source: 'first_contact' })
  await label('default', { createdH: 2, sentH: 1 })
  const ev = (await H.db.query(`SELECT kind, account, source FROM owner_chat_events WHERE contact_id = $1 ORDER BY created_at`, [owner.id])).rows
  assert.deepStrictEqual(ev, [
    { kind: 'new_owner_chat', account: 'Cedric', source: 'first_contact' },
    { kind: 'new_owner_chat', account: 'default', source: 'outreach' },
  ])
})
