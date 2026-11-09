'use strict'
// ============================================================================
// services/outreachAutomation.js — Outreach Planner V2 automation engine
// (Claude, 2026-11-09).
//
// Root causes this replaces (see docs/ARGUS_OUTREACH_PLANNER_V2_2026-11-09.md):
//   - The legacy Auto prepared five calendar days ahead, attaching contacts to
//     days that might never run, and shifted start times by calendar day, not
//     by runs that actually happened.
//   - A run whose account was disconnected at its time stayed "armed" without
//     a job; the watchdog re-fired it every minute and it went out whenever
//     the session came back (an 08:00 run sent at 17:51).
//
// Model:
//   - One persisted config per account (outreach_automation_configs).
//   - Exactly one upcoming automation run is materialised at a time, as the
//     existing day plan (status 'scheduled', no contacts attached yet).
//   - Two minutes before its time a preflight claims it, checks the account,
//     template, quota and contacts, then reserves contacts and arms it through
//     the existing armPlan → BullMQ → outreachRunEngine path.
//   - The start time shifts by `shift_minutes` per run that ACTUALLY sent
//     something (accepted_count > 0) since sequence_epoch. Skipped, paused or
//     failed days never advance it.
//   - Wrap policy: when base + shift × n would leave less than 30 minutes
//     before the window end, the sequence restarts at the base time.
// ============================================================================
const db = require('../db')
const log = require('../logger')
const waha = require('../waha')
const outreachSchedule = require('./outreachSchedule')
const outreachQuota = require('./outreachQuota')
const outreachPace = require('./outreachPace')
const outreachStatus = require('./outreachStatus')

const PREFLIGHT_LEAD_MS = 2 * 60_000
const LATE_GRACE_MS = 10 * 60_000
const MIN_RUN_MINUTES = 30
const HEALTHY = new Set(['WORKING', 'CONNECTED'])
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

const planner = () => require('./outreachPlanner')

function toMinutes(hhmm) {
  const m = TIME_RE.exec(String(hhmm || ''))
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}
const hhmm = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
const isoWeekday = dateStr => { const d = new Date(`${dateStr}T12:00:00Z`).getUTCDay(); return d === 0 ? 7 : d }

function invalid(field, message) {
  const err = new Error(message)
  err.code = 'invalid_config'
  err.field = field
  return err
}

