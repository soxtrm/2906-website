'use strict'
// ============================================================================
// services/outreachPlanner.js — ARGUS / NEON Multi-Account Outreach Planner
// (Kev, 2026-09-11).
//
// This is a PLANNING/SCHEDULING layer on top of the existing, hardened
// outreach machinery — it does not reimplement sending. The actual send
// (pacing, cooldown checks, personalization, outreach_log, crash-durable
// checkpointing, automatic restart-recovery) is 100% services/
// adminCommands.js:runDirectOutreach() — the SAME function manual !outreach/
// !foutreach already call. List generation reuses services/listBuilder.js:
// buildPoolBatch() — the SAME function the real !createlist command calls.
//
// What's genuinely new here (nothing upstream has this today):
//   - A durable, dated Plan/Entry model per (WhatsApp account, calendar day)
//     so a queue can be prepared hours or days ahead and survive a browser/
//     phone going offline (spec point 36).
//   - A CENTRAL cross-account reservation table (outreach_reservations) —
//     confirmed missing today: listBuilder.js's buildPoolBatch() only checks
//     a SAME-account 20-day cooldown, and cooldownRules.js's canContact()
//     explicitly documents "no cross-account/cross-persona checks anywhere
//     ... no longer performed here". Without this table, DEFAULT and
//     KEVSECOND generating lists minutes apart really can select the same
//     owner twice, exactly as Kev suspected.
//   - Idempotent one-shot scheduling via BullMQ, jobId = idempotency_key, so
//     a plan can never fire twice even across a worker restart.
// ============================================================================

const db = require('../db')
const log = require('../logger')
const waha = require('../waha')
const config = require('../config')
const { addJob, QUEUES } = require('../queues')
const { buildPoolBatch } = require('./listBuilder')
const { canContact, normalizePhone: cooldownNormalizePhone } = require('./cooldownRules')

const MALTA_TZ = 'Europe/Malta'

// ── Retry policy for a plan whose OWN assigned session is unhealthy at fire
// time (2026-09-17 incident fix). Bounded, visible retries — never a silent
// ARMED -> UNARMED with no trace. ~1h of coverage at 3-minute spacing, which
// comfortably outlives a WAHA restart/QR-rescan cycle.
const MAX_RETRY_ATTEMPTS = 20
const RETRY_DELAY_MS = 3 * 60_000
// The account safety window is enforced by the backend from the real last
// send. UI suggestions never weaken this boundary.
const OUTREACH_ACCOUNT_INTERVAL_MS = (24 * 60 + 15) * 60_000
const AUTO_DAILY_MINUTES_MIN = 16
const AUTO_DAILY_MINUTES_MAX = 22
const AUTO_PREP_LEAD_MS = 2 * 60 * 60_000
const AUTO_PREP_GRACE_MS = 15 * 60_000
const OUTREACH_PLAN_MAX = 45
const NEXUSLINK_PLAN_MAX = 15
const DEFAULT_RESTRICTION_HOURS = 40
const HEALTHY_SESSION_STATES = new Set(['WORKING', 'CONNECTED'])
const RESTRICTED_SESSION_STATES = new Set(['FAILED', 'SCAN_QR_CODE', 'STOPPED'])

function planLimit(sessionName, label = '') {
  return /argus\s*5|argus[_-]?5|nexuslink/i.test(`${sessionName || ''} ${label || ''}`) ? NEXUSLINK_PLAN_MAX : OUTREACH_PLAN_MAX
}

// BullMQ reserves ':' inside custom job ids. Legacy plan keys contain ISO
// timestamps, so every derived retry/cooldown id is normalized at the queue
// boundary as well as new arm keys below.
const safeJobId = value => String(value).replace(/:/g, '-')

