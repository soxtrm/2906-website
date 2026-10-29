'use strict'
// Kev, 2026-10-29: Auto preparation, Save All, rolling schedule, day gate,
// rotation and pace persistence — the REAL services/outreachPlanner.js on a
// real Postgres. Jobs are recorded by the queue stub; nothing is sent.
//   node --test test/planner.test.js
const test = require('node:test')
const assert = require('node:assert')
const H = require('./helpers/harness')
const S = H.load('services/outreachSchedule')
const Pace = H.load('services/outreachPace')
const Templates = H.load('services/outreachTemplates')
const P = H.load('services/outreachPlanner')

const at = (d, t) => S.maltaLocalToUTC(d, t)
// A fixed future morning, so every horizon day is ahead of the real clock.
const BASE_DAY = '2026-11-16'
const NOW = at(BASE_DAY, '06:00')

async function seedPool(n = 260) {
  await H.db.query(`INSERT INTO pool_cursors(pool, cursor_id) VALUES ('top', 0), ('bottom', 999999999) ON CONFLICT (pool) DO UPDATE SET cursor_id = EXCLUDED.cursor_id`)
  const values = Array.from({ length: n }, (_, i) => `('3569${String(i).padStart(7, '0')}', 'Owner ${i}', 'new')`).join(',')
  await H.db.query(`INSERT INTO owner_contacts(phone_normalized, name, status) VALUES ${values}`)
}

test.beforeEach(async () => {
  await H.reset()
  await H.db.query(`TRUNCATE pool_cursors`)
  await Templates.ensureSeed()
  await seedPool()
})

test('auto prepare: 5 morning days, no drift, persona rotation, target 30–40, all "A"', async () => {
  const acc = await H.account({ session: 'Gabriela', persona: 'gabriela', pace: 33 })
  await P.setAutoEnabled(acc.id, true, { now: NOW })
  const plans = await P.listRollingPlans(acc.id, 'test', NOW)
  assert.strictEqual(plans.length, 5)
  const slots = []
  for (const plan of plans) {
    const local = S.maltaParts(new Date(plan.scheduled_at))
    assert.ok(local.minutes >= 8 * 60 + 30 && local.minutes <= 9 * 60 + 15, `${plan.label} starts ${local.hour}:${local.minute}`)
    assert.strictEqual(plan.message_mode, 'persona_rotation')
    assert.ok(plan.target_count >= 30 && plan.target_count <= 40, String(plan.target_count))
    assert.ok(plan.stats.eligible >= 30 && plan.stats.eligible <= 40, String(plan.stats.eligible))
    assert.strictEqual(P.dayDisplayState(plan, plan.stats).state, 'auto_prepared')
    assert.match(plan.message_template, /Gabriela/)
    slots.push(plan.template_slot)
  }
  for (let i = 1; i < slots.length; i++) assert.notStrictEqual(slots[i], slots[i - 1], `slot repeated on day ${i}`)
  assert.strictEqual(new Set(slots.slice(0, 4)).size, 4, 'first four days use four different variants')
})

test('Save All: 5 prepared days → 5 scheduled, one job each; a second Save All changes nothing', async () => {
  const acc = await H.account({ session: 'Argus2', persona: 'kev', pace: 33 })
  await P.setAutoEnabled(acc.id, true, { now: NOW })
  const first = await P.saveAllPrepared(acc.id, { now: NOW })
  assert.strictEqual(first.ok, true, JSON.stringify(first.results))
  assert.strictEqual(first.scheduled, 5)
  const jobsAfterFirst = H.jobs.filter(j => j.name === 'outreach-plan').map(j => j.opts.jobId)
  assert.strictEqual(new Set(jobsAfterFirst).size, 5)
  const second = await P.saveAllPrepared(acc.id, { now: NOW })
  assert.strictEqual(second.ok, true)
  assert.strictEqual(second.scheduled, 0)
  assert.strictEqual(second.alreadyScheduled, 5)
  assert.strictEqual(H.jobs.filter(j => j.name === 'outreach-plan').length, 5, 'no duplicate jobs')
  const plans = await P.listRollingPlans(acc.id, 'test', NOW)
  for (const plan of plans) assert.strictEqual(P.dayDisplayState(plan, plan.stats).state, 'scheduled')
  const reserved = (await H.db.query(`SELECT COUNT(*)::int n, COUNT(DISTINCT normalized_phone)::int d FROM outreach_reservations WHERE released_at IS NULL`)).rows[0]
  assert.strictEqual(reserved.n, reserved.d, 'no owner reserved twice')
  const row = (await H.db.query(`SELECT outreach_auto_rolling FROM whatsapp_accounts WHERE id=$1`, [acc.id])).rows[0]
  assert.strictEqual(row.outreach_auto_rolling, true)
})

test('two Save All clicks at the same time do not duplicate schedules', async () => {
  const acc = await H.account({ session: 'Cedric', persona: 'cedric' })
  await P.setAutoEnabled(acc.id, true, { now: NOW })
  const [a, b] = await Promise.all([P.saveAllPrepared(acc.id, { now: NOW }), P.saveAllPrepared(acc.id, { now: NOW })])
  assert.strictEqual(a.scheduled + b.scheduled, 5)
  assert.strictEqual(new Set(H.jobs.filter(j => j.name === 'outreach-plan').map(j => j.opts.jobId)).size, 5)
})

