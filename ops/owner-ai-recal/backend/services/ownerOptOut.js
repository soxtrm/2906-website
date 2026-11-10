'use strict'
// ============================================================================
// services/ownerOptOut.js — one detector for "stop contacting me", and the one
// place that turns it into a do-not-contact record (Kev, 2026-10-31).
//
// Evidence (production, 2026-10-30): an owner wrote "I already told you to
// remove me from your list. You are breaking data protection law." and was
// contacted again from another account. The two existing detectors
// (ownerSendGate.EXPLICIT_OPT_OUT_RES, conversationPolicy.OPT_OUT_RE) only knew
// "don't contact me" / a bare "remove me"; neither recognised "remove me from
// your list", "remove my number from your database" or a data-protection
// complaint. The complaint path set an automation block but never the
// do-not-contact flag, so the owner stayed an ordinary contact. Of 65 owners
// with such blocks, 11 had explicitly asked to stop (fixed in production
// 2026-10-31, backup ops_backup_owner_dnc_20261031).
//
// Kev: "bitte solche dinge immer von der datenbank entfernen". The owner row is
// KEPT as a suppression record (do_not_contact + status + reason): deleting it
// would let the next owner-list import bring the number back as contactable.
// ============================================================================

const crypto = require('crypto')
const log = require('../logger')

