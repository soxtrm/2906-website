'use strict'
// Weekly Owner Conversation Quality report on the isolated test DB.
const test = require('node:test')
const assert = require('node:assert/strict')
const H = require('./helpers/ownerHarness')
const Q = H.load('services/ownerQualityReport')

const at = iso => iso
// Real 8–10 Nov bot behaviour (texts from production logs, owner text anonymised).
const LOGS = [
  { session: 'default', log: [
    { from: 'owner', text: 'Good day we have a bungalow in Kappara 4 bedroom 3 bathrooms big pool', at: at('2026-11-10T08:39:38Z') },
    { from: 'bot', text: 'Great, noted, could you tell me the permit or licence status?', at: at('2026-11-10T09:40:47Z') }] },
  { session: 'Gabriela', log: [
    { from: 'owner', text: 'Hello, yes two bedroom apartment in Msida, coming available towards the end of the year', at: at('2026-11-09T09:04:03Z') },
    { from: 'bot', text: 'Perfect, thank you, Do you consider professional sharing in the apartment?', at: at('2026-11-09T09:31:21Z') },
    { from: 'owner', text: 'ok', at: at('2026-11-09T09:35:00Z') },
    { from: 'bot', text: "One last question, sorry for the spam, but I want to make sure I ask before I don't and you somehow accept it. If I have super serious subletting companies with very interesting offers for you, would you may consider it?", at: at('2026-11-09T09:40:33Z') }] },
  { session: 'default', log: [
    { from: 'owner', text: 'Studio in Valletta, 1100e', at: at('2026-11-09T14:30:00Z') },
    { from: 'bot', text: 'How many bedrooms does it have?', at: at('2026-11-09T14:35:37Z') },
    { from: 'owner', text: '[voice]', at: at('2026-11-09T14:40:00Z') },
    { from: 'bot', text: 'Thank you for your feedback, I am currently on appointments, I will be coming back later to you', at: at('2026-11-09T14:41:14Z') }] },
  { session: 'Argus3', log: [
    { from: 'owner', text: 'Which company do you work for?', at: at('2026-11-09T20:10:00Z') },
    { from: 'bot', text: 'How many bedrooms are there?', at: at('2026-11-09T21:36:00Z') }] },
]

test.before(async () => {
  await H.db.query(`TRUNCATE owner_auto_conversations RESTART IDENTITY CASCADE`)
  await H.db.query(`TRUNCATE owner_ai_quality_reviews, owner_ai_fixture_candidates, owner_ai_quality_reports, owner_ai_quality_incidents, owner_ai_decisions RESTART IDENTITY CASCADE`)
  await H.db.query(`TRUNCATE whatsapp_accounts RESTART IDENTITY CASCADE`)
  for (const [s, p] of [['default', 'kev'], ['Gabriela', 'gabriela'], ['Argus3', 'kev']]) await H.account(s, p)
  for (const c of LOGS) {
    await H.db.query(`INSERT INTO owner_auto_conversations (phone, session, status, checklist, created_at, updated_at) VALUES ('35699000111', $1, 'active_collecting', $2::jsonb, '2026-11-08T08:00:00Z', '2026-11-10T10:00:00Z')`,
      [c.session, JSON.stringify({ _log: c.log })])
  }
  await H.db.query(`INSERT INTO owner_ai_decisions (next_action, reason_code, policy_version, created_at) VALUES ('DEFER','OUT_OF_HOURS','test','2026-11-09T22:00:00Z'), ('DNC','DNC','test','2026-11-09T12:00:00Z')`)
})
test.after(async () => { await H.db.end?.().catch(() => {}); setTimeout(() => process.exit(process.exitCode || 0), 300).unref() })

let reportId
test('period is the previous seven Malta calendar days; Monday run is 08:30 Malta', () => {
  assert.deepEqual(Q.periodFor(new Date('2026-11-16T07:30:00Z')), { from: '2026-11-09', to: '2026-11-15' })
  assert.equal(Q.nextMondayRun(new Date('2026-11-10T12:00:00Z')).toISOString(), '2026-11-16T07:30:00.000Z')
  assert.equal(Q.nextMondayRun(new Date('2026-11-16T07:30:00Z')).toISOString(), '2026-11-23T07:30:00.000Z')
  assert.equal(Q.nextMondayRun(new Date('2027-03-25T12:00:00Z')).toISOString(), '2027-03-29T06:30:00.000Z', 'DST: CEST = UTC+2')
})