function starterBatchCount(value) {
  return Math.max(1, Math.min(OUTREACH_PLAN_MAX, Math.round(Number(value) || 10)))
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function addMinutesToMaltaTime(time, minutes) {
  const [hour, minute] = String(time || '14:15').split(':').map(Number)
  const total = ((hour * 60 + minute + minutes) % 1440 + 1440) % 1440
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function isSystemManagerSession(sessionName, label = '') {
  return /argus\s*1|argus[_-]?1/i.test(`${sessionName || ''} ${label || ''}`)
}

async function recordAccountEvent(accountId, eventType, { sessionStatus = null, reason = null, restrictedUntil = null, actor = 'system' } = {}) {
  await db.query(
    `INSERT INTO outreach_account_events
       (account_id, event_type, session_status, reason, restricted_until, actor)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [accountId, eventType, sessionStatus, reason, restrictedUntil, actor]
  ).catch(err => log.warn('outreachPlanner: account event write failed', { accountId, eventType, err: err.message }))
}

async function holdArmedPlansForAccount(accountId, reason) {
  const plans = (await db.query(
    `SELECT id, status, job_id FROM outreach_plans WHERE account_id=$1 AND armed=TRUE`,
    [accountId]
  )).rows
  for (const plan of plans) {
    if (plan.job_id) {
      try { const job = await QUEUES['outreach-plan'].getJob(plan.job_id); if (job) await job.remove() }
      catch (err) { log.debug('outreachPlanner: restriction job removal failed', { planId: plan.id, err: err.message }) }
    }
    await releaseReservationsForPlan(plan.id, reason)
    await db.query(`UPDATE outreach_plans SET status='saved', armed=FALSE, job_id=NULL, updated_at=NOW() WHERE id=$1`, [plan.id])
    await logTransition(plan.id, plan.status, 'saved', reason, 'system')
  }
}

async function setAccountRestriction(accountId, { restricted = true, hours = DEFAULT_RESTRICTION_HOURS, reason = 'manual_restriction', sessionStatus = null, actor = 'admin' } = {}) {
  const before = (await db.query(`SELECT * FROM whatsapp_accounts WHERE id=$1`, [accountId])).rows[0]
  if (!before) throw new Error(`account ${accountId} not found`)
  if (restricted) {
    const safeHours = Math.max(24, Math.min(168, Math.round(Number(hours) || DEFAULT_RESTRICTION_HOURS)))
    const until = new Date(Date.now() + safeHours * 60 * 60_000)
    const changed = before.operational_status !== 'restricted'
    const result = (await db.query(
      `UPDATE whatsapp_accounts
          SET operational_status='restricted',
              restriction_detected_at=CASE WHEN operational_status='restricted' THEN restriction_detected_at ELSE NOW() END,
              restriction_until=CASE WHEN operational_status='restricted' AND restriction_until > NOW() THEN restriction_until ELSE $2 END,
              restriction_reason=$3,
              last_session_status=COALESCE($4,last_session_status),
              last_session_check_at=NOW()
        WHERE id=$1 RETURNING *`,
      [accountId, until.toISOString(), reason, sessionStatus]
    )).rows[0]
    if (changed) await recordAccountEvent(accountId, 'restricted', { sessionStatus, reason, restrictedUntil: result.restriction_until, actor })
    await holdArmedPlansForAccount(accountId, `account_restricted:${reason}`)
    return result
  }
  const result = (await db.query(
    `UPDATE whatsapp_accounts
        SET operational_status='ready', restriction_detected_at=NULL,
            restriction_until=NULL, restriction_reason=NULL,
            last_session_status=COALESCE($2,last_session_status), last_session_check_at=NOW()
      WHERE id=$1 RETURNING *`, [accountId, sessionStatus]
  )).rows[0]
  if (before.operational_status === 'restricted') await recordAccountEvent(accountId, 'restriction_cleared', { sessionStatus, reason, actor })
  return result
}

async function syncAccountHealth(account, sessionStatus) {
  const status = String(sessionStatus || 'UNKNOWN').toUpperCase()
  await db.query(`UPDATE whatsapp_accounts SET last_session_status=$2,last_session_check_at=NOW() WHERE id=$1`, [account.id, status])
  if (account.is_active && account.outreach_enabled && !isSystemManagerSession(account.session_name, account.label) && RESTRICTED_SESSION_STATES.has(status)) {
    if (account.operational_status !== 'restricted') {
      return setAccountRestriction(account.id, { restricted: true, reason: `session_${status.toLowerCase()}`, sessionStatus: status, actor: 'health_check' })
    }
  } else if (HEALTHY_SESSION_STATES.has(status) && account.operational_status === 'restricted' && account.restriction_until && new Date(account.restriction_until) <= new Date()) {
    return setAccountRestriction(account.id, { restricted: false, reason: 'cooldown_elapsed_and_session_healthy', sessionStatus: status, actor: 'health_check' })
  }
  return { ...account, last_session_status: status }
}

async function accountCooldown(sessionName, at = new Date()) {
  const result = await db.query(
    `SELECT MAX(sent_at) AS last_sent_at FROM outreach_log WHERE account_used = $1 AND sent_at IS NOT NULL`,
    [sessionName]
  )
  const lastSentAt = result.rows[0]?.last_sent_at ? new Date(result.rows[0].last_sent_at) : null
  const nextEligibleAt = lastSentAt ? new Date(lastSentAt.getTime() + OUTREACH_ACCOUNT_INTERVAL_MS) : null
  return { lastSentAt, nextEligibleAt, allowed: !nextEligibleAt || nextEligibleAt <= at }
}

function autoPreparationWindow(lastSentAt, now = new Date()) {
  if (!lastSentAt) return { due: false, reason: 'no_previous_outreach' }
  const readyAt = new Date(new Date(lastSentAt).getTime() + OUTREACH_ACCOUNT_INTERVAL_MS)
  const remainingMs = readyAt.getTime() - now.getTime()
  return {
    due: remainingMs <= AUTO_PREP_LEAD_MS && remainingMs >= -AUTO_PREP_GRACE_MS,
    readyAt,
    remainingMs,
    reason: remainingMs > AUTO_PREP_LEAD_MS ? 'too_early' : remainingMs < -AUTO_PREP_GRACE_MS ? 'window_passed' : 'due',
  }
}

// ── Explicit state-transition log (spec: every ARMED exit needs a reason,
// an actor and a timestamp, queryable later — not just a log line that
// scrolls away). Best-effort: a failed audit write must never block or
// crash the transition it is describing.
async function logTransition(planId, fromState, toState, reason, actor = 'system', extra = {}) {
  try {
    await db.query(
      `INSERT INTO outreach_plan_transitions (plan_id, from_state, to_state, reason, actor, job_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [planId, fromState || null, toState, reason || null, actor, extra.job_id || null])
  } catch (e) {
    log.debug('outreachPlanner: transition log write failed (non-fatal)', { planId, err: e.message })
  }
  log.info('outreachPlanner: transition', { planId, from: fromState, to: toState, reason, actor, ...extra })
}

// ── Malta-local date/time helpers ───────────────────────────────────────────
// en-CA formats as YYYY-MM-DD, which is exactly the DATE column shape.
function maltaTodayStr(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: MALTA_TZ }).format(now)
}
function addDaysStr(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
// Converts a Malta-local wall-clock date+time into the real UTC instant it
// represents, correct across the CET/CEST DST boundary (never a hardcoded
// UTC+1/+2 offset — spec point 2's explicit requirement). Standard
// round-trip technique: guess UTC=local, see what Malta's own clock reads
// for that guess, then correct by the difference.
// node-pg returns a DATE column as a JS Date object (UTC midnight), not a
// string — every caller here may hand either shape in, so normalize once,
// centrally, rather than each call site guessing right.
function toDateStr(d) {
  if (d instanceof Date) return d.toISOString().slice(0, 10)
  return String(d).slice(0, 10)
}
function maltaLocalToUTC(dateStrOrDate, timeStr) {
  const dateStr = toDateStr(dateStrOrDate)
  const guess = new Date(`${dateStr}T${timeStr}:00.000Z`)
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: MALTA_TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
  const parts = fmt.formatToParts(guess).reduce((acc, p) => { acc[p.type] = p.value; return acc }, {})
  const shownAsUTC = new Date(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00.000Z`)
  const wantedAsUTC = new Date(`${dateStr}T${timeStr}:00.000Z`)
  const diff = wantedAsUTC.getTime() - shownAsUTC.getTime()
  return new Date(guess.getTime() + diff)
}
function maltaTimeLabel(date) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: MALTA_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}
// Dynamic label relative to Malta's CURRENT date — never stored, always
// recomputed (spec point 7: no physical day-rolling, no data migration).
function dayLabelFor(scheduledDateStr, todayStr) {
  if (scheduledDateStr === todayStr) return 'TODAY'
  if (scheduledDateStr === addDaysStr(todayStr, 1)) return 'TOMORROW'
  if (scheduledDateStr === addDaysStr(todayStr, 2)) return 'IN_2_DAYS'
  if (scheduledDateStr === addDaysStr(todayStr, 3)) return 'IN_3_DAYS'
  if (scheduledDateStr === addDaysStr(todayStr, 4)) return 'IN_4_DAYS'
  return scheduledDateStr < todayStr ? 'PAST' : 'FUTURE'
}

function normPhone(p) { return cooldownNormalizePhone(p) }

// ── Accounts / profiles ─────────────────────────────────────────────────────
async function listAccounts() {
  const r = await db.query(
    `SELECT id, session_name, phone, label, is_active, outreach_enabled, account_persona,
            outreach_volume_percent, outreach_volume_until, pool, operational_status,
            restriction_detected_at, restriction_until, restriction_reason,
            last_session_status, last_session_check_at,
            outreach_auto_base_count, outreach_auto_message
       FROM whatsapp_accounts ORDER BY priority, id`)
  // Kev, 2026-09-11: "Last Outreach" reads the REAL send history
  // (outreach_log), not just this planner's own plans — a manual !outreach
  // typed straight into WhatsApp counts too, since both write the same
  // table (services/adminCommands.js:runDirectOutreach's INSERT). This is
  // also what the arm-time auto-suggestion is based on (see suggestTime on
  // the frontend): always the real last send +30min, never a stale ARGUS-
  // only value.
  const lastSent = await db.query(
    `SELECT account_used, MAX(sent_at) AS last_sent FROM outreach_log GROUP BY account_used`)
  const lastSentMap = new Map(lastSent.rows.map(row => [row.account_used, row.last_sent]))
  const lastRuns = await db.query(`
    SELECT DISTINCT ON (session_name)
           session_name, id, status, total_contacts, sent_count, skip_count,
           started_at, completed_at, updated_at
      FROM outreach_batches
     ORDER BY session_name, COALESCE(completed_at, updated_at, started_at) DESC, id DESC`)
  const lastRunMap = new Map(lastRuns.rows.map(row => [row.session_name, row]))
  const recentRuns = await db.query(`
    SELECT * FROM (
      SELECT session_name, id, status, total_contacts, sent_count, skip_count,
             started_at, completed_at, updated_at, volume_percent_snapshot,
             ROW_NUMBER() OVER (PARTITION BY session_name ORDER BY COALESCE(completed_at,updated_at,started_at) DESC,id DESC) AS rn
        FROM outreach_batches
       WHERE status IN ('completed','cancelled','running')
    ) ranked WHERE rn <= 5 ORDER BY session_name, rn`)
  const recentRunMap = new Map()
  for (const run of recentRuns.rows) {
    const rows = recentRunMap.get(run.session_name) || []
    rows.push(run)
    recentRunMap.set(run.session_name, rows)
  }
  const restrictionCounts = await db.query(`
    SELECT account_id, COUNT(*)::int AS count
      FROM outreach_account_events
     WHERE event_type='restricted'
       AND created_at >= date_trunc('week', NOW() AT TIME ZONE 'Europe/Malta') AT TIME ZONE 'Europe/Malta'
     GROUP BY account_id`)
  const restrictionCountMap = new Map(restrictionCounts.rows.map(row => [row.account_id, Number(row.count)]))

  const today = maltaTodayStr()
  const horizon = await db.query(`SELECT account_id, scheduled_date::text AS day, status, armed, scheduled_at, target_count FROM outreach_plans WHERE scheduled_date >= $1::date AND scheduled_date <= $2::date ORDER BY scheduled_date`, [today, addDaysStr(today, 4)])
  const accounts = []
  for (const stored of r.rows) {
    let acc = stored
    let connected = false
    let sessionStatus = 'UNKNOWN'
    try {
      const status = await waha.getSessionStatus(acc.session_name)
      sessionStatus = String(status?.status || 'UNKNOWN').toUpperCase()
      connected = HEALTHY_SESSION_STATES.has(sessionStatus)
      acc = await syncAccountHealth(acc, sessionStatus)
    } catch (e) {
      log.debug('outreachPlanner: session status check failed', { session: acc.session_name, err: e.message })
    }
    const restricted = acc.operational_status === 'restricted'
    accounts.push({
      id: acc.id, sessionName: acc.session_name, phone: acc.phone,
      label: acc.label || acc.session_name, connected,
      active: acc.is_active,
      planningDays: Array.from({ length: 5 }, (_, offset) => {
        const day = addDaysStr(today, offset)
        const plan = horizon.rows.find(p => p.account_id === acc.id && p.day === day)
        return { day, label: dayLabelFor(day, today), status: plan?.status || 'empty', armed: plan?.armed === true, scheduledAt: plan?.scheduled_at || null, count: plan?.target_count || 0 }
      }),
      outreachEnabled: acc.outreach_enabled,
      lastOutreachAt: lastSentMap.get(acc.session_name) || null,
      lastRun: lastRunMap.get(acc.session_name) || null,
      recentRuns: recentRunMap.get(acc.session_name) || [],
      pool: acc.pool || 'top',
      outreachVolumePercent: acc.outreach_volume_until && new Date(acc.outreach_volume_until) <= new Date()
        ? 100
        : Number(acc.outreach_volume_percent || 100),
      outreachVolumeUntil: acc.outreach_volume_until || null,
      sessionStatus,
      operationalStatus: restricted ? 'restricted' : (connected ? 'ready' : 'offline'),
      restrictionDetectedAt: acc.restriction_detected_at || null,
      restrictionUntil: acc.restriction_until || null,
      restrictionReason: acc.restriction_reason || null,
      restrictionsThisWeek: restrictionCountMap.get(acc.id) || 0,
      outreachAutoBaseCount: acc.outreach_auto_base_count == null ? null : Number(acc.outreach_auto_base_count),
      outreachAutoMessage: acc.outreach_auto_message || '',
      outreachEligible: acc.is_active && acc.outreach_enabled && connected && !restricted && !isSystemManagerSession(acc.session_name, acc.label),
    })
  }
  return accounts
}

async function setAccountVolume(accountId, percent, days = null) {
  const value = Math.max(10, Math.min(100, Math.round(Number(percent) || 100)))
  const durationDays = days == null ? null : Math.max(1, Math.min(30, Math.round(Number(days) || 1)))
  const r = await db.query(
    `UPDATE whatsapp_accounts
        SET outreach_volume_percent = $2,
            outreach_volume_until = CASE WHEN $3::int IS NULL THEN NULL ELSE NOW() + ($3::int * interval '1 day') END
      WHERE id = $1 AND is_active = TRUE AND outreach_enabled = TRUE
      RETURNING id, session_name, outreach_volume_percent, outreach_volume_until`,
    [accountId, value, durationDays]
  )
  if (!r.rows.length) throw new Error(`account ${accountId} not found`)
  return r.rows[0]
}

// ── Plan lifecycle ───────────────────────────────────────────────────────────
// Plans are created lazily on first write (never an empty row for a day
// nobody touched yet) — see ensurePlan().
async function ensurePlan(accountId, scheduledDate, createdBy) {
  const existing = await db.query(
    `SELECT * FROM outreach_plans WHERE account_id = $1 AND scheduled_date = $2`,
    [accountId, scheduledDate])
  if (existing.rows.length) return existing.rows[0]

  const acc = await db.query(`SELECT session_name FROM whatsapp_accounts WHERE id = $1 AND is_active = TRUE AND outreach_enabled = TRUE`, [accountId])
  if (!acc.rows.length) throw new Error(`account ${accountId} not found`)

  const ins = await db.query(
    `INSERT INTO outreach_plans (account_id, session_name, scheduled_date, status, created_by)
     VALUES ($1, $2, $3, 'draft', $4) RETURNING *`,
    [accountId, acc.rows[0].session_name, scheduledDate, createdBy || null])
  return ins.rows[0]
}

async function getPlanWithEntries(planId) {
  const p = await db.query(`SELECT * FROM outreach_plans WHERE id = $1`, [planId])
  if (!p.rows.length) return null
  const entries = await db.query(
    `SELECT * FROM outreach_plan_entries WHERE plan_id = $1 ORDER BY position ASC NULLS LAST, id ASC`, [planId])
  return { ...p.rows[0], entries: entries.rows }
}

// Rolling 3-day view for one account (spec point 6/7) — real dates, labels
// computed fresh against Malta's current date every call.
async function listRollingPlans(accountId, createdBy) {
  const today = maltaTodayStr()
  const dates = Array.from({ length: 5 }, (_, day) => addDaysStr(today, day))
  const out = []
  for (const d of dates) {
    const plan = await ensurePlan(accountId, d, createdBy)
    const stats = await computeStats(plan.id)
    out.push({ ...plan, label: dayLabelFor(d, today), stats })
  }
  return out
}

async function computeStats(planId) {
  const r = await db.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE eligibility_status = 'eligible')::int AS eligible,
       COUNT(*) FILTER (WHERE classification = 'hot')::int AS hot,
       COUNT(*) FILTER (WHERE classification = 'cold')::int AS cold,
       COUNT(*) FILTER (WHERE eligibility_status = 'skip')::int AS skip,
       COUNT(*) FILTER (WHERE send_status = 'sent')::int AS sent
     FROM outreach_plan_entries WHERE plan_id = $1`, [planId])
  return r.rows[0]
}

async function setMessageTemplate(planId, text) {
  // A plan's template must sign as the plan's own account (2026-09-24: plan
  // 73 on Cedric carried the shared "Kevin Eich Agent" template).
  const p = await db.query(`SELECT session_name FROM outreach_plans WHERE id = $1`, [planId])
  if (p.rows[0] && String(text || '').trim()) {
    const outreachIdentity = require('./outreachIdentity')
    const identity = await outreachIdentity.resolveSenderIdentity(p.rows[0].session_name)
    const foreign = identity ? outreachIdentity.findForeignSignatures(text, identity.persona) : []
    if (foreign.length) {
      const err = new Error(outreachIdentity.describeMismatch(identity, foreign))
      err.status = 400
      err.code = 'identity_mismatch'
      throw err
    }
  }
  await db.query(
    `UPDATE outreach_plans SET message_template = $1, updated_at = NOW() WHERE id = $2`,
    [String(text || '').slice(0, 2000), planId])
}

// ── Saved message templates (spec follow-up, Kev 2026-09-11) — a small
// reusable library so a good message doesn't need retyping on every plan.
async function listMessageTemplates() {
  const r = await db.query(`SELECT id, label, text, created_at FROM outreach_message_templates ORDER BY updated_at DESC LIMIT 50`)
  return r.rows
}
async function saveMessageTemplate(label, text, createdBy) {
  const ins = await db.query(
    `INSERT INTO outreach_message_templates (label, text, created_by) VALUES ($1,$2,$3) RETURNING id`,
    [String(label || 'Untitled').slice(0, 100), String(text || '').slice(0, 2000), createdBy || null])
  return ins.rows[0].id
}
async function deleteMessageTemplate(templateId) {
  await db.query(`DELETE FROM outreach_message_templates WHERE id = $1`, [templateId])
}

// Draft preparation only. It never arms or sends a plan. Two hours before an
// account becomes eligible again, reuse the newest identity-compatible text
// and its previous list size. This gives Kevin a prepared morning queue while
// preserving REVIEW_ONLY and the normal final contact checks.
async function prepareDueAccountPlans(now = new Date()) {
  const rows = await db.query(
    `SELECT a.id, a.session_name, a.label, a.account_persona,
            MAX(l.sent_at) AS last_sent_at
       FROM whatsapp_accounts a
       JOIN outreach_log l ON l.account_used = a.session_name AND l.sent_at IS NOT NULL
      WHERE a.is_active = TRUE AND a.outreach_enabled = TRUE
      GROUP BY a.id, a.session_name, a.label, a.account_persona
      ORDER BY a.priority, a.id`)
  const identityRules = require('./outreachIdentity')
  const prepared = []
  const skipped = []

  for (const account of rows.rows) {
    if (isSystemManagerSession(account.session_name, account.label)) {
      skipped.push({ session: account.session_name, reason: 'system_manager' })
      continue
    }
    const window = autoPreparationWindow(account.last_sent_at, now)
    if (!window.due) continue
    const date = maltaTodayStr(window.readyAt)
    const plan = await ensurePlan(account.id, date, 'auto-prep-2h')
    const stats = await computeStats(plan.id)
    if (plan.armed || ['ready', 'running', 'completed', 'cancelled'].includes(plan.status)
      || stats.total > 0 || String(plan.message_template || '').trim()) {
      skipped.push({ session: account.session_name, planId: plan.id, reason: 'already_prepared' })
      continue
    }

    const previous = await db.query(
      `SELECT message_template, target_count
         FROM outreach_plans
        WHERE account_id = $1 AND id <> $2
          AND NULLIF(BTRIM(message_template), '') IS NOT NULL
          AND COALESCE(target_count, 0) > 0
        ORDER BY scheduled_date DESC, updated_at DESC
        LIMIT 12`,
      [account.id, plan.id])
    const compatible = previous.rows.find(row =>
      identityRules.findForeignSignatures(row.message_template, String(account.account_persona || '').toLowerCase()).length === 0)
    if (!compatible) {
      skipped.push({ session: account.session_name, planId: plan.id, reason: 'no_identity_safe_previous_draft' })
      continue
    }

    const count = starterBatchCount(compatible.target_count)
    try {
      const generated = await generateList(plan.id, count, { actor: 'auto-prep' })
      if (!generated.added) {
        skipped.push({ session: account.session_name, planId: plan.id, reason: 'no_eligible_contacts' })
        continue
      }
      await setMessageTemplate(plan.id, compatible.message_template)
      await db.query(
        `UPDATE outreach_plans
            SET scheduled_at = $2, source = 'auto_prepared_2h', status = 'saved', armed = FALSE, updated_at = NOW()
          WHERE id = $1`,
        [plan.id, window.readyAt])
      prepared.push({ session: account.session_name, planId: plan.id, scheduledAt: window.readyAt, count: generated.added })
    } catch (err) {
      await clearEntries(plan.id).catch(() => {})
      log.warn('outreachPlanner: two-hour draft preparation failed', { session: account.session_name, planId: plan.id, err: err.message })
      skipped.push({ session: account.session_name, planId: plan.id, reason: err.code || err.message })
    }
  }
  return { prepared, skipped }
}

// Prepare every untouched day in the five-day deck for one account. This is
// intentionally a preview operation: it neither writes reservations nor
// advances pool_cursors. Generated times/counts live on the plans, so reloads
// show the exact same preparation instead of rolling fresh random values.
async function autoPrepareAccount(accountId, { baseCount = null, message = null, actor = 'admin', now = new Date() } = {}) {
  const account = (await db.query(`SELECT * FROM whatsapp_accounts WHERE id=$1 AND is_active=TRUE AND outreach_enabled=TRUE`, [accountId])).rows[0]
  if (!account) throw new Error(`account ${accountId} not found`)
  if (isSystemManagerSession(account.session_name, account.label)) {
    const err = new Error('system manager account cannot run outreach')
    err.code = 'system_manager_not_outreach'
    throw err
  }
  if (account.operational_status === 'restricted' && (!account.restriction_until || new Date(account.restriction_until) > now)) {
    const err = new Error('account is restricted')
    err.code = 'account_restricted'
    throw err
  }

  const latest = (await db.query(
    `SELECT message_template, target_count
       FROM outreach_plans
      WHERE account_id=$1
        AND (NULLIF(BTRIM(message_template),'') IS NOT NULL OR COALESCE(target_count,0)>0)
      ORDER BY updated_at DESC, id DESC LIMIT 1`, [accountId]
  )).rows[0] || {}
  const suppliedCount = Number(baseCount)
  const requestedBase = Number.isFinite(suppliedCount) && suppliedCount > 0
    ? suppliedCount
    : (account.outreach_auto_base_count || latest.target_count || starterBatchCount(null))
  const limit = planLimit(account.session_name, account.label)
  const resolvedBase = Math.max(1, Math.min(limit, Math.round(requestedBase)))
  const suppliedMessage = message == null ? '' : String(message).trim()
  const resolvedMessage = suppliedMessage || String(account.outreach_auto_message || latest.message_template || '').trim()

  await db.query(
    `UPDATE whatsapp_accounts
        SET outreach_auto_base_count=$2, outreach_auto_message=$3
      WHERE id=$1`,
    [accountId, resolvedBase, resolvedMessage]
  )

  const plans = await listRollingPlans(accountId, actor)
  const cooldown = await accountCooldown(account.session_name, now)
  let anchor = cooldown.lastSentAt
  let previewCursor = null
  const excludedPhones = new Set()
  const results = []

  for (const plan of plans) {
    const full = await getPlanWithEntries(plan.id)
    const untouched = !plan.armed
      && !['ready', 'running', 'completed', 'cancelled'].includes(plan.status)
      && plan.stats.total === 0
      && !String(plan.message_template || '').trim()
      && !plan.scheduled_at

    if (!untouched) {
      for (const entry of full?.entries || []) {
        const phone = normPhone(entry.normalized_phone)
        if (phone) excludedPhones.add(phone)
      }
      if (plan.scheduled_at) anchor = new Date(plan.scheduled_at)
      results.push({ planId: plan.id, label: plan.label, status: 'preserved', scheduledAt: plan.scheduled_at, targetCount: plan.stats.eligible, preparedCount: 0 })
      continue
    }

    const spreadMinutes = randomInt(AUTO_DAILY_MINUTES_MIN, AUTO_DAILY_MINUTES_MAX)
    const time = anchor ? addMinutesToMaltaTime(maltaTimeLabel(anchor), spreadMinutes) : '14:15'
    const scheduledAt = maltaLocalToUTC(plan.scheduled_date, time)
    if (scheduledAt <= now || (cooldown.nextEligibleAt && scheduledAt < cooldown.nextEligibleAt)) {
      const reason = scheduledAt <= now ? 'time_in_past' : 'account_24h15_cooldown'
      await db.query(
        `UPDATE outreach_plans
            SET scheduled_at=$2, source=$3, status='draft', armed=FALSE, updated_at=NOW()
          WHERE id=$1`, [plan.id, scheduledAt.toISOString(), `auto_blocked:${reason}`]
      )
      results.push({ planId: plan.id, label: plan.label, status: 'blocked', reason, scheduledAt: scheduledAt.toISOString(), targetCount: 0, preparedCount: 0 })
      continue
    }

    const target = Math.max(1, Math.min(limit, resolvedBase + randomInt(-3, 3)))
    try {
      const generated = await generateList(plan.id, target, {
        actor: 'auto-prepare', topUp: false, previewCursor, excludedPhones,
      })
      previewCursor = generated.previewCursor
      for (const phone of generated.addedPhones || []) excludedPhones.add(phone)
      if (resolvedMessage) await setMessageTemplate(plan.id, resolvedMessage)
      await db.query(
        `UPDATE outreach_plans
            SET scheduled_at=$2, status='saved', source='auto_prepared', armed=FALSE, updated_at=NOW()
          WHERE id=$1`, [plan.id, scheduledAt.toISOString()]
      )
      anchor = scheduledAt
      results.push({
        planId: plan.id, label: plan.label, status: 'prepared', scheduledAt: scheduledAt.toISOString(),
        targetCount: target, preparedCount: generated.resultEligible, spreadMinutes,
      })
    } catch (err) {
      await clearEntries(plan.id).catch(() => {})
      log.warn('outreachPlanner: account auto preparation failed', { accountId, planId: plan.id, err: err.message })
      results.push({ planId: plan.id, label: plan.label, status: 'failed', reason: err.code || err.message, scheduledAt: null, targetCount: target, preparedCount: 0 })
    }
  }

  return {
    ok: true, accountId, baseCount: resolvedBase, message: resolvedMessage,
    intervalMinutes: { min: AUTO_DAILY_MINUTES_MIN, max: AUTO_DAILY_MINUTES_MAX },
    plans: results, rollingPlans: await listRollingPlans(accountId, actor),
  }
}

// ── Reservation (spec point 14/35) ──────────────────────────────────────────
// Atomic by construction: the partial unique index on outreach_reservations
// (normalized_phone WHERE released_at IS NULL) means a second attempt to
// reserve an already-reserved phone fails with a unique-violation, which we
// catch and treat as "already reserved" rather than a real error.
async function tryReserve(ownerId, phone, planId, entryId) {
  try {
    await db.query(
      `INSERT INTO outreach_reservations (owner_id, normalized_phone, plan_id, entry_id)
       VALUES ($1, $2, $3, $4)`,
      [ownerId || null, phone, planId, entryId])
    return { ok: true }
  } catch (err) {
    if (err.code === '23505') { // unique_violation
      const existing = await db.query(
        `SELECT r.plan_id, p.session_name, p.scheduled_date
           FROM outreach_reservations r JOIN outreach_plans p ON p.id = r.plan_id
          WHERE r.released_at IS NULL
            AND (r.normalized_phone = $1 OR ($2::bigint IS NOT NULL AND r.owner_id = $2::bigint))
          LIMIT 1`, [phone, ownerId || null])
      const row = existing.rows[0]
      return {
        ok: false,
        reason: row ? `reserved_on_${row.session_name}_${row.scheduled_date}` : 'reserved_elsewhere',
      }
    }
    throw err
  }
}

async function releaseReservationsForPlan(planId, reason = null) {
  await db.query(
    `UPDATE outreach_reservations SET released_at = NOW(), override_reason = COALESCE(override_reason, $2)
      WHERE plan_id = $1 AND released_at IS NULL`, [planId, reason])
}

async function releaseReservationForEntry(entryId) {
  await db.query(`UPDATE outreach_reservations SET released_at = NOW() WHERE entry_id = $1 AND released_at IS NULL`, [entryId])
}

// Preliminary eligibility (spec point 37 distinguishes this from the FINAL
// recheck that happens inside runDirectOutreach's own WAHA preflight at
// send time) — cheap, DB-only: do-not-contact + same-account cooldown via
// the existing canContact(), no per-contact WAHA round trip at list-build
// time (hundreds of entries would make that far too slow here).
async function classifyAndCheck(ownerRow, accountId) {
  const classification = ownerRow.status === 'hot' ? 'hot' : (ownerRow.status ? 'cold' : 'cold')
  if (ownerRow.do_not_contact) return { eligibility_status: 'skip', skip_reason: 'do_not_contact', classification }
  if (ownerRow.id) {
    try {
      const chk = await canContact(ownerRow.id, accountId)
      if (!chk.allowed) return { eligibility_status: 'skip', skip_reason: chk.reason || 'cooldown', classification }
    } catch (e) {
      log.debug('outreachPlanner: canContact check failed, allowing', { err: e.message })
    }
  }
  return { eligibility_status: 'eligible', skip_reason: null, classification }
}

// ── Adding entries: paste (spec point 9/12) ─────────────────────────────────
async function addEntriesFromPaste(planId, rawText, createdBy) {
  const { parseOwnerLine } = require('./adminCommands')
  const plan = await db.query(`SELECT * FROM outreach_plans WHERE id = $1`, [planId])
  if (!plan.rows.length) throw new Error('plan not found')
  const { account_id: accountId } = plan.rows[0]

  const lines = String(rawText || '').split('\n').map(l => l.trim()).filter(Boolean)
  const existing = await db.query(`SELECT normalized_phone FROM outreach_plan_entries WHERE plan_id = $1`, [planId])
  const seen = new Set(existing.rows.map(r => r.normalized_phone))

  const added = []
  const maxPos = await db.query(`SELECT COALESCE(MAX(position), 0) AS m FROM outreach_plan_entries WHERE plan_id = $1`, [planId])
  let pos = maxPos.rows[0].m

  for (const line of lines) {
    const parsed = parseOwnerLine(line)
    if (!parsed) continue
    const phone = normPhone(parsed.phone)
    if (!phone || seen.has(phone)) continue
    seen.add(phone)
    pos++

    const ocRes = await db.query(
      `SELECT id, name, status, do_not_contact FROM owner_contacts WHERE phone_normalized = $1 LIMIT 1`, [phone])
    const oc = ocRes.rows[0] || { id: null, name: parsed.name || null, status: null, do_not_contact: false }
    const check = await classifyAndCheck(oc, accountId)

    const eligibility = check.eligibility_status
    const skipReason = check.skip_reason

    const ins = await db.query(
      `INSERT INTO outreach_plan_entries
         (plan_id, owner_id, normalized_phone, display_name, classification, eligibility_status, skip_reason, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [planId, oc.id, phone, parsed.name || oc.name || null, check.classification, eligibility, skipReason, pos])

    added.push(ins.rows[0])
  }

  if (plan.rows[0].status === 'draft') {
    await db.query(`UPDATE outreach_plans SET source = COALESCE(source, 'manual'), updated_at = NOW() WHERE id = $1`, [planId])
  }
  return { added: added.length, skipped: lines.length - added.length }
}

// ── Generate list (spec point 10/26/27) ─────────────────────────────────────
// Draft generation is a preview: it neither advances the shared pool cursor
// nor reserves contacts. ARM is the single commit point for both operations.
async function generateList(planId, requestedCount, {
  actor = 'admin', topUp = false, previewCursor: initialPreviewCursor = null, excludedPhones = [],
} = {}) {
  const plan = await db.query(`SELECT p.*, a.label AS account_label FROM outreach_plans p LEFT JOIN whatsapp_accounts a ON a.id=p.account_id WHERE p.id = $1`, [planId])
  if (!plan.rows.length) throw new Error('plan not found')
  if (plan.rows[0].armed || ['ready','running','completed','cancelled'].includes(plan.rows[0].status)) {
    const err = new Error('plan is not editable')
    err.code = 'plan_not_editable'
    throw err
  }
  const { account_id: accountId, session_name: sessionName } = plan.rows[0]
  const limit = planLimit(sessionName, plan.rows[0].account_label)
  const target = Math.max(1, Math.min(limit, Math.round(Number(requestedCount) || 1)))

  if (!topUp) {
    await releaseReservationsForPlan(planId, 'draft_regenerated')
    await db.query(`DELETE FROM outreach_plan_entries WHERE plan_id=$1`, [planId])
  }

  const existing = await db.query(`SELECT normalized_phone FROM outreach_plan_entries WHERE plan_id = $1`, [planId])
  const seen = new Set([
    ...existing.rows.map(r => r.normalized_phone),
    ...Array.from(excludedPhones || []).map(normPhone).filter(Boolean),
  ])
  const currentEligible = (await db.query(
    `SELECT COUNT(*)::int AS n FROM outreach_plan_entries WHERE plan_id = $1 AND eligibility_status = 'eligible'`, [planId]
  )).rows[0].n
  const need = Math.max(0, target - currentEligible)
  const maxPos = await db.query(`SELECT COALESCE(MAX(position), 0)::int AS m FROM outreach_plan_entries WHERE plan_id = $1`, [planId])
  let pos = maxPos.rows[0].m
  let remainingNeed = need
  let addedCount = 0
  let batchAttempts = 0
  let previewCursor = initialPreviewCursor
  const addedPhones = []
  while (remainingNeed > 0 && batchAttempts < 4) {
    batchAttempts++
    const batchSize = Math.max(remainingNeed * 2, remainingNeed)
    const result = await buildPoolBatch(sessionName, batchSize, {
      advanceCursor: false,
      ...(previewCursor == null ? {} : { cursorOverride: previewCursor }),
    })
    if (!result.list.length) break
    previewCursor = result.cursor_advanced_to

    for (const c of result.list) {
      if (remainingNeed <= 0) break
      const phone = normPhone(c.phone_normalized)
      if (!phone || seen.has(phone)) continue
      seen.add(phone)

      const ocRes = await db.query(`SELECT id, name, status, do_not_contact FROM owner_contacts WHERE id = $1`, [c.id])
      const oc = ocRes.rows[0] || { id: c.id, name: c.name, status: null, do_not_contact: false }
      const check = await classifyAndCheck(oc, accountId)
      const eligibility = check.eligibility_status
      const skipReason = check.skip_reason

      pos++
      const ins = await db.query(
        `INSERT INTO outreach_plan_entries
           (plan_id, owner_id, normalized_phone, display_name, classification, eligibility_status, skip_reason, position)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [planId, oc.id, phone, oc.name || c.name || null, check.classification, eligibility, skipReason, pos])
      addedPhones.push(phone)

      if (eligibility === 'eligible') {
        addedCount++
        remainingNeed--
      }
    }
    if (result.list.length < batchSize) break // pool exhausted for this pass
  }

  const resultEligible = currentEligible + addedCount
  await db.query(
    `UPDATE outreach_plans SET source = $2, target_count = $3, updated_at = NOW() WHERE id = $1`,
    [planId, topUp && currentEligible > 0 ? 'mixed' : 'generated', resultEligible])
  await logTransition(
    planId,
    plan.rows[0].status,
    plan.rows[0].status,
    `${topUp ? 'queue_top_up' : 'queue_exact'}:requested_${target}:added_${addedCount}:before_${currentEligible}:after_${resultEligible}`,
    actor
  )
  return { added: addedCount, need, requestedTotal: target, currentEligible, resultEligible, max: limit, topUp, previewCursor, addedPhones }
}

