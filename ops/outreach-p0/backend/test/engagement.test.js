'use strict'
// Kev, 2026-10-29: engagement metrics, Call Candidates segment, automatic
// stop after N unanswered attempts, account list pace display.
//   node --test test/engagement.test.js
const test = require('node:test')
const assert = require('node:assert')
const H = require('./helpers/harness')
const E = H.load('services/outreachEngagement')
const Elig = H.load('services/outreachEligibility')
const P = H.load('services/outreachPlanner')

const DAY = 86400000
async function sends(phone, n, { session = 'default', replied = false, start = Date.now() - 60 * DAY } = {}) {
  for (let i = 0; i < n; i++) {
    await H.db.query(`INSERT INTO outreach_log(phone, account_used, sent_at, replied) VALUES ($1,$2,$3,$4)`,
      [phone, session, new Date(start + i * 7 * DAY), replied && i === n - 1])
  }
}

test.beforeEach(async () => {
  await H.reset()
  await H.db.query(`UPDATE outreach_settings SET value = '5'::jsonb WHERE key = 'engagement.no_reply_review_after'`)
})

test('engagement: thresholds 1/3/5/6/7, reply rate, opted-out owners counted apart', async () => {
  await H.contact('35610000001'); await sends('35610000001', 1)
  await H.contact('35610000003'); await sends('35610000003', 3)
  await H.contact('35610000006'); await sends('35610000006', 6)
  await H.contact('35610000007'); await sends('35610000007', 7, { replied: true })
  await H.contact('35610000009', { status: 'do_not_contact' }); await sends('35610000009', 5)
  const o = await E.overview()
  assert.strictEqual(o.ownersContacted, 5)
  assert.strictEqual(o.ownersReplied, 1)
  assert.strictEqual(o.replyRate, 20)
  assert.strictEqual(o.optedOut, 1)
  assert.deepStrictEqual(o.noReplyByAttempts, [
    { attempts: 1, owners: 3 }, { attempts: 3, owners: 2 }, { attempts: 5, owners: 1 },
    { attempts: 6, owners: 1 }, { attempts: 7, owners: 0 },
  ])
})

test('Call Candidates: no reply after >= 3 attempts; opted-out, blocked, angry and replied owners are never listed', async () => {
  await H.contact('35620000001'); await sends('35620000001', 4)
  await H.contact('35620000002'); await sends('35620000002', 2)
  await H.contact('35620000003', { do_not_contact: true }); await sends('35620000003', 4)
  await H.contact('35620000004'); await sends('35620000004', 4)
  await H.db.query(`INSERT INTO owner_automation_blocks(phone_normalized, reason, active) VALUES ('35620000004','asked to stop',TRUE)`)
  const angry = await H.contact('35620000005'); await sends('35620000005', 4)
  await H.db.query(`INSERT INTO owner_account_labels(contact_id, account_session, label) VALUES ($1,'default','angry')`, [angry.id])
  await H.contact('35620000006', { last_reply_at: new Date() }); await sends('35620000006', 4)
  const r = await E.callCandidates()
  assert.strictEqual(r.minAttempts, 3)
  assert.deepStrictEqual(r.candidates.map(c => c.phone), ['35620000001'])
  const six = await E.callCandidates({ minAttempts: 6 })
  assert.strictEqual(six.candidates.length, 0)
})

test('automation stops at the review threshold (5): 4 unanswered → allowed, 5 → refused', async () => {
  await H.account({ session: 'default', persona: 'kev' })
  await H.contact('35630000001'); await sends('35630000001', 4, { start: Date.now() - 200 * DAY })
  const four = await Elig.checkBeforeSend({ phone: '35630000001', session: 'default' })
  assert.strictEqual(four.allowed, true, JSON.stringify(four))
  await sends('35630000001', 1, { start: Date.now() - 100 * DAY })
  const five = await Elig.checkBeforeSend({ phone: '35630000001', session: 'default' })
  assert.deepStrictEqual([five.allowed, five.reason], [false, 'no_reply_limit_reached'])
  await H.db.query(`UPDATE outreach_settings SET value = '7'::jsonb WHERE key = 'engagement.no_reply_review_after'`)
  assert.strictEqual((await Elig.checkBeforeSend({ phone: '35630000001', session: 'default' })).allowed, true)
})

test('account list shows the saved pace even after an old expiry passed (was: 100)', async () => {
  const acc = await H.account({ session: 'default', persona: 'kev', pace: 33 })
  await H.db.query(`UPDATE whatsapp_accounts SET outreach_volume_until = NOW() - INTERVAL '2 days', outreach_pace_min = NULL, outreach_pace_max = NULL WHERE id = $1`, [acc.id])
  const row = (await P.listAccounts()).find(a => a.id === acc.id)
  assert.strictEqual(row.outreachVolumePercent, 33)
  assert.strictEqual(row.quotaToday.cap, 40)
  assert.strictEqual(row.planningDays.length, 5)
})

test('old volume API with days=1 no longer creates an expiring pace', async () => {
  const acc = await H.account({ session: 'default', persona: 'kev', pace: 100 })
  await P.setAccountVolume(acc.id, 30, 1)
  const row = (await H.db.query(`SELECT outreach_volume_percent, outreach_volume_until, outreach_pace_min, outreach_pace_max FROM whatsapp_accounts WHERE id=$1`, [acc.id])).rows[0]
  assert.deepStrictEqual(row, { outreach_volume_percent: 30, outreach_volume_until: null, outreach_pace_min: 30, outreach_pace_max: 30 })
})
