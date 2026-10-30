'use strict'
// ============================================================================
// services/reminderFromMessage.js — wire the reminderDetector into the message
// pipeline so that owner DMs containing phrases like "in September I should
// have" automatically create a reminders row.
//
// This is the bridge between services/reminderDetector.js (pure) and the
// live message-handling path. It is deliberately fire-and-forget — the
// caller awaits it but a failure here must NOT abort the inbound webhook.
//
// Pipeline:
//   owner DM  →  reminderFromMessage.captureFromReply(phone, text, ctx)
//              ↓
//   reminderDetector.detectReminderPhrase(text)
//              ↓
//   INSERT INTO reminders (...) — live schema columns only.
// ============================================================================

const db = require('../db')
const log = require('../logger')
const detector = require('./reminderDetector')

const OWNER_FALLBACK_DAYS = 7

function adjustFarFutureDueDate(dueAt, ctx = {}, now = new Date()) {
  const leadDays = Number(ctx.farFutureLeadDays || 0)
  const thresholdDays = Number(ctx.farFutureThresholdDays || 0)
  if (!leadDays || !thresholdDays || !/^\d{4}-\d{2}-\d{2}$/.test(String(dueAt || ''))) return dueAt
  const target = new Date(`${dueAt}T12:00:00.000Z`)
  if (!Number.isFinite(target.getTime())) return dueAt
  const daysOut = (target.getTime() - now.getTime()) / 86_400_000
  if (daysOut < thresholdDays) return dueAt
  target.setUTCDate(target.getUTCDate() - leadDays)
  return target.toISOString().slice(0, 10)
}

function inferOwnerName(ctx) {
  if (ctx && typeof ctx.ownerName === 'string' && ctx.ownerName.trim()) return ctx.ownerName.trim()
  if (ctx && ctx.contact && ctx.contact.name) return ctx.contact.name.trim()
  return null
}

function inferSourceMessageId(ctx) {
  if (ctx && typeof ctx.messageId === 'string') return ctx.messageId
  if (ctx && typeof ctx.id === 'string') return ctx.id
  return null
}