test('pace 30 survives Auto on, Save All and a module reload (spec 15)', async () => {
  const acc = await H.account({ session: 'default', persona: 'kev', pace: 100 })
  await Pace.setAccountPace(acc.id, { min: 30 })
  await P.setAutoEnabled(acc.id, true, { now: NOW })
  await P.saveAllPrepared(acc.id, { now: NOW })
  delete require.cache[require.resolve('../services/outreachPace')]
  const reloaded = require('../services/outreachPace')
  assert.strictEqual((await reloaded.resolvePace(acc.id)).percent, 30)
  const accounts = await P.listAccounts()
  assert.strictEqual(accounts.find(a => a.id === acc.id).outreachVolumePercent, 30)
})

test('rolling: the next morning prepares and schedules the new fifth day by itself', async () => {
  const acc = await H.account({ session: 'Kevsecond', persona: 'kev' })
  await P.setAutoEnabled(acc.id, true, { now: NOW })
  await P.saveAllPrepared(acc.id, { now: NOW })
  const nextMorning = at(S.addDays(BASE_DAY, 1), '06:00')
  const result = await P.maintainAutoSchedules(nextMorning)
  assert.ok(result.armed.some(r => r.day === S.addDays(BASE_DAY, 5)), JSON.stringify(result.armed))
  const plans = await P.listRollingPlans(acc.id, 'test', nextMorning)
  for (const plan of plans) assert.strictEqual(P.dayDisplayState(plan, plan.stats).state, 'scheduled', plan.label)
})

test('auto off pauses future auto days; nothing stays scheduled', async () => {
  const acc = await H.account({ session: 'Argus3', persona: 'kev' })
  await P.setAutoEnabled(acc.id, true, { now: NOW })
  await P.saveAllPrepared(acc.id, { now: NOW })
  const off = await P.setAutoEnabled(acc.id, false, { now: NOW })
  assert.strictEqual(off.paused.length, 5)
  const armed = (await H.db.query(`SELECT COUNT(*)::int n FROM outreach_plans WHERE account_id=$1 AND armed`, [acc.id])).rows[0].n
  assert.strictEqual(armed, 0)
})

test('arm refuses 19:45 and 08:00; daily gate after 40 points to the next morning', async () => {
  const acc = await H.account({ session: 'Argus4', persona: 'kev' })
  await P.setAutoEnabled(acc.id, true, { now: NOW })
  const plan = (await P.listRollingPlans(acc.id, 'test', NOW)).find(p => p.label === 'TOMORROW')
  for (const time of ['19:45', '08:00']) {
    const r = await P.armPlan(plan.id, { time })
    assert.strictEqual(r.ok, false, time)
    assert.strictEqual(r.reason, 'outside_send_window', time)
  }
  const day = S.addDays(BASE_DAY, 1)
  await H.db.query(`INSERT INTO outreach_daily_quota(account_id, malta_date, target, cap, used) VALUES ($1,$2,40,40,40) ON CONFLICT (account_id, malta_date) DO UPDATE SET used = 40, cap = 40`, [acc.id, day])
  const gate = await P.accountCooldown('Argus4', at(day, '10:00'))
  assert.strictEqual(gate.allowed, false)
  assert.strictEqual(gate.reason, 'daily_cap_reached')
  assert.strictEqual(gate.nextEligibleAt.toISOString(), at(S.addDays(day, 1), '08:30').toISOString())
})

test('day gate: an evening send no longer blocks the next morning (24h15 replaced)', async () => {
  await H.account({ session: 'Argus5', persona: 'kev' })
  await H.db.query(`INSERT INTO outreach_log(phone, account_used, sent_at) VALUES ('35600000001','Argus5',$1)`, [at(BASE_DAY, '19:20')])
  const gate = await P.accountCooldown('Argus5', at(S.addDays(BASE_DAY, 1), '08:45'))
  assert.strictEqual(gate.allowed, true)
})

test('rotation persists across a restart and keeps preferring the least recently used variant', async () => {
  const acc = await H.account({ session: 'default', persona: 'kev' })
  const used = []
  for (let i = 0; i < 4; i++) {
    const plan = await P.ensurePlan(acc.id, S.addDays(BASE_DAY, i), 'test')
    used.push(await Templates.pickSlot(acc.id, 'kev', { planId: plan.id, now: NOW }))
  }
  assert.deepStrictEqual([...used].sort(), [1, 2, 3, 4])
  delete require.cache[require.resolve('../services/outreachTemplates')]
  const reloaded = require('../services/outreachTemplates')
  const plan5 = await P.ensurePlan(acc.id, S.addDays(BASE_DAY, 4), 'test')
  const fifth = await reloaded.pickSlot(acc.id, 'kev', { planId: plan5.id, now: NOW })
  assert.strictEqual(fifth, used[0], 'least recently used comes back first')
  assert.strictEqual(await reloaded.pickSlot(acc.id, 'kev', { planId: plan5.id, now: NOW }), fifth, 'same plan → same slot')
})

test('an operator-written text turns that day into free text; greeting still fixed at send', async () => {
  const acc = await H.account({ session: 'default', persona: 'kev' })
  await P.setAutoEnabled(acc.id, true, { now: NOW })
  const plan = (await P.listRollingPlans(acc.id, 'test', NOW))[1]
  await P.setMessageTemplate(plan.id, 'Good evening! Kevin here, quick question about your flat. Enjoy your evening!')
  const row = (await H.db.query(`SELECT message_mode, template_slot FROM outreach_plans WHERE id=$1`, [plan.id])).rows[0]
  assert.deepStrictEqual(row, { message_mode: 'free_text', template_slot: null })
})