async function removeEntry(entryId) {
  await releaseReservationForEntry(entryId)
  await db.query(`DELETE FROM outreach_plan_entries WHERE id = $1`, [entryId])
}

async function clearEntries(planId) {
  await releaseReservationsForPlan(planId, 'cleared_by_user')
  await db.query(`DELETE FROM outreach_plan_entries WHERE plan_id = $1`, [planId])
}

async function regenerate(planId, requestedCount) {
  return generateList(planId, requestedCount, { topUp: false })
}

async function lockPlanEntries(planId) {
  await releaseReservationsForPlan(planId, 'relock_before_arm')
  const entries = (await db.query(
    `SELECT id, owner_id, normalized_phone FROM outreach_plan_entries
      WHERE plan_id=$1 AND eligibility_status='eligible' AND send_status='pending'
      ORDER BY position ASC NULLS LAST, id ASC`, [planId]
  )).rows
  const conflicts = []
  for (const entry of entries) {
    const reserved = await tryReserve(entry.owner_id, entry.normalized_phone, planId, entry.id)
    if (!reserved.ok) conflicts.push({ entryId: entry.id, reason: reserved.reason })
  }
  if (conflicts.length) {
    await releaseReservationsForPlan(planId, 'arm_lock_conflict')
    return { ok: false, reason: 'queue_lock_conflict', conflicts: conflicts.length, conflictEntryIds: conflicts.map(c => c.entryId) }
  }
  return { ok: true, locked: entries.length }
}

