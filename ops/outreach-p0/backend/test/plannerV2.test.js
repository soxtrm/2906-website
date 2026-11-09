'use strict'
// Outreach Planner V2 acceptance tests (Claude, 2026-11-09) — the REAL
// services/outreachAutomation.js + outreachPlanner.js on the isolated test
// Postgres. WhatsApp is the harness stub; nothing is sent anywhere.
//   node --test test/plannerV2.test.js   (inside the isolated test container)
// Dates are far enough in the future that the real clock never makes a
// scheduled time "past" while the tests drive `now` explicitly.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const H = require('./helpers/harness')
const S = H.load('services/outreachSchedule')
const Templates = H.load('services/outreachTemplates')
const P = H.load('services/outreachPlanner')
const A = H.load('services/outreachAutomation')
const Engine = H.load('services/outreachRunEngine')
const { runDirectOutreach } = H.load('services/adminCommands')

const MON = '2026-11-23'   // Monday
const at = (d, t) => S.maltaLocalToUTC(d, t)
const minus = (date, ms) => new Date(date.getTime() - ms)
const BASE = { startDate: MON, startTime: '09:00', weekdays: [1, 2, 3, 4, 5], targetBase: 10, targetVariation: 0, paceBase: 30, paceVariation: 0, shiftMinutes: 20 }

async function seedPool(n = 120) {
  await H.db.query(`INSERT INTO pool_cursors(pool, cursor_id) VALUES ('top', 0), ('bottom', 999999999) ON CONFLICT (pool) DO UPDATE SET cursor_id = EXCLUDED.cursor_id`)
  const values = Array.from({ length: n }, (_, i) => `('3569${String(i).padStart(7, '0')}', 'Owner ${i}', 'new')`).join(',')
  await H.db.query(`INSERT INTO owner_contacts(phone_normalized, name, status) VALUES ${values}`)
}
async function gabriela() {
  const acc = await H.account({ session: 'Gabriela', persona: 'gabriela', pace: 30 })
  return acc
}
const plan = async id => (await H.db.query(`SELECT * FROM outreach_plans WHERE id=$1`, [id])).rows[0]
const activeReservations = async planId => (await H.db.query(
  `SELECT COUNT(*)::int AS n FROM outreach_reservations WHERE plan_id=$1 AND released_at IS NULL`, [planId])).rows[0].n
async function completedAutomationRun(accountId, date, accepted, total = accepted) {
  const p = (await H.db.query(
    `INSERT INTO outreach_plans(account_id, session_name, scheduled_date, status, run_mode, scheduled_at, dispatch_started_at, executed_at)
     SELECT $1, session_name, $2, 'completed', 'automation', $3, $3, $3 FROM whatsapp_accounts WHERE id=$1 RETURNING id`,
    [accountId, date, at(date, '09:00')])).rows[0]
  for (let i = 0; i < total; i++) {
    await H.db.query(`INSERT INTO outreach_plan_entries(plan_id, normalized_phone, eligibility_status, send_status, sent_at)
                      VALUES ($1,$2,'eligible',$3,$4)`, [p.id, `35670${date.replace(/-/g, '')}${i}`, i < accepted ? 'sent' : 'failed', i < accepted ? at(date, '09:05') : null])
  }
  await P.refreshPlanOutcome(p.id)
  return p.id
}

test.beforeEach(async () => {
  await H.reset()
  await H.db.query(`TRUNCATE pool_cursors, outreach_run_events`)
  await Templates.ensureSeed()
  await seedPool()
})

test('A: a paused/skipped day is not executed — the next run starts at the base time, nothing counted', async () => {
  const acc = await gabriela()
  await A.saveConfig(acc.id, { ...BASE, enabled: true }, 'test', at('2026-11-22', '20:00'))
  const first = await A.ensureNextRun(await A.getConfig(acc.id), acc, at('2026-11-22', '20:00'))
  assert.equal(S.maltaParts(new Date(first.scheduled_at)).minutes, 9 * 60)
  await P.pausePlan(first.id)   // operator pauses Monday's run; automation stays enabled
  const paused = await plan(first.id)
  assert.equal(paused.status, 'skipped')
  assert.equal(P.dayDisplayState(paused, {}).state, 'skipped')
  assert.equal(paused.accepted_count, 0)
  assert.equal((await A.getConfig(acc.id)).enabled, true, 'automation stays enabled')
  assert.equal(await A.executedRunCount(acc.id, (await A.getConfig(acc.id)).sequenceEpoch), 0)
  const next = await A.ensureNextRun(await A.getConfig(acc.id), acc, at(MON, '10:00'))
  assert.equal(next.scheduled_date.toISOString?.().slice(0, 10) ?? String(next.scheduled_date).slice(0, 10), '2026-11-24')
  assert.equal(S.maltaParts(new Date(next.scheduled_at)).minutes, 9 * 60, 'Tuesday keeps 09:00 — Monday did not run')
  assert.equal(Number(next.sequence_index), 0)
})