// ── Validation (one place; the API and the UI preview use the same rules) ───
function validateConfig(input = {}, { today = outreachSchedule.maltaDateStr() } = {}) {
  const int = (name, lo, hi) => {
    const v = Number(input[name])
    if (!Number.isInteger(v) || v < lo || v > hi) throw invalid(name, `${name} must be a whole number from ${lo} to ${hi}`)
    return v
  }
  const startDate = String(input.startDate || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw invalid('startDate', 'startDate must be YYYY-MM-DD')
  const windowStart = input.windowStart || '08:30'
  const windowEnd = input.windowEnd || '19:30'
  const ws = toMinutes(windowStart); const we = toMinutes(windowEnd)
  if (ws == null || we == null || ws < toMinutes('08:30') || we > toMinutes('19:30') || we - ws < MIN_RUN_MINUTES) {
    throw invalid('window', 'the sending window must lie inside 08:30–19:30 and be at least 30 minutes long')
  }
  const start = toMinutes(input.startTime)
  if (start == null) throw invalid('startTime', 'startTime must be HH:MM')
  if (start < ws || start + MIN_RUN_MINUTES > we) throw invalid('startTime', `startTime must leave 30 minutes inside ${windowStart}–${windowEnd}`)
  const weekdays = [...new Set((Array.isArray(input.weekdays) ? input.weekdays : [1, 2, 3, 4, 5]).map(Number))].sort()
  if (!weekdays.length || weekdays.some(d => !Number.isInteger(d) || d < 1 || d > 7)) throw invalid('weekdays', 'choose at least one weekday (1=Mon … 7=Sun)')
  const targetBase = int('targetBase', 0, outreachQuota.HARD_DAILY_CAP)
  const targetVariation = int('targetVariation', 0, 10)
  if (targetBase > 0 && targetVariation > targetBase - 1) throw invalid('targetVariation', 'variation must leave at least one contact')
  const paceBase = int('paceBase', 10, 100)
  const paceVariation = int('paceVariation', 0, 20)
  if (paceBase - paceVariation < 10 || paceBase + paceVariation > 100) throw invalid('paceVariation', 'pace ± variation must stay within 10–100%')
  const shiftMinutes = int('shiftMinutes', 0, 60)
  const templateMode = input.templateMode === 'fixed' ? 'fixed' : 'persona_rotation'
  const templateId = templateMode === 'fixed' ? Number(input.templateId) : null
  if (templateMode === 'fixed' && !Number.isInteger(templateId)) throw invalid('templateId', 'choose an approved template')
  return {
    enabled: input.enabled === true, startDate: startDate < today ? today : startDate, startTime: hhmm(start), weekdays,
    targetBase, targetVariation, paceBase, paceVariation, shiftMinutes, windowStart: hhmm(ws), windowEnd: hhmm(we),
    templateMode, templateId,
  }
}

function fromRow(row) {
  if (!row) return null
  return {
    accountId: row.account_id, agencyKey: row.agency_key, enabled: row.enabled,
    startDate: typeof row.start_date === 'string' ? row.start_date.slice(0, 10) : outreachSchedule.maltaDateStr(new Date(row.start_date.getTime() + 12 * 3600_000)),
    startTime: row.start_time, weekdays: (row.weekdays || []).map(Number), targetBase: row.target_base, targetVariation: row.target_variation,
    paceBase: row.pace_base, paceVariation: row.pace_variation, shiftMinutes: row.shift_minutes,
    windowStart: row.window_start, windowEnd: row.window_end, templateMode: row.template_mode, templateId: row.template_id,
    sequenceEpoch: row.sequence_epoch, suspendedReason: row.suspended_reason, suspendedAt: row.suspended_at,
    suspendedRecoverable: row.suspended_recoverable, version: row.version, updatedAt: row.updated_at, updatedBy: row.updated_by,
    manualPausedAt: row.manual_paused_at || null, manualPausedBy: row.manual_paused_by || null, manualPauseReason: row.manual_pause_reason || null,
  }
}

async function getConfig(accountId) {
  return fromRow((await db.query(`SELECT * FROM outreach_automation_configs WHERE account_id=$1`, [accountId])).rows[0])
}

// ── Slot arithmetic (pure) ───────────────────────────────────────────────────
function cycleLength(config) {
  const base = toMinutes(config.startTime); const end = toMinutes(config.windowEnd)
  if (!config.shiftMinutes) return Infinity
  return Math.floor((end - MIN_RUN_MINUTES - base) / config.shiftMinutes) + 1
}
function slotMinutes(config, sequenceIndex) {
  const cycle = cycleLength(config)
  const step = Number.isFinite(cycle) ? sequenceIndex % cycle : 0
  return toMinutes(config.startTime) + config.shiftMinutes * step
}

// Future run dates/times from `fromDate`, assuming each listed run executes.
// executedRuns = runs that actually sent since sequence_epoch.
function projectRuns(config, { now = new Date(), executedRuns = 0, days = 10, fromDate = null } = {}) {
  const today = outreachSchedule.maltaDateStr(now)
  let date = [config.startDate, fromDate || today].sort().pop()
  const out = []
  let seq = executedRuns
  for (let i = 0; out.length < days && i < 60; i++, date = outreachSchedule.addDays(date, 1)) {
    if (!config.weekdays.includes(isoWeekday(date))) continue
    const minutes = slotMinutes(config, seq)
    const at = outreachSchedule.maltaLocalToUTC(date, hhmm(minutes))
    if (at.getTime() <= now.getTime()) continue
    out.push({ date, time: hhmm(minutes), scheduledAt: at.toISOString(), sequenceIndex: seq, wrapped: minutes === toMinutes(config.startTime) && seq > 0 })
    seq++
  }
  return out
}

function drawWithin(base, variation, lo, hi, rng = Math.random) {
  if (!variation) return Math.max(lo, Math.min(hi, base))
  const v = base - variation + Math.floor(rng() * (variation * 2 + 1))
  return Math.max(lo, Math.min(hi, v))
}

// ── Persistence ─────────────────────────────────────────────────────────────
async function event(planId, accountId, kind, ok = null, detail = {}) {
  try {
    await db.query(`INSERT INTO outreach_run_events(plan_id,account_id,kind,ok,detail) VALUES($1,$2,$3,$4,$5)`,
      [planId || null, accountId || null, kind, ok, JSON.stringify(detail || {})])
  } catch (err) { log.debug('outreachAutomation: event write failed', { kind, err: err.message }) }
}

async function executedRunCount(accountId, epoch) {
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM outreach_plans
      WHERE account_id=$1 AND run_mode='automation' AND accepted_count > 0
        AND COALESCE(dispatch_started_at, executed_at, scheduled_at) >= $2`, [accountId, epoch])
  return r.rows[0].n
}

async function saveConfig(accountId, input, actor = 'admin', now = new Date()) {
  const account = (await db.query(`SELECT id, is_active, outreach_enabled FROM whatsapp_accounts WHERE id=$1`, [accountId])).rows[0]
  if (!account) throw Object.assign(new Error('account not found'), { code: 'not_found' })
  const c = validateConfig(input, { today: outreachSchedule.maltaDateStr(now) })
  if (c.templateMode === 'fixed') {
    const t = (await db.query(`SELECT status, active FROM outreach_persona_templates WHERE id=$1`, [c.templateId])).rows[0]
    if (!t || t.status !== 'approved' || !t.active) throw invalid('templateId', 'the template must be approved and active')
  }
  const before = await getConfig(accountId)
  // P0 (2026-11-10): optimistic concurrency - a stale tab cannot overwrite a newer save.
  if (before && input.expectedVersion != null && Number(input.expectedVersion) !== before.version) {
    throw Object.assign(new Error('These settings were changed elsewhere; reload to see the latest version'), { code: 'version_conflict', current: before })
  }
  const scheduleChanged = !before || before.startDate !== c.startDate || before.startTime !== c.startTime || before.shiftMinutes !== c.shiftMinutes
  const row = (await db.query(
    `INSERT INTO outreach_automation_configs
       (account_id, enabled, start_date, start_time, weekdays, target_base, target_variation, pace_base, pace_variation,
        shift_minutes, window_start, window_end, template_mode, template_id, sequence_epoch, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),$15,NOW())
     ON CONFLICT (account_id) DO UPDATE SET
       enabled=EXCLUDED.enabled, start_date=EXCLUDED.start_date, start_time=EXCLUDED.start_time, weekdays=EXCLUDED.weekdays,
       target_base=EXCLUDED.target_base, target_variation=EXCLUDED.target_variation, pace_base=EXCLUDED.pace_base,
       pace_variation=EXCLUDED.pace_variation, shift_minutes=EXCLUDED.shift_minutes, window_start=EXCLUDED.window_start,
       window_end=EXCLUDED.window_end, template_mode=EXCLUDED.template_mode, template_id=EXCLUDED.template_id,
       sequence_epoch=CASE WHEN $16 THEN NOW() ELSE outreach_automation_configs.sequence_epoch END,
       suspended_reason=CASE WHEN EXCLUDED.enabled AND outreach_automation_configs.suspended_recoverable IS FALSE THEN NULL ELSE outreach_automation_configs.suspended_reason END,
       suspended_at=CASE WHEN EXCLUDED.enabled AND outreach_automation_configs.suspended_recoverable IS FALSE THEN NULL ELSE outreach_automation_configs.suspended_at END,
       suspended_recoverable=CASE WHEN EXCLUDED.enabled AND outreach_automation_configs.suspended_recoverable IS FALSE THEN NULL ELSE outreach_automation_configs.suspended_recoverable END,
       version=outreach_automation_configs.version+1, updated_by=EXCLUDED.updated_by, updated_at=NOW()
     RETURNING *`,
    [accountId, c.enabled, c.startDate, c.startTime, c.weekdays, c.targetBase, c.targetVariation, c.paceBase, c.paceVariation,
     c.shiftMinutes, c.windowStart, c.windowEnd, c.templateMode, c.templateId, actor, scheduleChanged])).rows[0]
  // The dispatch engine draws pace per run from the account's saved range
  // (outreachPace, delay multiplier 100 / pace): keep that one source of truth.
  await outreachPace.setAccountPace(accountId, { min: c.paceBase - c.paceVariation, max: c.paceBase + c.paceVariation })
  // The dispatcher reads whatsapp_accounts min/max (outreachQuota.drawTarget): one value, also for 0.
  const env = c.targetBase === 0 ? { min: 0, max: 0 } : { min: Math.max(1, c.targetBase - c.targetVariation), max: Math.min(outreachQuota.HARD_DAILY_CAP, c.targetBase + c.targetVariation) }
  await db.query(`UPDATE whatsapp_accounts SET outreach_daily_target_min=$2, outreach_daily_target_max=$3 WHERE id=$1`, [accountId, env.min, env.max])
  if (c.enabled) await retireLegacyAuto(accountId, actor, now)
  // A not-yet-prepared future automation run follows the new settings.
  await db.query(`UPDATE outreach_plans SET status='draft', run_mode='manual', scheduled_at=NULL, sequence_index=NULL, updated_at=NOW()
                   WHERE account_id=$1 AND run_mode='automation' AND status='scheduled'`, [accountId])
  await event(null, accountId, before ? 'config_saved' : 'config_created', true, { version: row.version, enabled: c.enabled, actor })
  if (c.enabled) await tickAccount(accountId, now)
  return fromRow(row)
}

// Two engines may never drive one account: enabling V2 turns the legacy
// five-day Auto off and pauses its armed, not-yet-started auto days.
async function retireLegacyAuto(accountId, actor, now) {
  const legacy = (await db.query(`SELECT outreach_auto_enabled FROM whatsapp_accounts WHERE id=$1`, [accountId])).rows[0]
  if (legacy?.outreach_auto_enabled) {
    await planner().setAutoEnabled(accountId, false, { actor: `${actor}:v2-takeover`, now })
    await event(null, accountId, 'legacy_auto_retired', true, {})
  }
}

async function setEnabled(accountId, enabled, actor = 'admin', now = new Date()) {
  const cfg = await getConfig(accountId)
  if (!cfg) throw Object.assign(new Error('no automation config saved for this account'), { code: 'not_found' })
  return saveConfig(accountId, { ...cfg, enabled: enabled === true }, actor, now)
}

async function suspend(accountId, reason, recoverable, planId = null) {
  await db.query(
    `UPDATE outreach_automation_configs SET suspended_reason=$2, suspended_at=COALESCE(suspended_at, NOW()), suspended_recoverable=$3, updated_at=NOW()
      WHERE account_id=$1 AND (suspended_reason IS DISTINCT FROM $2)`, [accountId, reason, recoverable])
  await event(planId, accountId, 'automation_suspended', false, { reason, recoverable })
}

async function sessionState(sessionName) {
  try { return String((await waha.getSessionStatus(sessionName))?.status || 'UNKNOWN').toUpperCase() } catch (_) { return 'UNKNOWN' }
}

function restrictionActive(account, now) {
  return account.operational_status === 'restricted'
    && (!account.restriction_until || new Date(account.restriction_until) > now)
}

// Recoverable suspensions lift themselves only when the cause is gone.
async function tryRecover(config, account, now) {
  if (!config.suspendedReason || config.suspendedRecoverable !== true) return false
  const state = await sessionState(account.session_name)
  if (!HEALTHY.has(state)) return false
  if (restrictionActive(account, now) && !String(account.restriction_reason || '').startsWith('session_')) return false
  await db.query(`UPDATE outreach_automation_configs SET suspended_reason=NULL, suspended_at=NULL, suspended_recoverable=NULL, updated_at=NOW() WHERE account_id=$1`, [config.accountId])
  await event(null, config.accountId, 'automation_resumed', true, { after: config.suspendedReason, session: state })
  return true
}

async function markSkipped(planId, accountId, reason, actor = 'system') {
  await planner().markPlanSkipped(planId, reason, actor)
  await event(planId, accountId, 'run_skipped', false, { reason })
}

// Make sure exactly one upcoming automation run exists. Returns it.
async function ensureNextRun(config, account, now) {
  const existing = (await db.query(
    `SELECT * FROM outreach_plans WHERE account_id=$1 AND run_mode='automation' AND status IN ('scheduled','preflight','ready','running')
      ORDER BY scheduled_at LIMIT 1`, [config.accountId])).rows[0]
  if (existing) return existing
  const executed = await executedRunCount(config.accountId, config.sequenceEpoch)
  for (const slot of projectRuns(config, { now, executedRuns: executed, days: 14 })) {
    // Preflight needs its two minutes: a slot that close is left for the next.
    if (new Date(slot.scheduledAt).getTime() - now.getTime() < PREFLIGHT_LEAD_MS) continue
    const plan = (await db.query(`SELECT * FROM outreach_plans WHERE account_id=$1 AND scheduled_date=$2`, [config.accountId, slot.date])).rows[0]
    if (plan) {
      const entryCount = (await db.query(`SELECT COUNT(*)::int AS n FROM outreach_plan_entries WHERE plan_id=$1`, [plan.id])).rows[0].n
      const untouched = !plan.armed && ['draft', 'saved'].includes(plan.status) && entryCount === 0
      if (!untouched) {
        // A manual run (or a finished/skipped day) owns this date.
        continue
      }
    }
    const target = drawWithin(config.targetBase, config.targetVariation, 0, outreachQuota.HARD_DAILY_CAP)
    const pace = drawWithin(config.paceBase, config.paceVariation, 10, 100)
    const created = (await db.query(
      `INSERT INTO outreach_plans (account_id, session_name, scheduled_date, status, created_by, run_mode, scheduled_at,
                                   sequence_index, target_snapshot, pace_snapshot, target_count, source)
       VALUES ($1,$2,$3,'scheduled','automation','automation',$4,$5,$6,$7,$6,'automation')
       ON CONFLICT (account_id, scheduled_date) DO UPDATE SET
         status='scheduled', run_mode='automation', scheduled_at=EXCLUDED.scheduled_at, sequence_index=EXCLUDED.sequence_index,
         target_snapshot=EXCLUDED.target_snapshot, pace_snapshot=EXCLUDED.pace_snapshot, target_count=EXCLUDED.target_count,
         source='automation', armed=FALSE, job_id=NULL, outcome=NULL, outcome_reason=NULL, updated_at=NOW()
       RETURNING *`,
      [config.accountId, account.session_name, slot.date, slot.scheduledAt, slot.sequenceIndex, target, pace])).rows[0]
    await event(created.id, config.accountId, 'run_scheduled', true, { at: slot.scheduledAt, sequenceIndex: slot.sequenceIndex, target, pace })
    return created
  }
  return null
}

// ── Preflight (T−2 min) ─────────────────────────────────────────────────────
async function runPreflight(planId, now = new Date()) {
  const claimed = (await db.query(
    `UPDATE outreach_plans SET status='preflight', preflight_at=NOW(), updated_at=NOW()
      WHERE id=$1 AND status='scheduled' AND run_mode='automation' RETURNING *`, [planId])).rows[0]
  if (!claimed) return { ok: false, reason: 'not_claimable' }
  const plan = claimed
  const account = (await db.query(`SELECT * FROM whatsapp_accounts WHERE id=$1`, [plan.account_id])).rows[0]
  const config = await getConfig(plan.account_id)
  const check = async (name, ok, detail = {}) => { await event(plan.id, plan.account_id, `preflight:${name}`, ok, detail); return ok }
  await event(plan.id, plan.account_id, 'preflight_started', null, { scheduledAt: plan.scheduled_at })

  const fail = async (reason, { suspendReason = null, recoverable = true } = {}) => {
    await markSkipped(plan.id, plan.account_id, reason)
    if (suspendReason) await suspend(plan.account_id, suspendReason, recoverable, plan.id)
    return { ok: false, reason }
  }

  if (!(await check('automation_enabled', !!config?.enabled && !config?.suspendedReason))) return fail('automation_not_enabled')
  const state = await sessionState(account.session_name)
  if (!(await check('account_connected', HEALTHY.has(state), { session: state }))) {
    return fail(`account_disconnected:${state}`, { suspendReason: `account_disconnected:${state}`, recoverable: true })
  }
  if (!(await check('account_not_restricted', !restrictionActive(account, now), { until: account.restriction_until }))) {
    return fail('account_restricted', { suspendReason: 'account_restricted', recoverable: true })
  }
  const at = new Date(plan.scheduled_at)
  const windowOk = outreachSchedule.isSendAllowed(at) && outreachSchedule.isSendAllowed(new Date(at.getTime() + MIN_RUN_MINUTES * 60_000 - 60_000))
  if (!(await check('time_in_window', windowOk, { at: plan.scheduled_at }))) return fail('outside_send_window')
  const persona = String(account.account_persona || '').toLowerCase()
  const templateOk = config.templateMode === 'fixed'
    ? !!(await db.query(`SELECT 1 FROM outreach_persona_templates WHERE id=$1 AND status='approved' AND active`, [config.templateId])).rows.length
    : !!persona && !!(await db.query(`SELECT 1 FROM outreach_persona_templates WHERE persona=$1 AND status='approved' AND active LIMIT 1`, [persona])).rows.length
  if (!(await check('template_approved', templateOk, { mode: config.templateMode, persona }))) {
    return fail('no_approved_template', { suspendReason: 'no_approved_template', recoverable: false })
  }
  const quota = await outreachQuota.status(plan.account_id, { now: at }).catch(() => null)
  if (!(await check('daily_cap', !!quota && quota.remaining > 0, { remaining: quota?.remaining }))) return fail('daily_cap_reached')
  const target = Math.min(plan.target_snapshot || config.targetBase, quota.remaining)
  if (target <= 0) { await check('target_positive', false, { target }); return fail('daily_target_zero') }

  // Contacts: eligibility (DNC, cooldown, global suppression, cross-account
  // reservations) is applied by generateList; armPlan reserves them.
  let generated
  try { generated = await planner().generateList(plan.id, target, { actor: 'automation-preflight', topUp: false }) }
  catch (err) { await check('contacts_eligible', false, { error: err.code || err.message }); return fail(`contact_selection_failed:${err.code || err.message}`) }
  const eligible = Number(generated?.resultEligible) || 0
  if (!(await check('contacts_eligible', eligible > 0, { eligible, target }))) {
    await planner().clearEntries(plan.id).catch(() => {})
    return fail('insufficient_eligible_contacts')
  }
  // Run with what the pool really has (never a target the arm check refuses).
  await db.query(`UPDATE outreach_plans SET target_count=$2 WHERE id=$1`, [plan.id, Math.min(target, eligible)])
  if (config.templateMode === 'fixed') {
    const body = (await db.query(`SELECT body FROM outreach_persona_templates WHERE id=$1`, [config.templateId])).rows[0].body
    await planner().setMessageTemplate(plan.id, body)
  } else {
    await planner().setRotationTemplate(plan.id, plan.account_id, persona, at)
  }
  await db.query(`UPDATE outreach_plans SET status='saved' WHERE id=$1`, [plan.id])
  const armed = await planner().armPlan(plan.id, { time: hhmm(outreachSchedule.maltaParts(at).minutes), chain: false })
  if (!(await check('armed', armed.ok, { reason: armed.reason || null, eligible }))) {
    await planner().clearEntries(plan.id).catch(() => {})
    return fail(`arm_failed:${armed.reason}`)
  }
  await db.query(`UPDATE outreach_plans SET run_mode='automation' WHERE id=$1`, [plan.id])
  await event(plan.id, plan.account_id, 'preflight_passed', true, { eligible, target, scheduledAt: armed.scheduledAt })
  return { ok: true, eligible, scheduledAt: armed.scheduledAt }
}

// ── Tick (cron, every minute) ───────────────────────────────────────────────
async function tickAccount(accountId, now = new Date()) {
  const config = await getConfig(accountId)
  const account = (await db.query(`SELECT * FROM whatsapp_accounts WHERE id=$1`, [accountId])).rows[0]
  if (!config || !account) return { accountId, state: 'no_config' }
  // Runs whose time passed without a preflight (worker down) are skipped,
  // never sent late and never counted as executed.
  const missed = (await db.query(
    `SELECT id FROM outreach_plans WHERE account_id=$1 AND run_mode='automation' AND status='scheduled' AND scheduled_at < $2`,
    [accountId, new Date(now.getTime() - LATE_GRACE_MS)])).rows
  for (const m of missed) await markSkipped(m.id, accountId, 'missed_preflight')
  if (!config.enabled) return { accountId, state: 'disabled' }
  if (config.manualPausedAt) return { accountId, state: 'manually_paused' }
  if (config.suspendedReason && !(await tryRecover(config, account, now))) return { accountId, state: 'suspended', reason: config.suspendedReason }
  if (!account.is_active || !account.outreach_enabled) return { accountId, state: 'account_inactive' }
  const next = await ensureNextRun({ ...config, suspendedReason: null }, account, now)
  if (!next) return { accountId, state: 'no_slot' }
  if (next.status === 'scheduled') {
    const t = new Date(next.scheduled_at).getTime()
    if (now.getTime() >= t - PREFLIGHT_LEAD_MS && now.getTime() < t + LATE_GRACE_MS) {
      const pf = await runPreflight(next.id, now)
      return { accountId, state: pf.ok ? 'armed' : 'preflight_failed', planId: next.id, reason: pf.reason || null }
    }
  }
  return { accountId, state: next.status, planId: next.id, scheduledAt: next.scheduled_at }
}

async function tick(now = new Date()) {
  const ids = (await db.query(`SELECT account_id FROM outreach_automation_configs WHERE enabled ORDER BY account_id`)).rows.map(r => r.account_id)
  const out = []
  for (const id of ids) {
    // One tick per account at a time, across processes.
    const client = await db.connect()
    try {
      const got = (await client.query(`SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok`, [`outreach-automation:${id}`])).rows[0].ok
      if (!got) { out.push({ accountId: id, state: 'locked' }); continue }
      try { out.push(await tickAccount(id, now)) }
      catch (err) { log.warn('outreachAutomation: tick failed', { accountId: id, err: err.message }); out.push({ accountId: id, state: 'error', reason: err.message }) }
      finally { await client.query(`SELECT pg_advisory_unlock(hashtextextended($1,0))`, [`outreach-automation:${id}`]).catch(() => {}) }
    } finally { client.release() }
  }
  return out
}

module.exports = {
  PREFLIGHT_LEAD_MS, LATE_GRACE_MS, validateConfig, fromRow, getConfig, saveConfig, setEnabled, projectRuns, slotMinutes,
  cycleLength, drawWithin, executedRunCount, ensureNextRun, runPreflight, tickAccount, tick, suspend, event, isoWeekday,
}

// ── Read model for the control center (everything from persisted records) ──
function maltaDayBounds(now = new Date()) {
  const today = outreachSchedule.maltaDateStr(now)
  return { today, start: outreachSchedule.maltaLocalToUTC(today, '00:00'), end: outreachSchedule.maltaLocalToUTC(outreachSchedule.addDays(today, 1), '00:00') }
}

const planDate = p => (typeof p.scheduled_date === 'string' ? p.scheduled_date.slice(0, 10)
  : outreachSchedule.maltaDateStr(new Date(p.scheduled_date.getTime() + 12 * 3600_000)))

function planDay(plan) {
  const display = planner().dayDisplayState(plan, { eligible: plan.target_count || 0, total: plan.target_count || 0 })
  return {
    planId: plan.id, mode: plan.run_mode, status: plan.status, state: display.state, label: display.label,
    scheduledAt: plan.scheduled_at, target: plan.target_snapshot ?? plan.target_count ?? null,
    accepted: plan.accepted_count || 0, failed: plan.failed_count || 0, skipped: plan.skipped_count || 0,
    outcome: plan.outcome, reason: plan.outcome_reason, pace: plan.pace_snapshot,
  }
}

async function timeline(accountId, { now = new Date(), days = 10, config = undefined } = {}) {
  const { today } = maltaDayBounds(now)
  const last = outreachSchedule.addDays(today, days - 1)
  const plans = (await db.query(
    `SELECT * FROM outreach_plans WHERE account_id=$1 AND scheduled_date BETWEEN $2::date AND $3::date`, [accountId, today, last])).rows
  const byDate = new Map(plans.map(p => [planDate(p), p]))
  const cfg = config === undefined ? await getConfig(accountId) : config
  let projected = []
  if (cfg?.enabled && !cfg.suspendedReason) {
    const executed = await executedRunCount(accountId, cfg.sequenceEpoch)
    projected = projectRuns(cfg, { now, executedRuns: executed, days })
  }
  const proj = new Map(projected.map(p => [p.date, p]))
  const out = []
  for (let i = 0; i < days; i++) {
    const date = outreachSchedule.addDays(today, i)
    const plan = byDate.get(date)
    const base = { date, relative: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : null, weekday: isoWeekday(date) }
    const usable = plan && !(['draft', 'saved'].includes(plan.status) && !plan.armed && !plan.scheduled_at)
    if (usable) { out.push({ ...base, ...planDay(plan) }); continue }
    const p = proj.get(date)
    if (p) {
      out.push({ ...base, mode: 'automation', state: 'planned', label: `Planned ${p.time}`, scheduledAt: p.scheduledAt,
        target: cfg.targetVariation ? `${Math.max(1, cfg.targetBase - cfg.targetVariation)}–${cfg.targetBase + cfg.targetVariation}` : cfg.targetBase,
        accepted: 0, wrapped: p.wrapped })
      continue
    }
    const suspended = cfg?.enabled && cfg.suspendedReason
    const offDay = cfg?.enabled && !cfg.weekdays.includes(isoWeekday(date))
    out.push({ ...base, state: suspended ? 'suspended' : offDay ? 'off' : 'empty',
      label: suspended ? `Suspended — ${cfg.suspendedReason.replace(/_/g, ' ')}` : offDay ? 'Not a run day' : 'Nothing planned' })
  }
  return out
}

async function overview(now = new Date()) {
  const { today, start, end } = maltaDayBounds(now)
  const accounts = (await db.query(
    `SELECT a.id, a.session_name, a.label, a.account_persona, a.is_active, a.outreach_enabled, a.operational_status,
            a.restriction_until, a.restriction_reason, a.outreach_auto_enabled, a.outreach_daily_target_min, a.outreach_daily_target_max
       FROM whatsapp_accounts a
      WHERE a.is_active = TRUE AND a.outreach_enabled = TRUE
      ORDER BY a.priority, a.id`)).rows
  const sentMap = new Map((await db.query(
    `SELECT account_used, COUNT(*)::int AS n FROM outreach_log
      WHERE sent_at >= $1 AND sent_at < $2 GROUP BY account_used`, [start, end])).rows.map(r => [r.account_used, r.n]))
  const lastAccepted = new Map((await db.query(
    `SELECT account_used, MAX(sent_at) AS last FROM outreach_log WHERE sent_at IS NOT NULL GROUP BY account_used`)).rows.map(r => [r.account_used, r.last]))
  const todayPlans = (await db.query(
    `SELECT p.*, (SELECT COUNT(*)::int FROM outreach_plan_entries e WHERE e.plan_id = p.id AND e.eligibility_status='eligible' AND e.send_status='pending') AS pending
       FROM outreach_plans p WHERE p.scheduled_date = $1::date`, [today])).rows
  const nextRuns = new Map((await db.query(
    `SELECT DISTINCT ON (account_id) account_id, scheduled_at, run_mode, status FROM outreach_plans
      WHERE status IN ('scheduled','preflight','ready') AND scheduled_at > $1 ORDER BY account_id, scheduled_at`, [now])).rows.map(r => [r.account_id, r]))
  const configs = new Map((await db.query(`SELECT * FROM outreach_automation_configs`)).rows.map(r => [r.account_id, fromRow(r)]))

  const rows = []
  // Definitions (shown as tooltips in the UI):
  //   sentToday  = provider-accepted outreach messages today (outreach_log)
  //   scheduled  = messages in today's runs that have not started yet
  //   remaining  = messages still pending in today's runs that have started
  const kpi = { sentToday: 0, scheduled: 0, remaining: 0, nextRun: null, activeAccounts: 0, accounts: accounts.length, attention: [], health: { green: 0, yellow: 0, red: 0, gray: 0, unknown: 0 } }
  for (const a of accounts) {
    const state = await sessionState(a.session_name)
    const connected = HEALTHY.has(state)
    const restricted = restrictionActive(a, now)
    const cfg = configs.get(a.id) || null
    const sent = sentMap.get(a.session_name) || 0
    const plan = todayPlans.find(p => p.account_id === a.id) || null
    const next = nextRuns.get(a.id) || null
    const days = await timeline(a.id, { now, days: 10, config: cfg })
    const running = todayPlans.find(p => p.account_id === a.id && p.status === 'running') || null
    // P0 (2026-11-10): traffic light from live WAHA state (read just now), persisted config and plans.
    const health = outreachStatus.accountHealth({
      sessionStatus: state, telemetryAt: state === 'UNKNOWN' ? null : now, restricted, restrictionUntil: a.restriction_until, restrictionReason: a.restriction_reason,
      autoMode: cfg?.enabled ? 'v2' : a.outreach_auto_enabled ? 'legacy' : 'off', suspendedReason: cfg?.enabled ? cfg.suspendedReason : null, suspendedRecoverable: cfg?.suspendedRecoverable,
      manualPaused: cfg?.manualPausedAt ? { at: cfg.manualPausedAt, by: cfg.manualPausedBy, reason: cfg.manualPauseReason } : null,
      target: a.outreach_daily_target_max, runningPlan: running, nextRun: next ? { at: next.scheduled_at, status: next.status } : null,
      window: cfg ? { start: cfg.windowStart, end: cfg.windowEnd } : null, now,
    })
    kpi.health[health.color] = (kpi.health[health.color] || 0) + 1
    kpi.sentToday += sent
    if (plan && ['scheduled', 'preflight'].includes(plan.status)) kpi.scheduled += plan.target_snapshot || plan.target_count || 0
    else if (plan && plan.status === 'ready') kpi.scheduled += plan.pending
    if (plan && plan.status === 'running') kpi.remaining += plan.pending
    if (next && (!kpi.nextRun || new Date(next.scheduled_at) < new Date(kpi.nextRun.at))) kpi.nextRun = { at: next.scheduled_at, accountId: a.id, label: a.label || a.session_name }
    if (connected && !restricted) kpi.activeAccounts++
    const attention = []
    if (!connected) attention.push(`Disconnected (${state})`)
    if (restricted) attention.push('Restricted')
    if (cfg?.enabled && cfg.suspendedReason) attention.push(`Automation suspended — ${cfg.suspendedReason.replace(/_/g, ' ')}`)
    if (plan?.status === 'skipped') attention.push(`Today skipped — ${String(plan.outcome_reason || '').replace(/_/g, ' ')}`)
    for (const reason of attention) kpi.attention.push({ accountId: a.id, label: a.label || a.session_name, reason })
    rows.push({
      id: a.id, label: a.label || a.session_name, sessionName: a.session_name, persona: a.account_persona,
      sessionStatus: state, connected, restricted, restrictionUntil: a.restriction_until, restrictionReason: a.restriction_reason,
      sentToday: sent, targetToday: plan ? (plan.target_snapshot ?? plan.target_count ?? null) : null,
      lastAcceptedAt: lastAccepted.get(a.session_name) || null,
      nextRun: next ? { at: next.scheduled_at, mode: next.run_mode, status: next.status } : null,
      automation: cfg ? { enabled: cfg.enabled, suspendedReason: cfg.suspendedReason, suspendedRecoverable: cfg.suspendedRecoverable } : null,
      legacyAuto: a.outreach_auto_enabled === true, days, attention, health,
      pace: { target: cfg ? cfg.targetBase : null, variation: cfg ? cfg.targetVariation : 0, min: a.outreach_daily_target_min, max: a.outreach_daily_target_max, version: cfg ? cfg.version : 0, savedAt: cfg ? cfg.updatedAt : null },
      manualPaused: cfg?.manualPausedAt ? { at: cfg.manualPausedAt, by: cfg.manualPausedBy, reason: cfg.manualPauseReason } : null,
    })
  }
  return { generatedAt: now.toISOString(), timezone: 'Europe/Malta', today, kpi, accounts: rows }
}

async function activity(accountId, { days = 14, now = new Date() } = {}) {
  const since = new Date(now.getTime() - days * 86400_000)
  const runs = (await db.query(
    `SELECT id, scheduled_date::text AS day, scheduled_at, run_mode, status, outcome, outcome_reason, target_snapshot, target_count,
            accepted_count, failed_count, skipped_count, preflight_at, dispatch_started_at, last_accepted_at, executed_at,
            (SELECT COUNT(*)::int FROM outreach_reservations r WHERE r.plan_id = p.id AND r.released_at IS NULL) AS reserved,
            (SELECT COUNT(*)::int FROM outreach_plan_entries e WHERE e.plan_id = p.id AND e.eligibility_status='eligible' AND e.send_status='pending') AS pending
       FROM outreach_plans p
      WHERE account_id = $1 AND (scheduled_at >= $2 OR updated_at >= $2) ORDER BY scheduled_date DESC LIMIT 30`, [accountId, since])).rows
  const ids = runs.map(r => r.id)
  const events = ids.length ? (await db.query(
    `SELECT plan_id, at, kind, ok, detail FROM outreach_run_events WHERE plan_id = ANY($1::int[])
     UNION ALL
     SELECT plan_id, created_at AS at, 'transition:' || to_state AS kind, NULL::boolean AS ok,
            jsonb_build_object('from', from_state, 'reason', reason) AS detail
       FROM outreach_plan_transitions WHERE plan_id = ANY($1::int[])
     ORDER BY at`, [ids])).rows : []
  const accountEvents = (await db.query(
    `SELECT at, kind, ok, detail FROM outreach_run_events WHERE account_id = $1 AND plan_id IS NULL AND at >= $2 ORDER BY at DESC LIMIT 50`, [accountId, since])).rows
  return { runs: runs.map(r => ({ ...r, light: outreachStatus.runStatus(r, now), events: events.filter(e => e.plan_id === r.id) })), accountEvents }
}

Object.assign(module.exports, { timeline, overview, activity })


// ── P0 (2026-11-10): pace card + manual pause ───────────────────────────────
// Daily target N contacts/day with an optional ±5 planning envelope. The
// canonical value is written in ONE transaction to the versioned automation
// config and to whatsapp_accounts min/max, which every dispatcher reads.
// Saving never enables, arms, prepares or sends anything.
const PACE_VARIATIONS = [0, 5]
function paceView(cfg, acc) {
  return {
    accountId: acc.id, target: cfg ? cfg.target_base : null, variation: cfg ? cfg.target_variation : 0,
    min: acc.outreach_daily_target_min, max: acc.outreach_daily_target_max, cap: outreachQuota.HARD_DAILY_CAP,
    version: cfg ? cfg.version : 0, savedAt: cfg ? cfg.updated_at : null, savedBy: cfg ? cfg.updated_by : null,
    worker: { min: acc.outreach_daily_target_min, max: acc.outreach_daily_target_max, source: 'whatsapp_accounts.outreach_daily_target_min/max' },
    enabled: cfg ? cfg.enabled : false, legacyAuto: acc.outreach_auto_enabled === true,
    manualPausedAt: cfg ? cfg.manual_paused_at : null,
  }
}
async function ensureConfigRow(q, accountId) {
  await q.query(
    `INSERT INTO outreach_automation_configs (account_id, enabled, start_date, start_time, target_base, target_variation, pace_base, pace_variation, updated_by)
     SELECT a.id, FALSE, (NOW() AT TIME ZONE 'Europe/Malta')::date + 1, '08:30',
            LEAST(40, GREATEST(0, ROUND((COALESCE(a.outreach_daily_target_min, 30) + COALESCE(a.outreach_daily_target_max, 40)) / 2.0)::int)), 0,
            LEAST(100, GREATEST(10, ROUND((COALESCE(a.outreach_pace_min, 30) + COALESCE(a.outreach_pace_max, 30)) / 2.0)::int)), 0, 'pace-card'
       FROM whatsapp_accounts a WHERE a.id=$1
     ON CONFLICT (account_id) DO NOTHING`, [accountId])
}
async function getPace(accountId) {
  const acc = (await db.query(`SELECT * FROM whatsapp_accounts WHERE id=$1`, [accountId])).rows[0]
  if (!acc) throw Object.assign(new Error('account not found'), { code: 'not_found' })
  const cfg = (await db.query(`SELECT * FROM outreach_automation_configs WHERE account_id=$1`, [accountId])).rows[0] || null
  return paceView(cfg, acc)
}
async function savePace(accountId, input = {}, actor = 'admin') {
  const target = Number(input.target)
  const variation = input.variation == null ? 5 : Number(input.variation)
  if (!Number.isInteger(target) || target < 0 || target > outreachQuota.HARD_DAILY_CAP) throw invalid('target', `Daily target must be a whole number from 0 to ${outreachQuota.HARD_DAILY_CAP}`)
  if (!PACE_VARIATIONS.includes(variation)) throw invalid('variation', 'Variation must be 0 or ±5')
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const acc = (await client.query(`SELECT * FROM whatsapp_accounts WHERE id=$1 FOR UPDATE`, [accountId])).rows[0]
    if (!acc) throw Object.assign(new Error('account not found'), { code: 'not_found' })
    await ensureConfigRow(client, accountId)
    const cur = (await client.query(`SELECT * FROM outreach_automation_configs WHERE account_id=$1 FOR UPDATE`, [accountId])).rows[0]
    if (input.version != null && Number(input.version) !== cur.version) {
      throw Object.assign(new Error('This target was changed elsewhere (another tab or user). Reload to see the latest value.'), { code: 'version_conflict', current: paceView(cur, acc) })
    }
    // The accepted variation never leaves fewer than one contact; it is reported back explicitly.
    const acceptedVariation = target === 0 ? 0 : Math.min(variation, target - 1)
    const env = target === 0 ? { min: 0, max: 0 } : { min: Math.max(1, target - acceptedVariation), max: Math.min(outreachQuota.HARD_DAILY_CAP, target + acceptedVariation) }
    const cfg = (await client.query(
      `UPDATE outreach_automation_configs SET target_base=$2, target_variation=$3, version=version+1, updated_by=$4, updated_at=NOW()
        WHERE account_id=$1 RETURNING *`, [accountId, target, acceptedVariation, actor])).rows[0]
    const accRow = (await client.query(
      `UPDATE whatsapp_accounts SET outreach_daily_target_min=$2, outreach_daily_target_max=$3 WHERE id=$1 RETURNING *`, [accountId, env.min, env.max])).rows[0]
    await client.query(`INSERT INTO outreach_run_events (plan_id, account_id, kind, ok, detail) VALUES (NULL,$1,'pace_saved',TRUE,$2)`,
      [accountId, JSON.stringify({ target, requestedVariation: variation, variation: acceptedVariation, min: env.min, max: env.max, version: cfg.version, actor })])
    await client.query('COMMIT')
    return { ...paceView(cfg, accRow), requested: { target, variation }, note: acceptedVariation !== variation ? `±${variation} would go below 1 contact; ±${acceptedVariation} applied` : null }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }
}
async function setPaused(accountId, paused, actor = 'admin', reason = null) {
  const acc = (await db.query(`SELECT id FROM whatsapp_accounts WHERE id=$1`, [accountId])).rows[0]
  if (!acc) throw Object.assign(new Error('account not found'), { code: 'not_found' })
  await ensureConfigRow(db, accountId)
  const row = (await db.query(
    `UPDATE outreach_automation_configs SET manual_paused_at=CASE WHEN $2 THEN COALESCE(manual_paused_at, NOW()) ELSE NULL END,
            manual_paused_by=CASE WHEN $2 THEN $3 ELSE NULL END, manual_pause_reason=CASE WHEN $2 THEN $4 ELSE NULL END,
            version=version+1, updated_by=$3, updated_at=NOW()
      WHERE account_id=$1 RETURNING *`, [accountId, paused === true, actor, reason ? String(reason).slice(0, 200) : null])).rows[0]
  await event(null, accountId, paused ? 'manual_pause' : 'manual_resume', true, { actor, reason: reason || null })
  return fromRow(row)
}
Object.assign(module.exports, { getPace, savePace, setPaused, PACE_VARIATIONS })
