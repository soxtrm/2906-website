'use strict'
// ============================================================================
// services/outreachEligibility.js — last eligibility check against CURRENT
// data, immediately before each outreach message (Kev, 2026-10-29).
//
// Plans are prepared hours or days ahead. Between preparation and the send
// an owner can reply, opt out, be blocked, be paused, become unreachable or
// be contacted from another account. This gate re-reads the canonical tables
// at the instant of sending and returns the first reason that forbids it.
//
// Found while building this (2026-10-29, production counts): 210 owners carry
// status='do_not_contact' (reasons "No thanks", "All rented", …) but the
// do_not_contact BOOLEAN is set on 0 rows, and both the pool query and
// cooldownRules.canContact only looked at the boolean. 57 of those owners
// were messaged by outreach in the last 30 days. Both forms are DNC now.
// A WhatsApp opt-out is never read as permission for another channel.
// ============================================================================
const db = require('../db')

const normPhone = p => String(p || '').replace(/\D/g, '')
const DEFAULT_CROSS_ACCOUNT_DAYS = 20

async function setting(key, fallback) {
  try {
    const r = await db.query(`SELECT value FROM outreach_settings WHERE key = $1`, [key])
    return r.rows.length ? r.rows[0].value : fallback
  } catch (_) { return fallback }
}

function isDnc(contact) {
  return contact?.do_not_contact === true || String(contact?.status || '').toLowerCase() === 'do_not_contact'
}

async function checkBeforeSend({ phone, accountId, session, now = new Date(), force = false }) {
  const p = normPhone(phone)
  if (!p) return { allowed: false, reason: 'invalid_phone' }

  const contact = (await db.query(
    `SELECT id, status, do_not_contact, owner_contact_paused_until, last_reply_at
       FROM owner_contacts WHERE phone_normalized = $1 LIMIT 1`, [p])).rows[0] || null

  // Opt-out/DNC and blocks hold even for force mode: force only skips timing.
  if (isDnc(contact)) return { allowed: false, reason: 'dnc', contactId: contact.id }
  const block = (await db.query(
    `SELECT reason FROM owner_automation_blocks WHERE phone_normalized = $1 AND active = TRUE LIMIT 1`, [p])).rows[0]
  if (block) return { allowed: false, reason: 'automation_block', detail: block.reason }
  if (contact) {
    const label = (await db.query(
      `SELECT label FROM owner_account_labels WHERE contact_id = $1 AND label IN ('dnc','angry') LIMIT 1`, [contact.id])).rows[0]
    if (label) return { allowed: false, reason: `label_${label.label}`, contactId: contact.id }
  }
  if (force) return { allowed: true, reason: 'force', contactId: contact?.id || null }

  if (contact?.owner_contact_paused_until && new Date(contact.owner_contact_paused_until) > now) {
    return { allowed: false, reason: 'owner_paused', contactId: contact.id }
  }
  const unreachable = (await db.query(
    `SELECT reason FROM outreach_unreachable
      WHERE phone = $1 AND reason IN ('not_registered','no_lid') AND last_seen_at > $2::timestamptz - INTERVAL '90 days' LIMIT 1`,
    [p, now.toISOString()])).rows[0]
  if (unreachable) return { allowed: false, reason: 'unreachable', detail: unreachable.reason }

  // One person, one recent approach — across ALL accounts. Stale or duplicate
  // records must not let a second account write to the same owner.
  const days = Number(await setting('dispatch.cross_account_days', DEFAULT_CROSS_ACCOUNT_DAYS)) || DEFAULT_CROSS_ACCOUNT_DAYS
  const recent = (await db.query(
    `SELECT account_used, sent_at FROM outreach_log
      WHERE phone = $1 AND sent_at IS NOT NULL AND sent_at > $2::timestamptz - make_interval(days => $3)
      ORDER BY sent_at DESC LIMIT 1`, [p, now.toISOString(), days])).rows[0]
  if (recent) {
    const same = String(recent.account_used || '').toLowerCase() === String(session || '').toLowerCase()
    return { allowed: false, reason: same ? 'same_account_recent' : 'contacted_by_other_account', detail: recent.account_used }
  }
  // Spec 11: after N unanswered attempts automation stops; the owner moves to
  // the manual "Call Candidates" list (services/outreachEngagement.js).
  if (await require('./outreachEngagement').reachedNoReplyLimit(p)) {
    return { allowed: false, reason: 'no_reply_limit_reached', contactId: contact?.id || null }
  }
  if (contact?.last_reply_at && new Date(contact.last_reply_at) > new Date(now.getTime() - 30 * 86400000)) {
    return { allowed: false, reason: 'in_live_conversation', contactId: contact.id }
  }
  return { allowed: true, contactId: contact?.id || null }
}

module.exports = { checkBeforeSend, isDnc, setting, DEFAULT_CROSS_ACCOUNT_DAYS }