test('B: tomorrow 08:30 scheduled in the evening stays 08:30 Malta; a blocked gate skips instead of re-timing', async () => {
  const acc = await gabriela()
  const p = await P.ensurePlan(acc.id, '2026-11-24', 'test')
  await P.generateList(p.id, 5, { actor: 'test' })
  await P.setMessageTemplate(p.id, 'Good morning, this is Gabriela.')
  const armed = await P.armPlan(p.id, { time: '08:30', chain: false })
  assert.equal(armed.ok, true, JSON.stringify(armed))
  assert.equal(armed.scheduledAt, at('2026-11-24', '08:30').toISOString())
  // The daily cap is used up before the run fires: the run is SKIPPED with a
  // reason, never silently moved to the next eligible time.
  await H.db.query(`INSERT INTO outreach_daily_quota(account_id, malta_date, target, cap, used) VALUES ($1, $2, 40, 40, 40)
                    ON CONFLICT (account_id, malta_date) DO UPDATE SET used = 40`, [acc.id, S.maltaDateStr(new Date())])
  await P.runScheduledPlan(p.id)
  const after = await plan(p.id)
  assert.equal(after.status, 'skipped')
  assert.equal(after.outcome_reason, 'daily_cap_reached')
  assert.equal(new Date(after.scheduled_at).toISOString(), at('2026-11-24', '08:30').toISOString(), 'time not rewritten')
  assert.equal(await activeReservations(p.id), 0, 'contacts returned to the pool')
})

test('C: automation settings persist across a reload of every module (restart) with a new version', async () => {
  const acc = await gabriela()
  const saved = await A.saveConfig(acc.id, { ...BASE, targetBase: 30, targetVariation: 5, paceBase: 25, paceVariation: 5, enabled: true }, 'test', at('2026-11-22', '20:00'))
  for (const key of Object.keys(require.cache)) if (key.includes(`${path.sep}services${path.sep}`)) delete require.cache[key]
  const A2 = H.load('services/outreachAutomation')
  const again = await A2.getConfig(acc.id)
  for (const k of ['enabled', 'startDate', 'startTime', 'targetBase', 'targetVariation', 'paceBase', 'paceVariation', 'shiftMinutes']) {
    assert.deepEqual(again[k], saved[k], k)
  }
  assert.deepEqual(again.weekdays, [1, 2, 3, 4, 5])
  const pace = (await H.db.query(`SELECT outreach_pace_min, outreach_pace_max FROM whatsapp_accounts WHERE id=$1`, [acc.id])).rows[0]
  assert.deepEqual([pace.outreach_pace_min, pace.outreach_pace_max], [20, 30], 'pace envelope stored where dispatch reads it')
  const v2 = await A2.saveConfig(acc.id, { ...again, paceBase: 30 }, 'test', at('2026-11-22', '20:00'))
  assert.equal(v2.version, saved.version + 1)
})

test('validation: impossible values are refused, never clamped silently', () => {
  assert.throws(() => A.validateConfig({ ...BASE, startTime: '19:15' }), /startTime/)
  assert.throws(() => A.validateConfig({ ...BASE, paceBase: 12, paceVariation: 5 }), /pace/)
  assert.throws(() => A.validateConfig({ ...BASE, targetBase: 41 }), /targetBase/)
  assert.throws(() => A.validateConfig({ ...BASE, weekdays: [] }), /weekday/)
  assert.equal(A.validateConfig({ ...BASE, targetBase: 0 }).targetBase, 0)
})