async function recheckAndLockPlanEntries(planId, accountId, targetCount) {
  const target = Math.max(1, Number(targetCount) || 1)
  for (let attempt = 0; attempt < 3; attempt++) {
    const rows = (await db.query(
      `SELECT e.id, e.owner_id, e.normalized_phone, o.name, o.status, o.do_not_contact
         FROM outreach_plan_entries e
         LEFT JOIN owner_contacts o ON o.id=e.owner_id
        WHERE e.plan_id=$1 AND e.eligibility_status='eligible' AND e.send_status='pending'
        ORDER BY e.position ASC NULLS LAST, e.id ASC`, [planId]
    )).rows
    for (const row of rows) {
      const check = await classifyAndCheck({ id: row.owner_id, name: row.name, status: row.status, do_not_contact: row.do_not_contact }, accountId)
      if (check.eligibility_status !== 'eligible') {
        await db.query(
          `UPDATE outreach_plan_entries SET eligibility_status='skip',skip_reason=$2 WHERE id=$1`,
          [row.id, check.skip_reason || 'ineligible_at_arm']
        )
      }
    }

    let eligible = Number((await db.query(
      `SELECT COUNT(*)::int AS n FROM outreach_plan_entries WHERE plan_id=$1 AND eligibility_status='eligible' AND send_status='pending'`, [planId]
    )).rows[0].n)
    if (eligible < target) {
      await generateList(planId, target, { actor: 'arm-recheck', topUp: true })
      eligible = Number((await db.query(
        `SELECT COUNT(*)::int AS n FROM outreach_plan_entries WHERE plan_id=$1 AND eligibility_status='eligible' AND send_status='pending'`, [planId]
      )).rows[0].n)
    }
    if (eligible < target) {
      await releaseReservationsForPlan(planId, 'arm_insufficient_contacts')
      return { ok: false, reason: 'insufficient_eligible_contacts', requested: target, eligible }
    }

    const lock = await lockPlanEntries(planId)
    if (lock.ok) return lock
    if (lock.conflictEntryIds?.length) {
      await db.query(
        `UPDATE outreach_plan_entries
            SET eligibility_status='skip',skip_reason='reserved_elsewhere_at_arm'
          WHERE id=ANY($1::bigint[])`, [lock.conflictEntryIds]
      )
    }
  }
  await releaseReservationsForPlan(planId, 'arm_lock_conflict')
  return { ok: false, reason: 'queue_lock_conflict' }
}

