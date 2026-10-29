'use strict'
// Kev, 2026-10-29: drives the REAL runDirectOutreach (services/adminCommands.js)
// against a real Postgres with a controllable clock. No WhatsApp is reached:
// waha.sendText is recorded by the harness.
//   node --test test/dispatch.test.js   (inside the isolated test container)
const test = require('node:test')
const assert = require('node:assert')
const H = require('./helpers/harness')
const S = H.load('services/outreachSchedule')
const Pace = H.load('services/outreachPace')
const Quota = H.load('services/outreachQuota')
const Templates = H.load('services/outreachTemplates')
const { runDirectOutreach } = H.load('services/adminCommands')
const { TEMPLATES } = H.load('services/outreachTemplateSeed')

const ADMIN = '35699811819'
const at = (d, t) => S.maltaLocalToUTC(d, t)
const DAY = '2026-11-03'
const ownerSends = () => H.sent.filter(m => m.phone !== ADMIN)

// A clock that advances by `stepMin` minutes every time the dispatcher reads it
// after a pause; the real delays are skipped.
function clock(start, stepMin = 0) {
  let t = start.getTime()
  return {
    now: () => new Date(t),
    sleep: async () => { t += stepMin * 60_000 },
  }
}

async function send(session, contacts, template, extra = {}) {
  const c = extra.clock || clock(at(DAY, '10:00'))
  return runDirectOutreach(ADMIN, session, session, contacts, template, {
    suppressMirroredProgress: true, pacingType: 'cold', now: c.now, sleep: c.sleep, ...extra,
  })
}

test.beforeEach(async () => {
  await H.reset()
  await Templates.ensureSeed()
})

test('pace: a saved 33 with an expired override stays 33 (never 100)', async () => {
  const acc = await H.account({ session: 'Argus2', persona: 'kev', pace: 33 })
  // Legacy shape: no range yet, expiry in the past (the Argus2/Gabriela rows).
  await H.db.query(`UPDATE whatsapp_accounts SET outreach_pace_min=NULL, outreach_pace_max=NULL, outreach_volume_until=NOW() - INTERVAL '30 days' WHERE id=$1`, [acc.id])
  const p = await Pace.resolvePace(acc.id)
  assert.strictEqual(p.percent, 33)
  await H.contact('35670000001')
  const r = await send('Argus2', [{ phone: '35670000001', name: 'A' }], 'Good morning! Kevin here.')
  assert.strictEqual(r.volumePercent, 33)
  const batch = (await H.db.query(`SELECT volume_percent_snapshot FROM outreach_batches ORDER BY id DESC LIMIT 1`)).rows[0]
  assert.strictEqual(batch.volume_percent_snapshot, 33)
})

test('pace: saving 30 survives reload and repeated reads; a range draws inside it', async () => {
  const acc = await H.account({ session: 'default', persona: 'kev', pace: 100 })
  await Pace.setAccountPace(acc.id, { min: 30 })
  for (let i = 0; i < 5; i++) assert.strictEqual((await Pace.resolvePace(acc.id)).percent, 30)
  await Pace.setAccountPace(acc.id, { min: 28, max: 40 })
  const draws = new Set()
  for (let i = 0; i < 40; i++) {
    const v = (await Pace.resolvePace(acc.id)).percent
    assert.ok(v >= 28 && v <= 40, String(v))
    draws.add(v)
  }
  assert.ok(draws.size > 3, 'range should vary between runs')
  const row = (await H.db.query(`SELECT outreach_volume_until FROM whatsapp_accounts WHERE id=$1`, [acc.id])).rows[0]
  assert.strictEqual(row.outreach_volume_until, null)
})

test('pace: unreadable setting refuses the run instead of sending at 100', async () => {
  await H.account({ session: 'Ghost', persona: 'kev', pace: 30 })
  await H.db.query(`UPDATE whatsapp_accounts SET outreach_volume_percent = 30, outreach_pace_min = NULL, outreach_pace_max = NULL`)
  await H.db.query(`ALTER TABLE whatsapp_accounts RENAME COLUMN outreach_pace_min TO outreach_pace_min_x`)
  try {
    const r = await send('Ghost', [{ phone: '35670000002', name: 'B' }], 'Good morning!')
    assert.strictEqual(r.refused, 'pace_unavailable')
    assert.strictEqual(ownerSends().length, 0)
  } finally {
    await H.db.query(`ALTER TABLE whatsapp_accounts RENAME COLUMN outreach_pace_min_x TO outreach_pace_min`)
  }
})

