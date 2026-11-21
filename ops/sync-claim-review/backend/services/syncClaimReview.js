'use strict'
// ============================================================================
// services/syncClaimReview.js — the ownership review of NEXUS SYNC claims (Claude, 2026-11-21).
//
// Before: a confirmed claim only set nexus_owner_links.link_state = 'claim_pending'. Nobody was told, the CRM
// showed an amber line in the SYNC inbox, and the owner heard nothing after the decision.
// Now:
//   • review queue: pending(S, agent) -> every account waiting, with the claimed homes and the listing agent of
//     each (CRM: SYNC inbox, "Waiting for review"), and the count for the menu badge (staffSummary).
//   • staff are told when an owner confirms homes: an internal WhatsApp to SYNC_STAFF_NOTIFY_TO (only when that
//     staff number is configured; never to the owner) and the audit entry SYNC_CLAIM_REVIEW_REQUESTED.
//   • the owner gets a message in their SYNC chat after the decision (approve or reject), signed by the agent.
// Deciding stays where it was: syncAccount.staffDecideClaim (admins / agents with NEXUS owner controls only).
// ============================================================================
const db = require('../db')
const log = require('../logger')
const L = require('./nexusOwnerLink')
const { audit, AGENCY_KEY } = L._internal

async function pending(S, agent) {
  const { rows } = await db.query(
    `SELECT a.public_id, l.updated_at FROM nexus_owner_links l JOIN sync_accounts a ON l.nexus_account_ref = 'sync:' || a.public_id
      WHERE l.agency_key=$1 AND l.link_state='claim_pending' AND a.disabled_at IS NULL ORDER BY l.updated_at`, [AGENCY_KEY()])
  const out = []; const seen = new Set()
  for (const r of rows) {
    if (seen.has(r.public_id)) continue
    seen.add(r.public_id)
    try {
      const c = await S.staffContext(r.public_id, agent)
      const links = c.links.filter(l => l.state === 'claim_pending')
      if (links.length) out.push({ accountId: r.public_id, account: c.account, waitingSince: r.updated_at, links })
    } catch { /* not visible to this agent */ }
  }
  return { claims: out, canDecide: agent?.role === 'admin' || agent?.nexusOwnerLink === true }
}

// After the owner confirmed homes in SYNC: tell staff once (per account, per 6 hours).
async function afterOwnerDecision(S, account, result) {
  if (!result || !result.decided) return { notified: false }
  const { rows } = await db.query(
    `SELECT l.id, (SELECT COUNT(*)::int FROM nexus_owner_property_claims c WHERE c.owner_link_id=l.id AND c.claim_state IN ('confirmed','corrected')) AS homes
       FROM nexus_owner_links l WHERE l.agency_key=$1 AND l.nexus_account_ref=$2 AND l.link_state='claim_pending'`, [AGENCY_KEY(), `sync:${account.public_id}`])
  const homes = rows.reduce((n, r) => n + r.homes, 0)
  if (!homes) return { notified: false }
  const { rows: [recent] } = await db.query(
    `SELECT 1 FROM agent_activity_log WHERE action_type='SYNC_CLAIM_REVIEW_REQUESTED' AND details->>'account'=$1 AND created_at > NOW() - interval '6 hours' LIMIT 1`, [account.public_id])
  if (recent) return { notified: false, reason: 'already requested' }
  await audit(db, null, 'SYNC_CLAIM_REVIEW_REQUESTED', { account: account.public_id, homes })
  const first = String(account.display_name || 'An owner').split(' ')[0]
  try {
    const sent = await S.staffNotice(`NEXUS SYNC: ${first} confirmed ${homes} home${homes === 1 ? '' : 's'} as owner and waits for the ownership check.\nCRM → SYNC inbox → Waiting for review: https://crm.2906.estate/sync-inbox`)
    return sent ? { notified: true } : { notified: false, reason: 'no staff number configured', queued: true }
  } catch (e) { log.warn(`[sync] claim review notice: ${e.message}`); return { notified: false, reason: 'send failed', queued: true } }
}

// The owner's SYNC chat after the decision. Plain words, signed by the agent who decided.
async function ownerNotice(account, ownerContactId, decision, agent) {
  const { rows: [l] } = await db.query(`SELECT id FROM nexus_owner_links WHERE agency_key=$1 AND owner_contact_id=$2`, [AGENCY_KEY(), ownerContactId])
  const who = agent?.name || agent?.username || 'Your agent'
  const body = decision === 'approve'
    ? `Your homes are confirmed. You can now manage availability, viewings, house rules and documents in SYNC. — ${who}, 2906 Estate`
    : `We could not confirm that these homes belong to you, so they are not linked to your account. If this is a mistake, reply here and we will check again. — ${who}, 2906 Estate`
  await db.query(
    `INSERT INTO nexus_owner_messages (agency_key, account_id, owner_link_id, direction, sender_kind, agent_id, sender_name, sender_org, body)
     VALUES ($1,$2,$3,'out','agent',$4,$5,'2906 Estate',$6)`, [AGENCY_KEY(), account.id, l?.id || null, agent?.id || null, who, body])
  await audit(db, agent, decision === 'approve' ? 'SYNC_CLAIM_APPROVED' : 'SYNC_CLAIM_REJECTED_NOTICE', { account: account.public_id, owner: account.public_id, owner_contact_id: ownerContactId })
}

module.exports = { pending, afterOwnerDecision, ownerNotice }
