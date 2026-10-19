// Catch-up for the 2026-10-19 outreach shortfall (Cedric 10/37, kevthirdd 2/32 —
// today's lists were built before the WhatsApp pre-check existed).
// Uses ONLY the planner functions the CRM UI uses. Without --go: dry run.
const db = require('/app/db')
const P = require('/app/services/outreachPlanner')
const go = process.argv.includes('--go')

// [session, date, target] — top-ups of armed days and brand-new days
const WORK = [
  ['Cedric', '2026-10-20', 40], ['Cedric', '2026-10-21', 40], ['Cedric', '2026-10-22', 40], ['Cedric', '2026-10-23', 40],
  ['kevthirdd', '2026-10-20', 40], ['kevthirdd', '2026-10-21', 40], ['kevthirdd', '2026-10-22', 40], ['kevthirdd', '2026-10-23', 40],
  ['Kevsecond', '2026-10-21', 35], ['Kevsecond', '2026-10-22', 35],
]

const eligibleOf = async id => (await db.query(`SELECT count(*)::int n FROM outreach_plan_entries WHERE plan_id=$1 AND eligibility_status='eligible'`, [id])).rows[0].n

;(async () => {
  for (const [session, date, target] of WORK) {
    const plan = (await db.query(`SELECT * FROM outreach_plans WHERE session_name=$1 AND scheduled_date=$2`, [session, date])).rows[0]
    if (!plan) { console.log(session, date, 'NO PLAN ROW — skipped'); continue }
    if (plan.scheduled_at && new Date(plan.scheduled_at).getTime() < Date.now() + 30 * 60e3) { console.log(session, date, `#${plan.id} starts within 30 min / already started — NOT touched`); continue }
    if (['running', 'completed', 'cancelled'].includes(plan.status)) { console.log(session, date, `#${plan.id} ${plan.status} — NOT touched`); continue }
    const before = await eligibleOf(plan.id)
    const prev = (await db.query(`SELECT * FROM outreach_plans WHERE account_id=$1 AND scheduled_date < $2 AND scheduled_at IS NOT NULL
        AND NULLIF(BTRIM(message_template),'') IS NOT NULL ORDER BY scheduled_date DESC LIMIT 1`, [plan.account_id, date])).rows[0]
    const wasArmed = plan.armed && plan.status === 'ready'
    const time = plan.scheduled_at
      ? P.maltaTimeLabel ? P.maltaTimeLabel(new Date(plan.scheduled_at)) : null
      : (prev ? new Date(new Date(prev.scheduled_at).getTime() + 24.5 * 3600e3) : null)
    const timeLabel = typeof time === 'string' ? time
      : time ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', hour: '2-digit', minute: '2-digit', hour12: false }).format(time) : '09:00'
    console.log(`${session.padEnd(9)} ${date} #${plan.id} ${plan.status}${wasArmed ? '/armed' : ''}: ${before} → ${target} @ ${timeLabel}${plan.message_template ? '' : ` (message from #${prev?.id})`}`)
    if (!go) continue
    if (before >= target) { console.log('   already full'); continue }
    if (wasArmed || plan.status === 'ready') await P.pausePlan(plan.id)
    const gen = await P.generateList(plan.id, target, { actor: 'catchup-2026-10-19', topUp: true })
    if (!plan.message_template && prev) await P.setMessageTemplate(plan.id, prev.message_template)
    await db.query(`UPDATE outreach_plans SET target_count=$2, source=COALESCE(source,'generated'), updated_at=NOW() WHERE id=$1`, [plan.id, target])
    const armed = await P.armPlan(plan.id, { time: timeLabel })
    console.log(`   added ${gen.added ?? '?'} → eligible ${await eligibleOf(plan.id)}; arm: ${JSON.stringify(armed).slice(0, 160)}`)
  }

  // Argus5 22.10.: saved list with 11/14 numbers not on WhatsApp → rebuild (stays saved, as before)
  const a5 = (await db.query(`SELECT * FROM outreach_plans WHERE session_name='Argus5' AND scheduled_date='2026-10-22'`)).rows[0]
  if (a5) {
    console.log(`Argus5    2026-10-22 #${a5.id} ${a5.status}: rebuild 14 → 15 (verified)`)
    if (go && ['draft', 'saved'].includes(a5.status)) {
      await P.clearEntries(a5.id)
      const g = await P.generateList(a5.id, 15, { actor: 'catchup-2026-10-19' })
      await db.query(`UPDATE outreach_plans SET target_count=15, updated_at=NOW() WHERE id=$1`, [a5.id])
      console.log(`   rebuilt: ${g.added ?? '?'} eligible ${await eligibleOf(a5.id)}`)
    }
  }
  process.exit(0)
})().catch(e => { console.error('ERR', e.stack || e.message); process.exit(1) })
