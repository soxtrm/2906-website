// outreachTracker.js — ghost-detection counter helpers.
//
// On every successful outbound message to an owner:
//   incrementNoReplyForPhone(phone, session)
//     → UPSERTs owner_account_labels and bumps consecutive_no_reply_count.
//     → If no row exists yet, creates one with label='cold', source='outreach'.
//
// On every inbound reply from an owner (webhook):
//   resetNoReplyForPhone(phone, session)
//     → Resets consecutive_no_reply_count = 0 and refreshes last_reply_at.
//
// Both helpers are no-ops when the contact isn't in owner_contacts; the caller
// doesn't have to pre-resolve contact_id.

const db  = require('../db')
const log = require('../logger')

async function _findContactId(phone) {
  if (!phone) return null
  const direct = await db.query(
    'SELECT id FROM owner_contacts WHERE phone_normalized = $1 LIMIT 1',
    [phone]
  )
  if (direct.rows[0]) return direct.rows[0].id
  const suffix = String(phone).slice(-8)
  const fb = await db.query(
    'SELECT id FROM owner_contacts WHERE phone_normalized LIKE $1 LIMIT 1',
    [`%${suffix}`]
  )
  const id = fb.rows[0]?.id || null
  // Was a silent no-op (see module doc comment above) — neither an exact nor
  // an 8-digit-suffix match, and nothing ever recorded that this phone tried.
  // #2906-129 / Michael case, 2026-08-20: this is the kind of miss that let
  // "never_contacted" stand even while the owner was actively replying.
  if (!id) log.warn('outreachTracker: no owner_contacts match for phone (exact + suffix)', { phoneTail: String(phone).slice(-4) })
  return id
}

async function incrementNoReplyForPhone(phone, session) {
  const contactId = await _findContactId(phone)
  if (!contactId || !session) return null
  try {
    await db.query(
      `INSERT INTO owner_account_labels
         (contact_id, account_session, label, source,
          last_outreach_at, last_we_sent_at, total_msgs_out,
          consecutive_no_reply_count, updated_at)
       VALUES ($1, $2, 'cold', 'outreach', NOW(), NOW(), 1, 1, NOW())
       ON CONFLICT (contact_id, account_session) DO UPDATE SET
         last_outreach_at           = NOW(),
         last_we_sent_at            = NOW(),
         total_msgs_out             = owner_account_labels.total_msgs_out + 1,
         consecutive_no_reply_count = owner_account_labels.consecutive_no_reply_count + 1,
         updated_at                 = NOW()`,
      [contactId, session]
    )
    return contactId
  } catch (err) {
    log.warn('incrementNoReplyForPhone failed', { phone: String(phone).slice(-4), session, err: err.message })
    return null
  }
}

async function resetNoReplyForPhone(phone, session) {
  const contactId = await _findContactId(phone)
  if (!contactId || !session) return null
  try {
    await db.query(
      `UPDATE owner_account_labels
       SET consecutive_no_reply_count = 0,
           last_reply_at              = NOW(),
           updated_at                 = NOW()
       WHERE contact_id = $1 AND account_session = $2`,
      [contactId, session]
    )
    return contactId
  } catch (err) {
    log.warn('resetNoReplyForPhone failed', { phone: String(phone).slice(-4), session, err: err.message })
    return null
  }
}

module.exports = { incrementNoReplyForPhone, resetNoReplyForPhone }
