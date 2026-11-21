'use strict'
// ARGUS P0 Auto Outreach fix (2026-11-21) — Kev's 12 controlled tests, run
// against a throwaway PostgreSQL with the full live schema (no live rows).
// Synthetic accounts and owners only; WhatsApp, BullMQ and the run engine are
// stubs that RECORD what would be sent. Nothing reaches a real owner.
//   BACKEND_DIR=/app PGHOST=... node --test test/outreach-autofix.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')

process.env.NODE_ENV = 'test'
const ROOT = process.env.BACKEND_DIR || '/app'
const R = p => path.join(ROOT, p)
const { Pool } = require(R('node_modules/pg'))
const pool = new Pool({ host: process.env.PGHOST, user: 'postgres', password: 'test', database: 'postgres', max: 8 })
const noop = () => {}
function stub(rel, exports) { const file = require.resolve(R(rel)); require.cache[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [] }; return exports }

stub('db.js', { query: (s, p) => pool.query(s, p), connect: () => pool.connect() })
stub('logger.js', { info: noop, warn: noop, error: noop, debug: noop })
stub('config.js', { admin: { botNumber: '35600000000' } })
const session = { status: 'WORKING' }
const wire = []
stub('waha.js', {
  getSessionStatus: async () => ({ status: session.status }),
  sendText: async (s, phone, text) => { wire.push({ session: s, phone, text }) },
  pickActiveAdminSession: async () => null, getSessionPhone: async () => '35600000000',
})
const jobs = new Map()
let jobSeq = 0
stub('queues.js', {
  addJob: async (q, data, opts) => { const id = opts?.jobId || `job-${++jobSeq}`; jobs.set(id, { q, data, opts }); return { id } },
  QUEUES: { 'outreach-plan': { getJob: async id => (jobs.has(id) ? { remove: async () => jobs.delete(id), getState: async () => 'delayed' } : null) } },
})
// Pool: synthetic owners in id order, cursor = last id handed out.
stub('services/listBuilder.js', {
  buildPoolBatch: async (_session, n, { cursorOverride = null } = {}) => {
    const after = cursorOverride || 0
    const { rows } = await pool.query(`SELECT id, phone_normalized, name FROM owner_contacts WHERE id > $1 ORDER BY id LIMIT $2`, [after, n])
    return { list: rows, cursor_advanced_to: rows.length ? rows[rows.length - 1].id : after }
  },
})
stub('services/conversationIntelligence.js', { preflightOutbound: async () => ({ allow: true }) })
const schedule = require(R('services/outreachSchedule.js'))
const realAllowed = schedule.isSendAllowed

// The run engine stand-in: renders every message exactly like
// adminCommands.runDirectOutreach (same renderAtSendTime call, same args) and
// records it on the wire stub, then books the result like the real engine.
let dispatchAt = null
stub('services/adminCommands.js', {
  enqueueDirectOutreach: async (_admin, _reply, sessionName, contacts, template, opts) => {
    const T = require(R('services/outreachTemplates.js'))
    const plan = (await pool.query(`SELECT * FROM outreach_plans WHERE id=$1`, [opts.planId])).rows[0]
    const acc = (await pool.query(`SELECT * FROM whatsapp_accounts WHERE id=$1`, [plan.account_id])).rows[0]
    for (const c of contacts) {
      const at = dispatchAt || new Date()
      const { text } = await T.renderAtSendTime({ mode: plan.message_mode, persona: acc.account_persona, slot: plan.template_slot, freeText: template, phone: c.phone, accountId: acc.id, planId: plan.id }, at)
      await require(R('waha.js')).sendText(sessionName, c.phone, text)
      await pool.query(`INSERT INTO outreach_log (phone, account_used, message_text, sent_at) VALUES ($1,$2,$3,NOW())`, [c.phone, sessionName, text])
      await pool.query(`UPDATE outreach_plan_entries SET send_status='sent', sent_at=NOW() WHERE plan_id=$1 AND normalized_phone=$2`, [plan.id, c.phone])
    }
    await pool.query(`UPDATE outreach_plans SET status='completed', armed=FALSE, executed_at=NOW() WHERE id=$1`, [plan.id])
    return { run_id: `run-${opts.planId}` }
  },
})

