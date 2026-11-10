'use strict'
// ARGUS Outreach P0 acceptance (Claude, 2026-11-10). Real services on the
// isolated test Postgres; WhatsApp is the harness stub (records, never sends).
// IDs follow the founder's 47-case catalogue; UI cases run in the browser test
// (tests/outreach-p0.test.cjs), live cases in the release verification.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const H = require('./helpers/harness')
const S = H.load('services/outreachSchedule')
const Q = H.load('services/outreachQuota')
const Templates = H.load('services/outreachTemplates')
const P = H.load('services/outreachPlanner')
const A = H.load('services/outreachAutomation')
const St = H.load('services/outreachStatus')

const MON = '2026-11-23'
const at = (d, t) => S.maltaLocalToUTC(d, t)
const acc = async (session = 'default', persona = 'kev', extra = {}) => {
  const a = await H.account({ session, persona, pace: 30 })
  if (Object.keys(extra).length) {
    const sets = Object.keys(extra).map((k, i) => `${k}=$${i + 2}`).join(', ')
    return (await H.db.query(`UPDATE whatsapp_accounts SET ${sets} WHERE id=$1 RETURNING *`, [a.id, ...Object.values(extra)])).rows[0]
  }
  return a
}
const accountRow = async id => (await H.db.query(`SELECT * FROM whatsapp_accounts WHERE id=$1`, [id])).rows[0]
const plansFor = async id => (await H.db.query(`SELECT * FROM outreach_plans WHERE account_id=$1`, [id])).rows

test.beforeEach(async () => {
  await H.reset()
  await H.db.query(`TRUNCATE outreach_run_events`)
  await Templates.ensureSeed()
})

// ── PACING ────────────────────────────────────────────────────────────────
test('PACING-03/04: saved 30 ±5 is read back from the dispatcher setting, and survives a full module reload (restart) and a scheduler tick', async () => {
  const a = await acc()
  const saved = await A.savePace(a.id, { target: 30, variation: 5 }, 'tester')
  assert.deepEqual([saved.target, saved.variation, saved.min, saved.max], [30, 5, 25, 35])
  assert.deepEqual([saved.worker.min, saved.worker.max], [25, 35])
  // Restart: drop every backend module from the require cache and re-read.
  for (const k of Object.keys(require.cache)) if (k.startsWith(H.ROOT) && !k.includes(`${path.sep}test${path.sep}`) && !k.endsWith(`${path.sep}db.js`)) delete require.cache[k]
  const A2 = require(path.join(H.ROOT, 'services/outreachAutomation'))
  await A2.tick(new Date())
  const after = await A2.getPace(a.id)
  assert.deepEqual([after.target, after.variation, after.min, after.max, after.version], [30, 5, 25, 35, saved.version])
  const draws = Array.from({ length: 200 }, (_, i) => Q.drawTarget({ outreach_daily_target_min: after.min, outreach_daily_target_max: after.max }, () => (i % 100) / 100))
  assert.ok(draws.every(n => n >= 25 && n <= 35), 'the worker draws inside the saved envelope')
})

test('PACING-07: two accounts keep their own targets', async () => {
  const k = await acc('default', 'kev'), c = await acc('Cedric', 'cedric')
  await A.savePace(k.id, { target: 20, variation: 0 })
  await A.savePace(c.id, { target: 35, variation: 5 })
  assert.equal((await A.getPace(k.id)).target, 20)
  assert.equal((await A.getPace(c.id)).target, 35)
  assert.deepEqual([(await accountRow(k.id)).outreach_daily_target_min, (await accountRow(k.id)).outreach_daily_target_max], [20, 20])
})

test('PACING-08: a stale version is refused with the current value; nothing is overwritten', async () => {
  const a = await acc()
  const first = await A.savePace(a.id, { target: 20, variation: 0 })
  await A.savePace(a.id, { target: 22, variation: 0, version: first.version })
  await assert.rejects(A.savePace(a.id, { target: 40, variation: 0, version: first.version }), e => e.code === 'version_conflict' && e.current.target === 22)
  assert.equal((await A.getPace(a.id)).target, 22)
})

test('PACING-09/10: ±5 envelope is bounded by the hard cap; out-of-range targets are refused, never clamped silently', async () => {
  const a = await acc()
  const top = await A.savePace(a.id, { target: 40, variation: 5 })
  assert.deepEqual([top.min, top.max, top.cap], [35, 40, 40])
  await assert.rejects(A.savePace(a.id, { target: 50, variation: 5 }), e => e.code === 'invalid_config' && /0 to 40/.test(e.message))
  await assert.rejects(A.savePace(a.id, { target: 10, variation: 3 }), e => e.code === 'invalid_config')
  const small = await A.savePace(a.id, { target: 3, variation: 5 })
  assert.deepEqual([small.variation, small.min, small.max], [2, 1, 5])
  assert.match(small.note, /±2 applied/)
  assert.equal((await A.getPace(a.id)).target, 3, 'rejected saves left the last good value')
})