async function commitPoolCursorForPlan(planId) {
  const r = await db.query(
    `SELECT a.pool, MIN(e.owner_id)::bigint AS min_id, MAX(e.owner_id)::bigint AS max_id
       FROM outreach_plans p
       JOIN whatsapp_accounts a ON a.id=p.account_id
       JOIN outreach_plan_entries e ON e.plan_id=p.id AND e.eligibility_status='eligible'
      WHERE p.id=$1 AND e.owner_id IS NOT NULL GROUP BY a.pool`, [planId]
  )
  if (!r.rows.length) return
  const row = r.rows[0]
  const cursor = row.pool === 'bottom' ? row.min_id : row.max_id
  if (cursor != null) await db.query(`UPDATE pool_cursors SET cursor_id=$1,updated_at=NOW() WHERE pool=$2`, [cursor, row.pool])
}

// ── Save / Arm / Pause / Cancel (spec point 15/16/17) ───────────────────────
async function saveDraft(planId) {
  await db.query(`UPDATE outreach_plans SET status = 'saved', updated_at = NOW() WHERE id = $1 AND status IN ('draft','saved')`, [planId])
  return getPlanWithEntries(planId)
}

async function armPlan(planId, { time } = {}) {
  const plan = await db.query(`SELECT * FROM outreach_plans WHERE id = $1`, [planId])
  if (!plan.rows.length) throw new Error('plan not found')
  const p = plan.rows[0]
  const account = await db.query(`SELECT * FROM whatsapp_accounts WHERE id = $1`, [p.account_id])
  if (isSystemManagerSession(p.session_name, account.rows[0]?.label)) {
    return { ok: false, reason: 'system_manager_not_outreach' }
  }
  if (!p.message_template || !p.message_template.trim()) {
    return { ok: false, reason: 'no_message' }
  }
  const eligibleCount = (await db.query(
    `SELECT COUNT(*)::int AS n FROM outreach_plan_entries WHERE plan_id = $1 AND eligibility_status = 'eligible'`, [planId]
  )).rows[0].n
  if (eligibleCount === 0) return { ok: false, reason: 'no_eligible_entries' }
  const accountLimit = planLimit(p.session_name, account.rows[0]?.label)
  if (eligibleCount > accountLimit) {
    return { ok: false, reason: 'starter_batch_limit', max: accountLimit, eligibleCount }
  }
  let sessionStatus = 'UNKNOWN'
  try {
    const status = await waha.getSessionStatus(p.session_name)
    sessionStatus = String(status?.status || 'UNKNOWN').toUpperCase()
  } catch (err) {
    log.debug('outreachPlanner: arm session health check failed', { planId, session: p.session_name, err: err.message })
  }
  const accountRow = account.rows[0]
  if (RESTRICTED_SESSION_STATES.has(sessionStatus)) {
    const restricted = await setAccountRestriction(p.account_id, { restricted: true, reason: `session_${sessionStatus.toLowerCase()}`, sessionStatus, actor: 'arm_health_check' })
    return { ok: false, reason: 'account_restricted', restrictionUntil: restricted.restriction_until }
  }
  if (accountRow?.operational_status === 'restricted' && (!accountRow.restriction_until || new Date(accountRow.restriction_until) > new Date())) {
    return { ok: false, reason: 'account_restricted', restrictionUntil: accountRow.restriction_until }
  }

  const timeStr = time || (p.scheduled_at ? maltaTimeLabel(new Date(p.scheduled_at)) : '09:00')
  const scheduledAt = maltaLocalToUTC(p.scheduled_date, timeStr)
  const delayMs = scheduledAt.getTime() - Date.now()
  if (delayMs < 0) return { ok: false, reason: 'time_in_past' }
  const cooldown = await accountCooldown(p.session_name, scheduledAt)
  if (!cooldown.allowed) {
    return { ok: false, reason: 'account_24h15_cooldown', nextEligibleAt: cooldown.nextEligibleAt.toISOString() }
  }

  const idempotencyKey = safeJobId(`outreach-plan-${planId}-${scheduledAt.toISOString()}`)

  // Cancel any previously-armed job for this plan first (re-arming after an
  // edit must never leave two jobs ticking for the same plan).
  if (p.job_id) {
    try { const old = await QUEUES['outreach-plan'].getJob(p.job_id); if (old) await old.remove() }
    catch (e) { log.debug('outreachPlanner: old job removal failed (likely already gone)', { err: e.message }) }
  }

  const lock = await recheckAndLockPlanEntries(planId, p.account_id, p.target_count || eligibleCount)
  if (!lock.ok) return lock

  let job
  try {
    job = await addJob('outreach-plan', { planId }, { delay: Math.max(0, delayMs), jobId: idempotencyKey })
  } catch (err) {
    await releaseReservationsForPlan(planId, 'arm_job_create_failed')
    throw err
  }

  await db.query(
    `UPDATE outreach_plans
        SET status = 'ready', armed = TRUE, scheduled_at = $2, job_id = $3, idempotency_key = $4, retry_attempt = 0, updated_at = NOW()
      WHERE id = $1`,
    [planId, scheduledAt.toISOString(), String(job.id), idempotencyKey])
  await logTransition(planId, p.status, 'ready', 'armed_by_user', 'admin', { job_id: String(job.id) })
  await commitPoolCursorForPlan(planId)
  return { ok: true, scheduledAt: scheduledAt.toISOString() }
}