test('E: account disconnects before preflight → day skipped, no contact reserved or sent, automation suspended then resumes', async () => {
  const acc = await gabriela()
  await A.saveConfig(acc.id, { ...BASE, enabled: true }, 'test', at('2026-11-22', '20:00'))
  const run = await A.ensureNextRun(await A.getConfig(acc.id), acc, at('2026-11-22', '20:00'))
  H.wahaBehaviour.sessionStatus = 'SCAN_QR_CODE'
  const r = await A.tickAccount(acc.id, minus(new Date(run.scheduled_at), 90_000))
  assert.equal(r.state, 'preflight_failed')
  const skipped = await plan(run.id)
  assert.equal(skipped.status, 'skipped')
  assert.match(skipped.outcome_reason, /account_disconnected/)
  assert.equal((await H.db.query(`SELECT COUNT(*)::int n FROM outreach_reservations WHERE released_at IS NULL`)).rows[0].n, 0)
  assert.equal(H.sent.length, 0)
  assert.equal((await H.db.query(`SELECT COUNT(*)::int n FROM outreach_log`)).rows[0].n, 0)
  const cfg = await A.getConfig(acc.id)
  assert.match(cfg.suspendedReason, /account_disconnected/)
  assert.equal(cfg.enabled, true, 'configuration intact')
  H.wahaBehaviour.sessionStatus = 'WORKING'
  const resumed = await A.tickAccount(acc.id, at(MON, '12:00'))
  assert.equal((await A.getConfig(acc.id)).suspendedReason, null)
  assert.equal(resumed.state, 'scheduled')
  const next = await plan(resumed.planId)
  assert.equal(String(next.scheduled_date.toISOString?.() ?? next.scheduled_date).slice(0, 10), '2026-11-24')
})

test('preflight passes: contacts reserved only now, run armed for its exact time', async () => {
  const acc = await gabriela()
  await A.saveConfig(acc.id, { ...BASE, enabled: true }, 'test', at('2026-11-22', '20:00'))
  const run = await A.ensureNextRun(await A.getConfig(acc.id), acc, at('2026-11-22', '20:00'))
  assert.equal(await activeReservations(run.id), 0, 'nothing reserved days ahead')
  const r = await A.tickAccount(acc.id, minus(new Date(run.scheduled_at), 90_000))
  assert.equal(r.state, 'armed', JSON.stringify(r))
  const armed = await plan(run.id)
  assert.equal(armed.status, 'ready')
  assert.equal(armed.armed, true)
  assert.equal(armed.run_mode, 'automation')
  assert.equal(new Date(armed.scheduled_at).toISOString(), new Date(run.scheduled_at).toISOString())
  assert.equal(await activeReservations(run.id), 10)
  const kinds = (await H.db.query(`SELECT kind FROM outreach_run_events WHERE plan_id=$1 ORDER BY id`, [run.id])).rows.map(r => r.kind)
  for (const k of ['preflight_started', 'preflight:account_connected', 'preflight:template_approved', 'preflight:contacts_eligible', 'preflight_passed']) assert.ok(kinds.includes(k), k)
})

test('F: partial run — 12 accepted, 18 not: 12 recorded, 18 back in the pool, nothing marked sent wrongly', async () => {
  const acc = await gabriela()
  const p = await P.ensurePlan(acc.id, '2026-11-24', 'test')
  await P.generateList(p.id, 30, { actor: 'test' })
  await P.setMessageTemplate(p.id, 'Good morning, this is Gabriela.')
  assert.equal((await P.armPlan(p.id, { time: '09:00', chain: false })).ok, true)
  assert.equal(await activeReservations(p.id), 30)
  const entries = (await H.db.query(`SELECT normalized_phone FROM outreach_plan_entries WHERE plan_id=$1 AND eligibility_status='eligible' ORDER BY id`, [p.id])).rows
  const runId = '11111111-1111-4111-8111-111111111111'
  await H.db.query(`INSERT INTO outreach_runs(run_id,trigger_id,source,plan_id,session_name,sender_identity,message_template,contacts,pacing_mode,status,run_after)
                    VALUES ($1,'t','website_plan',$2,'Gabriela','{}','x','[]','mixed','running',NOW())`, [runId, p.id])
  for (const [i, e] of entries.entries()) {
    await H.db.query(`INSERT INTO outreach_run_recipients(run_id,normalized_phone,state,sent_at) VALUES ($1,$2,$3,$4)`,
      [runId, e.normalized_phone, i < 12 ? 'sent' : 'failed', i < 12 ? new Date() : null])
  }
  await H.db.query(`UPDATE outreach_plans SET status='running' WHERE id=$1`, [p.id])
  await P.reconcilePlanFromRun(p.id, runId)
  const done = await plan(p.id)
  assert.equal(done.status, 'completed')
  assert.equal(done.outcome, 'partial')
  assert.equal(done.accepted_count, 12)
  assert.equal(done.failed_count, 18)
  assert.equal(P.dayDisplayState(done, {}).label, 'Partial — 12 accepted')
  assert.equal(await activeReservations(p.id), 0)
  const sentCount = (await H.db.query(`SELECT COUNT(*)::int n FROM outreach_plan_entries WHERE plan_id=$1 AND send_status='sent'`, [p.id])).rows[0].n
  assert.equal(sentCount, 12)
  // The 18 are free to be planned again; none of the 12 can be.
  const other = await P.ensurePlan(acc.id, '2026-11-25', 'test')
  const failedPhones = entries.slice(12).map(e => e.normalized_phone)
  await P.addEntriesFromPaste(other.id, failedPhones.join('\n'), 'test')
  const reusable = (await H.db.query(`SELECT COUNT(*)::int n FROM outreach_plan_entries WHERE plan_id=$1 AND eligibility_status='eligible'`, [other.id])).rows[0].n
  assert.equal(reusable, 18)
})