const planner = require(R('services/outreachPlanner.js'))
const lib = require(R('services/outreachLibrary.js'))
const status = require(R('services/outreachAutoStatus.js'))
const malta = (dateStr, hhmm) => schedule.maltaLocalToUTC(dateStr, hhmm)
const today = schedule.maltaDateStr(new Date())
const day = n => schedule.addDays(today, n)
let A, B // account ids

async function plansOf(accountId) {
  return (await pool.query(`SELECT p.*, (SELECT COUNT(*)::int FROM outreach_plan_entries e WHERE e.plan_id=p.id AND e.eligibility_status='eligible') AS elig
    FROM outreach_plans p WHERE account_id=$1 ORDER BY scheduled_date`, [accountId])).rows
}
const future = rows => rows.filter(p => p.scheduled_at && new Date(p.scheduled_at) > new Date(Date.now() + 5 * 60_000))

test.before(async () => {
  for (let i = 0; i < 60; i++) { try { await pool.query('SELECT 1'); break } catch { await new Promise(r => setTimeout(r, 500)) } }
  A = (await pool.query(`INSERT INTO whatsapp_accounts (session_name, phone, label, account_persona, is_active, outreach_enabled, priority, outreach_pace_min, outreach_pace_max)
    VALUES ('GabStage','35699900001','Gabriela stage','gabriela',TRUE,TRUE,1,27,27) RETURNING id`)).rows[0].id
  B = (await pool.query(`INSERT INTO whatsapp_accounts (session_name, phone, label, account_persona, is_active, outreach_enabled, priority, outreach_pace_min, outreach_pace_max)
    VALUES ('KevStage','35699900002','Kev stage','kev',TRUE,TRUE,2,30,30) RETURNING id`)).rows[0].id
  for (let i = 0; i < 420; i++) {
    await pool.query(`INSERT INTO owner_contacts (phone_normalized, name) VALUES ($1,$2)`, [`3567990${String(i).padStart(4, '0')}`, `Synthetic Owner ${i}`])
  }
  const seeded = await lib.ensureSeed()
  assert.equal(seeded, 150)
})
test.after(async () => { await pool.end() })

test('1 · Auto campaign creation: 32 ±5 is saved and every day is drawn inside 27–37, library text, greeting for the slot time', async () => {
  const r = await planner.autoPrepareAccount(A, { baseCount: 32, variation: 5, actor: 'kev' })
  const acc = (await pool.query(`SELECT outreach_daily_target_min mn, outreach_daily_target_max mx FROM whatsapp_accounts WHERE id=$1`, [A])).rows[0]
  assert.deepEqual([acc.mn, acc.mx], [27, 37])
  const prepared = r.plans.filter(p => p.status === 'prepared')
  assert.ok(prepared.length >= 4, `prepared ${prepared.length}`)
  for (const p of future(await plansOf(A))) {
    assert.ok(p.target_count >= 27 && p.target_count <= 37, `day ${p.id} target ${p.target_count}`)
    assert.ok(p.elig <= 37, `day ${p.id} has ${p.elig} contacts`)
    assert.equal(p.batch_min, 27); assert.equal(p.batch_max, 37)
    assert.equal(p.message_mode, 'library')
    const g = lib.greetingFor('356', new Date(p.scheduled_at)).greeting
    assert.ok(p.message_template.startsWith(`${g}, `), `preview "${p.message_template.slice(0, 30)}" for ${p.scheduled_at}`)
  }
  const s = await status.forAccount(A)
  assert.equal(s.auto.state, 'auto_off') // prepared, Auto not switched on yet
  assert.deepEqual([s.batch.min, s.batch.max], [27, 37])
})

