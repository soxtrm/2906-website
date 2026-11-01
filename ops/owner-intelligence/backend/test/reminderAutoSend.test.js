'use strict'
// Kev, 2026-11-01 — automated reminder messages need an explicit switch AND an
// account with Auto on. REAL services/reminderOutreach.js on the test DB; the
// provider is stubbed (sends recorded, nothing leaves).
//   node --test test/reminderAutoSend.test.js
const test = require('node:test')
const assert = require('node:assert')
const H = require('./helpers/ownerHarness')
H.stubs.waha.getWorkingSessions = async () => [{ name: 'Kevsecond' }]
H.stubs['services/ownerRecheck'] = { recheckDueReminders: async () => ({ checked: 0 }) }
const R = H.load('services/reminderOutreach')

const OWNER = '35699000111'
async function queuedReminder() {
  return (await H.db.query(
    `INSERT INTO reminders (owner_phone, owner_name, original_note, contact_due_date, status, auto_send_enabled, auto_send_status, auto_send_for, assigned_session, contact_classification)
     VALUES ($1, 'Owner R', 'contact me in november', CURRENT_DATE, 'pending', TRUE, 'queued', NOW() - INTERVAL '1 minute', 'Kevsecond', 'owner') RETURNING id`, [OWNER])).rows[0].id
}
// The reminder window is 08:00–20:30 Malta; freeze the clock at 10:00.
function at10(fn) {
  const Real = Date
  const fixed = new Real(require('../services/outreachSchedule').maltaLocalToUTC(new Real().toISOString().slice(0, 10), '10:00'))
  global.Date = class extends Real { constructor(...a) { super(...(a.length ? a : [fixed.getTime()])) } static now() { return fixed.getTime() } }
  return Promise.resolve().then(fn).finally(() => { global.Date = Real })
}

test.beforeEach(async () => {
  await H.reset()
  await H.db.query(`TRUNCATE reminders RESTART IDENTITY CASCADE`)
  await H.db.query(`DELETE FROM settings WHERE key IN ('reminder_auto_send', 'owner_automation_mode')`)
  await H.owner(OWNER, 'Owner R')
  await H.account('Kevsecond', 'kev')
})

test('no switch → nothing is sent and nothing is staged (default after 2026-11-01)', async () => {
  await queuedReminder()
  const r = await at10(() => R.runDueAutoBatch({ limit: 5 }))
  assert.strictEqual(r.autoSendDisabled, true)
  assert.strictEqual(H.sent.length, 0)
  assert.strictEqual((await R.stageUnplannedReminders({ limit: 10 })).autoSendDisabled, true)
})

test('switch on but the account has Auto off → still nothing sent (reminder waits)', async () => {
  await H.db.query(`INSERT INTO settings (key, value) VALUES ('reminder_auto_send', 'ENABLED')`)
  const id = await queuedReminder()
  const r = await at10(() => R.runDueAutoBatch({ limit: 5 }))
  assert.deepStrictEqual(r.waiting.map(w => w.id), [id])
  assert.strictEqual(H.sent.length, 0)
})

test('switch on AND account Auto on → the reminder may go out (all owner gates still apply)', async () => {
  await H.db.query(`INSERT INTO settings (key, value) VALUES ('reminder_auto_send', 'ENABLED')`)
  await H.db.query(`UPDATE whatsapp_accounts SET outreach_auto_enabled = TRUE WHERE session_name = 'Kevsecond'`)
  await queuedReminder()
  const r = await at10(() => R.runDueAutoBatch({ limit: 5 }))
  assert.strictEqual(r.sent.length, 1, JSON.stringify(r))
  assert.strictEqual(H.sent.length, 1)
})

test('paused backlog rows are never picked up, even with everything enabled', async () => {
  await H.db.query(`INSERT INTO settings (key, value) VALUES ('reminder_auto_send', 'ENABLED')`)
  await H.db.query(`UPDATE whatsapp_accounts SET outreach_auto_enabled = TRUE`)
  const id = await queuedReminder()
  await H.db.query(`UPDATE reminders SET auto_send_status = 'paused_manual', auto_send_enabled = FALSE WHERE id = $1`, [id])
  const r = await at10(() => R.runDueAutoBatch({ limit: 5 }))
  assert.strictEqual(r.due, 0)
  assert.strictEqual(H.sent.length, 0)
})