test('G: the same owner in two accounts — only one active reservation, the second account skips it', async () => {
  const g = await gabriela()
  const c = await H.account({ session: 'Cedric', persona: 'cedric', pace: 30 })
  const shared = '35690000005'
  const pg = await P.ensurePlan(g.id, '2026-11-24', 'test')
  const pc = await P.ensurePlan(c.id, '2026-11-24', 'test')
  await P.addEntriesFromPaste(pg.id, shared, 'test')
  await P.addEntriesFromPaste(pc.id, shared, 'test')
  await P.setMessageTemplate(pg.id, 'Good morning, this is Gabriela.')
  await P.setMessageTemplate(pc.id, 'Good morning, this is Cedric.')
  await H.db.query(`UPDATE outreach_plans SET target_count=1 WHERE id = ANY($1::int[])`, [[pg.id, pc.id]])
  const first = await P.armPlan(pg.id, { time: '09:00', chain: false })
  const second = await P.armPlan(pc.id, { time: '09:30', chain: false })
  assert.equal(first.ok, true)
  const active = (await H.db.query(`SELECT COUNT(*)::int n FROM outreach_reservations WHERE normalized_phone=$1 AND released_at IS NULL`, [shared])).rows[0].n
  assert.equal(active, 1)
  if (second.ok) {
    const e = (await H.db.query(`SELECT eligibility_status FROM outreach_plan_entries WHERE plan_id=$1 AND normalized_phone=$2`, [pc.id, shared])).rows[0]
    assert.equal(e.eligibility_status, 'skip')
  }
})

test('H: a restart during a run never re-sends an in-flight message — it is reconciled first, reservation kept', async () => {
  const acc = await gabriela()
  const p = await P.ensurePlan(acc.id, '2026-11-24', 'test')
  await P.generateList(p.id, 2, { actor: 'test' })
  await P.setMessageTemplate(p.id, 'Good morning, this is Gabriela.')
  assert.equal((await P.armPlan(p.id, { time: '09:00', chain: false })).ok, true)
  const phones = (await H.db.query(`SELECT normalized_phone FROM outreach_plan_entries WHERE plan_id=$1 ORDER BY id`, [p.id])).rows.map(r => r.normalized_phone)
  const runId = '22222222-2222-4222-8222-222222222222'
  await H.db.query(`INSERT INTO outreach_runs(run_id,trigger_id,source,plan_id,session_name,sender_identity,message_template,contacts,pacing_mode,status,run_after,started_at)
                    VALUES ($1,'t2','website_plan',$2,'Gabriela','{}','x','[]','mixed','running',NOW(),NOW())`, [runId, p.id])
  await H.db.query(`INSERT INTO outreach_run_recipients(run_id,normalized_phone,state,sending_started_at) VALUES ($1,$2,'sending',NOW()),($1,$3,'pending',NULL)`, [runId, phones[0], phones[1]])
  await H.db.query(`UPDATE outreach_plans SET status='running', dispatch_started_at=NOW() WHERE id=$1`, [p.id])
  const recovered = await Engine.recoverInterruptedRuns()
  assert.equal(recovered, 1)
  const states = (await H.db.query(`SELECT normalized_phone, state FROM outreach_run_recipients WHERE run_id=$1 ORDER BY id`, [runId])).rows
  assert.deepEqual(states.map(s => s.state), ['ambiguous', 'pending'], 'in-flight becomes ambiguous (history check), never pending')
  assert.equal(await activeReservations(p.id), 2, 'no reservation lost')
  assert.equal(H.sent.length, 0)
})

