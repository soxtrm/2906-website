'use strict'
// ============================================================================
// services/outreachAutoStatus.js — one honest Auto Outreach status per account
// (Kev, 2026-11-21: "Do not declare this solved just because the interface
// displays Active"). Read-only; every number comes from persisted records:
//   selected   = entries in the day's list
//   eligible   = entries that passed the eligibility checks
//   queued     = entries holding an active reservation (armed, not yet sent)
//   accepted   = entries the provider accepted (send_status 'sent')
//   delivered  = of those, WhatsApp delivery receipts recorded (outreach_log)
//   failed     = send attempts the provider refused
//   skipped    = entries left out, with their reason (opt-out, cooldown, …)
// Account state is one of: active · scheduled · ready_to_start · waiting ·
// paused_agent · paused_admin · connection_error · blocked · completed ·
// failed · auto_off — never a generic "Paused".
// ============================================================================
const db = require('../db')
const waha = require('../waha')
const outreachSchedule = require('./outreachSchedule')
const outreachQuota = require('./outreachQuota')

const HEALTHY = new Set(['WORKING', 'CONNECTED'])
const human = s => String(s || '').replace(/[:_]/g, ' ').replace(/\s+/g, ' ').trim()
const maltaHM = d => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(d))

async function forAccount(accountId, { now = new Date() } = {}) {
  const planner = require('./outreachPlanner')
  const a = (await db.query(`SELECT * FROM whatsapp_accounts WHERE id=$1`, [accountId])).rows[0]
  if (!a) { const err = new Error('account not found'); err.code = 'not_found'; throw err }
  const cfg = (await db.query(`SELECT manual_paused_at, manual_paused_by, manual_pause_reason, target_variation FROM outreach_automation_configs WHERE account_id=$1`, [accountId])).rows[0] || null
  let session = 'UNKNOWN'
  try { session = String((await waha.getSessionStatus(a.session_name))?.status || 'UNKNOWN').toUpperCase() } catch (_) {}
  const healthy = HEALTHY.has(session)
  const env = planner.batchEnvelope(a)
  const today = outreachSchedule.maltaDateStr(now)
  const plans = (await db.query(
    `SELECT p.*,
            (SELECT COUNT(*)::int FROM outreach_plan_entries e WHERE e.plan_id=p.id) AS selected,
            (SELECT COUNT(*)::int FROM outreach_plan_entries e WHERE e.plan_id=p.id AND e.eligibility_status='eligible') AS eligible,
            (SELECT COUNT(*)::int FROM outreach_reservations r WHERE r.plan_id=p.id AND r.released_at IS NULL) AS queued,
            -- while a run is sending, its recipients are the live record; entries are booked when it ends
            GREATEST((SELECT COUNT(*)::int FROM outreach_plan_entries e WHERE e.plan_id=p.id AND e.send_status='sent'),
                     (SELECT COUNT(*)::int FROM outreach_run_recipients rr JOIN outreach_runs r ON r.run_id=rr.run_id WHERE r.plan_id=p.id AND rr.state='sent')) AS accepted,
            GREATEST((SELECT COUNT(*)::int FROM outreach_plan_entries e WHERE e.plan_id=p.id AND e.send_status='failed'),
                     (SELECT COUNT(*)::int FROM outreach_run_recipients rr JOIN outreach_runs r ON r.run_id=rr.run_id WHERE r.plan_id=p.id AND rr.state='failed')) AS failed_n,
            (SELECT COUNT(*)::int FROM outreach_run_recipients rr JOIN outreach_runs r ON r.run_id=rr.run_id WHERE r.plan_id=p.id AND rr.state IN ('sent','failed','ambiguous','sending')) AS dispatched,
            (SELECT COALESCE(jsonb_object_agg(reason, n), '{}'::jsonb) FROM (
               SELECT COALESCE(skip_reason, 'skipped') AS reason, COUNT(*)::int AS n FROM outreach_plan_entries e
                WHERE e.plan_id=p.id AND (e.eligibility_status='skip' OR e.send_status='skipped') GROUP BY 1) s) AS skip_reasons
       FROM outreach_plans p
      WHERE p.account_id=$1 AND p.scheduled_date BETWEEN $2::date AND $2::date + 4 ORDER BY p.scheduled_date`, [accountId, today])).rows
  const days = []
  for (const p of plans) {
    let delivered = 0
    if (p.accepted > 0 && p.dispatch_started_at) {
      delivered = (await db.query(
        `SELECT COUNT(*)::int AS n FROM outreach_log l JOIN outreach_plan_entries e ON e.normalized_phone = l.phone AND e.plan_id=$1 AND e.send_status='sent'
          WHERE l.account_used=$2 AND l.sent_at >= $3 AND l.delivered IS TRUE`, [p.id, a.session_name, p.dispatch_started_at])).rows[0].n
    }
    const display = planner.dayDisplayState(p, { eligible: p.eligible, total: p.selected })
    days.push({
      planId: p.id, date: typeof p.scheduled_date === 'string' ? p.scheduled_date.slice(0, 10) : outreachSchedule.maltaDateStr(new Date(new Date(p.scheduled_date).getTime() + 12 * 3600_000)),
      status: p.status, armed: p.armed, scheduledAt: p.scheduled_at, display, holdReason: p.hold_reason || null,
      batch: { min: p.batch_min, max: p.batch_max, target: p.target_count },
      counts: { selected: p.selected, eligible: p.eligible, queued: p.queued, dispatched: p.dispatched, accepted: p.accepted, delivered, failed: p.failed_n, skipped: Object.values(p.skip_reasons || {}).reduce((s, n) => s + n, 0) },
      skipReasons: p.skip_reasons || {}, outcome: p.outcome, outcomeReason: p.outcome_reason, messageMode: p.message_mode,
    })
  }
  const last = (await db.query(
    `SELECT id, scheduled_date::text AS day, accepted_count, COALESCE(last_accepted_at, executed_at) AS at FROM outreach_plans
      WHERE account_id=$1 AND accepted_count > 0 ORDER BY COALESCE(last_accepted_at, executed_at) DESC NULLS LAST LIMIT 1`, [accountId])).rows[0] || null
  const next = days.find(d => d.armed && ['ready', 'blocked_session'].includes(d.status) && d.scheduledAt && new Date(d.scheduledAt) > now) || null
  const running = days.find(d => d.status === 'running') || null
  const quota = await outreachQuota.status(accountId, { now }).catch(() => null)
  const restricted = a.operational_status === 'restricted' && (!a.restriction_until || new Date(a.restriction_until) > now)
  const sessionHold = restricted && String(a.restriction_reason || '').startsWith('session_')

  let s
  if (cfg?.manual_paused_at) {
    s = { state: 'paused_agent', label: `Paused by ${cfg.manual_paused_by || 'agent'}`, reason: cfg.manual_pause_reason || 'Paused by hand', next: 'Resume when ready. Nothing is sent until then.' }
  } else if (restricted && !sessionHold) {
    const admin = /manual/.test(String(a.restriction_reason || ''))
    s = { state: admin ? 'paused_admin' : 'blocked', label: admin ? 'Paused by administrator' : 'Blocked — account restricted', reason: human(a.restriction_reason), next: a.restriction_until ? `Held until ${maltaHM(a.restriction_until)} Malta, or until cleared by hand.` : 'Held until cleared by hand.' }
  } else if (!healthy || sessionHold) {
    s = { state: 'connection_error', label: 'Connection error', reason: `WhatsApp session ${human(session).toLowerCase()}`, next: 'Reconnect the session. Scheduled runs retry every 3 minutes for 45 minutes; held days schedule again by themselves once it is back.' }
  } else if (running) {
    s = { state: 'active', label: 'Active — sending now', reason: `${running.counts.accepted} of ${running.counts.eligible} accepted so far`, next: null }
  } else if (!a.outreach_auto_enabled) {
    s = next
      ? { state: 'scheduled', label: 'Scheduled (manual)', reason: 'Auto is off; a manually armed day will run.', next: `Next run ${maltaHM(next.scheduledAt)} Malta.` }
      : { state: 'auto_off', label: 'Auto off', reason: 'Nothing runs automatically for this account.', next: 'Turn Auto on to schedule the next five days.' }
  } else if (!a.outreach_auto_rolling) {
    s = { state: 'ready_to_start', label: 'Ready to start', reason: 'Auto has prepared the days, but nobody has started them yet. Nothing will be sent.', next: 'Press Start Auto to schedule them.' }
  } else if (next) {
    s = { state: 'scheduled', label: 'Scheduled', reason: `${next.batch.target || next.counts.eligible} owners at ${maltaHM(next.scheduledAt)} Malta`, next: `Next run ${maltaHM(next.scheduledAt)} Malta.` }
  } else if (quota && quota.remaining <= 0) {
    s = { state: 'waiting', label: 'Temporarily waiting', reason: `Daily cap reached (${quota.used}/${quota.cap})`, next: 'Continues tomorrow from 08:30.' }
  } else if (!outreachSchedule.isSendAllowed(now)) {
    s = { state: 'waiting', label: 'Temporarily waiting', reason: 'Outside the 08:30–19:30 sending window', next: 'The 5-minute maintenance prepares and schedules the next day.' }
  } else {
    const todayPlan = days.find(d => d.date === today)
    if (todayPlan && todayPlan.status === 'failed') s = { state: 'failed', label: 'Failed', reason: human(todayPlan.outcomeReason) || 'Run failed', next: 'Check the account and its contacts; the next day is prepared automatically.' }
    else if (todayPlan && todayPlan.status === 'completed' && !days.some(d => d.date > today && (d.armed || d.counts.eligible > 0))) s = { state: 'completed', label: 'Completed', reason: `${todayPlan.counts.accepted} accepted today`, next: 'The next day is prepared within 5 minutes.' }
    else s = { state: 'waiting', label: 'Temporarily waiting', reason: 'No day is scheduled right now (pool shortage or a blocked day — see the days below)', next: 'The 5-minute maintenance prepares and schedules eligible days.' }
  }

  return {
    accountId, generatedAt: now.toISOString(), session, healthy,
    auto: { enabled: a.outreach_auto_enabled === true, rolling: a.outreach_auto_rolling === true, ...s },
    batch: { base: Math.round((env.min + env.max) / 2), variation: Math.round((env.max - env.min) / 2), min: env.min, max: env.max, hardCap: outreachQuota.HARD_DAILY_CAP },
    lastSuccess: last ? { planId: last.id, day: last.day, at: last.at, accepted: last.accepted_count } : null,
    nextRun: next ? { planId: next.planId, at: next.scheduledAt, target: next.batch.target, queued: next.counts.queued } : null,
    quotaToday: quota, days,
  }
}

module.exports = { forAccount }