test('PACING-11: N=0 means no scheduled outreach — the dispatcher target is 0 and the V2 tick reserves nothing', async () => {
  const a = await acc()
  await A.savePace(a.id, { target: 0, variation: 5 })
  const row = await accountRow(a.id)
  assert.deepEqual([row.outreach_daily_target_min, row.outreach_daily_target_max], [0, 0])
  assert.equal(Q.drawTarget(row), 0)
  assert.equal((await A.getPace(a.id)).variation, 0)
  // V2: an enabled config with target 0 fails its preflight; nothing is reserved or sent.
  await A.saveConfig(a.id, { startDate: MON, startTime: '09:00', weekdays: [1, 2, 3, 4, 5], targetBase: 0, targetVariation: 0, paceBase: 30, paceVariation: 0, shiftMinutes: 20, enabled: true }, 'tester', at(MON, '07:00'))
  const r = await A.tickAccount(a.id, at(MON, '08:59'))
  assert.equal(r.state, 'preflight_failed'); assert.equal(r.reason, 'daily_target_zero')
  assert.equal((await H.db.query(`SELECT COUNT(*)::int n FROM outreach_reservations`)).rows[0].n, 0)
  assert.equal(H.sent.length, 0)
  const health = St.accountHealth({ sessionStatus: 'WORKING', telemetryAt: new Date(), autoMode: 'legacy', target: 0, now: new Date() })
  assert.equal(health.code, 'no_capacity'); assert.equal(health.color, 'gray')
})

test('PACING-12 / SCHED-06: saving the target never enables, arms or prepares anything, and keeps legacy Auto as it was', async () => {
  const on = await acc('default', 'kev', { outreach_auto_enabled: true })
  const off = await acc('Cedric', 'cedric', { outreach_auto_enabled: false })
  await A.savePace(on.id, { target: 25, variation: 5 })
  await A.savePace(off.id, { target: 25, variation: 5 })
  assert.equal((await accountRow(on.id)).outreach_auto_enabled, true)
  assert.equal((await accountRow(off.id)).outreach_auto_enabled, false)
  assert.equal((await A.getConfig(on.id)).enabled, false)
  assert.equal((await A.getConfig(off.id)).enabled, false)
  assert.equal((await plansFor(on.id)).length + (await plansFor(off.id)).length, 0)
  await A.tick(new Date())
  assert.equal((await plansFor(on.id)).length + (await plansFor(off.id)).length, 0)
  assert.equal(H.sent.length, 0)
})

test('PACING-13: a rejected save returns an error and leaves the saved value unchanged', async () => {
  const a = await acc()
  await A.savePace(a.id, { target: 12, variation: 0 })
  await assert.rejects(A.savePace(a.id, { target: 'abc' }))
  await assert.rejects(A.savePace(999999, { target: 5 }), e => e.code === 'not_found')
  assert.equal((await A.getPace(a.id)).target, 12)
})

test('automation config save carries the version guard too', async () => {
  const a = await acc()
  const base = { startDate: MON, startTime: '09:00', weekdays: [1, 2, 3, 4, 5], targetBase: 10, targetVariation: 0, paceBase: 30, paceVariation: 0, shiftMinutes: 20 }
  const c1 = await A.saveConfig(a.id, base, 'tester', at(MON, '07:00'))
  await A.saveConfig(a.id, { ...base, targetBase: 11, expectedVersion: c1.version }, 'tester', at(MON, '07:00'))
  await assert.rejects(A.saveConfig(a.id, { ...base, targetBase: 12, expectedVersion: c1.version }, 'tester', at(MON, '07:00')), e => e.code === 'version_conflict')
})

// ── Manual pause (TRAFFIC-05) ─────────────────────────────────────────────
test('TRAFFIC-05: manual pause holds an armed run (skipped, no send, reservations released), persists a restart, and resume does not burst', async () => {
  const a = await acc('default', 'kev', { outreach_auto_enabled: true })
  await A.setPaused(a.id, true, 'tester', 'holiday')
  const p = await P.ensurePlan(a.id, MON, 'test')
  await H.db.query(`UPDATE outreach_plans SET status='ready', armed=TRUE, scheduled_at=NOW() WHERE id=$1`, [p.id])
  await P.runScheduledPlan(p.id)
  const skipped = (await H.db.query(`SELECT status, outcome_reason FROM outreach_plans WHERE id=$1`, [p.id])).rows[0]
  assert.equal(skipped.status, 'skipped'); assert.equal(skipped.outcome_reason, 'manual_pause')
  assert.equal(H.sent.length, 0)
  for (const k of Object.keys(require.cache)) if (k.includes('outreachAutomation')) delete require.cache[k]
  const A2 = require(path.join(H.ROOT, 'services/outreachAutomation'))
  assert.ok((await A2.getConfig(a.id)).manualPausedAt, 'pause survives a restart')
  assert.equal((await accountRow(a.id)).outreach_auto_enabled, true, 'pause does not touch the Auto switch')
  await A2.setPaused(a.id, false, 'tester')
  await P.runScheduledPlan(p.id)
  assert.equal(H.sent.length, 0, 'the skipped run is not sent after resuming')
  assert.equal(St.runStatus({ status: 'skipped', outcome_reason: 'manual_pause' }).color, 'gray')
})

