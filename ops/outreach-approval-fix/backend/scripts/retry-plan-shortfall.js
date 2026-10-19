// Re-shoot today's plan shortfall for one account (Kev, 2026-10-18: "was
// nicht weggeschickt wurde, für den jeweiligen Account nochmal").
//
//   node /app/scripts/retry-plan-shortfall.js <session> [--go]
//
// For the account's plan of today (Malta date): want = plan target minus what
// was actually delivered today. Builds a fresh list with the production list
// builder (25-day rotation + WhatsApp pre-check), drops every number already
// in any run today, and enqueues ONE run through the normal run engine (same
// pacing, volume percent and sender-identity checks as a plan run), with the
// plan's own message template. Without --go it only prints what it would do
// (the cursor is not moved, nothing is enqueued).
'use strict'
const db = require('/app/db')
const lb = require('/app/services/listBuilder')
const engine = require('/app/services/outreachRunEngine')
const { maltaTodayStr } = require('/app/services/outreachPlanner')

;(async () => {
  const [session, flag] = process.argv.slice(2)
  const go = flag === '--go'
  if (!session) throw new Error('usage: retry-plan-shortfall.js <session> [--go]')
  const today = maltaTodayStr()
  const plan = (await db.query(
    `SELECT p.* FROM outreach_plans p WHERE p.session_name = $1 AND p.scheduled_date = $2`, [session, today])).rows[0]
  if (!plan) throw new Error(`no plan for ${session} on ${today}`)
  if (!plan.message_template?.trim()) throw new Error(`plan ${plan.id} has no message`)
  const runs = (await db.query(
    `SELECT r.*, (SELECT count(*) FROM outreach_run_recipients x WHERE x.run_id::text IN (r.id::text, r.run_id::text) AND x.state='sent')::int AS sent,
            (SELECT count(*) FROM outreach_run_recipients x WHERE x.run_id::text IN (r.id::text, r.run_id::text) AND x.state='pending')::int AS pending
       FROM outreach_runs r WHERE r.session_name = $1 AND r.created_at::date >= ($2::date - 1) AND (r.plan_id = $3 OR r.trigger_id LIKE $4)`,
    [session, today, plan.id, `plan-${plan.id}-retry-%`])).rows
  if (runs.some(r => ['ready', 'claimed', 'running', 'held'].includes(r.status) && r.pending > 0)) {
    console.log(JSON.stringify({ session, plan: plan.id, skipped: 'a run for this plan is still active', runs: runs.map(r => ({ status: r.status, sent: r.sent, pending: r.pending })) }))
    process.exit(0)
  }
  const target = plan.target_count || Math.max(...runs.map(r => (r.contacts || []).length), 0)
  const delivered = runs.reduce((n, r) => n + r.sent, 0)
  const want = Math.max(0, target - delivered)
  if (!want) { console.log(JSON.stringify({ session, plan: plan.id, target, delivered, skipped: 'nothing short' })); process.exit(0) }

  const usedToday = new Set((await db.query(
    `SELECT DISTINCT x.normalized_phone FROM outreach_run_recipients x JOIN outreach_runs r ON x.run_id::text IN (r.id::text, r.run_id::text)
      WHERE r.created_at > NOW() - INTERVAL '24 hours'`)).rows.map(r => r.normalized_phone))
  const built = await lb.buildPoolBatch(session, want + 5, { advanceCursor: go })
  const list = built.list.filter(c => !usedToday.has(c.phone_normalized)).slice(0, want)
  const original = runs[0]
  const summary = { session, plan: plan.id, target, delivered, want, found: list.length, notOnWhatsApp: built.reachability?.notRegistered, unverified: built.reachability?.unverified, pool: built.pool, wrapped: !!built.wrapped }
  if (!go || !list.length) { console.log(JSON.stringify({ ...summary, dryRun: !go })); process.exit(0) }

  const attempt = runs.filter(r => String(r.trigger_id).startsWith(`plan-${plan.id}-retry-`)).length + 1
  const run = await engine.enqueueOutreachRun({
    triggerId: `plan-${plan.id}-retry-${attempt}`, source: 'plan_retry', session,
    replySession: original?.reply_session || null, initiatedBy: original?.initiated_by || null,
    template: plan.message_template, pacingMode: original?.pacing_mode || 'mixed',
    contacts: list.map(c => ({ name: c.name, phone: c.phone_normalized, ownerId: c.id })),
  })
  console.log(JSON.stringify({ ...summary, enqueued: run.run_id, status: run.status }))
  process.exit(0)
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
