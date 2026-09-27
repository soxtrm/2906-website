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
const OUTREACH_ACCOUNT_INTERVAL_MS = (24 * 60 + 15) * 60_000

function isSystemManagerSession(sessionName, label = '') {
  return /argus\s*1|argus[_-]?1/i.test(`${sessionName || ''} ${label || ''}`)
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
  return scheduledDateStr < todayStr ? 'PAST' : 'FUTURE'
}

function normPhone(p) { return cooldownNormalizePhone(p) }

// ── Accounts / profiles ─────────────────────────────────────────────────────
async function listAccounts() {
  const r = await db.query(
    `SELECT id, session_name, phone, label, is_active, outreach_enabled, account_persona,
            outreach_volume_percent, outreach_volume_until, pool
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

  const accounts = []
  for (const acc of r.rows) {
    let connected = false
    try {
      const status = await waha.getSessionStatus(acc.session_name)
      connected = status?.status === 'WORKING' || status?.status === 'CONNECTED'
    } catch (e) {
      log.debug('outreachPlanner: session status check failed', { session: acc.session_name, err: e.message })
    }
    accounts.push({
      id: acc.id, sessionName: acc.session_name, phone: acc.phone,
      label: acc.label || acc.session_name, connected,
      active: acc.is_active,
      outreachEnabled: acc.outreach_enabled,
      lastOutreachAt: lastSentMap.get(acc.session_name) || null,
      pool: acc.pool || 'top',
      outreachVolumePercent: acc.outreach_volume_until && new Date(acc.outreach_volume_until) <= new Date()
        ? 100
        : Number(acc.outreach_volume_percent || 100),
      outreachVolumeUntil: acc.outreach_volume_until || null,
      outreachEligible: acc.is_active && acc.outreach_enabled && !isSystemManagerSession(acc.session_name, acc.label),
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
  const dates = [today, addDaysStr(today, 1), addDaysStr(today, 2)]
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
          WHERE r.normalized_phone = $1 AND r.released_at IS NULL LIMIT 1`, [phone])
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

    let eligibility = check.eligibility_status
    let skipReason = check.skip_reason
    if (eligibility === 'eligible') {
      const reserved = await tryReserve(oc.id, phone, planId, null)
      if (!reserved.ok) { eligibility = 'skip'; skipReason = reserved.reason }
    }

    const ins = await db.query(
      `INSERT INTO outreach_plan_entries
         (plan_id, owner_id, normalized_phone, display_name, classification, eligibility_status, skip_reason, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [planId, oc.id, phone, parsed.name || oc.name || null, check.classification, eligibility, skipReason, pos])

    if (eligibility === 'eligible') {
      await db.query(`UPDATE outreach_reservations SET entry_id = $1 WHERE plan_id = $2 AND normalized_phone = $3 AND released_at IS NULL`,
        [ins.rows[0].id, planId, phone])
    }
    added.push(ins.rows[0])
  }

  if (plan.rows[0].status === 'draft') {
    await db.query(`UPDATE outreach_plans SET source = COALESCE(source, 'manual'), updated_at = NOW() WHERE id = $1`, [planId])
  }
  return { added: added.length, skipped: lines.length - added.length }
}

// ── Generate list (spec point 10/26/27) ─────────────────────────────────────
// Reuses buildPoolBatch() verbatim (the SAME engine !createlist calls) for
// candidate selection, then applies the reservation layer buildPoolBatch
// itself does not have. Over-fetches to absorb reservation conflicts.
async function generateList(planId, requestedCount, { topUp = false } = {}) {
  const plan = await db.query(`SELECT * FROM outreach_plans WHERE id = $1`, [planId])
  if (!plan.rows.length) throw new Error('plan not found')
  const { account_id: accountId, session_name: sessionName } = plan.rows[0]

  const existing = await db.query(`SELECT normalized_phone FROM outreach_plan_entries WHERE plan_id = $1`, [planId])
  const seen = new Set(existing.rows.map(r => r.normalized_phone))
  const currentEligible = topUp
    ? (await db.query(`SELECT COUNT(*)::int AS n FROM outreach_plan_entries WHERE plan_id = $1 AND eligibility_status = 'eligible'`, [planId])).rows[0].n
    : 0
  const need = topUp ? Math.max(0, requestedCount - currentEligible) : requestedCount
  if (need === 0) return { added: 0, need: 0 }

  const maxPos = await db.query(`SELECT COALESCE(MAX(position), 0) AS m FROM outreach_plan_entries WHERE plan_id = $1`, [planId])
  let pos = maxPos.rows[0].m

  // Over-fetch — reservation conflicts and same-paste duplicates both eat
  // into the buffer, same reasoning listBuilder.js's own buildPoolBatch
  // already uses internally for ITS buffer (candidates vs requestedCount).
  let remainingNeed = need
  let addedCount = 0
  let batchAttempts = 0
  while (remainingNeed > 0 && batchAttempts < 4) {
    batchAttempts++
    const batchSize = remainingNeed * 2 + 10
    const result = await buildPoolBatch(sessionName, batchSize)
    if (!result.list.length) break

    for (const c of result.list) {
      if (remainingNeed <= 0) break
      const phone = normPhone(c.phone_normalized)
      if (!phone || seen.has(phone)) continue
      seen.add(phone)

      const ocRes = await db.query(`SELECT id, name, status, do_not_contact FROM owner_contacts WHERE id = $1`, [c.id])
      const oc = ocRes.rows[0] || { id: c.id, name: c.name, status: null, do_not_contact: false }
      const check = await classifyAndCheck(oc, accountId)
      let eligibility = check.eligibility_status
      let skipReason = check.skip_reason
      let reservedEntryLink = null
      if (eligibility === 'eligible') {
        const reserved = await tryReserve(oc.id, phone, planId, null)
        if (!reserved.ok) { eligibility = 'skip'; skipReason = reserved.reason }
        else reservedEntryLink = true
      }

      pos++
      const ins = await db.query(
        `INSERT INTO outreach_plan_entries
           (plan_id, owner_id, normalized_phone, display_name, classification, eligibility_status, skip_reason, position)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [planId, oc.id, phone, oc.name || c.name || null, check.classification, eligibility, skipReason, pos])

      if (reservedEntryLink) {
        await db.query(`UPDATE outreach_reservations SET entry_id = $1 WHERE plan_id = $2 AND normalized_phone = $3 AND released_at IS NULL`,
          [ins.rows[0].id, planId, phone])
        addedCount++
        remainingNeed--
      }
    }
    if (result.list.length < batchSize) break // pool exhausted for this pass
  }

  await db.query(
    `UPDATE outreach_plans SET source = $2, target_count = COALESCE(target_count, 0) + $3, updated_at = NOW() WHERE id = $1`,
    [planId, topUp ? 'mixed' : 'generated', addedCount])
  return { added: addedCount, need }
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
  await clearEntries(planId)
  return generateList(planId, requestedCount)
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
  const account = await db.query(`SELECT label FROM whatsapp_accounts WHERE id = $1`, [p.account_id])
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

  const timeStr = time || (p.scheduled_at ? maltaTimeLabel(new Date(p.scheduled_at)) : '09:00')
  const scheduledAt = maltaLocalToUTC(p.scheduled_date, timeStr)
  const delayMs = scheduledAt.getTime() - Date.now()
  if (delayMs < 0) return { ok: false, reason: 'time_in_past' }
  const cooldown = await accountCooldown(p.session_name, scheduledAt)
  if (!cooldown.allowed) {
    return { ok: false, reason: 'account_24h15_cooldown', nextEligibleAt: cooldown.nextEligibleAt.toISOString() }
  }

  const idempotencyKey = `outreach-plan-${planId}-${scheduledAt.toISOString()}`

  // Cancel any previously-armed job for this plan first (re-arming after an
  // edit must never leave two jobs ticking for the same plan).
  if (p.job_id) {
    try { const old = await QUEUES['outreach-plan'].getJob(p.job_id); if (old) await old.remove() }
    catch (e) { log.debug('outreachPlanner: old job removal failed (likely already gone)', { err: e.message }) }
  }

  const job = await addJob('outreach-plan', { planId }, { delay: Math.max(0, delayMs), jobId: idempotencyKey })

  await db.query(
    `UPDATE outreach_plans
        SET status = 'ready', armed = TRUE, scheduled_at = $2, job_id = $3, idempotency_key = $4, retry_attempt = 0, updated_at = NOW()
      WHERE id = $1`,
    [planId, scheduledAt.toISOString(), String(job.id), idempotencyKey])
  await logTransition(planId, p.status, 'ready', 'armed_by_user', 'admin', { job_id: String(job.id) })
  return { ok: true, scheduledAt: scheduledAt.toISOString() }
}