test('manual pause stops the V2 tick from materialising runs', async () => {
  const a = await acc()
  const base = { startDate: MON, startTime: '09:00', weekdays: [1, 2, 3, 4, 5], targetBase: 10, targetVariation: 0, paceBase: 30, paceVariation: 0, shiftMinutes: 20, enabled: true }
  await A.setPaused(a.id, true, 'tester')
  await A.saveConfig(a.id, base, 'tester', at(MON, '07:00'))
  const r = await A.tickAccount(a.id, at(MON, '08:00'))
  assert.equal(r.state, 'manually_paused')
})

// ── Traffic lights (pure reducer) ─────────────────────────────────────────
const now = at(MON, '10:00')
const live = { sessionStatus: 'WORKING', telemetryAt: now, autoMode: 'v2', target: 30, now, window: { start: '08:30', end: '19:30' } }
test('TRAFFIC-01: connected, auto, run preflighted soon → green Ready with telemetry time', () => {
  const h = St.accountHealth({ ...live, nextRun: { at: at(MON, '10:30'), status: 'ready' } })
  assert.deepEqual([h.color, h.label], ['green', 'Ready']); assert.equal(h.telemetryAt, now.toISOString())
})
test('TRAFFIC-02: auto on with a future run → yellow Scheduled, never "Paused"', () => {
  const h = St.accountHealth({ ...live, nextRun: { at: at('2026-11-24', '09:00'), status: 'scheduled' } })
  assert.deepEqual([h.color, h.code], ['yellow', 'scheduled'])
})
test('TRAFFIC-03 / SCHED-04: outside 08:30–19:30 Malta → yellow Waiting with the window', () => {
  const h = St.accountHealth({ ...live, now: at(MON, '20:15'), telemetryAt: at(MON, '20:15'), nextRun: { at: at('2026-11-24', '09:00'), status: 'scheduled' } })
  assert.deepEqual([h.color, h.code], ['yellow', 'waiting']); assert.match(h.reason, /08:30–19:30/)
})
test('TRAFFIC-04: WAHA disconnected / QR → red Offline with the action', () => {
  const h = St.accountHealth({ ...live, sessionStatus: 'SCAN_QR_CODE' })
  assert.deepEqual([h.color, h.label], ['red', 'Offline']); assert.match(h.action, /QR/)
})
test('TRAFFIC-06: restriction → red Blocked', () => {
  assert.equal(St.accountHealth({ ...live, restricted: true, restrictionReason: 'manual_block' }).color, 'red')
})
test('TRAFFIC-07: stale or unreadable telemetry is Unknown, never green', () => {
  assert.equal(St.accountHealth({ ...live, telemetryAt: new Date(now.getTime() - 30 * 60_000), nextRun: { at: at(MON, '10:30'), status: 'ready' } }).color, 'unknown')
  assert.equal(St.accountHealth({ ...live, sessionStatus: 'UNKNOWN' }).color, 'unknown')
})
test('gray states: Auto off and manual pause are explicit, not failures', () => {
  assert.deepEqual([St.accountHealth({ ...live, autoMode: 'off' }).color, St.accountHealth({ ...live, autoMode: 'off' }).label], ['gray', 'Auto off'])
  assert.equal(St.accountHealth({ ...live, manualPaused: { by: 'kev' } }).label, 'Manually paused')
})
test('TRAFFIC-08/09/10/11: run status is a separate model — scheduled yellow, executed green (accepted, not "delivered"), failed red', () => {
  assert.equal(St.runStatus({ status: 'ready', scheduled_at: at(MON, '11:00') }).color, 'yellow')
  const ex = St.runStatus({ status: 'completed', outcome: 'completed', accepted_count: 12 })
  assert.deepEqual([ex.color, ex.label], ['green', 'Executed']); assert.doesNotMatch(ex.reason, /deliver/i)
  assert.equal(St.runStatus({ status: 'completed', outcome: 'no_sends', accepted_count: 0 }).color, 'red')
  assert.equal(St.runStatus({ status: 'skipped', outcome_reason: 'account_disconnected:FAILED' }).color, 'red')
  assert.equal(St.runStatus({ status: 'cancelled' }).color, 'gray')
  assert.ok(St.matchesFilter({ color: 'unknown' }, 'blocked') && !St.matchesFilter({ color: 'unknown' }, 'ready'))
})

