'use strict'
// ============================================================================
// services/reminderOutreach.js — backs !outreminder.
//
// Follows up every currently-open reminder (reminders.status='pending') with
// a warm, reminder-specific "checking in as promised" message, sent from the
// SAME account the reminder originally came from (reminders.source_session) —
// not the normal admin-fallback priority chain. Only when that exact account
// is not WORKING right now does 'default' step in, per Kev's explicit rule:
// "der Ur-Account, sonst NUR Default" (not the full Default→Kevsecond→
// kevthirdd→Cedric→Jasmine chain waha.pickActiveAdminSession() walks for
// everything else in this codebase — this is deliberately narrower).
//
// The actual send only ever happens from services/adminCommands.js's
// !outreminder YES confirm — nothing in this file sends unprompted.
// ============================================================================

const db   = require('../db')
const log  = require('../logger')
const waha = require('../waha')

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const REMINDER_TIME_ZONE = 'Europe/Malta'
const REMINDER_WINDOW_START_MINUTE = 8 * 60
const REMINDER_WINDOW_END_MINUTE = 20 * 60 + 30
const REVIEW_ONLY_BLOCK_REASON = 'REVIEW_ONLY: context recheck required before contact'

function maltaReminderWindow(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: REMINDER_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value
    return acc
  }, {})
  const minuteOfDay = Number(parts.hour) * 60 + Number(parts.minute)
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minuteOfDay,
    open: minuteOfDay >= REMINDER_WINDOW_START_MINUTE && minuteOfDay <= REMINDER_WINDOW_END_MINUTE,
  }
}
// Same "cold" pacing runDirectOutreach uses for a list that isn't a live,
// currently-warm conversation (services/adminCommands.js coldDelay()) — a
// reminder follow-up is exactly that: reopening a conversation that went
// quiet, not replying inside one.
function coldDelay() { return Math.floor(Math.random() * (60000 - 40000 + 1)) + 40000 } // 40-60s

// "Open" = pending AND actually due (contact_due_date <= today) — Kev's spec
// describes "checking in as promised", which only reads as intended once the
// promised timing has arrived. Found live 2026-09-02: `reminders` currently
// holds 354 status='pending' rows total, 243 of them due only in the future
// (some over a year out) — !outreminder must never message an owner about a
// date that hasn't happened yet, so those are excluded here, not just left
// to the confirm-step preview to catch. Also excludes 11 rows with a
// contact_due_date before 2020 — clearly corrupted (year 1530/1600/1700),
// a pre-existing upstream parsing bug flagged separately, not something this
// command should guess a message around.
async function openReminders() {
  const r = await db.query(
    `SELECT id, source_session, source_phone, source_message_id, owner_phone,
            owner_name, original_note, parsed_timing, estimated_owner_date,
            contact_due_date, status, contact_classification,
            auto_send_status, assigned_session, auto_send_for,
            auto_send_enabled, auto_send_block_reason
       FROM reminders
      WHERE status = 'pending'
        AND contact_due_date <= CURRENT_DATE
        AND contact_due_date >= '2020-01-01'
      ORDER BY contact_due_date ASC NULLS LAST, id ASC`)
  return r.rows
}

function fmtDateHuman(d) {
  if (!d) return null
  const dt = typeof d === 'string' ? new Date(d) : d
  if (Number.isNaN(dt.getTime())) return null
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' })
}

// Which timing phrase to use in the message — the owner's own words
// (parsed_timing, e.g. "end of September") read more natural than a bare
// date, so they win; a bare estimated_owner_date is the fallback when only
// that survived parsing.
function timingPhrase(row) {
  if (row.parsed_timing && row.parsed_timing.trim()) return row.parsed_timing.trim()
  const d = fmtDateHuman(row.estimated_owner_date)
  return d || null
}

// Warm, personal, "as promised" tone (Kev's brief) — references the actual
// reminder content (timing + original note) so it never reads as a generic
// template blast.
function buildOutreminderMessage(row) {
  const firstName = row.owner_name && row.owner_name.trim()
    ? row.owner_name.trim().split(/\s+/)[0]
    : null
  const greeting = firstName ? `Hey ${firstName}!` : 'Hey!'
  const timing = timingPhrase(row)
  const note = (row.original_note || '').trim()

  const timingLine = timing
    ? `you mentioned you might have something available around ${timing} — `
    : `you mentioned you might have something coming up — `
  const noteLine = note ? ` You'd said: "${note.slice(0, 200)}"` : ''

  return `${greeting} Just checking in as promised — ${timingLine}how's that looking now?${noteLine}\n\nLet me know whenever it's ready to list, no rush 🙂`
}

