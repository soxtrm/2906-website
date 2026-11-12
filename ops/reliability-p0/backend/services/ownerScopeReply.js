'use strict'
// ============================================================================
// services/ownerScopeReply.js — owner-wide availability statements (P0, 2026-11-12)
//
// Incident: on 2026-11-11 an owner with two active listings answered an
// availability question with "Nothing available". The multi-unit guard asked
// "which one do you mean, #A or #B?", left the open check 'awaiting', and the
// queued next-morning follow-up went out the day after.
//
// "Nothing available", "all rented", "I have nothing" are not ambiguous: they
// are about EVERYTHING this owner currently offers. This module
//   1. recognises such a statement (pure function, no I/O),
//   2. applies it in ONE transaction: every on-market listing of the owner
//      becomes 'not_available' and unpublished (never 'rented' — the owner did
//      not say rented), every open availability check of the owner is closed,
//      pending owner reminders are blocked, and the owner is paused for
//      availability questions,
//   3. removes already-queued follow-ups / delayed sends for that owner.
// It is idempotent per inbound message id. Listing history is kept.
// Only a new explicit availability statement or a staff decision lifts the pause.
// ============================================================================

const db = require('../db')
const log = require('../logger')

const PAUSE_MARKER = 'OWNER_SAID_NOTHING_AVAILABLE'
const PAUSE_DAYS = 180
const ON_MARKET = ['available', 'available_confirmed', 'upcoming', 'soon_available', 'pending_check']

// The phrase itself. Each pattern is a statement about the whole offer.
const ALL_UNAVAILABLE = [
  /\bnothing\s+(?:is\s+|else\s+)?(?:available|free|vacant|left|for\s+rent|to\s+rent)\b/i,
  /\b(?:have|got|don'?t\s+have|do\s+not\s+have|haven'?t\s+got)\s+(?:nothing|anything)(?:\s+(?:available|free|vacant|left|for\s+rent|to\s+rent|at\s+the\s+moment|right\s+now|atm))?\b/i,
  /\b(?:all|everything|both|all\s+of\s+them|all\s+(?:my\s+)?(?:apartments?|flats?|propert(?:y|ies)|units?|places?))\s+(?:(?:is|are|were|got|been|already|now|currently|'s|'re)\s+)*(?:rented|taken|let(?:\s+out)?|leased|gone|occupied|full|booked)\b/i,
  /\bnone\s+(?:of\s+(?:them|these|those|my\s+\w+)\s+)?(?:(?:is|are)\s+)?(?:available|free|vacant|left)\b/i,
  /\bno\s+(?:apartments?|flats?|propert(?:y|ies)|units?|places?|rooms?)\s+(?:(?:is|are)\s+)?(?:available|free|vacant|left)\b/i,
  /\bfully\s+(?:rented|booked|occupied|let)\b/i,
]
// Anything after the phrase that narrows it makes it property-specific or dated:
// "nothing available until February", "all rented except number 3".
const NARROWING = /\b(?:only|except|apart\s+from|other\s+than|but|however|until|till|from|before|after|next\s+(?:week|month|year)|in\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|number\s+\w+|no\.?\s*\d+)\b|#?\b\d{3,}\b|€/i
// A new offer: lifts the pause, never re-lists anything by itself.
const NEW_AVAILABILITY = /\b(?:(?:i\s+)?(?:have|got)\s+(?:a|an|one|two|three|\d+|another|something|some)\b[^.?!]{0,60}\b(?:available|free|vacant|for\s+rent|to\s+rent)|(?:is|are)\s+available\s+(?:again|now)|available\s+again|back\s+on\s+the\s+market|new\s+(?:apartment|flat|property|listing|place)\b)/i

function classifyOwnerScope(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim()
  if (!raw || raw.length > 400) return { scope: null }
  for (const re of ALL_UNAVAILABLE) {
    const m = re.exec(raw)
    if (!m) continue
    // the sentence that carries the phrase must not be a question
    const end = m.index + m[0].length
    const stop = raw.slice(end).search(/[.!?\n]/)
    const sentenceEnd = stop < 0 ? raw.length : end + stop
    if (raw[sentenceEnd] === '?') continue
    const rest = raw.slice(end, sentenceEnd)
    if (NARROWING.test(rest)) continue
    // "not sure if nothing available" style hedges
    if (/\b(?:not\s+sure|maybe|perhaps|i\s+think|might)\b/i.test(raw.slice(Math.max(0, m.index - 30), m.index))) continue
    return { scope: 'owner_all_unavailable', phrase: m[0] }
  }
  return { scope: null }
}