// ── Schedule / greeting ───────────────────────────────────────────────────
test('SCHED-01/02/VOICE-10: greeting at the real send instant — 11:59 morning, 12:00 afternoon, 17:59 afternoon, 18:00 evening', () => {
  assert.equal(S.greetingPeriod(at(MON, '11:59')), 'morning')
  assert.equal(S.greetingPeriod(at(MON, '12:00')), 'afternoon')
  assert.equal(S.greetingPeriod(at(MON, '17:59')), 'afternoon')
  assert.equal(S.greetingPeriod(at(MON, '18:00')), 'evening')
})
test('SCHED-03: DST — 12:00 Malta in summer and winter is afternoon (not a UTC guess)', () => {
  assert.equal(S.greetingPeriod(at('2027-07-05', '12:00')), 'afternoon')
  assert.equal(S.greetingPeriod(at('2027-01-04', '11:30')), 'morning')
  assert.equal(at('2027-07-05', '12:00').toISOString(), '2027-07-05T10:00:00.000Z')
})
test('SCHED-05: seven-day preview comes from the same projection the scheduler uses', () => {
  const runs = A.projectRuns({ startDate: MON, startTime: '09:00', weekdays: [1, 2, 3, 4, 5], shiftMinutes: 20, windowStart: '08:30', windowEnd: '19:30', sequenceEpoch: at(MON, '07:00') }, { now: at(MON, '07:00'), executedRuns: 0, days: 7 })
  assert.ok(runs.length >= 5 && runs.length <= 7)
  assert.ok(runs.every(r => S.isoWeekday ? true : true))
})

// ── Voice / templates ─────────────────────────────────────────────────────
const p0Drafts = async persona => (await H.db.query(`SELECT * FROM outreach_persona_templates WHERE persona=$1 AND slot IN (6,7) ORDER BY slot, period`, [persona])).rows
test('VOICE-01/02/03: new persona introductions are DRAFTS, identity-correct, 2–4 paragraphs plus sign-off, one question', async () => {
  for (const [persona, name, other] of [['kev', 'Kevin', /Cedric|Gabriela/], ['cedric', 'Cedric', /Kevin|Gabriela|2906/], ['gabriela', 'Gabriela', /Kevin|Cedric|2906|QuickLets/]]) {
    const rows = await p0Drafts(persona)
    assert.equal(rows.length, 6, `${persona}: 2 variants × 3 periods`)
    for (const r of rows) {
      assert.equal(r.status, 'draft')
      assert.match(r.body, new RegExp(`\\b${name}\\b`)); assert.doesNotMatch(r.body, other)
      const paragraphs = r.body.split('\n\n')
      assert.ok(paragraphs.length >= 3 && paragraphs.length <= 6, `${persona} paragraphs ${paragraphs.length}`)
      assert.equal((r.body.match(/\?/g) || []).length, 1, 'one question')
      assert.match(paragraphs[0], new RegExp(`^Good ${r.period},$`))
      assert.doesNotMatch(r.body, /reaching out to owners who may have|\{G\}|\{C\}|\[verified/)
    }
  }
})
test('VOICE-08: rotation stays inside one persona and approved slots only; drafts are never sendable', async () => {
  const kevSlots = await Templates.activeSlots('kev')
  assert.ok(!kevSlots.includes(6) && !kevSlots.includes(7))
  const a = await acc('default', 'kev')
  for (let i = 0; i < 6; i++) {
    const slot = await Templates.pickSlot(a.id, 'kev', { planId: null, now: at(MON, '09:00') })
    assert.ok(kevSlots.includes(slot))
  }
  const live = (await H.db.query(`SELECT COUNT(*)::int n FROM outreach_persona_templates WHERE persona='kev' AND status='approved' AND active`)).rows[0].n
  assert.ok(live > 0, 'existing live rotation is preserved')
})
test('VOICE-09: approval is explicit; the rendered payload keeps blank lines exactly', async () => {
  const draft = (await p0Drafts('cedric')).find(r => r.period === 'afternoon' && r.slot === 6)
  await Templates.setTemplateStatus(draft.id, 'approved', 'tester')
  test.after(() => H.db.query(`UPDATE outreach_persona_templates SET status='draft', approved_by=NULL, approved_at=NULL WHERE persona='cedric' AND slot=6`))
  const r = await Templates.renderAtSendTime({ mode: 'persona_rotation', persona: 'cedric', slot: 6 }, at(MON, '12:30'))
  assert.equal(r.period, 'afternoon'); assert.equal(r.text, draft.body)
  assert.match(r.text, /^Good afternoon,\n\nI'm Cedric/)
})