test('2 · Starting: Auto on with Start schedules the prepared days; before that it says Ready to start, never Paused', async () => {
  await pool.query(`UPDATE whatsapp_accounts SET outreach_auto_enabled=TRUE WHERE id=$1`, [A])
  let s = await status.forAccount(A)
  assert.equal(s.auto.state, 'ready_to_start')
  for (const d of s.days.filter(d => d.scheduledAt && new Date(d.scheduledAt) > new Date())) assert.ok(!/paused/i.test(d.display.label), d.display.label)
  const r = await planner.setAutoEnabled(A, true, { actor: 'kev', startNow: true })
  assert.ok(r.armed, JSON.stringify(r.started?.results?.map(x => [x.status, x.reason])))
  s = await status.forAccount(A)
  assert.equal(s.auto.rolling, true)
  assert.equal(s.auto.state, 'scheduled', s.auto.reason)
  assert.ok(s.nextRun && s.nextRun.queued > 0 && s.nextRun.queued <= 37)
})

test('3 · Normal owner replies and confirmations do not pause anything', async () => {
  const armedBefore = (await plansOf(A)).filter(p => p.armed).map(p => p.id)
  await pool.query(`INSERT INTO outreach_log (phone, account_used, message_text, sent_at, replied, replied_at) VALUES ('35679900005','GabStage','x',NOW()-interval '1 day',TRUE,NOW())`)
  await pool.query(`UPDATE owner_contacts SET status='hot' WHERE phone_normalized='35679900005'`)
  await planner.maintainAutoSchedules()
  const armedAfter = (await plansOf(A)).filter(p => p.armed).map(p => p.id)
  assert.deepEqual(armedAfter, armedBefore)
  assert.equal((await status.forAccount(A)).auto.state, 'scheduled')
})

test('4 · Explicit pause and resume: "Paused by agent" only after the agent pauses; resume schedules it again', async () => {
  const p = future(await plansOf(A)).find(x => x.armed)
  await planner.pausePlan(p.id)
  const held = (await pool.query(`SELECT * FROM outreach_plans WHERE id=$1`, [p.id])).rows[0]
  assert.equal(held.hold_reason, 'paused_by_agent')
  assert.equal(planner.dayDisplayState(held, { eligible: 1, total: 1 }).label, 'Paused by agent')
  const r = await planner.armPlan(p.id, { time: new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(held.scheduled_at)), chain: false })
  const diag = (await pool.query(`SELECT eligibility_status, send_status, skip_reason, COUNT(*)::int n FROM outreach_plan_entries WHERE plan_id=$1 GROUP BY 1,2,3`, [p.id])).rows
  assert.ok(r.ok, `${r.reason} requested ${r.requested} eligible ${r.eligible} target ${held.target_count} ${JSON.stringify(diag)}`)
  const back = (await pool.query(`SELECT * FROM outreach_plans WHERE id=$1`, [p.id])).rows[0]
  assert.equal(back.hold_reason, null); assert.equal(back.status, 'ready')
})

test('5 · Owner opt-out: the opted-out owner is skipped with its reason, the campaign keeps running', async () => {
  schedule.isSendAllowed = () => true
  try {
    const p = future(await plansOf(A)).find(x => x.armed)
    const optOut = (await pool.query(`SELECT normalized_phone FROM outreach_plan_entries WHERE plan_id=$1 AND eligibility_status='eligible' ORDER BY position LIMIT 1`, [p.id])).rows[0].normalized_phone
    await pool.query(`UPDATE owner_contacts SET do_not_contact=TRUE WHERE phone_normalized=$1`, [optOut])
    await pool.query(`UPDATE outreach_plans SET scheduled_at=NOW() WHERE id=$1`, [p.id])
    wire.length = 0
    await planner.runScheduledPlan(p.id)
    assert.ok(!wire.some(w => w.phone === optOut), 'opted-out owner received a message')
    const e = (await pool.query(`SELECT eligibility_status, skip_reason FROM outreach_plan_entries WHERE plan_id=$1 AND normalized_phone=$2`, [p.id, optOut])).rows[0]
    assert.equal(e.eligibility_status, 'skip'); assert.match(e.skip_reason, /do_not_contact|opt|final_check/)
    assert.ok(wire.length > 0)
    assert.ok(wire.length <= 37)
    const s = await status.forAccount(A)
    assert.notEqual(s.auto.state, 'paused_agent'); assert.ok(['scheduled', 'waiting', 'completed'].includes(s.auto.state), s.auto.state)
  } finally { schedule.isSendAllowed = realAllowed }
})