test('window: nothing starts at 08:29, 19:30 or 20:30; 08:30 sends', async () => {
  await H.account({ session: 'default', persona: 'kev' })
  for (const time of ['08:29', '19:30', '20:30']) {
    await H.contact(`3567100${time.replace(':', '')}`)
    const r = await send('default', [{ phone: `3567100${time.replace(':', '')}`, name: 'X' }], 'Good morning!', { clock: clock(at(DAY, time)) })
    assert.strictEqual(r.deferred, 'outside_send_window', time)
    assert.ok(r.resumeAt instanceof Date)
  }
  assert.strictEqual(ownerSends().length, 0)
  // A run that wakes at 08:29 is deferred as a whole (the scheduler starts it
  // again at 08:30); a run started at 08:30 sends.
  await H.contact('35671000830')
  const ok = await send('default', [{ phone: '35671000830', name: 'X' }], 'Good morning!', { clock: clock(at(DAY, '08:30')) })
  assert.strictEqual(ok.sent, 1)
})

test('window: a run crossing 19:30 stops at the cutoff and resumes 08:30 next morning', async () => {
  await H.account({ session: 'Gabriela', persona: 'gabriela' })
  const phones = ['35672000001', '35672000002', '35672000003']
  for (const p of phones) await H.contact(p)
  const r = await send('Gabriela', phones.map(p => ({ phone: p, name: 'O' })), 'Good evening! Gabriela here.', { clock: clock(at(DAY, '19:27'), 2) })
  assert.strictEqual(r.sent, 1)      // 19:29 → sent; 19:31 → cutoff
  assert.strictEqual(r.deferred, 'outside_send_window')
  assert.strictEqual(r.resumeAt.toISOString(), at('2026-11-04', '08:30').toISOString())
  assert.strictEqual(ownerSends().length, 1)
})

test('greeting: free text prepared in the evening, sent next morning, says good morning', async () => {
  await H.account({ session: 'default', persona: 'kev' })
  await H.contact('35673000001')
  await send('default', [{ phone: '35673000001', name: 'O' }],
    'Good evening! Just a quick message from Kevin. Wishing you a pleasant evening!', { clock: clock(at('2026-11-04', '08:40')) })
  assert.strictEqual(ownerSends()[0].text, 'Good morning! Just a quick message from Kevin. Have a lovely day!')
})

test('greeting: prepared 11:30, sent 12:05 → afternoon', async () => {
  await H.account({ session: 'default', persona: 'kev' })
  await H.contact('35673000002')
  await send('default', [{ phone: '35673000002', name: 'O' }], 'Good morning! Kevin here. Have a lovely day!', { clock: clock(at(DAY, '12:05')) })
  assert.strictEqual(ownerSends()[0].text, 'Good afternoon! Kevin here. Have a lovely afternoon!')
})

async function rotationPlan(acc, slot) {
  return (await H.db.query(
    `INSERT INTO outreach_plans(account_id, session_name, scheduled_date, message_template, message_mode, template_slot, status)
     VALUES ($1,$2,$3,'placeholder','persona_rotation',$4,'running') RETURNING *`,
    [acc.id, acc.session_name, DAY, slot])).rows[0]
}

test('persona rotation renders the slot for the period of each send', async () => {
  const acc = await H.account({ session: 'default', persona: 'kev' })
  const plan = await rotationPlan(acc, 2)
  const phones = ['35674000001', '35674000002']
  for (const p of phones) await H.contact(p)
  // Every message (the first included) follows a pause; the clock advances 3 min per pause.
  await send('default', phones.map(p => ({ phone: p, name: 'O' })), 'placeholder', { planId: plan.id, clock: clock(at(DAY, '11:54'), 3) })
  const texts = ownerSends().map(m => m.text)
  assert.strictEqual(texts[0], TEMPLATES.kev.morning[1])    // sent 11:57
  assert.strictEqual(texts[1], TEMPLATES.kev.afternoon[1])  // sent 12:00
})

test('persona isolation: Kevin + ARGUS accounts use Kevin, Cedric and Gabriela their own', async () => {
  const cases = [
    ['default', 'kev'], ['Kevsecond', 'kev'], ['kevthirdd', 'kev'], ['Argus2', 'kev'],
    ['Argus3', 'kev'], ['Argus4', 'kev'], ['Argus5', 'kev'], ['Cedric', 'cedric'], ['Gabriela', 'gabriela'],
  ]
  let n = 0
  for (const [session, persona] of cases) {
    const acc = await H.account({ session, persona })
    const plan = await rotationPlan(acc, 1)
    const phone = `3567500${String(++n).padStart(4, '0')}`
    await H.contact(phone)
    await send(session, [{ phone, name: 'O' }], 'placeholder', { planId: plan.id, clock: clock(at(DAY, '15:00')) })
    const msg = ownerSends().find(m => m.phone === phone)
    assert.strictEqual(msg.text, TEMPLATES[persona].afternoon[0], session)
    for (const other of ['kev', 'cedric', 'gabriela'].filter(p => p !== persona)) {
      for (const body of Object.values(TEMPLATES[other]).flat()) assert.notStrictEqual(msg.text, body)
    }
  }
})