async function pausePlan(planId) {
  const plan = await db.query(`SELECT status, job_id FROM outreach_plans WHERE id = $1`, [planId])
  if (plan.rows[0]?.job_id) {
    try { const job = await QUEUES['outreach-plan'].getJob(plan.rows[0].job_id); if (job) await job.remove() }
    catch (e) { log.debug('outreachPlanner: pause job removal failed', { err: e.message }) }
  }
  await releaseReservationsForPlan(planId, 'paused_by_user')
  await db.query(`UPDATE outreach_plans SET status = 'saved', armed = FALSE, job_id = NULL, updated_at = NOW() WHERE id = $1`, [planId])
  await logTransition(planId, plan.rows[0]?.status, 'saved', 'paused_by_user', 'admin')
}

async function cancelPlan(planId) {
  const plan = await db.query(`SELECT status, job_id FROM outreach_plans WHERE id = $1`, [planId])
  if (plan.rows[0]?.job_id) {
    try { const job = await QUEUES['outreach-plan'].getJob(plan.rows[0].job_id); if (job) await job.remove() }
    catch (e) { log.debug('outreachPlanner: cancel job removal failed', { err: e.message }) }
  }
  await releaseReservationsForPlan(planId, 'plan_cancelled')
  await db.query(`UPDATE outreach_plans SET status = 'cancelled', armed = FALSE, job_id = NULL, updated_at = NOW() WHERE id = $1`, [planId])
  await logTransition(planId, plan.rows[0]?.status, 'cancelled', 'cancelled_by_user', 'admin')
}

// A plan whose own session is down, or whose send attempt crashed before any
// message went out, is NOT the same as a plan nobody wants any more — it
// stays ARMED (visibly, as 'blocked_session') and gets a bounded, spaced
// retry instead of silently flipping to unarmed/failed on the first hiccup.
async function blockAndRetry(planId, plan, reason) {
  const attempt = (plan.retry_attempt || 0) + 1
  if (attempt > MAX_RETRY_ATTEMPTS) {
    await db.query(`UPDATE outreach_plans SET status = 'failed', armed = FALSE, updated_at = NOW() WHERE id = $1`, [planId])
    await logTransition(planId, plan.status, 'failed', `${reason}_max_retries_exhausted(${MAX_RETRY_ATTEMPTS})`, 'system')
    return
  }
  const jobId = safeJobId(`${plan.idempotency_key || 'outreach-plan-' + planId}-retry-${attempt}`)
  const job = await addJob('outreach-plan', { planId }, { delay: RETRY_DELAY_MS, jobId })
  await db.query(
    `UPDATE outreach_plans SET status = 'blocked_session', armed = TRUE, job_id = $2, retry_attempt = $3, updated_at = NOW() WHERE id = $1`,
    [planId, String(job.id), attempt])
  await logTransition(planId, plan.status, 'blocked_session', reason, 'system', { job_id: String(job.id), attempt, next_retry_in_ms: RETRY_DELAY_MS })
}