test('6 · Temporary WAHA failure: the run is kept and retried (Connection error), not paused or skipped', async () => {
  schedule.isSendAllowed = () => true
  try {
    const p = future(await plansOf(A)).find(x => x.armed && x.status === 'ready')
    await pool.query(`UPDATE outreach_plans SET scheduled_at=NOW() WHERE id=$1`, [p.id])
    session.status = 'FAILED'
    wire.length = 0
    await planner.runScheduledPlan(p.id)
    const row = (await pool.query(`SELECT * FROM outreach_plans WHERE id=$1`, [p.id])).rows[0]
    assert.equal(row.status, 'blocked_session'); assert.equal(row.armed, true); assert.equal(row.retry_attempt, 1)
    assert.match(planner.dayDisplayState(row, { eligible: 1 }).label, /Connection error/)
    assert.equal(wire.length, 0)
    assert.equal((await status.forAccount(A)).auto.state, 'connection_error')

    // 7 · Recovery after the connection is back: the retry dispatches.
    session.status = 'WORKING'
    await planner.runScheduledPlan(p.id)
    assert.ok(wire.length > 0 && wire.length <= 37)
    assert.equal((await pool.query(`SELECT status FROM outreach_plans WHERE id=$1`, [p.id])).rows[0].status, 'completed')
  } finally { schedule.isSendAllowed = realAllowed; session.status = 'WORKING' }
})

test('7 · Held by a dropped session: future days are scheduled again by themselves once WhatsApp is back', async () => {
  const before = future(await plansOf(A)).filter(p => p.armed).map(p => p.id)
  assert.ok(before.length >= 1)
  await planner.setAccountRestriction(A, { restricted: true, reason: 'session_failed', sessionStatus: 'FAILED', actor: 'test' })
  const held = await plansOf(A)
  for (const id of before) {
    const r = held.find(p => p.id === id)
    assert.equal(r.armed, false); assert.match(r.hold_reason, /session_failed/)
    assert.match(planner.dayDisplayState(r, { eligible: 1 }).label, /Connection error/)
  }
  session.status = 'WORKING'
  await planner.recoverSessionHolds()
  const after = await plansOf(A)
  for (const id of before) assert.equal(after.find(p => p.id === id).armed, true)
  assert.equal((await pool.query(`SELECT operational_status FROM whatsapp_accounts WHERE id=$1`, [A])).rows[0].operational_status, 'ready')
})

test('8 · Greeting at the moment of sending: morning, afternoon, evening (Malta); neutral when the zone is unknown', async () => {
  const d = day(1)
  const cases = [['09:10', 'Good morning'], ['14:44', 'Good afternoon'], ['15:00', 'Good afternoon'], ['18:30', 'Good evening']]
  for (const [hm, want] of cases) {
    const r = await lib.renderForSend({ persona: 'gabriela', phone: '35679912345', accountId: A }, malta(d, hm), { record: false })
    assert.ok(r.text.startsWith(`${want}, `), `${hm}: ${r.text.slice(0, 40)}`)
    assert.ok(!/good (morning|afternoon|evening)/i.test(r.text.slice(want.length + 2)), 'a second greeting inside the text')
  }
  assert.ok((await lib.renderForSend({ persona: 'kev', phone: '15551234567' }, malta(d, '15:00'), { record: false })).text.startsWith('Hello, '))
  // London is one hour behind Malta: 18:30 Malta is 17:30 there → afternoon.
  assert.ok((await lib.renderForSend({ persona: 'cedric', phone: '447700900123' }, malta(d, '18:30'), { record: false })).text.startsWith('Good afternoon, '))
})

