'use strict'
// Kev, 2026-10-30 — acceptance tests B, C and H through the REAL
// services/conversationIntelligence.handleInbound on the isolated test DB.
// Sends are recorded by the harness; nothing reaches WhatsApp.
//   node --test test/ownerIdentity.test.js
const test = require('node:test')
const assert = require('node:assert')
const H = require('./helpers/ownerHarness')
const CI = H.load('services/conversationIntelligence')
const Policy = H.load('services/conversationPolicy')
const Registry = H.load('services/agentIdentityRegistry')

const OWNER = '35699000123'
const chat = `${OWNER}@c.us`
let n = 0
const inbound = (session, text, id = `wamid-${++n}`) =>
  CI.handleInbound({ phone: OWNER, chatId: chat, session, text, messageId: id, timestamp: Math.floor(Date.now() / 1000), event: 'message' })

test.beforeEach(async () => {
  await H.reset()
  await H.owner(OWNER)
})

test('Test B: "Which company are you representing?" — one truthful answer, a short one if asked again, then nothing', async () => {
  await H.account('default', 'kev')
  const first = await inbound('default', 'Which company are you representing?')
  assert.strictEqual(first.replySent, true)
  assert.strictEqual(H.sent[0].text, Registry.PERSONA_IDENTITIES.kev.introAnswer)
  assert.match(H.sent[0].text, /self-employed real estate agent working with 2906 Estate, a collective of independent/)
  assert.doesNotMatch(H.sent[0].text, /employ(?:ed|ee) (?:by|of)|representing 2906/i)
  await inbound('default', 'Sorry, which company did you say?')
  assert.strictEqual(H.sent[1].text, Registry.PERSONA_IDENTITIES.kev.shortIntroAnswer)
  const third = await inbound('default', 'What agency are you with?')
  assert.strictEqual(H.sent.length, 2, 'no third explanation')
  assert.strictEqual(third.suppressAutomation, true, 'the other reply path must not answer either')
})

test('Test H: the same inbound event delivered twice → one conversation update, one reply', async () => {
  await H.account('default', 'kev')
  const a = await inbound('default', 'Which company are you with?', 'wamid-dup')
  const b = await inbound('default', 'Which company are you with?', 'wamid-dup')
  assert.strictEqual(a.replySent, true)
  assert.strictEqual(b.duplicate, true)
  assert.strictEqual(H.sent.length, 1)
  const revisions = (await H.db.query(`SELECT COUNT(*)::int n FROM conversation_message_revisions`)).rows[0].n
  assert.strictEqual(revisions, 1)
})

test('Test C: Kevin\'s email comes from the verified config; Cedric and Gabriela get a human, never a guess', async () => {
  await H.account('Argus3', 'kev')
  await H.account('Cedric', 'cedric')
  await H.account('Gabriela', 'gabriela')
  const k = await inbound('Argus3', 'Could you send me your email address please?')
  assert.strictEqual(k.replySent, true)
  assert.strictEqual(H.sent[0].text, 'Of course, my email is kevinsony1@gmail.com.')
  for (const s of ['Cedric', 'Gabriela']) {
    await H.db.query(`TRUNCATE conversation_outbound_guard, conversation_message_revisions, conversation_facts, conversation_intelligence_state RESTART IDENTITY CASCADE`)
    const before = H.sent.length
    const r = await inbound(s, "What's your email?")
    assert.strictEqual(H.sent.length, before, `${s}: nothing sent`)
    assert.strictEqual(r.suppressAutomation, true, `${s}: the LLM path may not answer it`)
    const human = (await H.db.query(`SELECT human_active FROM conversation_intelligence_state ORDER BY id DESC LIMIT 1`)).rows[0]
    assert.strictEqual(human.human_active, true, `${s}: handed to a human`)
  }
})

test('no outgoing draft may carry an email the sender has not verified', () => {
  const kev = Registry.PERSONA_IDENTITIES.kev
  const ok = Policy.validateDraft({ draft: 'Sure, you can reach me at kevinsony1@gmail.com.', identity: kev })
  assert.strictEqual(ok.allow, true)
  for (const fake of ['kevin@2906.estate', 'kevin.eich@gmail.com', 'contact@2906.estate']) {
    const r = Policy.validateDraft({ draft: `Sure, write to ${fake}.`, identity: kev })
    assert.deepStrictEqual([r.allow, r.reason], [false, 'unverified_email'], fake)
  }
  assert.strictEqual(Policy.validateDraft({ draft: 'Write to cedric@quicklets.com', identity: Registry.PERSONA_IDENTITIES.cedric }).allow, false)
})

test('Cedric and Gabriela keep their own agency — never Kevin\'s identity', async () => {
  await H.account('Cedric', 'cedric')
  await inbound('Cedric', 'Which agency are you from?')
  assert.match(H.sent[0].text, /Cedric Reiter.*QuickLets/)
  assert.doesNotMatch(H.sent[0].text, /2906|Kevin/)
})
