'use strict'
// ============================================================================
// services/ownerAsk.js — the daily-question cap, shared.
//
// Was a private helper inside routes/crmScheduleBoard.js (the Board's own
// /ask/preview + /ask/send). Pulled out so the NEW !ask WhatsApp command
// (handlers/ask.js) counts against the exact same limit, off the exact same
// query, instead of a second copy that could quietly drift from this one —
// the Board route now imports this file too. Nothing about the limit itself
// changed: still 2 questions per agent per property per Malta day.
// ============================================================================
const db = require('../db')

const QUESTIONS_PER_DAY = 2

async function questionsUsedFor(agentId, propertyId) {
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM owner_contact_log
      WHERE agent_id = $1 AND property_id = $2 AND kind = 'question'
        AND status IN ('sent', 'queued')
        AND malta_day = (now() AT TIME ZONE 'Europe/Malta')::date`, [agentId, propertyId])
  return r.rows[0].n
}

// Owner phone + do-not-contact, read server-side only. The phone is used to
// address the message and to key the log; it is never put on a response.
async function ownerFor(propertyId) {
  const r = await db.query(
    `SELECT oc.id, oc.phone_normalized, oc.name, oc.do_not_contact, oc.do_not_contact_reason
       FROM properties p JOIN owner_contacts oc ON oc.id = p.owner_id
      WHERE p.id = $1`, [propertyId])
  return r.rows[0] || null
}

// A lot of owner_contacts rows carry an import code instead of a name
// ("CP00006025 NA", "NA NA"). Showing that as the recipient looks broken, and
// feeding it to the model risks it being greeted by it. Anything without two
// consecutive lowercase letters is treated as not-a-name.
function humanName(raw) {
  const s = String(raw || '').trim()
  if (!s || !/[a-z]{2}/.test(s)) return null
  if (/^(na|n\/a|unknown|owner)$/i.test(s)) return null
  return s
}

// Has this owner been written to before on any listing? A greeting is about
// the human conversation, not one property reference. owner_account_labels
// is the durable source of WhatsApp/outreach history (including manual chat
// sync); owner_contact_log covers Board/!ask sends even if label sync lagged.
async function isReachout(ownerPhone, _propertyId) {
  if (!ownerPhone) return false
  const r = await db.query(
    `SELECT 1
       FROM owner_contacts oc
      WHERE oc.phone_normalized = $1
        AND (
          EXISTS (
            SELECT 1 FROM owner_contact_log l
             WHERE l.owner_phone = $1 AND l.status = 'sent'
          )
          OR EXISTS (
            SELECT 1 FROM owner_account_labels oal
             WHERE oal.contact_id = oc.id
               AND (oal.source = 'first_contact'
                    OR oal.last_outreach_at IS NOT NULL
                    OR oal.last_reply_at IS NOT NULL
                    OR oal.last_we_sent_at IS NOT NULL
                    OR COALESCE(oal.total_msgs_in, 0) > 0
                    OR COALESCE(oal.total_msgs_out, 0) > 0)
          )
        )
      LIMIT 1`,
    [ownerPhone])
  return r.rowCount > 0
}

// Who is texting, for the !ask / !book WhatsApp commands. handlers/
// uploadListing.js's own resolveAgent() only matches whatsapp_phones — the
// numbers Kev's OWN WAHA sessions run on — so it never finds a board-only
// agent (Vitaliy, Katya, ...), who has a notify_whatsapp number but no
// session of their own. Mirrors services/dashboardReport.js's
// loadAgentByPhone (last-8-digits, notify_whatsapp OR whatsapp_phones) —
// same matching rule, not a second one; that function isn't exported, so
// this is the one both !ask and the !book fix call.
async function resolveAgentByPhone(phone) {
  const digits = String(phone || '').replace(/[^0-9]/g, '')
  if (digits.length < 6) return null
  const tail = digits.slice(-8)
  const r = await db.query(
    `SELECT id, username, name, display_name, notify_whatsapp, whatsapp_phones
       FROM agents
      WHERE active = TRUE
        AND (RIGHT(REGEXP_REPLACE(COALESCE(notify_whatsapp,''), '[^0-9]', '', 'g'), 8) = $1
             OR EXISTS (SELECT 1 FROM unnest(whatsapp_phones) p
                         WHERE RIGHT(REGEXP_REPLACE(p, '[^0-9]', '', 'g'), 8) = $1))
      LIMIT 1`, [tail])
  return r.rows[0] || null
}

module.exports = { QUESTIONS_PER_DAY, questionsUsedFor, ownerFor, humanName, isReachout, resolveAgentByPhone }
