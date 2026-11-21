#!/usr/bin/env python3
"""ARGUS P0 Auto Outreach fix (2026-11-21): anchor patches on the LIVE backend files.

usage: patch_autofix.py <backend_dir>   (writes the patched files in place; refuses on any missing anchor)
Every anchor must occur exactly once. CRLF files keep CRLF (patched with newline='').
"""
import sys, os

ROOT = sys.argv[1]

def P(path, old, new):
    return (path, old, new)

PLANNER = 'services/outreachPlanner.js'
TEMPLATES = 'services/outreachTemplates.js'
ADMIN = 'services/adminCommands.js'
CRM = 'routes/crm.js'

PATCHES = [
# ── outreachTemplates.js: library mode at send time + preview ──────────────
P(TEMPLATES,
"""async function renderAtSendTime({ mode, persona, slot, freeText }, now = new Date()) {
  if (mode !== MODE_ROTATION) {""",
"""async function renderAtSendTime({ mode, persona, slot, freeText, phone = null, accountId = null, planId = null }, now = new Date()) {
  // Kev, 2026-11-21: hand-written library, one text per owner, greeting generated now (outreachLibrary.js).
  if (mode === 'library') return require('./outreachLibrary').renderForSend({ persona, phone, accountId, planId }, now)
  if (mode !== MODE_ROTATION) {"""),
P(TEMPLATES,
"""  if (plan.message_mode !== MODE_ROTATION) return normalizeGreeting(plan.message_template || '', at).text""",
"""  if (plan.message_mode === 'library') { try { return (await require('./outreachLibrary').preview(persona, at)) || '' } catch (_) { return '' } }
  if (plan.message_mode !== MODE_ROTATION) return normalizeGreeting(plan.message_template || '', at).text"""),

# ── adminCommands.js: pass library mode + recipient to the renderer ────────
P(ADMIN,
"""    if (planRow?.message_mode === outreachTemplates.MODE_ROTATION && planRow.template_slot) {
      messageMode = outreachTemplates.MODE_ROTATION
      templateSlot = planRow.template_slot
    }""",
"""    if (planRow?.message_mode === outreachTemplates.MODE_ROTATION && planRow.template_slot) {
      messageMode = outreachTemplates.MODE_ROTATION
      templateSlot = planRow.template_slot
    } else if (planRow?.message_mode === 'library') {
      messageMode = 'library' // Kev, 2026-11-21: one library text per owner, greeting at send time
    }"""),
P(ADMIN,
"""      baseText = (await outreachTemplates.renderAtSendTime({ mode: messageMode, persona: FROZEN.persona, slot: templateSlot, freeText: FROZEN.template }, sendAt)).text""",
"""      baseText = (await outreachTemplates.renderAtSendTime({ mode: messageMode, persona: FROZEN.persona, slot: templateSlot, freeText: FROZEN.template, phone, accountId, planId: opts.planId || null }, sendAt)).text"""),

# ── outreachPlanner.js ─────────────────────────────────────────────────────
P(PLANNER,
"""const MALTA_TZ = 'Europe/Malta'
""",
"""const MALTA_TZ = 'Europe/Malta'
const outreachLibrary = () => require('./outreachLibrary')

// Kev, 2026-11-21: the account's batch envelope (base ± variation, saved as
// outreach_daily_target_min/max) is the ONE source for Auto batch sizes.
function batchEnvelope(account) {
  const lo = account?.outreach_daily_target_min == null ? 30 : Number(account.outreach_daily_target_min)
  const hi = account?.outreach_daily_target_max == null ? 40 : Number(account.outreach_daily_target_max)
  const min = Math.max(0, Math.min(outreachQuota.HARD_DAILY_CAP, lo))
  return { min, max: Math.max(min, Math.min(outreachQuota.HARD_DAILY_CAP, hi)) }
}
"""),
# hold reason on restriction holds
P(PLANNER,
"""    await db.query(`UPDATE outreach_plans SET status='saved', armed=FALSE, job_id=NULL, updated_at=NOW() WHERE id=$1`, [plan.id])
    await logTransition(plan.id, plan.status, 'saved', reason, 'system')""",
"""    await db.query(`UPDATE outreach_plans SET status='saved', armed=FALSE, job_id=NULL, hold_reason=$2, hold_at=NOW(), updated_at=NOW() WHERE id=$1`, [plan.id, String(reason).slice(0, 200)])
    await logTransition(plan.id, plan.status, 'saved', reason, 'system')"""),
# recovery after reconnect
P(PLANNER,
"""    return setAccountRestriction(account.id, { restricted: false, reason: 'session_recovered_live', sessionStatus: status, actor: 'health_check' })
  }
  return { ...account, last_session_status: status }
}""",
"""    const cleared = await setAccountRestriction(account.id, { restricted: false, reason: 'session_recovered_live', sessionStatus: status, actor: 'health_check' })
    await rearmHeldPlans(account.id).catch(err => log.warn('outreachPlanner: re-arm after reconnect failed', { accountId: account.id, err: err.message }))
    return cleared
  }
  return { ...account, last_session_status: status }
}

// Kev, 2026-11-21: runs that were held because the WhatsApp session dropped
// are scheduled again once it is healthy — only those still in the future
// (never a missed run sent late) and only those that WERE armed before.
async function rearmHeldPlans(accountId, now = new Date()) {
  const held = (await db.query(
    `SELECT id, scheduled_at FROM outreach_plans
      WHERE account_id=$1 AND armed=FALSE AND status='saved' AND hold_reason LIKE 'account_restricted:session_%'
        AND scheduled_at > $2 ORDER BY scheduled_at`, [accountId, new Date(now.getTime() + 2 * 60_000)])).rows
  const out = []
  for (const p of held) {
    const r = await armPlan(p.id, { time: maltaTimeLabel(new Date(p.scheduled_at)), chain: false }).catch(err => ({ ok: false, reason: err.message }))
    if (r.ok) await logTransition(p.id, 'saved', 'ready', 'rearmed_after_reconnect', 'system')
    else await db.query(`UPDATE outreach_plans SET hold_reason=$2 WHERE id=$1`, [p.id, `rearm_failed:${r.reason}`])
    out.push({ planId: p.id, ok: !!r.ok, reason: r.reason || null })
  }
  return out
}

// Every 5 minutes (maintainAutoSchedules): a session-caused hold lifts itself
// as soon as the session is healthy again, without anyone opening the CRM.
async function recoverSessionHolds() {
  const rows = (await db.query(
    `SELECT * FROM whatsapp_accounts WHERE is_active AND outreach_enabled AND operational_status='restricted' AND restriction_reason LIKE 'session_%'`)).rows
  for (const a of rows) {
    const live = await waha.getSessionStatus(a.session_name).catch(() => null)
    const s = String(live?.status || 'UNKNOWN').toUpperCase()
    if (HEALTHY_SESSION_STATES.has(s)) await syncAccountHealth(a, s)
  }
}"""),
# setRotationTemplate → library
P(PLANNER,
"""async function setRotationTemplate(planId, accountId, persona, now = new Date()) {
  const slot = await outreachTemplates.pickSlot(accountId, persona, { planId, now })
  const preview = (await outreachTemplates.renderAtSendTime(
    { mode: outreachTemplates.MODE_ROTATION, persona, slot }, outreachSchedule.maltaLocalToUTC(outreachSchedule.maltaDateStr(now), '09:00'))).text""",
"""async function setRotationTemplate(planId, accountId, persona, now = new Date(), at = null) {
  // Kev, 2026-11-21: Auto uses the hand-written library when it has texts for
  // this persona; a text is picked per owner at send time and the greeting is
  // generated then. The stored text is only a preview for the plan's OWN time
  // (it used to be rendered for 09:00 — "Good morning" on a 15:00 run).
  const row = (await db.query(`SELECT scheduled_at FROM outreach_plans WHERE id = $1`, [planId])).rows[0]
  const when = at || (row?.scheduled_at ? new Date(row.scheduled_at) : null)
  if (await outreachLibrary().activeCount(persona) > 0) {
    const text = await outreachLibrary().preview(persona, when || now)
    await db.query(`UPDATE outreach_plans SET message_template = $2, message_mode = 'library', template_slot = NULL, updated_at = NOW() WHERE id = $1`, [planId, text])
    return 'library'
  }
  const slot = await outreachTemplates.pickSlot(accountId, persona, { planId, now })
  const preview = (await outreachTemplates.renderAtSendTime(
    { mode: outreachTemplates.MODE_ROTATION, persona, slot }, when || outreachSchedule.maltaLocalToUTC(outreachSchedule.maltaDateStr(now), '09:00'))).text"""),
# autoPrepare: variation param
P(PLANNER,
"""async function autoPrepareAccount(accountId, { baseCount = null, message = null, labels = null, actor = 'admin', now = new Date() } = {}) {""",
"""async function autoPrepareAccount(accountId, { baseCount = null, variation = null, message = null, labels = null, actor = 'admin', now = new Date() } = {}) {"""),
P(PLANNER,
"""  const resolvedBase = Math.max(1, Math.min(limit, Math.round(requestedBase)))
""",
"""  const resolvedBase = Math.max(1, Math.min(limit, Math.round(requestedBase)))
  // Kev, 2026-11-21 ("32 ±5 loads 38 or 40"): the batch size typed for Auto
  // used to be stored and then IGNORED — every day was drawn from the old
  // 30–40 default. It is now saved as the account's envelope (base ± variation,
  // the same record every dispatcher reads), and every Auto day is drawn from it.
  if (Number.isFinite(suppliedCount) && suppliedCount > 0) {
    const cfgRow = (await db.query(`SELECT target_variation FROM outreach_automation_configs WHERE account_id=$1`, [accountId])).rows[0]
    const current = cfgRow ? Number(cfgRow.target_variation) : (Number(account.outreach_daily_target_max) - Number(account.outreach_daily_target_min) >= 2 ? 5 : 0)
    const v = (variation == null ? current : Number(variation)) >= 5 ? 5 : 0
    await require('./outreachAutomation').savePace(accountId, { target: resolvedBase, variation: v }, actor)
    account = (await db.query(`SELECT * FROM whatsapp_accounts WHERE id=$1`, [accountId])).rows[0]
  }
  const envelope = batchEnvelope(account)
"""),
P(PLANNER,
"""      const savedTarget = Math.max(1, Math.min(limit, Number(plan.target_count) || resolvedBase))
      try {
        const generated = await generateList(plan.id, savedTarget, {
          actor: 'auto-prepare-topup', topUp: true, previewCursor, excludedPhones,
        })
        previewCursor = generated.previewCursor""",
"""      // The day's count must lie inside the CURRENT envelope; a count drawn
      // under an older range (40 under 30–40 after the agent chose 32 ±5) is
      // redrawn and the list trimmed — never silently expanded.
      const previousTarget = Number(plan.target_count) || 0
      const inside = previousTarget >= Math.max(1, envelope.min) && previousTarget <= envelope.max
      const savedTarget = inside ? previousTarget : Math.max(1, Math.min(limit, outreachQuota.drawTarget(account) || resolvedBase))
      try {
        if (plan.stats.eligible > savedTarget) await trimPlanToBatch(plan.id, savedTarget, 'batch_envelope_changed')
        await db.query(`UPDATE outreach_plans SET batch_min=$2, batch_max=$3 WHERE id=$1`, [plan.id, envelope.min, envelope.max])
        const generated = await generateList(plan.id, savedTarget, {
          actor: 'auto-prepare-topup', topUp: true, previewCursor, excludedPhones,
        })
        previewCursor = generated.previewCursor
        // generateList marks a topped-up list 'mixed'; it is still an Auto day.
        await db.query(`UPDATE outreach_plans SET source='auto_prepared' WHERE id=$1`, [plan.id])"""),
P(PLANNER,
"""        if (persona && plan.message_mode !== outreachTemplates.MODE_ROTATION) await setRotationTemplate(plan.id, accountId, persona, now)""",
"""        // Only the old period-copied rotation moves to the library; a text the agent wrote or
        // edited for this day (free_text) is never replaced by the 5-minute refresh (Kev, 2026-11-21).
        if (persona && plan.message_mode === outreachTemplates.MODE_ROTATION) await setRotationTemplate(plan.id, accountId, persona, now)"""),
P(PLANNER,
"""      if (persona) templateSlot = await setRotationTemplate(plan.id, accountId, persona, now)""",
"""      if (persona) templateSlot = await setRotationTemplate(plan.id, accountId, persona, now, scheduledAt)"""),
P(PLANNER,
"""            SET scheduled_at=$2, status='saved', source='auto_prepared', armed=FALSE, target_count=$3, updated_at=NOW()
          WHERE id=$1`, [plan.id, scheduledAt.toISOString(), Math.max(1, prepared)]""",
"""            SET scheduled_at=$2, status='saved', source='auto_prepared', armed=FALSE, target_count=$3,
                batch_min=$4, batch_max=$5, hold_reason=NULL, hold_at=NULL, updated_at=NOW()
          WHERE id=$1`, [plan.id, scheduledAt.toISOString(), Math.max(1, prepared), envelope.min, envelope.max]"""),
# pre-existing crash: getPlanWithEntries has no stats, so every 5-minute refresh of a prepared day threw
P(PLANNER,
"""        const refreshed = await getPlanWithEntries(plan.id)""",
"""        const refreshed = { ...(await getPlanWithEntries(plan.id)), stats: await computeStats(plan.id) }"""),
# trimPlanToBatch
P(PLANNER,
"""async function regenerate(planId, requestedCount) {""",
"""// Kev, 2026-11-21: a batch never grows past its maximum. Pending eligible
// entries beyond `max` (last positions first) leave the list — deleted while
// the plan is a preview, marked skipped 'over_batch_limit' once it is armed —
// and their reservations are released. Sent entries are never touched.
async function trimPlanToBatch(planId, max, reason = 'over_batch_limit', { mode = 'delete' } = {}) {
  const total = (await db.query(`SELECT COUNT(*)::int AS n FROM outreach_plan_entries WHERE plan_id=$1 AND eligibility_status='eligible'`, [planId])).rows[0].n
  const excess = total - Math.max(0, Number(max) || 0)
  if (excess <= 0) return 0
  const ids = (await db.query(
    `SELECT id FROM outreach_plan_entries WHERE plan_id=$1 AND eligibility_status='eligible' AND send_status='pending'
      ORDER BY position DESC NULLS FIRST, id DESC LIMIT $2`, [planId, excess])).rows.map(r => r.id)
  if (!ids.length) return 0
  await db.query(`UPDATE outreach_reservations SET released_at=NOW(), override_reason=COALESCE(override_reason,$2) WHERE entry_id = ANY($1::bigint[]) AND released_at IS NULL`, [ids, reason])
  if (mode === 'skip') {
    await db.query(`UPDATE outreach_plan_entries SET eligibility_status='skip', skip_reason=$2, updated_at=NOW() WHERE id = ANY($1::bigint[])`, [ids, reason])
  } else {
    await db.query(`DELETE FROM outreach_plan_entries WHERE id = ANY($1::bigint[])`, [ids])
  }
  const st = (await db.query(`UPDATE outreach_plans SET target_count = LEAST(COALESCE(target_count, $2), $2), updated_at=NOW() WHERE id=$1 RETURNING status`, [planId, max])).rows[0]
  await logTransition(planId, st?.status || null, st?.status || 'saved', `${reason}:removed_${ids.length}:max_${max}`, 'system')
  return ids.length
}

async function regenerate(planId, requestedCount) {"""),
# armPlan: enforce batch max, clear hold
P(PLANNER,
"""  if (eligibleCount > accountLimit) {
    return { ok: false, reason: 'starter_batch_limit', max: accountLimit, eligibleCount }
  }
  let sessionStatus = 'UNKNOWN'""",
"""  if (eligibleCount > accountLimit) {
    return { ok: false, reason: 'starter_batch_limit', max: accountLimit, eligibleCount }
  }
  // Kev, 2026-11-21: an Auto day is frozen to its batch range before arming.
  if (p.batch_max && eligibleCount > p.batch_max) await trimPlanToBatch(planId, p.batch_max, 'over_batch_limit')
  let sessionStatus = 'UNKNOWN'"""),
P(PLANNER,
"""  const lock = await recheckAndLockPlanEntries(planId, p.account_id, p.target_count || eligibleCount)""",
"""  // An Auto day needs at least its batch minimum, not the exact count drawn when it was prepared
  // (one owner replying or entering a cooldown made every re-arm fail: 28 of 29). Manual days unchanged.
  const lockTarget = p.batch_min ? Math.min(p.target_count || eligibleCount, Math.max(1, p.batch_min)) : (p.target_count || eligibleCount)
  const lock = await recheckAndLockPlanEntries(planId, p.account_id, lockTarget)"""),
P(PLANNER,
"""        SET status = 'ready', armed = TRUE, scheduled_at = $2, job_id = $3, idempotency_key = $4, retry_attempt = 0, updated_at = NOW()""",
"""        SET status = 'ready', armed = TRUE, scheduled_at = $2, job_id = $3, idempotency_key = $4, retry_attempt = 0, hold_reason = NULL, hold_at = NULL, updated_at = NOW()"""),
# dayDisplayState: no generic "Paused"
P(PLANNER,
"""  if (plan.status === 'blocked_session') return { state: 'attention', label: 'Account offline — retrying' }""",
"""  if (plan.status === 'blocked_session') return { state: 'attention', label: 'Connection error — retrying every 3 min' }"""),
P(PLANNER,
"""  if (plan.source === 'auto_prepared' && plan.scheduled_at && (stats.eligible || 0) > 0) return { state: 'auto_prepared', label: 'Auto prepared — not saved' }
  if (plan.status === 'saved' && plan.scheduled_at && (stats.eligible || 0) > 0) return { state: 'paused', label: 'Paused' }""",
"""  // Kev, 2026-11-21: "Paused" is never a fallback. A held day says WHY; a
  // prepared day nobody has authorised yet is "Ready to start"; a day whose
  // time passed without being scheduled says exactly that.
  const hold = String(plan.hold_reason || '')
  if (!plan.armed && ['saved', 'draft'].includes(plan.status) && hold) {
    if (hold === 'paused_by_agent') return { state: 'paused', label: 'Paused by agent' }
    if (hold === 'paused_by_admin') return { state: 'paused', label: 'Paused by administrator' }
    if (hold === 'auto_turned_off') return { state: 'paused', label: 'Auto turned off — not scheduled' }
    if (/session_|connection/.test(hold)) return { state: 'attention', label: 'Connection error — schedules again when WhatsApp reconnects' }
    if (hold.startsWith('account_restricted')) return { state: 'attention', label: 'Held — account restricted' }
    return { state: 'attention', label: `Held — ${hold.replace(/[:_]/g, ' ')}` }
  }
  const prepared = plan.scheduled_at && (stats.eligible || 0) > 0 && !plan.armed && ['saved', 'draft'].includes(plan.status)
  if (prepared && new Date(plan.scheduled_at).getTime() <= Date.now()) return { state: 'missed', label: 'Not sent — was never scheduled' }
  if (prepared) return { state: 'ready_to_start', label: plan.source === 'auto_prepared' ? 'Ready to start — prepared by Auto, not scheduled yet' : 'Ready to start — saved, not scheduled yet' }"""),
# saveAll: past day is "missed", explicit Save All authorises rolling
P(PLANNER,
"""      if (new Date(plan.scheduled_at) <= now) { results.push({ ...base, status: 'failed', reason: 'time_in_past' }); continue }""",
"""      if (new Date(plan.scheduled_at) <= now) { results.push({ ...base, status: 'missed', reason: 'time_in_past' }); continue }"""),
P(PLANNER,
"""    const failed = results.filter(x => x.status === 'failed')
    if (!failed.length) {""",
"""    const failed = results.filter(x => x.status === 'failed')
    // An explicit Save All / Start by a person authorises the rolling schedule
    // even if single days could not be scheduled (each is reported with its
    // reason). The 5-minute maintenance never authorises anything by itself.
    const authorised = actor !== 'auto-rolling' && results.some(x => ['scheduled', 'already_scheduled'].includes(x.status))
    if (!failed.length || authorised) {"""),
# Auto on = prepare + start (explicit), off = hold with reason
P(PLANNER,
"""async function setAutoEnabled(accountId, enabled, { actor = 'admin', now = new Date() } = {}) {""",
"""async function setAutoEnabled(accountId, enabled, { actor = 'admin', now = new Date(), startNow = false, baseCount = null, variation = null } = {}) {"""),
P(PLANNER,
"""    const preparation = await autoPrepareAccount(accountId, { actor, now })
    return { enabled: true, preparation, rollingPlans: preparation.rollingPlans }""",
"""    const preparation = await autoPrepareAccount(accountId, { actor, now, baseCount, variation })
    // Kev, 2026-11-21: turning Auto on in the CRM (after its confirmation that
    // lists days, times and the batch range) IS the authorisation to start; it
    // used to leave every day "prepared — not saved" until a separate SAVE ALL.
    const started = startNow ? await saveAllPrepared(accountId, { actor, now }) : null
    return {
      enabled: true, started, preparation,
      armed: !!started && started.scheduled + started.alreadyScheduled > 0,
      rollingPlans: started ? started.rollingPlans : preparation.rollingPlans,
    }"""),
P(PLANNER,
"""  for (const plan of armed) { await pausePlan(plan.id); paused.push(plan.id) }""",
"""  for (const plan of armed) {
    await pausePlan(plan.id)
    await db.query(`UPDATE outreach_plans SET hold_reason='auto_turned_off', hold_at=NOW() WHERE id=$1`, [plan.id])
    paused.push(plan.id)
  }"""),
P(PLANNER,
"""  const prepared = []
  const skipped = []
  const armed = []
  for (const account of accounts) {""",
"""  const prepared = []
  const skipped = []
  const armed = []
  await recoverSessionHolds().catch(err => log.warn('outreachPlanner: session hold recovery failed', { err: err.message }))
  for (const account of accounts) {"""),
# pause = held by agent
P(PLANNER,
"""  await releaseReservationsForPlan(planId, 'paused_by_user')
  await db.query(`UPDATE outreach_plans SET status = 'saved', armed = FALSE, job_id = NULL, updated_at = NOW() WHERE id = $1`, [planId])""",
"""  await releaseReservationsForPlan(planId, 'paused_by_user')
  await db.query(`UPDATE outreach_plans SET status = 'saved', armed = FALSE, job_id = NULL, hold_reason = 'paused_by_agent', hold_at = NOW(), updated_at = NOW() WHERE id = $1`, [planId])"""),
# connection errors: bounded retry instead of instant skip
P(PLANNER,
"""const LATE_START_GRACE_MS = 10 * 60_000
""",
"""const LATE_START_GRACE_MS = 10 * 60_000
// Kev, 2026-11-21: a dropped WhatsApp session is retried every 3 minutes for
// up to 45 minutes after the run's time; after that the day is skipped.
const CONNECTION_RETRY_MS = 45 * 60_000
"""),
P(PLANNER,
"""async function blockAndRetry(planId, plan, reason) {
  if (!plan.dispatch_started_at && plan.scheduled_at && Date.now() > new Date(plan.scheduled_at).getTime() + LATE_START_GRACE_MS) {""",
"""async function blockAndRetry(planId, plan, reason) {
  const grace = String(reason).startsWith('connection_error') ? CONNECTION_RETRY_MS : LATE_START_GRACE_MS
  if (!plan.dispatch_started_at && plan.scheduled_at && Date.now() > new Date(plan.scheduled_at).getTime() + grace) {"""),
P(PLANNER,
"""  if (!plan.dispatch_started_at && plan.scheduled_at && Date.now() > new Date(plan.scheduled_at).getTime() + LATE_START_GRACE_MS) {
    await markPlanSkipped(planId, 'missed_start_window')
    return
  }""",
"""  const startGrace = plan.status === 'blocked_session' ? CONNECTION_RETRY_MS : LATE_START_GRACE_MS
  if (!plan.dispatch_started_at && plan.scheduled_at && Date.now() > new Date(plan.scheduled_at).getTime() + startGrace) {
    await markPlanSkipped(planId, plan.status === 'blocked_session' ? 'connection_error_not_recovered' : 'missed_start_window')
    return
  }"""),
P(PLANNER,
"""  if (!sessionHealthy) {
    await setAccountRestriction(plan.account_id, {""",
"""  if (!sessionHealthy) {
    if (plan.run_mode !== 'automation' && (plan.retry_attempt || 0) < MAX_RETRY_ATTEMPTS
        && plan.scheduled_at && Date.now() <= new Date(plan.scheduled_at).getTime() + CONNECTION_RETRY_MS) {
      await recordAccountEvent(plan.account_id, 'connection_error', { sessionStatus, reason: `plan_${planId}_retry`, actor: 'scheduled_health_check' })
      return blockAndRetry(planId, plan, `connection_error:${sessionStatus}`)
    }
    await setAccountRestriction(plan.account_id, {"""),
# dispatch: never more than the frozen batch maximum
P(PLANNER,
"""  if (!entries.length) {
    await releaseReservationsForPlan(planId, 'no_pending_entries')""",
"""  if (plan.batch_max && entries.length > plan.batch_max) {
    await trimPlanToBatch(planId, plan.batch_max, 'over_batch_limit', { mode: 'skip' })
    const keep = new Set((await db.query(`SELECT id FROM outreach_plan_entries WHERE plan_id = $1 AND eligibility_status = 'eligible' AND send_status = 'pending'`, [planId])).rows.map(r => r.id))
    for (let i = entries.length - 1; i >= 0; i--) if (!keep.has(entries[i].id)) entries.splice(i, 1)
  }

  if (!entries.length) {
    await releaseReservationsForPlan(planId, 'no_pending_entries')"""),
# listAccounts horizon: include hold_reason for the day badges
P(PLANNER,
"""SELECT account_id, scheduled_date::text AS day, status, armed, scheduled_at, target_count, source, message_template FROM outreach_plans""",
"""SELECT account_id, scheduled_date::text AS day, status, armed, scheduled_at, target_count, source, message_template, hold_reason, batch_min, batch_max FROM outreach_plans"""),
P(PLANNER,
"""  saveAllPrepared, setAutoEnabled, maintainAutoSchedules, dayDisplayState, setRotationTemplate,""",
"""  saveAllPrepared, setAutoEnabled, maintainAutoSchedules, dayDisplayState, setRotationTemplate,
  trimPlanToBatch, rearmHeldPlans, recoverSessionHolds, batchEnvelope,"""),

# ── routes/crm.js ──────────────────────────────────────────────────────────
P(CRM,
"""    const result = await outreachPlanner.autoPrepareAccount(accountId, {
      baseCount,
""",
"""    const result = await outreachPlanner.autoPrepareAccount(accountId, {
      baseCount,
      variation: req.body?.variation == null ? null : Number(req.body.variation),
"""),
P(CRM,
"""    res.json(await outreachPlanner.setAutoEnabled(accountId, req.body.enabled, { actor: req.agent?.username || 'admin' }))""",
"""    const baseCount = req.body?.baseCount == null ? null : Number(req.body.baseCount)
    if (baseCount != null && (!Number.isInteger(baseCount) || baseCount < 1 || baseCount > 40)) return res.status(400).json({ error: 'baseCount must be 1–40' })
    res.json(await outreachPlanner.setAutoEnabled(accountId, req.body.enabled, {
      actor: req.agent?.username || 'admin', startNow: req.body.start === true, baseCount,
      variation: req.body?.variation == null ? null : Number(req.body.variation),
    }))"""),
P(CRM,
"""  const known = ['account_restricted', 'system_manager_not_outreach', 'invalid_pace', 'unknown_persona', 'invalid_period', 'invalid_slot', 'invalid_length', 'foreign_persona_signature']""",
"""  const known = ['account_restricted', 'system_manager_not_outreach', 'invalid_pace', 'unknown_persona', 'invalid_period', 'invalid_slot', 'invalid_length', 'foreign_persona_signature', 'greeting_not_allowed', 'not_found', 'invalid_target']"""),
P(CRM,
"""router.get('/outreach/accounts/:accountId/quota', auth, adminOnly, async (req, res) => {""",
"""// Kev, 2026-11-21: one honest status per account (state, reason, next action,
// batch range, per-day selected/queued/accepted/failed/skipped with reasons).
router.get('/outreach/accounts/:accountId/auto-status', auth, adminOnly, async (req, res) => {
  try {
    const accountId = Number.parseInt(req.params.accountId, 10)
    if (!accountId) return res.status(400).json({ error: 'valid accountId required' })
    res.json(await require('../services/outreachAutoStatus').forAccount(accountId))
  } catch (err) { outreachAutomationError(res, err, 'Failed to read Auto status') }
})

// Message library (hand-written first-contact texts, one picked per owner).
router.get('/outreach/library', auth, adminOnly, async (req, res) => {
  try {
    const persona = req.query.persona ? String(req.query.persona).toLowerCase() : null
    res.json({ templates: await require('../services/outreachLibrary').list(persona) })
  } catch (err) { outreachAutomationError(res, err, 'Failed to load the message library') }
})
router.post('/outreach/library', auth, adminOnly, async (req, res) => {
  try {
    const id = req.body?.id == null ? null : Number(req.body.id)
    res.json({ template: await require('../services/outreachLibrary').save({ id, persona: req.body?.persona, body: req.body?.body, active: req.body?.active !== false }, req.agent?.username || 'admin') })
  } catch (err) { outreachAutomationError(res, err, 'Failed to save the library text') }
})
router.post('/outreach/library/:id/active', auth, adminOnly, async (req, res) => {
  try {
    res.json({ template: await require('../services/outreachLibrary').setActive(Number(req.params.id), req.body?.active === true, req.agent?.username || 'admin') })
  } catch (err) { outreachAutomationError(res, err, 'Failed to change the library text') }
})

router.get('/outreach/accounts/:accountId/quota', auth, adminOnly, async (req, res) => {"""),
]

def main():
    files = {}
    for path, old, new in PATCHES:
        full = os.path.join(ROOT, path)
        if path not in files:
            with open(full, 'r', encoding='utf-8', newline='') as f:
                files[path] = f.read()
        text = files[path]
        crlf = '\r\n' in text
        o = old.replace('\n', '\r\n') if crlf else old
        n = new.replace('\n', '\r\n') if crlf else new
        count = text.count(o)
        if count != 1:
            print(f'ANCHOR {count}x in {path}: {old[:90]!r}')
            sys.exit(1)
        files[path] = text.replace(o, n)
    for path, text in files.items():
        with open(os.path.join(ROOT, path), 'w', encoding='utf-8', newline='') as f:
            f.write(text)
    print(f'patched {len(PATCHES)} anchors in {len(files)} files')

main()
