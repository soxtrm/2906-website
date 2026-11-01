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

// Suppression record for every owner_contacts row with this number (last 8
// digits, like the rest of the owner matching). Idempotent; never deletes.
async function markDoNotContact(phone, reason, client = require('../db')) {
  const p = String(phone || '').replace(/\D/g, '')
  if (p.length < 8) return { updated: 0 }
  const r = await client.query(
    `UPDATE owner_contacts
        SET do_not_contact = TRUE, status = 'do_not_contact',
            do_not_contact_reason = COALESCE(NULLIF(do_not_contact_reason, ''), $2),
            do_not_contact_at = COALESCE(do_not_contact_at, NOW()), updated_at = NOW()
      WHERE right(regexp_replace(COALESCE(phone_normalized,''), '\\D', '', 'g'), 8) = right($1, 8)
        AND (do_not_contact IS DISTINCT FROM TRUE OR COALESCE(status,'') <> 'do_not_contact')
      RETURNING id`, [p, String(reason || 'Owner asked to stop contact').slice(0, 300)])
  return { updated: r.rowCount, ids: r.rows.map(x => x.id) }
}

module.exports = { OPT_OUT_RES, DATA_SOURCE_RES, isOptOut, isDataSourceQuestion, markDoNotContact }
