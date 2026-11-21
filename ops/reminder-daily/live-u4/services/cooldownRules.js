'use strict'
const db = require('../db')

const RULES = {
  SAME_ACCOUNT_DAYS:      20,   // same account re-contacts same owner (ONLY cooldown)
  ADMIN_BYPASS:         true    // admin WA accounts bypass all cooldowns
}

function normalizePhone(raw) {
  return String(raw || '').replace(/\+/g, '').replace(/@(?:c\.us|s\.whatsapp\.net|lid)$/i, '').replace(/\s/g, '')
}

async function isAdminAccount(phone) {
  // whatsapp_accounts uses 'phone' column (not phone_normalized)
  const n = normalizePhone(phone)
  const r = await db.query(
    'SELECT 1 FROM whatsapp_accounts WHERE phone = $1 AND is_active = TRUE LIMIT 1',
    [n]
  )
  return r.rows.length > 0
}

async function canContact(contactId, accountId) {
  const accountRes = await db.query('SELECT * FROM whatsapp_accounts WHERE id = $1', [accountId])
  const account = accountRes.rows[0]
  if (!account) return { allowed: false, reason: 'Account not found' }

  const contactRes = await db.query('SELECT * FROM owner_contacts WHERE id = $1', [contactId])
  const contact = contactRes.rows[0]
  if (!contact) return { allowed: false, reason: 'Contact not found' }

  // Admin phones bypass all cooldowns
  if (RULES.ADMIN_BYPASS) {
    const isAdmin = await isAdminAccount(contact.phone_normalized)
    if (isAdmin) return { allowed: true, reason: 'admin_bypass' }
  }

  // Global do-not-contact always blocks (DNC is global across ALL accounts).
  // 2026-10-29: status='do_not_contact' is the form the classifier actually
  // writes (210 owners); the boolean was set on none, so both count as DNC.
  if (contact.do_not_contact === true || String(contact.status || '').toLowerCase() === 'do_not_contact') {
    return { allowed: false, reason: 'dnc' }
  }

  // Same-account 20-day cooldown — the ONLY timing check.
  // No cross-account / cross-persona / kev-group history checks anywhere.
  const cooldownMs = RULES.SAME_ACCOUNT_DAYS * 86400 * 1000

  // outreach_log uses phone (text) + account_used (session_name text)
  const sameRes = await db.query(`
    SELECT MAX(sent_at) AS last_sent FROM outreach_log
    WHERE phone = $1 AND account_used = $2
  `, [contact.phone_normalized, account.session_name])

  const lastSentSame = sameRes.rows[0].last_sent
  if (lastSentSame) {
    const elapsed = Date.now() - new Date(lastSentSame).getTime()
    if (elapsed < cooldownMs) {
      return {
        allowed: false,
        reason: 'same_account_cooldown',
        next_eligible_at: new Date(new Date(lastSentSame).getTime() + cooldownMs)
      }
    }
  }

  return { allowed: true }
}

// Real-WhatsApp cooldown — single-session only: checks the LAST fromMe
// message from the *requesting* session and applies a flat 22-day cooldown.
// Cross-account history checks are no longer performed here — outreach_log
// + canContact() in cooldownRules handle cross-session timing.
async function checkOwnerEligibilityViaWAHA(ownerPhone, requestingSession) {
  const waha = require('../waha')
  const log  = require('../logger')

  const chatId = `${String(ownerPhone || '').replace(/\D/g, '')}@s.whatsapp.net`

  let messages
  try {
    // Eligibility is a fail-closed decision. The strict endpoint preserves
    // the difference between a real empty history and an unavailable lookup.
    messages = await waha.getChatMessagesStrict(requestingSession, chatId, 10)
  } catch (err) {
    log.warn('WAHA check failed', { session: requestingSession, ownerPhone, err: err.message })
    return { eligible: null, unknown: true, reason: 'waha_history_unknown', error: err.message }
  }

  if (!messages || messages.length === 0) {
    return { eligible: true, reason: 'no_chat_history' }
  }

  const lastFromMe = messages.find(m => m && m.fromMe === true)
  if (!lastFromMe) {
    return { eligible: true, reason: 'never_sent_from_this_account' }
  }

  const tsMs = (lastFromMe.timestamp || 0) * 1000
  if (!tsMs) return { eligible: true, reason: 'no_timestamp' }

  const daysAgo = (Date.now() - tsMs) / (1000 * 60 * 60 * 24)
  const COOLDOWN_DAYS = 22

  if (daysAgo < COOLDOWN_DAYS) {
    return { eligible: false, reason: 'wa_cooldown', days_ago: Math.round(daysAgo) }
  }

  return { eligible: true, reason: 'wa_check_passed', days_ago: Math.round(daysAgo) }
}

async function findPreferredKevAccount(contactId) {
  const res = await db.query(`
    SELECT wa.id, wa.session_name,
      COALESCE(cah.total_messages_they_sent, 0) AS replies,
      cah.last_message_they_sent_at AS last_reply
    FROM whatsapp_accounts wa
    LEFT JOIN contact_account_history cah
      ON wa.id = cah.account_id AND cah.contact_id = $1
    WHERE wa.account_persona = 'kev' AND wa.is_active = TRUE
    ORDER BY
      COALESCE(cah.total_messages_they_sent, 0) DESC,
      cah.last_message_they_sent_at DESC NULLS LAST
    LIMIT 1
  `, [contactId])
  return res.rows[0] || null
}

module.exports = { canContact, isAdminAccount, findPreferredKevAccount, checkOwnerEligibilityViaWAHA, normalizePhone, RULES }
