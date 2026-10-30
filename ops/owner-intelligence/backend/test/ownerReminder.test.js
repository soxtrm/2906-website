'use strict'
// Kev, 2026-10-30 — acceptance test D: "Contact me again in January" in
// October 2026 through the REAL services/reminderFromMessage.captureFromReply
// on the test DB. Nothing is sent to anyone.
//   node --test test/ownerReminder.test.js
const test = require('node:test')
const assert = require('node:assert')
const H = require('./helpers/ownerHarness')
const R = H.load('services/reminderFromMessage')
const D = H.load('services/reminderDetector')

const OWNER = '35699000888'
const OCT = new Date('2026-10-30T10:00:00Z')
let propertyId

test.beforeEach(async () => {
  await H.reset()
  await H.db.query(`TRUNCATE reminders RESTART IDENTITY CASCADE`)
  await H.db.query(`DELETE FROM agents WHERE username IN ('jason-test','listing-test')`)
  await H.db.query(`DELETE FROM properties WHERE ref IN ('2906-7001','2906-7002')`)
  const owner = await H.owner(OWNER, 'Enza')
  propertyId = (await H.db.query(`INSERT INTO properties (ref, owner_id, town) VALUES ('2906-7001', $1, 'St Julians') RETURNING id`, [owner.id])).rows[0].id
})

test('Test D: January 2027 window (month precision), linked to owner + property, availability unconfirmed, nothing sent', async () => {
  const id = await R.captureFromReply(OWNER, 'It may become available around January, depending on whether the current tenants renew. Contact me again in January.',
    { messageId: 'wamid-enza-1', now: OCT, ownerName: 'Enza' })
  assert.ok(id, 'reminder stored')
  const r = (await H.db.query(`SELECT * FROM reminders WHERE id = $1`, [id])).rows[0]
  const iso = d => d && new Date(d).toISOString().slice(0, 10)
  assert.strictEqual(iso(r.contact_due_date), '2027-01-01')
  assert.strictEqual(iso(r.due_window_end), '2027-01-31')
  assert.strictEqual(r.due_precision, 'month', 'not presented as an exact owner date')
  assert.strictEqual(r.availability_state, 'awaiting_tenant_decision', 'availability stays unconfirmed')
  assert.strictEqual(r.property_id, propertyId)
  assert.strictEqual(r.owner_name, 'Enza')
  assert.strictEqual(r.source_message_id, 'wamid-enza-1')
  assert.match(r.reason, /Owner said/)
  assert.strictEqual(H.sent.length, 0, 'no message sent')
})

test('the same message synchronised again does not create a second reminder', async () => {
  const text = 'Contact me again in January.'
  const a = await R.captureFromReply(OWNER, text, { messageId: 'wamid-x', now: OCT })
  const b = await R.captureFromReply(OWNER, text, { messageId: 'wamid-x', now: OCT })
  assert.ok(a)
  assert.strictEqual(b, null)
  assert.strictEqual((await H.db.query(`SELECT COUNT(*)::int n FROM reminders`)).rows[0].n, 1)
})

test('two listings for the owner → no guessed property link', async () => {
  const owner = (await H.db.query(`SELECT id FROM owner_contacts WHERE phone_normalized = $1`, [OWNER])).rows[0]
  await H.db.query(`INSERT INTO properties (ref, owner_id, town) VALUES ('2906-7002', $1, 'Gzira')`, [owner.id])
  const id = await R.captureFromReply(OWNER, 'Please check back next month.', { messageId: 'm2', now: OCT })
  assert.strictEqual((await H.db.query(`SELECT property_id FROM reminders WHERE id = $1`, [id])).rows[0].property_id, null)
})

test('the brief\'s phrases are understood; ordinary plans are not reminders', () => {
  const cases = {
    'Contact me again in January.': ['2027-01-01', 'month', 'contact_later'],
    'Please check back next month.': ['2026-11-30', 'month', 'contact_later'],
    'The tenants will decide next week.': ['2026-11-06', 'week', 'awaiting_tenant_decision'],
    'I might have something available in two months.': ['2026-12-30', 'month', 'possibly_available'],
    'Call me after the weekend.': ['2026-11-02', 'day', 'contact_later'],
    'Let me know closer to the end of the month.': ['2026-10-30', 'week', 'contact_later'],
  }
  for (const [text, [due, precision, availability]] of Object.entries(cases)) {
    const r = D.detectReminderPhrase(text, { now: OCT })
    assert.ok(r, text)
    assert.deepStrictEqual([r.dueAt, r.precision, r.availability], [due, precision, availability], text)
  }
  for (const text of ['next week I will be abroad', 'Our tenants are lovely', 'Thanks, see you!']) {
    assert.strictEqual(D.detectReminderPhrase(text, { now: OCT }), null, text)
  }
})