function isNewAvailabilityStatement(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim()
  if (!raw || /\?\s*$/.test(raw)) return false
  if (classifyOwnerScope(raw).scope) return false
  if (/\b(?:not|no\s+longer|isn'?t|aren'?t)\s+(?:available|free)\b/i.test(raw)) return false
  return NEW_AVAILABILITY.test(raw)
}

const digits = v => String(v || '').replace(/\D/g, '')

async function findOwner(phones) {
  const list = [...new Set(phones.map(digits).filter(d => d.length >= 8))]
  if (!list.length) return null
  const r = await db.query(
    `SELECT id, phone_normalized, owner_contact_paused_until, owner_contact_pause_note, do_not_contact
       FROM owner_contacts
      WHERE regexp_replace(COALESCE(phone_normalized,''), '\\D', '', 'g') = ANY($1::text[])
      ORDER BY id LIMIT 2`, [list])
  return r.rows.length === 1 ? r.rows[0] : null     // two contacts with one number: do not guess
}

// Applies an owner-wide "nothing available". Returns { handled, ... }.
// deps is for tests only (queue invalidation, acknowledgement, admin alert).
async function applyOwnerWideUnavailable({ ownerId, text, session = null, chatId = null, messageId = null, deps = {} } = {}) {
  if (!ownerId) return { handled: false, reason: 'no_owner' }
  const said = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300)
  const msgKey = messageId ? String(messageId).slice(0, 180) : null
  const client = await db.connect()
  let changed = [], closedChecks = [], blockedReminders = 0, already = false, phone = null
  try {
    await client.query('BEGIN')
    const o = (await client.query(
      `SELECT id, phone_normalized, owner_contact_pause_note FROM owner_contacts WHERE id = $1 FOR UPDATE`, [ownerId])).rows[0]
    if (!o) { await client.query('ROLLBACK'); return { handled: false, reason: 'no_owner' } }
    phone = o.phone_normalized
    // idempotent: the same inbound message is applied once
    if (msgKey && String(o.owner_contact_pause_note || '').includes(`msg:${msgKey}`)) already = true

    if (!already) {
      const props = (await client.query(
        `UPDATE properties p
            SET available_status = 'not_available', published = FALSE,
                status_change_reason = $2, updated_at = NOW()
           FROM (SELECT id, available_status AS old_status, published AS old_published
                   FROM properties WHERE owner_id = $1 AND COALESCE(available_status, 'available') = ANY($3::text[])
                    FOR UPDATE) prev
          WHERE p.id = prev.id
        RETURNING p.id, p.ref, prev.old_status, prev.old_published`,
        [ownerId, `Owner said nothing is available: "${said.slice(0, 160)}"`, ON_MARKET])).rows
      changed = props
      for (const p of props) {
        await client.query(
          `INSERT INTO property_activities (property_id, activity_type, details, is_significant, created_at)
           VALUES ($1, 'owner_all_unavailable', $2::jsonb, TRUE, NOW())`,
          [p.id, JSON.stringify({
            changed_by: 'owner_reply', scope: 'owner', owner_id: ownerId, owner_reply: said,
            old_status: p.old_status, new_status: 'not_available', was_published: p.old_published,
            source_message_id: msgKey, account_session: session,
          })])
      }
      closedChecks = (await client.query(
        `UPDATE availability_checks
            SET status = CASE WHEN status = 'awaiting' THEN 'replied_no' ELSE 'cancelled' END,
                reply_at = COALESCE(reply_at, NOW()), reply_text = COALESCE(reply_text, $2),
                reply_message_id = COALESCE(reply_message_id, $3), needs_review = FALSE, updated_at = NOW()
          WHERE owner_id = $1 AND status IN ('awaiting', 'queued', 'sending', 'waiting_for_source_session', 'send_failed')
        RETURNING id`, [ownerId, said, msgKey])).rows.map(r => Number(r.id))
      blockedReminders = (await client.query(
        `UPDATE reminders
            SET auto_send_enabled = FALSE, auto_send_status = 'blocked',
                auto_send_block_reason = $2
          WHERE status = 'pending'
            AND regexp_replace(COALESCE(owner_phone,''), '\\D', '', 'g') = $1
            AND COALESCE(auto_send_status, 'unplanned') NOT IN ('sent', 'blocked')`,
        [digits(phone), `${PAUSE_MARKER}: owner said nothing is available`])).rowCount
      await client.query(
        `UPDATE owner_contacts
            SET owner_contact_paused_until = (CURRENT_DATE + $2::int),
                owner_contact_pause_note = $3, owner_contact_paused_by = 'owner_reply', owner_contact_paused_at = NOW()
          WHERE id = $1`,
        [ownerId, PAUSE_DAYS, `${PAUSE_MARKER}${msgKey ? ` msg:${msgKey}` : ''} — "${said.slice(0, 200)}"`.slice(0, 500)])
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    log.error('[ownerScope] owner-wide unavailable failed — nothing was changed', { ownerId, err: err.message })
    throw err
  } finally {
    client.release()
  }
  if (already) {
    log.info('[ownerScope] owner-wide statement already applied for this message', { ownerId })
    return { handled: true, already: true, properties: [], closedChecks: [] }
  }

  // Outside the transaction: queued jobs live in Redis, not Postgres.
  let removedJobs = 0
  try {
    const invalidate = deps.invalidateQueuedForOwner || require('./ownerSendGate').invalidateQueuedForOwner
    removedJobs = await invalidate({ phone, chatIds: chatId ? [chatId] : [] })
  } catch (err) { log.warn('[ownerScope] queue invalidation failed', { ownerId, err: err.message }) }

  log.info('[ownerScope] owner said nothing is available — applied owner-wide', {
    ownerId, properties: changed.map(p => p.ref || p.id), closedChecks, blockedReminders, removedJobs,
  })
  try {
    const alert = deps.alertAdmin || (t => require('../telegram').sendAlert(t))
    await alert(`Owner #${ownerId} said nothing is available. ${changed.length} listing(s) set to not available and unpublished (${changed.map(p => '#' + (p.ref || p.id)).join(', ') || 'none on market'}); ${closedChecks.length} open check(s) closed; availability questions paused. Nothing was marked rented.`)
  } catch (err) { log.warn('[ownerScope] admin alert failed', { ownerId, err: err.message }) }
  return { handled: true, already: false, properties: changed, closedChecks, blockedReminders, removedJobs }
}