test('9 · Custom templates are preserved: an agent-written day keeps its words; library texts go out unchanged', async () => {
  const p = future(await plansOf(A)).find(x => !x.armed && x.status !== 'completed') || future(await plansOf(A)).find(x => x.status !== 'completed')
  if (p.armed) await planner.pausePlan(p.id)
  const mine = "Good Afternoon, hope you're well.\n\nMy name is Gabriela and I am an agent and real estate specialist.\n\nGabriela\nRental Agent"
  await planner.setMessageTemplate(p.id, mine)
  await planner.maintainAutoSchedules()
  await planner.autoPrepareAccount(A, { actor: 'auto-rolling' })
  const row = (await pool.query(`SELECT message_mode, message_template FROM outreach_plans WHERE id=$1`, [p.id])).rows[0]
  assert.equal(row.message_mode, 'free_text'); assert.equal(row.message_template, mine)
  const body = (await pool.query(`SELECT body FROM outreach_library_templates WHERE persona='gabriela' ORDER BY number LIMIT 1`)).rows[0].body
  assert.ok(lib.joinGreeting('Good afternoon', body).endsWith(body.replace(/^Hope/, 'hope')))
  await assert.rejects(lib.save({ persona: 'gabriela', body: 'Good morning! This text carries its own greeting and must be refused.' }), /greeting_not_allowed/)
  await assert.rejects(lib.save({ persona: 'gabriela', body: 'I hope you are well. This is Kevin Eich signing as somebody else entirely.' }), /foreign_persona_signature/)
})

test('10 · Batch 32 ±5: draws stay in 27–37; an old 40-day is trimmed; an armed 40-list sends at most 37', async () => {
  const acc = (await pool.query(`SELECT * FROM whatsapp_accounts WHERE id=$1`, [A])).rows[0]
  const draws = Array.from({ length: 400 }, () => require(R('services/outreachQuota.js')).drawTarget(acc))
  assert.ok(Math.min(...draws) >= 27 && Math.max(...draws) <= 37, `${Math.min(...draws)}–${Math.max(...draws)}`)
  assert.ok(new Set(draws).size >= 8)
  // An old Auto day prepared with 40 under the 30–40 default:
  const d = (await pool.query(`SELECT id FROM outreach_plans WHERE account_id=$1 AND scheduled_date=$2`, [B, day(3)])).rows[0]
    || (await pool.query(`INSERT INTO outreach_plans (account_id, session_name, scheduled_date, status, created_by) VALUES ($1,'KevStage',$2,'draft','test') RETURNING id`, [B, day(3)])).rows[0]
  await planner.generateList(d.id, 40, { actor: 'test' })
  await pool.query(`UPDATE outreach_plans SET source='auto_prepared', status='saved', scheduled_at=$2, target_count=40, message_template='x', message_mode='persona_rotation' WHERE id=$1`, [d.id, malta(day(3), '10:00')])
  await pool.query(`UPDATE whatsapp_accounts SET outreach_auto_enabled=TRUE, outreach_daily_target_min=27, outreach_daily_target_max=37 WHERE id=$1`, [B])
  await planner.autoPrepareAccount(B, { actor: 'auto-rolling' })
  const trimmed = (await plansOf(B)).find(p => p.id === d.id)
  assert.ok(trimmed.elig <= 37 && trimmed.target_count <= 37, `still ${trimmed.elig}/${trimmed.target_count}`)
  // An ARMED list that already holds 40 (armed before this fix) never sends more than its maximum.
  schedule.isSendAllowed = () => true
  try {
    const e = (await pool.query(`INSERT INTO outreach_plans (account_id, session_name, scheduled_date, status, created_by, message_template, message_mode) VALUES ($1,'KevStage',$2,'draft','test',$3,'library') RETURNING id`, [B, day(6), 'preview'])).rows[0]
    await planner.generateList(e.id, 40, { actor: 'test' })
    await pool.query(`UPDATE outreach_plans SET status='ready', armed=TRUE, scheduled_at=NOW(), batch_min=27, batch_max=37 WHERE id=$1`, [e.id])
    wire.length = 0
    await planner.runScheduledPlan(e.id)
    assert.equal(wire.length, 37)
    const over = (await pool.query(`SELECT COUNT(*)::int n FROM outreach_plan_entries WHERE plan_id=$1 AND skip_reason='over_batch_limit'`, [e.id])).rows[0].n
    assert.equal(over, 3)
  } finally { schedule.isSendAllowed = realAllowed }
})