// ── Scheduled execution (spec point 16/36/37) — the BullMQ processor ────────
// Re-verifies everything from scratch rather than trusting arm-time — same
// principle services/autoOwnerConversation.js's runAutoPublishJob already
// uses for exactly this reason (minutes/hours have passed since arming).
async function runScheduledPlan(planId) {
  const r = await db.query(`SELECT * FROM outreach_plans WHERE id = $1`, [planId])
  const plan = r.rows[0]
  if (!plan) { log.warn('outreachPlanner: plan not found for scheduled run', { planId }); return }

  // Stale-job guard: a pause/cancel/re-arm between scheduling and firing may
  // have already moved this plan on, or armed a NEWER job with a different
  // id — same shape as owner-auto-publish's own guard. 'blocked_session' is
  // included on purpose: it is a RETRY of an armed plan, not a dead one.
  if (!plan.armed || !['ready', 'blocked_session'].includes(plan.status)) {
    log.info('outreachPlanner: plan no longer ready/armed, skipping', { planId, status: plan.status, armed: plan.armed })
    return
  }

  const account = await db.query(`SELECT * FROM whatsapp_accounts WHERE id = $1`, [plan.account_id])
  if (isSystemManagerSession(plan.session_name, account.rows[0]?.label)) {
    await releaseReservationsForPlan(planId, 'system_manager_not_outreach')
    await db.query(`UPDATE outreach_plans SET status = 'failed', armed = FALSE, updated_at = NOW() WHERE id = $1`, [planId])
    await logTransition(planId, plan.status, 'failed', 'system_manager_not_outreach', 'system')
    return
  }
  const accountRow = account.rows[0]
  if (accountRow?.operational_status === 'restricted' && (!accountRow.restriction_until || new Date(accountRow.restriction_until) > new Date())) {
    await holdArmedPlansForAccount(plan.account_id, 'account_restricted')
    return
  }
  const accountGate = await accountCooldown(plan.session_name)
  if (!accountGate.allowed) {
    const delay = Math.max(60_000, accountGate.nextEligibleAt.getTime() - Date.now())
    const jobId = safeJobId(`${plan.idempotency_key || 'outreach-plan-' + planId}-account-cooldown-${accountGate.nextEligibleAt.toISOString()}`)
    const job = await addJob('outreach-plan', { planId }, { delay, jobId })
    await db.query(`UPDATE outreach_plans SET status='ready', armed=TRUE, scheduled_at=$2, job_id=$3, updated_at=NOW() WHERE id=$1`, [planId, accountGate.nextEligibleAt.toISOString(), String(job.id)])
    await logTransition(planId, plan.status, 'ready', 'account_24h15_cooldown', 'system', { job_id: String(job.id) })
    return
  }

  // ── Transport health gate (2026-09-17 incident fix) ───────────────────────
  // The ONLY thing that decides whether this plan can run is whether ITS OWN
  // assigned session (plan.session_name — e.g. Kev40/kevthirdd) is actually
  // WORKING, checked live, the same call outreachPlanner.listAccounts() uses
  // for the UI's "connected" badge. This used to be gated instead on
  // waha.pickActiveAdminSession() finding ONE of the three legacy admin
  // sessions (default/Kevsecond/kevthirdd) healthy — a completely different,
  // privileged concept meant for admin progress-ping replies, not the actual
  // send transport. If none of those three happened to be WORKING at the
  // exact minute the job fired (they didn't have to include Kev40's session
  // at all), the WHOLE plan was marked 'failed' and silently unarmed even
  // though Kev40 itself was perfectly healthy. Root-caused live 2026-09-17
  // against plan 33/40 (kevthirdd): confirmed in logs as repeated
  // "no admin session/phone available" failures while the UI showed
  // kevthirdd connected. `default` (or any specific account) now has ZERO
  // privileged role anywhere in this function.
  let sessionHealthy = false
  let sessionStatus = 'UNKNOWN'
  try {
    const status = await waha.getSessionStatus(plan.session_name)
    sessionStatus = String(status?.status || 'UNKNOWN').toUpperCase()
    sessionHealthy = HEALTHY_SESSION_STATES.has(sessionStatus)
  } catch (e) {
    log.debug('outreachPlanner: session health check threw, treating as unhealthy', { planId, session: plan.session_name, err: e.message })
  }
  if (!sessionHealthy) {
    await setAccountRestriction(plan.account_id, {
      restricted: true,
      reason: `session_${sessionStatus.toLowerCase()}`,
      sessionStatus,
      actor: 'scheduled_health_check',
    })
    return
  }

  await logTransition(planId, plan.status, 'running', 'send_starting', 'system', { job_id: plan.job_id })
  await db.query(`UPDATE outreach_plans SET status = 'running', updated_at = NOW() WHERE id = $1`, [planId])

  const entries = (await db.query(
    `SELECT * FROM outreach_plan_entries WHERE plan_id = $1 AND eligibility_status = 'eligible' AND send_status = 'pending'`,
    [planId])).rows

  // Recheck the ceiling at execution time as well. A plan may have been
  // armed before this guard existed, or edited through another client.
  const limit = planLimit(plan.session_name, account.rows[0]?.label)
  if (entries.length > limit) {
    await releaseReservationsForPlan(planId, 'plan_limit_exceeded')
    await db.query(`UPDATE outreach_plans SET status = 'saved', armed = FALSE, job_id = NULL, updated_at = NOW() WHERE id = $1`, [planId])
    await logTransition(planId, plan.status, 'saved', `starter_batch_limit_${entries.length}_over_${limit}`, 'system')
    return
  }

  if (!entries.length) {
    await releaseReservationsForPlan(planId, 'no_pending_entries')
    await db.query(`UPDATE outreach_plans SET status = 'completed', armed = FALSE, executed_at = NOW(), updated_at = NOW() WHERE id = $1`, [planId])
    await logTransition(planId, 'running', 'completed', 'no_pending_entries', 'system')
    return
  }

  // Final eligibility recheck (spec point 37) — DB-only re-verification;
  // runDirectOutreach's own WAHA preflight below is the LAST word before an
  // actual send.
  const stillEligible = []
  for (const e of entries) {
    if (e.owner_id) {
      try {
        const chk = await canContact(e.owner_id, plan.account_id)
        if (!chk.allowed) {
          await db.query(`UPDATE outreach_plan_entries SET eligibility_status='skip', skip_reason=$2, updated_at=NOW() WHERE id=$1`,
            [e.id, `final_check_${chk.reason || 'cooldown'}`])
          await releaseReservationForEntry(e.id)
          continue
        }
      } catch (err) {
        log.warn('outreachPlanner: final canContact check unavailable, holding entry', { planId, entryId: e.id, err: err.message })
        await db.query(`UPDATE outreach_plan_entries SET eligibility_status='skip', skip_reason='final_check_unavailable', updated_at=NOW() WHERE id=$1`, [e.id])
        await releaseReservationForEntry(e.id)
        continue
      }
    }
    stillEligible.push(e)
  }

  if (!stillEligible.length) {
    await releaseReservationsForPlan(planId, 'all_entries_skipped_final_check')
    await db.query(`UPDATE outreach_plans SET status = 'completed', armed = FALSE, executed_at = NOW(), updated_at = NOW() WHERE id = $1`, [planId])
    await logTransition(planId, 'running', 'completed', 'all_entries_skipped_final_check', 'system')
    return
  }

  const startedAt = new Date()
  const contacts = stillEligible.map(e => ({ phone: e.normalized_phone, name: e.display_name }))

  // Admin-notification session — best-effort progress pings ONLY (the
  // "Sending via X to N contacts…" style messages inside runDirectOutreach).
  // This must NEVER be able to block or fail the actual send: prefer a
  // legacy admin session for the human-facing UX, but if none is currently
  // WORKING, self-notify through the plan's OWN (already confirmed healthy)
  // session/phone instead of aborting the run over a status message.
  const { runDirectOutreach } = require('./adminCommands')
  let replySession = await waha.pickActiveAdminSession().catch(() => null)
  let adminPhone = config.admin?.botNumber || (replySession ? (await waha.getSessionPhone(replySession).catch(() => null)) : null)
  if (!replySession || !adminPhone) {
    log.warn('outreachPlanner: no legacy admin session available for progress pings, self-notifying via plan session', { planId, session: plan.session_name })
    replySession = plan.session_name
    adminPhone = adminPhone || await waha.getSessionPhone(plan.session_name).catch(() => null)
  }

  try {
    // planId (Phase 4, 2026-09-17): tags the outreach_batches row this call
    // creates as belonging to THIS plan, so that batch's completion — from
    // ANY path, including outreachRecovery.js resuming it after a restart —
    // can reconcile this plan's own status/entries. See
    // reconcilePlanFromBatch() below and its call sites in adminCommands.js
    // / outreachRecovery.js. Fixes the exact plan-40 incident: a restart
    // mid-send left the plan stuck in 'running' forever even though the
    // underlying batch (resumed by outreachRecovery.js) completed correctly.
    const outcome = await runDirectOutreach(adminPhone, replySession, plan.session_name, contacts, plan.message_template, { planId })
    if (outcome && outcome.refused) {
      // Identity guard (2026-09-24): nothing was sent. Say so on the plan
      // instead of "completed, 0 of N".
      await db.query(
        `UPDATE outreach_plan_entries SET send_status='failed', skip_reason=$2, updated_at=NOW() WHERE plan_id=$1 AND send_status IS DISTINCT FROM 'sent'`,
        [planId, outcome.refused])
      for (const e of stillEligible) await releaseReservationForEntry(e.id)
      await db.query(`UPDATE outreach_plans SET status = 'failed', armed = FALSE, updated_at = NOW() WHERE id = $1`, [planId])
      await logTransition(planId, 'running', 'failed', `${outcome.refused}: ${outcome.why}`, 'system')
      log.warn('outreachPlanner: plan refused by sender-identity guard', { planId, why: outcome.why })
      return
    }
  } catch (err) {
    log.error('outreachPlanner: runDirectOutreach crashed', { planId, err: err.message })
    const fresh = (await db.query(`SELECT * FROM outreach_plans WHERE id = $1`, [planId])).rows[0] || plan
    return blockAndRetry(planId, { ...fresh, status: 'running' }, `runDirectOutreach_crashed:${err.message}`)
  }

  // Correlate results back onto MY entries via outreach_log (phone + account
  // + sent after this run started) rather than touching runDirectOutreach's
  // return shape (it has none — it replies via WhatsApp, not a return value).
  const sentRes = await db.query(
    `SELECT phone, sent_at FROM outreach_log WHERE account_used = $1 AND phone = ANY($2::text[]) AND sent_at >= $3`,
    [plan.session_name, stillEligible.map(e => e.normalized_phone), startedAt.toISOString()])
  const sentMap = new Map(sentRes.rows.map(r => [r.phone, r.sent_at]))

  for (const e of stillEligible) {
    const sentAt = sentMap.get(e.normalized_phone)
    if (sentAt) {
      await db.query(
        `UPDATE outreach_plan_entries SET send_status='sent', sent_at=$2, actual_session_name=$3, updated_at=NOW() WHERE id=$1`,
        [e.id, sentAt, plan.session_name])
    } else {
      await db.query(
        `UPDATE outreach_plan_entries SET send_status='failed', skip_reason=COALESCE(skip_reason,'not_sent'), updated_at=NOW() WHERE id=$1`,
        [e.id])
    }
    await releaseReservationForEntry(e.id)
  }

  await db.query(
    `UPDATE outreach_plans SET status = 'completed', armed = FALSE, executed_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [planId])
  const sentCount = [...sentMap.keys()].length
  await logTransition(planId, 'running', 'completed', `sent_${sentCount}_of_${stillEligible.length}`, 'system')
  log.info('outreachPlanner: plan executed', { planId, attempted: stillEligible.length })
}

// ── Batch-completion reconciliation (Phase 4, 2026-09-17 — the plan-40
// incident fix) ──────────────────────────────────────────────────────────
// The gap: runScheduledPlan() above does its own correlate-and-complete
// after runDirectOutreach() RETURNS — but a restart can kill the process
// while runDirectOutreach() is still running, and outreachRecovery.js then
// resumes the SEND from a totally separate code path (a fresh
// runDirectOutreach() call for the remaining contacts) that has no idea a
// plan is waiting on it. The plan row was confirmed live stuck in
// 'running' for 4+ hours while the real sends had already gone out
// (34/40 real contacts, verified via outreach_log) — a bookkeeping gap,
// not a lost/duplicated send, but a gap nonetheless.
//
// Fix: every outreach_batches row now carries an optional plan_id (set
// only when armPlan()'s scheduled execution created it — NULL for every
// manual !outreach/!foutreach batch, zero behaviour change there). Called
// from every place a batch can reach a terminal state: adminCommands.js's
// runDirectOutreach() own completion, and BOTH of outreachRecovery.js's
// paths (the "already fully resolved before restart" shortcut, and after
// its own resumed runDirectOutreach() call finishes). Idempotent and safe
// to call redundantly or on a plan that isn't actually 'running' any more
// (no-ops immediately) — see the watchdog's own call to this below too.
async function reconcilePlanFromBatch(planId) {
  if (!planId) return
  const r = await db.query(`SELECT * FROM outreach_plans WHERE id = $1`, [planId])
  const plan = r.rows[0]
  if (!plan) { log.warn('outreachPlanner: reconcilePlanFromBatch — plan not found', { planId }); return }
  if (plan.status !== 'running') {
    log.debug('outreachPlanner: reconcilePlanFromBatch no-op, plan not running', { planId, status: plan.status })
    return
  }

  const pending = (await db.query(
    `SELECT * FROM outreach_plan_entries WHERE plan_id = $1 AND eligibility_status = 'eligible' AND send_status = 'pending'`,
    [planId])).rows

  if (pending.length) {
    // Correlate against outreach_log since the plan started running — same
    // phone+account+time-window technique runScheduledPlan() itself uses.
    const sentRes = await db.query(
      `SELECT phone, sent_at FROM outreach_log WHERE account_used = $1 AND phone = ANY($2::text[]) AND sent_at >= $3`,
      [plan.session_name, pending.map(e => e.normalized_phone), plan.updated_at])
    const sentMap = new Map(sentRes.rows.map(row => [row.phone, row.sent_at]))
    for (const e of pending) {
      const sentAt = sentMap.get(e.normalized_phone)
      if (sentAt) {
        await db.query(
          `UPDATE outreach_plan_entries SET send_status='sent', sent_at=$2, actual_session_name=$3, updated_at=NOW() WHERE id=$1`,
          [e.id, sentAt, plan.session_name])
        await releaseReservationForEntry(e.id)
      }
    }
  }

  const stillPending = (await db.query(
    `SELECT COUNT(*)::int AS n FROM outreach_plan_entries WHERE plan_id = $1 AND eligibility_status = 'eligible' AND send_status = 'pending'`,
    [planId])).rows[0].n

  if (stillPending === 0) {
    await db.query(`UPDATE outreach_plans SET status = 'completed', armed = FALSE, executed_at = NOW(), updated_at = NOW() WHERE id = $1`, [planId])
    await logTransition(planId, 'running', 'completed', 'reconciled_from_batch_all_resolved', 'system')
    log.info('outreachPlanner: plan reconciled to completed from batch', { planId })
  } else {
    // The batch itself is done (this function is only called at batch
    // completion) but some entries were never attempted — a genuinely
    // incomplete run, not just late bookkeeping. Same bounded retry as the
    // session-down case, never a silent drop.
    await blockAndRetry(planId, plan, 'reconciled_from_batch_still_incomplete')
    log.warn('outreachPlanner: plan reconciled but incomplete, queued retry', { planId, stillPending })
  }
}

// ── Reconciliation / watchdog (2026-09-17 incident fix) ─────────────────────
// A BullMQ delayed job is durable in Redis, but this closes the two gaps
// that are NOT covered just by that: (1) a job whose worker process was
// down/restarting exactly at delivery time and (2) — belt-and-braces — any
// plan that is ARMED and overdue but for whatever reason has no live job
// tracked against it any more. Called once at boot (startup catch-up) and
// every 60s after that (worker.js). Safe to call redundantly: runScheduledPlan
// itself only ever acts on 'ready'/'blocked_session' + armed rows, and only
// ever sends to entries still send_status='pending', so re-invoking it on a
// plan that is already running/completed/mid-retry is a no-op.
async function reconcileOverdueArmedPlans() {
  const overdue = await db.query(
    `SELECT id, job_id, status FROM outreach_plans
      WHERE armed = TRUE AND status IN ('ready', 'blocked_session')
        AND scheduled_at IS NOT NULL AND scheduled_at <= NOW()`)

  for (const row of overdue.rows) {
    let jobAlive = false
    if (row.job_id) {
      try {
        const job = await QUEUES['outreach-plan'].getJob(row.job_id)
        if (job) {
          const state = await job.getState()
          jobAlive = ['waiting', 'delayed', 'active'].includes(state)
        }
      } catch (e) {
        log.debug('outreachPlanner: watchdog job lookup failed, treating as missing', { planId: row.id, err: e.message })
      }
    }
    if (jobAlive) continue

    log.warn('outreachPlanner: watchdog found an overdue ARMED plan with no live job — executing now', { planId: row.id, status: row.status })
    await logTransition(row.id, row.status, 'overdue_ready', 'watchdog_missed_execution', 'system')
    try {
      await runScheduledPlan(row.id)
    } catch (err) {
      log.error('outreachPlanner: watchdog-triggered run threw', { planId: row.id, err: err.message })
    }
  }
  return overdue.rows.length
}

// ── Global audit (spec point 24/25) ─────────────────────────────────────────
async function checkDuplicatesGlobal() {
  const r = await db.query(`
    SELECT normalized_phone, array_agg(json_build_object('plan_id', plan_id, 'session_name', p.session_name, 'scheduled_date', p.scheduled_date)) AS plans
      FROM outreach_reservations res
      JOIN outreach_plans p ON p.id = res.plan_id
     WHERE res.released_at IS NULL
     GROUP BY normalized_phone
    HAVING COUNT(*) > 1
  `)
  return r.rows
}

async function todayContactedSummary() {
  const today = maltaTodayStr()
  const r = await db.query(`
    SELECT account_used AS session_name, COUNT(*)::int AS n
      FROM outreach_log
     WHERE (sent_at AT TIME ZONE 'Europe/Malta')::date = $1::date
     GROUP BY account_used
     ORDER BY n DESC, account_used
  `, [today])
  const uniqueRes = await db.query(`
    SELECT COUNT(DISTINCT regexp_replace(phone, '[^0-9]', '', 'g'))::int AS unique_owners,
           COUNT(*)::int AS total_sends
      FROM outreach_log
     WHERE (sent_at AT TIME ZONE 'Europe/Malta')::date = $1::date
  `, [today])
  // Batch checkpoints cover manual and planned outreach and expose skips,
  // which is the operational signal the account tiles and run bars need.
  const recent = await db.query(`
    SELECT id, session_name, sent_count::int AS n,
           total_contacts::int AS attempted, skip_count::int AS skipped,
           status, started_at, completed_at, COALESCE(completed_at, updated_at, started_at) AS sent_at
      FROM outreach_batches
     WHERE status IN ('completed','cancelled','running')
     ORDER BY COALESCE(completed_at, updated_at, started_at) DESC NULLS LAST, id DESC
     LIMIT 3`)
  const activity = await db.query(`
    SELECT t.id, t.created_at, t.actor, t.from_state, t.to_state, t.reason,
           p.session_name, p.scheduled_date
      FROM outreach_plan_transitions t
      JOIN outreach_plans p ON p.id=t.plan_id
     ORDER BY t.created_at DESC, t.id DESC
     LIMIT 20`)
  return { perAccount: r.rows, ...uniqueRes.rows[0], recentRuns: recent.rows, activity: activity.rows }
}

module.exports = {
  maltaTodayStr, addDaysStr, maltaLocalToUTC, maltaTimeLabel, dayLabelFor,
  autoPreparationWindow, prepareDueAccountPlans, autoPrepareAccount,
  listAccounts, setAccountVolume, ensurePlan, getPlanWithEntries, listRollingPlans, computeStats,
  setMessageTemplate, addEntriesFromPaste, generateList, removeEntry, clearEntries, regenerate,
  saveDraft, armPlan, pausePlan, cancelPlan, runScheduledPlan,
  setAccountRestriction,
  reconcileOverdueArmedPlans, reconcilePlanFromBatch,
  checkDuplicatesGlobal, todayContactedSummary,
  listMessageTemplates, saveMessageTemplate, deleteMessageTemplate,
  OUTREACH_PLAN_MAX, starterBatchCount,
}
