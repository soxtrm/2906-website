'use strict'
// Claude, 2026-11-09 — the four screenshot conversations through the REAL
// autoOwnerConversation.processStep worker on the isolated test DB. Sends are
// recorded by the harness (stubbed WAHA); nothing reaches WhatsApp.
//   node --test --require ./test/helpers/edgeStubs.js test/ownerTurnRouter.worker.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const H = require('./helpers/ownerHarness')
const Auto = H.load('services/autoOwnerConversation')

const OWNER = '35699000777'
const INTERROGATION_RE = /\bbed(?:room)?s?\b|\bbath(?:room)?s?\b|\brent per month\b/i

async function conversation(session, pending, status = 'active_collecting') {
  return (await H.db.query(
    `INSERT INTO owner_auto_conversations (phone, session, status, checklist)
     VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
    [OWNER, session, status, JSON.stringify({ _pending: pending })])).rows[0].id
}
const row = async id => (await H.db.query(`SELECT status, automation_disabled, checklist FROM owner_auto_conversations WHERE id=$1`, [id])).rows[0]

// The shared send gate keeps automated replies inside Malta business hours;
// pin the clock to a weekday afternoon so a send is permitted by time.
const RealDate = Date
function pinClock(iso) {
  const fixed = new RealDate(iso).getTime()
  global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [fixed])) } static now() { return fixed } }
}

test.beforeEach(async () => {
  await H.reset()
  await H.db.query(`DELETE FROM global_contact_suppressions`).catch(() => {})
  await H.owner(OWNER)
  pinClock('2026-11-10T13:30:00Z')
})
test.afterEach(() => { global.Date = RealDate })

test('Cedric screenshot: identity question gets the Cedric/QuickLets answer, never rent/bedrooms', async () => {
  await H.account('Cedric', 'cedric')
  const id = await conversation('Cedric', ['Thank you for contacting Gabriella!\nPlease let us know how we can help you.', 'are u an agent n malta', 'or u have ur own properties'])
  await Auto.processStep({ conversationId: id, phone: OWNER, session: 'Cedric' })
  assert.equal(H.sent.length, 1, JSON.stringify((await row(id)).checklist._last_action))
  assert.equal(H.sent[0].session, 'Cedric')
  assert.match(H.sent[0].text, /\bCedric\b/)
  assert.match(H.sent[0].text, /QuickLets/)
  assert.doesNotMatch(H.sent[0].text, /Gabriel+a|Kevin|2906/)
  assert.doesNotMatch(H.sent[0].text, INTERROGATION_RE)
  const r = await row(id)
  assert.equal(r.checklist._last_decision.route, 'ANSWER_QUESTION')
  assert.equal(r.checklist._last_decision.persona, 'cedric')
})

test('Gabriela screenshot: "who you represent … nothing for sale" is answered, not closed with "No worries"', async () => {
  await H.account('Gabriela', 'gabriela')
  const id = await conversation('Gabriela', ["Good evening Gabriela. I believe we haven't had contact before. Please let me who you represent or if you are by your own?\nHave at this time nothing for sale but might have for rent.\nRegards"])
  await Auto.processStep({ conversationId: id, phone: OWNER, session: 'Gabriela' })
  assert.equal(H.sent.length, 1)
  assert.match(H.sent[0].text, /Sotheby's/)
  assert.doesNotMatch(H.sent[0].text, /no worries|keep me posted/i)
  assert.equal((await row(id)).status, 'active_collecting', 'conversation stays open, not declined')
})

test('Gabriela follow-up complaint → automation stops for the chat, nothing sent', async () => {
  await H.account('Gabriela', 'gabriela')
  const id = await conversation('Gabriela', ['No worries??\nYes it is worries as you are unknown and not answer my question.\nThat’s not a good start.'])
  await Auto.processStep({ conversationId: id, phone: OWNER, session: 'Gabriela' })
  assert.equal(H.sent.length, 0)
  const r = await row(id)
  assert.equal(r.status, 'human_review_required')
  assert.equal(r.automation_disabled, true)
})

test('Kevin screenshot: illegal-number complaint → global suppression, owner do-not-contact, nothing sent', async () => {
  await H.account('default', 'kev')
  const id = await conversation('default', ['Sorry not interested.\nEspecially if an agent uses AI to respond to there messages.\nYou should even be contacting me as you obtained my number illegally.\nPlease remove my details from your database.'])
  await Auto.processStep({ conversationId: id, phone: OWNER, session: 'default' })
  assert.equal(H.sent.length, 0)
  const owner = (await H.db.query(`SELECT do_not_contact, status FROM owner_contacts WHERE phone_normalized=$1`, [OWNER])).rows[0]
  assert.deepEqual([owner.do_not_contact, owner.status], [true, 'do_not_contact'])
  const sup = (await H.db.query(`SELECT COUNT(*)::int n FROM global_contact_suppressions WHERE active`)).rows[0].n
  assert.equal(sup, 1)
  assert.equal((await row(id)).automation_disabled, true)
  // Another account cannot reach the same owner afterwards.
  await H.account('Cedric', 'cedric')
  const gate = await H.load('services/ownerSendGate').checkOwnerSend({ phone: OWNER, session: 'Cedric', kind: 'reply', automated: true, reviewRequired: false })
  assert.equal(gate.allow, false)
})

test('an unverified persona is held for a person instead of naming a firm', async () => {
  await H.account('Olga', 'olga')
  const id = await conversation('Olga', ['Which agency do you work for?'])
  await Auto.processStep({ conversationId: id, phone: OWNER, session: 'Olga' })
  assert.equal(H.sent.length, 0)
  const r = await row(id)
  assert.equal(r.checklist._last_decision.holdReason, 'sender_persona_unknown')
  assert.ok(r.checklist._owner_question_needs_human)
})

test('a repeated identity question gets one short restatement, the third goes to a person', async () => {
  await H.account('default', 'kev')
  const ask = async () => {
    const r = await H.db.query(`SELECT id FROM owner_auto_conversations WHERE phone=$1 ORDER BY id DESC LIMIT 1`, [OWNER])
    await H.db.query(`UPDATE owner_auto_conversations SET checklist = checklist || '{"_pending":["Which agency do you work for?"]}'::jsonb WHERE id=$1`, [r.rows[0].id])
    await Auto.processStep({ conversationId: r.rows[0].id, phone: OWNER, session: 'default' })
  }
  await conversation('default', [])
  await ask(); await ask(); await ask()
  assert.equal(H.sent.length, 2)
  assert.notEqual(H.sent[0].text, H.sent[1].text)
})

test('human takeover: a clear offer becomes one private staging draft, nothing sent, never published', async () => {
  // writeEntityDraft files drafts under agent 1 (production's owner account).
  await H.db.query(`INSERT INTO agents (id, username) VALUES (1, 'test-agent-1') ON CONFLICT (id) DO NOTHING`)
  const first = await Auto.passiveIntakeDuringTakeover(OWNER, 'I have a two bedroom apartment in Sliema available in December.', 'human_paused')
  const again = await Auto.passiveIntakeDuringTakeover(OWNER, 'I have a two bedroom apartment in Sliema available in December.', 'human_paused')
  assert.ok(first)
  assert.equal(again, first, 'no duplicate draft')
  const p = (await H.db.query(`SELECT town, bedrooms, published, is_staging, available_status FROM properties WHERE id=$1`, [first])).rows[0]
  assert.deepEqual([p.town, p.bedrooms, p.published, p.is_staging, p.available_status], ['Sliema', 2, false, true, 'pending_check'])
  assert.equal(H.sent.length, 0)
  assert.equal(await Auto.passiveIntakeDuringTakeover(OWNER, 'Please remove my number from your database', 'human_paused'), null)
})