async function pausePlan(planId) {
  const plan = await db.query(`SELECT status, job_id FROM outreach_plans WHERE id = $1`, [planId])
  if (plan.rows[0]?.job_id) {
    try { const job = await QUEUES['outreach-plan'].getJob(plan.rows[0].job_id); if (job) await job.remove() }
    catch (e) { log.debug('outreachPlanner: pause job removal failed', { err: e.message }) }
  }
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
  const jobId = `${plan.idempotency_key || 'outreach-plan-' + planId}-retry-${attempt}`
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

  const account = await db.query(`SELECT label FROM whatsapp_accounts WHERE id = $1`, [plan.account_id])
  if (isSystemManagerSession(plan.session_name, account.rows[0]?.label)) {
    await db.query(`UPDATE outreach_plans SET status = 'failed', armed = FALSE, updated_at = NOW() WHERE id = $1`, [planId])
    await logTransition(planId, plan.status, 'failed', 'system_manager_not_outreach', 'system')
    return
  }
  const accountGate = await accountCooldown(plan.session_name)
  if (!accountGate.allowed) {
    const delay = Math.max(60_000, accountGate.nextEligibleAt.getTime() - Date.now())
    const jobId = `${plan.idempotency_key || 'outreach-plan-' + planId}-account-cooldown-${accountGate.nextEligibleAt.toISOString()}`
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
  try {
    const status = await waha.getSessionStatus(plan.session_name)
    sessionHealthy = status?.status === 'WORKING' || status?.status === 'CONNECTED'
  } catch (e) {
    log.debug('outreachPlanner: session health check threw, treating as unhealthy', { planId, session: plan.session_name, err: e.message })
  }
  if (!sessionHealthy) {
    return blockAndRetry(planId, plan, `session_${plan.session_name}_not_working`)
  }

  await logTransition(planId, plan.status, 'running', 'send_starting', 'system', { job_id: plan.job_id })
  await db.query(`UPDATE outreach_plans SET status = 'running', updated_at = NOW() WHERE id = $1`, [planId])

  const entries = (await db.query(
    `SELECT * FROM outreach_plan_entries WHERE plan_id = $1 AND eligibility_status = 'eligible' AND send_status = 'pending'`,
    [planId])).rows

  if (!entries.length) {
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
    SELECT session_name, COUNT(*)::int AS n
      FROM outreach_plan_entries e
      JOIN outreach_plans p ON p.id = e.plan_id
     WHERE p.scheduled_date = $1 AND e.send_status = 'sent'
     GROUP BY session_name
  `, [today])
  const uniqueRes = await db.query(`
    SELECT COUNT(DISTINCT e.normalized_phone)::int AS unique_owners, COUNT(*)::int AS total_sends
      FROM outreach_plan_entries e
      JOIN outreach_plans p ON p.id = e.plan_id
     WHERE p.scheduled_date = $1 AND e.send_status = 'sent'
  `, [today])
  return { perAccount: r.rows, ...uniqueRes.rows[0] }
}

module.exports = {
  maltaTodayStr, addDaysStr, maltaLocalToUTC, maltaTimeLabel, dayLabelFor,
  listAccounts, setAccountVolume, ensurePlan, getPlanWithEntries, listRollingPlans, computeStats,
  setMessageTemplate, addEntriesFromPaste, generateList, removeEntry, clearEntries, regenerate,
  saveDraft, armPlan, pausePlan, cancelPlan, runScheduledPlan,
  reconcileOverdueArmedPlans, reconcilePlanFromBatch,
  checkDuplicatesGlobal, todayContactedSummary,
  listMessageTemplates, saveMessageTemplate, deleteMessageTemplate,
}