test('11 · No duplicates: one owner once per account horizon, never on two armed lists, never the same text twice', async () => {
  const dup = (await pool.query(`SELECT e.normalized_phone, COUNT(DISTINCT e.plan_id) n FROM outreach_plan_entries e JOIN outreach_plans p ON p.id=e.plan_id
    WHERE p.account_id=$1 AND e.eligibility_status='eligible' AND p.status NOT IN ('completed') GROUP BY 1 HAVING COUNT(DISTINCT e.plan_id) > 1`, [A])).rows
  assert.equal(dup.length, 0, JSON.stringify(dup.slice(0, 3)))
  const res = (await pool.query(`SELECT normalized_phone FROM outreach_reservations WHERE released_at IS NULL GROUP BY 1 HAVING COUNT(*) > 1`)).rows
  assert.equal(res.length, 0)
  const twice = (await pool.query(`SELECT phone, template_id FROM outreach_library_usage GROUP BY 1,2 HAVING COUNT(*) > 1`)).rows
  assert.equal(twice.length, 0)
  const phone = '35679955555'
  const seen = new Set()
  for (let i = 0; i < 50; i++) { const r = await lib.renderForSend({ persona: 'cedric', phone, accountId: B }, new Date()); assert.ok(!seen.has(r.templateId), `text ${r.number} twice`); seen.add(r.templateId) }
  // On one account, consecutive owners do not get identical wording.
  const recent = (await pool.query(`SELECT template_id FROM outreach_library_usage WHERE account_id=$1 AND phone LIKE '3567990%' ORDER BY id`, [A])).rows.map(r => r.template_id)
  for (let i = 1; i < recent.length; i++) assert.notEqual(recent[i], recent[i - 1])
})

test('12 · Dashboard counters equal the queue records', async () => {
  const s = await status.forAccount(A)
  for (const d of s.days) {
    const q = (await pool.query(`SELECT
        (SELECT COUNT(*)::int FROM outreach_plan_entries WHERE plan_id=$1) selected,
        (SELECT COUNT(*)::int FROM outreach_plan_entries WHERE plan_id=$1 AND eligibility_status='eligible') eligible,
        (SELECT COUNT(*)::int FROM outreach_reservations WHERE plan_id=$1 AND released_at IS NULL) queued,
        (SELECT COUNT(*)::int FROM outreach_plan_entries WHERE plan_id=$1 AND send_status='sent') accepted`, [d.planId])).rows[0]
    assert.deepEqual({ selected: d.counts.selected, eligible: d.counts.eligible, queued: d.counts.queued, accepted: d.counts.accepted }, q)
  }
  const sentAll = (await pool.query(`SELECT COUNT(*)::int n FROM outreach_plan_entries e JOIN outreach_plans p ON p.id=e.plan_id WHERE p.account_id=$1 AND e.send_status='sent'`, [A])).rows[0].n
  assert.equal(s.days.reduce((n, d) => n + d.counts.accepted, 0), sentAll)
  const skipped = s.days.find(d => Object.keys(d.skipReasons).length)
  assert.ok(skipped, 'skip reasons are reported')
})