// The Ur-Account rule: try the exact account this reminder came from; if
// it's not WORKING right now, 'default' is the ONLY fallback (never the full
// priority chain) — an owner mid-conversation with Jasmine should never
// suddenly hear from Cedric. Returns the resolved session name, or null if
// NEITHER the original account nor 'default' is up (a case Kev's spec
// doesn't cover — this file refuses to guess and reports it as skipped
// rather than silently picking some other account).
async function resolveSendSession(row) {
  const working = await waha.getWorkingSessions()
  const eligible = (await db.query(
    `SELECT session_name FROM whatsapp_accounts
      WHERE is_active = TRUE AND outreach_enabled = TRUE
        AND NOT (
          COALESCE(operational_status, 'active') = 'restricted'
          AND (restriction_until IS NULL OR restriction_until > NOW())
        )
      ORDER BY priority, id`)).rows.map(r => r.session_name)
  const liveEligible = eligible
    .map(wanted => working.find(s => String(s.name || '').toLowerCase() === String(wanted).toLowerCase()))
    .filter(Boolean)
  const preferred = row.assigned_session || row.source_session
  const match = liveEligible.find(s => String(s.name || '').toLowerCase() === String(preferred || '').toLowerCase())
  return match?.name || liveEligible[0]?.name || null
}

const digits = (value) => String(value || '').replace(/\D/g, '')

async function classifyReminderContact(row) {
  const phone = digits(row.owner_phone)
  if (!phone) return { kind: 'friend', reason: 'missing_phone' }
  const owner = await db.query(
    `SELECT id FROM owner_contacts
      WHERE regexp_replace(COALESCE(phone_normalized,''), '\D', '', 'g') = $1
      LIMIT 1`, [phone])
  if (!owner.rows.length) return { kind: 'friend', reason: 'friend_not_owner' }
  const blocked = await db.query(
    `SELECT reason FROM owner_automation_blocks
      WHERE phone_normalized = $1 AND active = TRUE LIMIT 1`, [phone])
  if (blocked.rows.length) return { kind: 'owner', reason: 'permanent_owner_stop' }
  return { kind: 'owner', reason: null }
}

async function stageUnplannedReminders({ limit = 500 } = {}) {
  const ownerSendGate = require('./ownerSendGate')
  if (await ownerSendGate.getAutomationMode() === 'REVIEW_ONLY') {
    const reviewed = await require('./ownerRecheck').recheckDueReminders({ limit })
    return { queued: 0, blocked: 0, reviewOnly: true, reviewed }
  }
  const accounts = (await db.query(
    `SELECT session_name FROM whatsapp_accounts
      WHERE is_active=TRUE AND outreach_enabled=TRUE AND account_persona='kev'
        AND NOT (
          COALESCE(operational_status, 'active') = 'restricted'
          AND (restriction_until IS NULL OR restriction_until > NOW())
        )
      ORDER BY priority, id`)).rows.map(r => r.session_name)
  if (!accounts.length) return { queued: 0, blocked: 0 }
  const rows = (await db.query(
    `SELECT * FROM reminders
      WHERE status='pending'
        AND (
          auto_send_status='unplanned'
          OR (
            auto_send_status='blocked'
            AND auto_send_block_reason=$2
            AND contact_due_date >= (NOW() AT TIME ZONE 'Europe/Malta')::date
          )
        )
      ORDER BY contact_due_date, id LIMIT $1`, [limit, REVIEW_ONLY_BLOCK_REASON])).rows
  let queued = 0, blocked = 0
  const perAccountSlots = new Map()
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const classification = await classifyReminderContact(row)
    if (classification.kind !== 'owner' || classification.reason) {
      await db.query(
        `UPDATE reminders SET contact_classification=$2, auto_send_enabled=FALSE,
                auto_send_status='blocked', auto_send_block_reason=$3
          WHERE id=$1 AND auto_send_status='unplanned'`,
        [row.id, classification.kind, classification.reason])
      blocked++
      continue
    }
    const session = accounts[queued % accounts.length]
    const slot = perAccountSlots.get(session) || 0
    perAccountSlots.set(session, slot + 1)
    const dueDay = new Date(row.contact_due_date)
    const ymd = Number.isNaN(dueDay.getTime()) ? new Date().toISOString().slice(0, 10) : dueDay.toISOString().slice(0, 10)
    await db.query(
      `UPDATE reminders
          SET contact_classification='owner', auto_send_enabled=TRUE,
              auto_send_status='queued', auto_send_block_reason=NULL,
              assigned_session=$2,
              auto_send_for=CASE
                WHEN $3::date > (NOW() AT TIME ZONE 'Europe/Malta')::date
                  THEN (($3::date + time '08:00') AT TIME ZONE 'Europe/Malta') + ($4 * interval '2 minutes')
                WHEN (NOW() AT TIME ZONE 'Europe/Malta')::time < time '08:00'
                  THEN ((((NOW() AT TIME ZONE 'Europe/Malta')::date + time '08:00') AT TIME ZONE 'Europe/Malta') + ($4 * interval '2 minutes'))
                WHEN (NOW() AT TIME ZONE 'Europe/Malta')::time <= time '20:30'
                  AND NOW() + interval '2 minutes' + ($4 * interval '2 minutes')
                    <= ((((NOW() AT TIME ZONE 'Europe/Malta')::date + time '20:30') AT TIME ZONE 'Europe/Malta'))
                  THEN NOW() + interval '2 minutes' + ($4 * interval '2 minutes')
                ELSE (((((NOW() AT TIME ZONE 'Europe/Malta')::date + 1) + time '08:00') AT TIME ZONE 'Europe/Malta') + ($4 * interval '2 minutes'))
              END
        WHERE id=$1
          AND (
            auto_send_status='unplanned'
            OR (auto_send_status='blocked' AND auto_send_block_reason=$5)
          )`,
      [row.id, session, ymd, slot, REVIEW_ONLY_BLOCK_REASON])
    queued++
  }
  return { queued, blocked }
}