// Entry point for the inbound owner-DM pipeline. Cheap when the text is not a
// global statement: one regex pass, no query.
async function maybeHandleInbound({ text, phones = [], session = null, chatId = null, messageId = null, deps = {} } = {}) {
  const verdict = classifyOwnerScope(text)
  if (verdict.scope !== 'owner_all_unavailable') {
    if (!isNewAvailabilityStatement(text)) return { handled: false }
    const owner = await findOwner(phones)
    if (!owner || !String(owner.owner_contact_pause_note || '').startsWith(PAUSE_MARKER)) return { handled: false }
    await db.query(
      `UPDATE owner_contacts SET owner_contact_paused_until = NULL, owner_contact_pause_note = NULL,
              owner_contact_paused_by = 'owner_reply', owner_contact_paused_at = NOW() WHERE id = $1`, [owner.id])
    log.info('[ownerScope] owner reported new availability — pause lifted, listings unchanged', { ownerId: owner.id })
    return { handled: false, pauseLifted: true, ownerId: owner.id }   // the normal pipeline still reads the message
  }
  const owner = await findOwner(phones)
  if (!owner) return { handled: false, reason: 'owner_not_unique' }
  const res = await applyOwnerWideUnavailable({ ownerId: owner.id, text, session, chatId, messageId, deps })
  return { ...res, ownerId: owner.id, scope: verdict.scope }
}

module.exports = {
  classifyOwnerScope, isNewAvailabilityStatement, applyOwnerWideUnavailable, maybeHandleInbound, findOwner,
  PAUSE_MARKER, PAUSE_DAYS, ON_MARKET,
}