test('I: the approved Gabriela template goes out with its exact paragraphs; a draft template is never used', async () => {
  const acc = await gabriela()
  const body = (await H.db.query(`SELECT body FROM outreach_persona_templates WHERE persona='gabriela' AND period='morning' AND slot=5`)).rows[0].body
  assert.match(body, /^Good morning,\n\nI hope you are doing well\.\n\nMy name is Gabriela/)
  // Templates are not truncated between tests: restore the other slots after.
  await H.db.query(`UPDATE outreach_persona_templates SET active=FALSE WHERE persona='gabriela' AND slot<>5 AND status='approved'`)
  test.after(() => H.db.query(`UPDATE outreach_persona_templates SET active=TRUE WHERE persona='gabriela' AND slot<>5 AND status='approved'`))
  const r = await Templates.renderAtSendTime({ mode: 'persona_rotation', persona: 'gabriela', slot: 5 }, at(MON, '09:10'))
  assert.equal(r.text, body)
  const clockAt = at(MON, '09:10')
  const p = await P.ensurePlan(acc.id, MON, 'test')
  await H.db.query(`UPDATE outreach_plans SET message_mode='persona_rotation', template_slot=5, message_template=$2 WHERE id=$1`, [p.id, body])
  await runDirectOutreach('35699811819', 'Gabriela', 'Gabriela', [{ phone: '35690000001', name: 'Owner 1' }], body, {
    suppressMirroredProgress: true, pacingType: 'cold', now: () => clockAt, sleep: async () => {}, planId: p.id,
  })
  const out = H.sent.filter(m => m.phone !== '35699811819')
  assert.equal(out.length, 1)
  assert.equal(out[0].text, body, 'final outbound payload keeps every paragraph and the signature')
  assert.match(out[0].text, /Kind regards,\nGabriela$/)
  const kevDraft = (await H.db.query(`SELECT status FROM outreach_persona_templates WHERE persona='kev' AND slot=5 AND period='morning'`)).rows[0]
  assert.equal(kevDraft.status, 'draft')
  const kevSlots = await Templates.activeSlots('kev')
  assert.ok(!kevSlots.includes(5), 'draft is not sendable')
  const rejected = (await H.db.query(`SELECT COUNT(*)::int n FROM outreach_persona_templates WHERE body ILIKE '%reaching out to owners who may have%' AND status='approved'`)).rows[0].n
  assert.equal(rejected, 0)
})

test('J: only runs that actually sent advance the start time; wrap resets to the base time', async () => {
  const acc = await gabriela()
  await A.saveConfig(acc.id, { ...BASE, enabled: true }, 'test', at('2026-11-22', '20:00'))
  await H.db.query(`UPDATE outreach_automation_configs SET sequence_epoch = $2 WHERE account_id=$1`, [acc.id, at('2026-11-01', '00:00')])
  await completedAutomationRun(acc.id, '2026-11-16', 25, 30)   // sent → counts
  await completedAutomationRun(acc.id, '2026-11-17', 0, 30)    // 0 accepted → does not count
  await completedAutomationRun(acc.id, '2026-11-18', 30)       // counts
  const cfg = await A.getConfig(acc.id)
  assert.equal(await A.executedRunCount(acc.id, cfg.sequenceEpoch), 2)
  // saveConfig already materialised a run before these finished runs existed;
  // in production the next run is only created once the previous one ended.
  await H.db.query(`DELETE FROM outreach_plans WHERE account_id=$1 AND status='scheduled'`, [acc.id])
  const next = await A.ensureNextRun(cfg, acc, at('2026-11-22', '20:00'))
  assert.equal(S.maltaParts(new Date(next.scheduled_at)).minutes, 9 * 60 + 40, '09:00 + 2 × 20 min')
  const wrap = A.projectRuns({ ...cfg, startTime: '18:30', shiftMinutes: 20 }, { now: at('2026-11-22', '20:00'), executedRuns: 0, days: 4 })
  assert.deepEqual(wrap.map(w => w.time), ['18:30', '18:50', '18:30', '18:50'], '19:10 would leave <30 min before 19:30 → back to 18:30')
})