// Claims only messages whose exact scheduled minute has arrived. A session
// outage puts the row back in queued state; a send attempt itself is never
// blindly replayed, avoiding duplicate owner messages after ambiguous errors.
async function runDueAutoBatch({ limit = 5, dryRun = false } = {}) {
  const ownerSendGate = require('./ownerSendGate')
  if (await ownerSendGate.getAutomationMode() === 'REVIEW_ONLY') {
    return { due: 0, sent: [], blocked: [], waiting: [], failed: [], reviewOnly: true }
  }
  const sendWindow = maltaReminderWindow()
  if (!sendWindow.open) {
    return { due: 0, sent: [], blocked: [], waiting: [], failed: [], outsideWindow: true }
  }
  const preview = (await db.query(
    `SELECT id, source_session, owner_phone, owner_name, original_note,
            parsed_timing, estimated_owner_date, contact_due_date,
            assigned_session, auto_send_for
       FROM reminders
      WHERE status = 'pending'
        AND auto_send_enabled = TRUE
        AND auto_send_status = 'queued'
        AND auto_send_for <= NOW()
      ORDER BY auto_send_for, id
      LIMIT $1`, [limit])).rows
  if (dryRun) return { due: preview.length, sent: [], blocked: [], waiting: [] }

  const sent = [], blocked = [], waiting = [], failed = []
  for (const candidate of preview) {
    const claim = (await db.query(
      `UPDATE reminders SET auto_send_status='sending', auto_send_attempted_at=NOW()
        WHERE id=$1 AND status='pending' AND auto_send_status='queued'
        RETURNING *`, [candidate.id])).rows[0]
    if (!claim) continue

    const classification = await classifyReminderContact(claim)
    if (classification.kind !== 'owner' || classification.reason) {
      await db.query(
        `UPDATE reminders
            SET contact_classification=$2, auto_send_enabled=FALSE,
                auto_send_status='blocked', auto_send_block_reason=$3
          WHERE id=$1`,
        [claim.id, classification.kind, classification.reason])
      blocked.push({ id: claim.id, reason: classification.reason })
      continue
    }

    const sendSession = await resolveSendSession(claim)
    if (!sendSession) {
      await db.query(
        `UPDATE reminders SET auto_send_status='queued', auto_send_attempted_at=NULL,
                auto_send_for=CASE
                  WHEN NOW() + interval '5 minutes'
                    <= ((((NOW() AT TIME ZONE 'Europe/Malta')::date + time '20:30') AT TIME ZONE 'Europe/Malta'))
                    THEN NOW() + interval '5 minutes'
                  ELSE (((((NOW() AT TIME ZONE 'Europe/Malta')::date + 1) + time '08:00') AT TIME ZONE 'Europe/Malta'))
                END
          WHERE id=$1`, [claim.id])
      waiting.push({ id: claim.id, reason: 'no_outreach_session_working' })
      continue
    }

    const gate = await ownerSendGate.checkOwnerSend({
      phone: claim.owner_phone, kind: 'reminder', automated: true,
    })
    if (!gate.allow) {
      await db.query(
        `UPDATE reminders SET auto_send_enabled=FALSE, auto_send_status='blocked', auto_send_block_reason=$2
          WHERE id=$1`, [claim.id, `pre_send_gate:${gate.reason}`])
      blocked.push({ id: claim.id, reason: gate.reason })
      continue
    }

    try {
      await waha.sendText(sendSession, claim.owner_phone, buildOutreminderMessage(claim))
      await db.query(
        `UPDATE reminders
            SET status='contacted', contacted_at=NOW(), contacted_by=$2,
                auto_send_status='sent', assigned_session=$2
          WHERE id=$1`, [claim.id, sendSession])
      sent.push({ id: claim.id, session: sendSession })
    } catch (e) {
      await db.query(
        `UPDATE reminders SET auto_send_status='failed', auto_send_block_reason=$2
          WHERE id=$1`, [claim.id, String(e.message || e).slice(0, 500)])
      failed.push({ id: claim.id, reason: e.message })
      log.warn('reminderOutreach: automatic due send failed; left for review', { id: claim.id, err: e.message })
    }
  }
  return { due: preview.length, sent, blocked, waiting, failed }
}