// Best-effort insert. Returns the new row id, or null when nothing matched.
async function captureFromReply(phone, text, ctx = {}) {
  const phoneNorm = String(phone || '').replace(/\D+/g, '')
  if (!phoneNorm) return null
  const internal = await db.query(
    `SELECT 1 FROM agents a
      WHERE a.active IS DISTINCT FROM FALSE AND (
        regexp_replace(COALESCE(a.whatsapp_phone,''), '\\D', '', 'g') = $1 OR
        regexp_replace(COALESCE(a.public_phone,''), '\\D', '', 'g') = $1 OR
        EXISTS (SELECT 1 FROM unnest(COALESCE(a.whatsapp_phones, ARRAY[]::text[])) p
                 WHERE regexp_replace(p, '\\D', '', 'g') = $1)
      ) LIMIT 1`, [phoneNorm])
  if (internal.rows.length) return null
  const body = String(text || '').trim()
  if (!body) return null

  let hit
  try {
    hit = detector.detectReminderPhrase(body, { now: ctx.now || new Date() })
  } catch (e) {
    log.warn('reminderFromMessage: detector crashed', { err: e.message })
    return null
  }
  if (!hit) return null

  // 7-day fallback when the phrase has no embedded date.
  let dueAt = hit.dueAt
  if (!dueAt) {
    const d = new Date()
    d.setUTCDate(d.getUTCDate() + OWNER_FALLBACK_DAYS)
    dueAt = d.toISOString().slice(0, 10)
  }
  const detectedDueAt = dueAt
  dueAt = adjustFarFutureDueDate(dueAt, ctx)

  const ownerName = inferOwnerName(ctx)
  const sourceMessageId = inferSourceMessageId(ctx)
  const parsedTiming = hit.phrase || 'phrase'

  try {
    // The normal inbound pipeline may already have created a reminder for the
    // raw market date before the debounced owner interview applies its
    // far-future policy. Move that pending reminder to the 90-day lead point
    // instead of leaving two reminders for the same owner statement.
    if (dueAt !== detectedDueAt) {
      const prior = await db.query(
        `SELECT id FROM reminders
          WHERE owner_phone = $1
            AND status = 'pending'
            AND original_note ILIKE $2
          ORDER BY created_at DESC
          LIMIT 1`,
        [phoneNorm, body.slice(0, 40) + '%'])
      if (prior.rows.length) {
        await db.query(
          `UPDATE reminders
              SET contact_due_date = $2, parsed_timing = $3
            WHERE id = $1`,
          [prior.rows[0].id, dueAt, parsedTiming])
        log.info('reminderFromMessage: moved far-future reminder to lead date', {
          id: prior.rows[0].id,
          phone: phoneNorm.slice(-4),
          dueAt,
        })
        return prior.rows[0].id
      }
    }

    // Avoid duplicates: the same source message (webhook redelivery, chat
    // re-sync) never creates a second row; otherwise same phone + due date +
    // note start, as before.
    const dupe = await db.query(
      `SELECT id FROM reminders
        WHERE owner_phone = $1
          AND (($4::text IS NOT NULL AND source_message_id = $4)
               OR (contact_due_date = $2 AND original_note ILIKE $3))
        LIMIT 1`,
      [phoneNorm, dueAt, body.slice(0, 40) + '%', sourceMessageId])
    if (dupe.rows.length) {
      log.debug('reminderFromMessage: dedup hit, skipping insert', { id: dupe.rows[0].id })
      return null
    }
    // Context (Kev, 2026-10-30, migration 20261030_reminder_context): how
    // precise the owner was, the window, why, what they said about
    // availability and — when the owner has exactly one listing — which
    // property. Never more certain than the owner was.
    const propertyId = ctx.propertyId || await singlePropertyFor(phoneNorm)
    const ins = await db.query(
      `INSERT INTO reminders
         (source_session, source_phone, source_message_id,
          owner_phone, owner_name, original_note, parsed_timing,
          contact_due_date, status,
          due_precision, due_window_end, property_id, reason, availability_state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10, $11, $12, $13)
       RETURNING id`,
      [ctx.session || 'default',
       phoneNorm,
       sourceMessageId,
       phoneNorm,
       ownerName,
       body,
       parsedTiming,
       dueAt,
       hit.dueAt ? (hit.precision || 'day') : 'fallback_7_days',
       hit.windowEnd || null,
       propertyId,
       `Owner said: "${String(hit.phrase || '').slice(0, 80)}"`,
       hit.availability || 'unknown'])
    const id = ins.rows[0].id
    log.info('reminderFromMessage: created', { id, phone: phoneNorm.slice(-4), dueAt, phrase: parsedTiming })
    // OG-4 (Kev, 2026-09-04): "bei Reminder ... nach Outreach" -- one of the
    // three Karteikarte creation triggers. Fire-and-forget, never blocks the
    // actual reminder insert above.
    ;(async () => {
      const oc = await db.query(`SELECT id FROM owner_contacts WHERE phone_normalized = $1 LIMIT 1`, [phoneNorm])
      if (!oc.rows.length) return
      await require('./ownerPreferenceProfile').maybeCreateFromReminderOrPositiveReply(
        oc.rows[0].id, body, `reminder created: ${parsedTiming}`)
    })().catch(err => log.warn('ownerPreferenceProfile hook (reminder) failed', { err: err.message }))
    return id
  } catch (e) {
    log.warn('reminderFromMessage: insert failed', { err: e.message, phone: phoneNorm.slice(-4) })
    return null
  }
}

// The owner's listing when there is exactly one; several → null (an agent
// links it), so a reminder is never attached to the wrong unit.
async function singlePropertyFor(phoneNorm) {
  try {
    const r = await db.query(
      `SELECT p.id FROM properties p JOIN owner_contacts oc ON oc.id = p.owner_id
        WHERE right(regexp_replace(COALESCE(oc.phone_normalized,''), '\\D', '', 'g'), 8) = right($1, 8)
        LIMIT 2`, [phoneNorm])
    return r.rows.length === 1 ? r.rows[0].id : null
  } catch (_) { return null }
}

module.exports = { captureFromReply, adjustFarFutureDueDate }