test('generate measures real conversations: permit-to-home, studio, spam pitch, fabricated status, ignored question, quiet hours', async () => {
  const out = await Q.generate({ now: new Date('2026-11-11T09:00:00Z'), trigger: 'manual', createdBy: 'test' })
  reportId = out.id
  const r = out.report
  assert.deepEqual(r.period, { from: '2026-11-04', to: '2026-11-10', timezone: 'Europe/Malta' })
  assert.equal(r.denominators.conversations, 4)
  assert.equal(r.indicators.residential_permit_questions, 1)
  assert.equal(r.indicators.room_studio_misinterpretations, 1)
  assert.ok(r.indicators.forbidden_copy >= 2, JSON.stringify(r.indicators))
  assert.ok(r.indicators.direct_questions_ignored >= 1)
  assert.ok(r.indicators.quiet_hours_violations >= 1)
  assert.equal(r.indicators.quiet_hours_blocked, 1)
  assert.equal(r.indicators.dnc_events, 1)
  assert.match(out.digest, /^Owner AI: \d+ issues need review; \d+ P0; \d+ good examples preserved/)
  for (const c of r.cases) { assert.doesNotMatch(c.inbound_excerpt + c.outbound_excerpt, /35699000111|\b\d{8,}\b/) }
})

test('reports are immutable rows; review appends and creates a fixture candidate; block does not', async () => {
  const rep = await Q.get(reportId)
  const [first, second] = rep.report.cases
  await Q.review(reportId, first.case_id, { decision: 'correct', correctedAction: 'ACKNOWLEDGE_UPDATE/RESIDENTIAL_NOT_COMMERCIAL', correctedReply: 'Thanks — noted as a residential bungalow.' }, 'founder')
  await Q.review(reportId, second.case_id, { decision: 'block', note: 'acceptable' }, 'founder')
  const fx = (await H.db.query(`SELECT fixture FROM owner_ai_fixture_candidates`)).rows
  assert.equal(fx.length, 1)
  assert.equal(fx[0].fixture.expected_action, 'ACKNOWLEDGE_UPDATE')
  assert.equal(fx[0].fixture.fixture_class, 'FOUNDER_WEEKLY_REVIEW')
  const again = await Q.get(reportId)
  assert.deepEqual(again.report, rep.report, 'report content unchanged by reviews')
  assert.equal(again.reviews.length, 2)
  await assert.rejects(Q.review(reportId, 'C-nope', { decision: 'approve' }, 'founder'), /case not found/)
})

test('anonymised export carries no conversation ids, sessions or phone fragments', async () => {
  const exp = Q.exportable(await Q.get(reportId))
  const s = JSON.stringify(exp)
  assert.doesNotMatch(s, /secure_chat_ref|owner_auto_conversations:|"session"|35699000111/)
  assert.ok(exp.cases.length > 0)
})

test('scheduled tick runs once when due, persists the next Monday, and is idempotent', async () => {
  await H.db.query(`UPDATE owner_ai_quality_schedule SET next_run_at='2026-11-16T07:30:00Z', last_run_at=NULL WHERE id='weekly_owner_ai'`)
  const early = await Q.tick(new Date('2026-11-16T07:29:00Z'))
  assert.equal(early.ran, false)
  const due = await Q.tick(new Date('2026-11-16T07:30:00Z'))
  assert.equal(due.ran, true)
  const row = (await H.db.query(`SELECT next_run_at, last_report_id FROM owner_ai_quality_schedule WHERE id='weekly_owner_ai'`)).rows[0]
  assert.equal(new Date(row.next_run_at).toISOString(), '2026-11-23T07:30:00.000Z')
  assert.equal(row.last_report_id, due.id)
  const twice = await Q.tick(new Date('2026-11-16T07:31:00Z'))
  assert.equal(twice.ran, false)
  const n = (await H.db.query(`SELECT count(*)::int n FROM owner_ai_quality_reports WHERE trigger='scheduled'`)).rows[0].n
  assert.equal(n, 1)
})