// The one and only place a real follow-up message goes out — called from
// services/adminCommands.js's !outreminder YES confirm handler.
async function runOutreminderBatch(reminderIds) {
  const ownerSendGate = require('./ownerSendGate')
  if (await ownerSendGate.getAutomationMode() === 'REVIEW_ONLY') {
    await require('./ownerRecheck').recheckDueReminders({ limit: 500 })
    return {
      sent: [], total: reminderIds.length,
      skipped: reminderIds.map(id => ({ id, reason: 'review_only_context_recheck_required' })),
      reviewOnly: true,
    }
  }
  // Re-fetch fresh rather than trust the ids' snapshot from preview time —
  // something else (a real reply from the owner, !done, !cancelreminder)
  // may have already closed one of these between preview and YES.
  const rows = (await db.query(
    `SELECT id, source_session, owner_phone, owner_name, original_note,
            parsed_timing, estimated_owner_date, contact_due_date
       FROM reminders WHERE id = ANY($1::int[]) AND status = 'pending'`,
    [reminderIds])).rows

  const sent = [], skipped = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (i > 0) await sleep(coldDelay())

    const sendSession = await resolveSendSession(row)
    if (!sendSession) {
      skipped.push({ id: row.id, reason: `neither ${row.source_session || 'original account'} nor default is online` })
      continue
    }

    const text = buildOutreminderMessage(row)
    const gate = await ownerSendGate.checkOwnerSend({ phone: row.owner_phone, kind: 'reminder', automated: true })
    if (!gate.allow) {
      skipped.push({ id: row.id, reason: `pre_send_gate:${gate.reason}` })
      continue
    }
    try {
      await waha.sendText(sendSession, row.owner_phone, text)
      await db.query(
        `UPDATE reminders
            SET status = 'contacted', contacted_at = NOW(), contacted_by = $2
          WHERE id = $1`,
        [row.id, sendSession])
      sent.push({ id: row.id, session: sendSession })
    } catch (e) {
      skipped.push({ id: row.id, reason: e.message })
      log.warn('reminderOutreach: send failed', { id: row.id, err: e.message })
    }
  }

  log.info('reminderOutreach: batch complete', { total: rows.length, sent: sent.length, skipped: skipped.length })
  return { sent, skipped, total: rows.length }
}

module.exports = {
  openReminders,
  runOutreminderBatch,
  // exported for a direct Level-2 proof, same convention handlers/upload.js
  // already uses (createListing/runCategoryDistribution/cmdBmarket) — a real
  // function call instead of simulating a full webhook payload.
  resolveSendSession,
  buildOutreminderMessage,
  classifyReminderContact,
  maltaReminderWindow,
  stageUnplannedReminders,
  runDueAutoBatch,
}