test('freshness: owner who opted out after the plan was built is not messaged', async () => {
  await H.account({ session: 'default', persona: 'kev' })
  await H.contact('35676000001', { status: 'do_not_contact' })          // classifier DNC form
  await H.contact('35676000002', { do_not_contact: true })               // boolean form
  await H.contact('35676000003')
  await H.db.query(`INSERT INTO owner_automation_blocks(phone_normalized, reason, active) VALUES ('35676000003','blocked by owner',TRUE)`)
  await H.contact('35676000004')
  const r = await send('default', ['35676000001', '35676000002', '35676000003', '35676000004'].map(p => ({ phone: p, name: 'O' })), 'Good morning!')
  assert.deepStrictEqual(ownerSends().map(m => m.phone), ['35676000004'])
  assert.strictEqual(r.sent, 1)
})

test('freshness: an owner already contacted by ANOTHER account is skipped', async () => {
  await H.account({ session: 'default', persona: 'kev' })
  await H.account({ session: 'Cedric', persona: 'cedric' })
  await H.contact('35677000001')
  await H.db.query(`INSERT INTO outreach_log(phone, account_used, sent_at) VALUES ('35677000001','Cedric', $1)`, [at(DAY, '09:00')])
  const r = await send('default', [{ phone: '35677000001', name: 'O' }], 'Good morning!', { clock: clock(at(DAY, '10:00')) })
  assert.strictEqual(r.sent, 0)
  assert.strictEqual(ownerSends().length, 0)
})

test('daily cap: 40 per account per Malta day; the 41st is refused', async () => {
  const acc = await H.account({ session: 'default', persona: 'kev' })
  for (const [n, expectOk] of [[29, true], [30, true], [39, true], [40, false]]) {
    await H.db.query(`DELETE FROM outreach_daily_recipients; DELETE FROM outreach_daily_quota`)
    await H.db.query(`INSERT INTO outreach_daily_quota(account_id, malta_date, target, cap, used) VALUES ($1,$2,35,40,$3)`, [acc.id, DAY, n])
    const r = await Quota.reserve(acc.id, `3567800${n}`, { now: at(DAY, '10:00') })
    assert.strictEqual(r.ok, expectOk, `with ${n} used`)
  }
})

test('daily cap: 12 workers racing for the last slot → exactly one wins', async () => {
  const acc = await H.account({ session: 'default', persona: 'kev' })
  await H.db.query(`INSERT INTO outreach_daily_quota(account_id, malta_date, target, cap, used) VALUES ($1,$2,40,40,39)`, [acc.id, DAY])
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => Quota.reserve(acc.id, `356790000${String(i).padStart(2, '0')}`, { now: at(DAY, '10:00') })))
  assert.strictEqual(results.filter(r => r.ok).length, 1)
  const q = (await H.db.query(`SELECT used FROM outreach_daily_quota WHERE account_id=$1`, [acc.id])).rows[0]
  assert.strictEqual(q.used, 40)
})

test('daily cap in the real loop: 39 used + 2 contacts → 1 sent, 1 skipped; retry of same owner is free', async () => {
  const acc = await H.account({ session: 'default', persona: 'kev' })
  await H.db.query(`INSERT INTO outreach_daily_quota(account_id, malta_date, target, cap, used) VALUES ($1,$2,40,40,39)`, [acc.id, DAY])
  await H.contact('35680000001')
  await H.contact('35680000002')
  const r = await send('default', [{ phone: '35680000001', name: 'O' }, { phone: '35680000002', name: 'P' }], 'Good morning!')
  assert.strictEqual(r.sent, 1)
  assert.deepStrictEqual(ownerSends().map(m => m.phone), ['35680000001'])
  const again = await Quota.reserve(acc.id, '35680000001', { now: at(DAY, '15:00') })
  assert.strictEqual(again.ok, true)
  assert.strictEqual(again.already, 'sent')
})

test('a definite send failure gives the daily slot back; it is not counted as outreach', async () => {
  const acc = await H.account({ session: 'default', persona: 'kev' })
  await H.contact('35681000001')
  H.wahaBehaviour.failFor.set('35681000001', Object.assign(new Error('400 bad request'), { code: 'E_BAD' }))
  const r = await send('default', [{ phone: '35681000001', name: 'O' }], 'Good morning!')
  assert.strictEqual(r.failed, 1)
  const q = (await H.db.query(`SELECT used FROM outreach_daily_quota WHERE account_id=$1`, [acc.id])).rows[0]
  assert.strictEqual(q.used, 0)
  const logged = (await H.db.query(`SELECT COUNT(*)::int n FROM outreach_log WHERE phone='35681000001'`)).rows[0].n
  assert.strictEqual(logged, 0)
})

test('restart does not reset consumed quota (state is in the database)', async () => {
  const acc = await H.account({ session: 'default', persona: 'kev' })
  for (let i = 0; i < 5; i++) await Quota.reserve(acc.id, `3568200000${i}`, { now: at(DAY, '10:00') })
  delete require.cache[require.resolve('../services/outreachQuota')]
  const fresh = require('../services/outreachQuota')
  const st = await fresh.status(acc.id, { now: at(DAY, '18:00') })
  assert.strictEqual(st.used, 5)
  assert.strictEqual(st.remaining, 35)
})