const OPT_OUT_RES = [
  /\b(?:please\s+)?remove\s+(?:me|my\s+(?:number|details|contact|data|phone)|mine|this\s+number)\b[^.?!\n]{0,40}\b(?:list|lists|database|records?|contacts?|system|data\s*base)\b/i,
  /\b(?:take|delete|erase)\s+(?:me|my\s+(?:number|details|contact|data))\s+(?:off|from|out\s+of)\b/i,
  /\b(?:already\s+)?(?:told|asked)\s+you\s+(?:to\s+)?(?:remove|delete|stop|not\s+to\s+(?:contact|message|text))/i,
  /\bstop\s+(?:contacting|messaging|texting|writing\s+to|sending\s+(?:me\s+)?(?:messages|these))\s*(?:me)?\b/i,
  /\bplease\s+stop\s+(?:it|the\s+bot|the\s+system|this)\s+from\s+(?:contacting|messaging|texting|writing\s+to)\s+me\b/i,
  /\b(?:do\s*not|don'?t|never)\s+(?:ever\s+)?(?:contact|message|text|write\s+to|call)\s+me\b/i,
  /\bturn\s+(?:your|the|this)\s+(?:bot|automation|system)\s+off\b/i,
  /\b(?:data\s+protection|gdpr|privacy\s+law|breach\s+of\s+(?:my\s+)?privacy|report\s+you\s+to\s+the\s+(?:idpc|authorit(?:y|ies)|police))\b/i,
  /^\s*(?:stop|unsubscribe|remove\s+me|opt\s*out)\s*[.!?]*\s*$/i,
  /\bunsubscribe\b|\bopt\s*out\b/i,
]

// "How did you get my number?" — a privacy question, not an opt-out. It must
// reach a human (and never get a property question back, as on 2026-09-22).
const DATA_SOURCE_RES = [
  /\b(?:how|where)\s+did\s+you\s+get\s+(?:my|this)\s+(?:number|contact|details|phone)\b/i,
  /\bwho\s+gave\s+you\s+my\s+(?:number|contact|details)\b/i,
  /\bdid\s+i\s+give\s+you\s+my\s+number\b/i,
]

function isOptOut(text) {
  const s = String(text || '').trim()
  return !!s && OPT_OUT_RES.some(re => re.test(s))
}

function isDataSourceQuestion(text) {
  const s = String(text || '').trim()
  return !!s && DATA_SOURCE_RES.some(re => re.test(s))
}

function normalizeIdentity(phone) {
  const digits = String(phone || '').replace(/\D/g, '')
  return digits.length >= 8 && digits.length <= 13 ? digits : null
}

function identityHash(phone) {
  const p = normalizeIdentity(phone)
  return p ? crypto.createHash('sha256').update(`whatsapp_phone:${p}`).digest('hex') : null
}

function requestTypeFor(reason = '') {
  const value = String(reason).toLowerCase()
  if (/delete|erase|remove.*(?:database|data|record)|gdpr|data protection|privacy/.test(value)) return 'ERASURE'
  if (/complain|inappropriate|unsolicited|report/.test(value)) return 'PRIVACY_COMPLAINT'
  return 'STOP_CONTACT'
}

async function isGloballySuppressed(phone, client = require('../db')) {
  const hash = identityHash(phone)
  if (!hash) return false
  const r = await client.query(
    `SELECT 1 FROM global_contact_suppressions WHERE identity_hash=$1 AND active=TRUE LIMIT 1`, [hash])
  return !!r.rows.length
}

// Suppression record for every owner_contacts row with this number (last 8
// digits, like the rest of the owner matching). Idempotent; never deletes.
async function markDoNotContact(phone, reason, client = require('../db'), meta = {}) {
  const p = normalizeIdentity(phone)
  const hash = identityHash(p)
  if (!p || !hash) return { updated: 0, suppressed: false }
  const requestedAt = meta.requestedAt ? new Date(meta.requestedAt) : new Date()
  const source = String(meta.source || 'owner_message').slice(0, 80)
  const sourceMessageId = meta.sourceMessageId ? String(meta.sourceMessageId).slice(0, 180) : null
  const cleanReason = String(reason || 'Owner asked to stop contact').replace(/\s+/g, ' ').slice(0, 300)

  await client.query(
    `INSERT INTO global_contact_suppressions
       (identity_hash,reason_code,source,source_message_id,first_requested_at,last_requested_at,active,updated_at)
     VALUES($1,$2,$3,$4,$5,$5,TRUE,NOW())
     ON CONFLICT(identity_hash) DO UPDATE SET
       reason_code=EXCLUDED.reason_code,source=EXCLUDED.source,
       source_message_id=COALESCE(EXCLUDED.source_message_id,global_contact_suppressions.source_message_id),
       last_requested_at=GREATEST(global_contact_suppressions.last_requested_at,EXCLUDED.last_requested_at),
       active=TRUE,resolved_by=NULL,resolved_at=NULL,resolution_note=NULL,updated_at=NOW()`,
    [hash, requestTypeFor(cleanReason), source, sourceMessageId, requestedAt])
  const r = await client.query(
    `UPDATE owner_contacts
        SET do_not_contact = TRUE, status = 'do_not_contact',
            do_not_contact_reason = COALESCE(NULLIF(do_not_contact_reason, ''), $2),
            do_not_contact_at = COALESCE(do_not_contact_at, NOW()), updated_at = NOW()
      WHERE right(regexp_replace(COALESCE(phone_normalized,''), '\\D', '', 'g'), 8) = right($1, 8)
        AND (do_not_contact IS DISTINCT FROM TRUE OR COALESCE(status,'') <> 'do_not_contact')
      RETURNING id`, [p, cleanReason])

  const ownerIds = r.rows.map(x => x.id)
  const allOwners = await client.query(
    `SELECT id FROM owner_contacts
      WHERE right(regexp_replace(COALESCE(phone_normalized,''), '\\D', '', 'g'), 8)=right($1,8)`, [p])
  for (const owner of allOwners.rows) {
    await client.query(
      `INSERT INTO owner_privacy_requests
         (identity_hash,owner_id,request_type,status,source,source_message_id,evidence_excerpt,requested_at)
       VALUES($1,$2,$3,'PENDING_REVIEW',$4,$5,$6,$7)
       ON CONFLICT DO NOTHING`,
      [hash, owner.id, requestTypeFor(cleanReason), source, sourceMessageId, cleanReason, requestedAt])
  }

  // Make prepared plans non-sendable immediately. A running worker performs
  // another global suppression check before WAHA dispatch, so this update is
  // both agent-visible and race-safe.
  await client.query(
    `UPDATE outreach_plan_entries
        SET eligibility_status='skip',skip_reason='global_suppression',updated_at=NOW()
      WHERE send_status='pending'
        AND right(regexp_replace(COALESCE(normalized_phone,''), '\\D', '', 'g'),8)=right($1,8)`, [p])
    .catch(err => log.warn('ownerOptOut: pending plan cancellation failed', { err: err.message }))

  await client.query(
    `UPDATE owner_auto_conversations
        SET automation_disabled=TRUE,status='human_review_required',pending_job_id=NULL,
            scheduled_response_at=NULL,cancelled_reason=$2,updated_at=NOW()
      WHERE right(regexp_replace(COALESCE(phone,''), '\\D', '', 'g'),8)=right($1,8)
        AND status IN ('active_collecting','awaiting_auto_publish')`, [p, `GLOBAL_SUPPRESSION: ${cleanReason}`])
    .catch(err => log.warn('ownerOptOut: pending AI cancellation failed', { err: err.message }))

  return { updated: r.rowCount, ids: ownerIds, suppressed: true, identityHash: hash, requestType: requestTypeFor(cleanReason) }
}

module.exports = {
  OPT_OUT_RES, DATA_SOURCE_RES, isOptOut, isDataSourceQuestion,
  normalizeIdentity, identityHash, requestTypeFor, isGloballySuppressed, markDoNotContact,
}