test('K: a restricted account suspends safely and nothing moves to another account', async () => {
  const g = await gabriela()
  const c = await H.account({ session: 'Cedric', persona: 'cedric', pace: 30 })
  await A.saveConfig(g.id, { ...BASE, enabled: true }, 'test', at('2026-11-22', '20:00'))
  const run = await A.ensureNextRun(await A.getConfig(g.id), g, at('2026-11-22', '20:00'))
  await H.db.query(`UPDATE whatsapp_accounts SET operational_status='restricted', restriction_reason='manual_restriction', restriction_until=$2 WHERE id=$1`,
    [g.id, at('2026-11-30', '09:00')])
  const r = await A.tickAccount(g.id, minus(new Date(run.scheduled_at), 90_000))
  assert.equal(r.state, 'preflight_failed')
  assert.equal((await plan(run.id)).outcome_reason, 'account_restricted')
  assert.equal((await A.getConfig(g.id)).suspendedReason, 'account_restricted')
  assert.equal((await H.db.query(`SELECT COUNT(*)::int n FROM outreach_plans WHERE account_id=$1`, [c.id])).rows[0].n, 0, 'no fallback plan on Cedric')
  assert.equal(H.sent.length, 0)
  const stillSuspended = await A.tickAccount(g.id, at(MON, '12:00'))
  assert.equal(stillSuspended.state, 'suspended', 'manual restriction still active → no auto resume')
})

test('late start: an armed run that could not start within 10 minutes is skipped, never sent hours later', async () => {
  const acc = await gabriela()
  const p = await P.ensurePlan(acc.id, '2026-11-24', 'test')
  await P.generateList(p.id, 3, { actor: 'test' })
  await P.setMessageTemplate(p.id, 'Good morning, this is Gabriela.')
  assert.equal((await P.armPlan(p.id, { time: '08:30', chain: false })).ok, true)
  await H.db.query(`UPDATE outreach_plans SET scheduled_at = NOW() - INTERVAL '9 hours' WHERE id=$1`, [p.id])
  await P.reconcileOverdueArmedPlans()
  const after = await plan(p.id)
  assert.equal(after.status, 'skipped')
  assert.equal(after.outcome_reason, 'missed_start_window')
  assert.equal(await activeReservations(p.id), 0)
  assert.equal(H.sent.length, 0)
})

test('L: KPIs reconcile with persisted records', async () => {
  const acc = await gabriela()
  for (let i = 0; i < 3; i++) {
    await H.db.query(`INSERT INTO outreach_log(phone, account_used, message_text, message_type, sent_at) VALUES ($1,'Gabriela','x','manual',NOW())`, [`3569000010${i}`])
  }
  await A.saveConfig(acc.id, { ...BASE, enabled: true, startDate: S.maltaDateStr(new Date()) }, 'test', new Date())
  const o = await A.overview(new Date())
  const row = o.accounts.find(a => a.id === acc.id)
  assert.equal(row.sentToday, 3)
  assert.equal(o.kpi.sentToday, (await H.db.query(`SELECT COUNT(*)::int n FROM outreach_log WHERE sent_at >= $1`, [S.maltaLocalToUTC(S.maltaDateStr(new Date()), '00:00')])).rows[0].n)
  assert.equal(row.days.length, 10)
  assert.equal(o.kpi.activeAccounts, 1)
  for (const d of row.days) assert.notEqual(d.state, 'completed', 'nothing shown as completed without a finished run')
})

test('DST: runs across the March 2027 change keep the same Malta wall-clock time', () => {
  const cfg = { ...BASE, startDate: '2027-03-25', startTime: '09:00', shiftMinutes: 0, windowStart: '08:30', windowEnd: '19:30' }
  const runs = A.projectRuns(cfg, { now: at('2027-03-24', '20:00'), executedRuns: 0, days: 4 })
  assert.deepEqual(runs.map(r => r.date), ['2027-03-25', '2027-03-26', '2027-03-29', '2027-03-30'])
  assert.deepEqual(runs.map(r => r.time), ['09:00', '09:00', '09:00', '09:00'])
  assert.deepEqual(runs.map(r => new Date(r.scheduledAt).getUTCHours()), [8, 8, 7, 7], 'CET 09:00 = 08:00Z, CEST 09:00 = 07:00Z')
})
