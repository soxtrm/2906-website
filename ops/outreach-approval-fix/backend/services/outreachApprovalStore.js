'use strict'
// ============================================================================
// services/outreachApprovalStore.js — durable notes-chat outreach approvals.
//
// adminCommands.js keeps its in-memory manualOutreachState as a cache; this
// store is the source of truth for the `awaiting_outreach_confirm` step so a
// backend restart no longer drops an approval the operator is looking at.
//
// Fail-open by design: if the table is missing (migration not yet applied) or
// the DB errors, every call logs once and returns a neutral result, and the
// caller behaves exactly like the in-memory version. Nothing here sends.
// ============================================================================
const db = require('../db')
const log = require('../logger')

let _disabledReason = null
async function q(sql, params) {
  if (_disabledReason) return null
  try {
    return await db.query(sql, params)
  } catch (err) {
    if (/relation .*outreach_pending_approvals.* does not exist/i.test(err.message)) {
      _disabledReason = 'table missing'
      log.warn('outreachApprovalStore disabled: migration 20261017_outreach_pending_approvals not applied — approvals stay in memory only')
    } else {
      log.warn('outreachApprovalStore query failed — continuing in memory', { err: err.message })
    }
    return null
  }
}

const rowToState = row => ({
  step: 'awaiting_outreach_confirm',
  approvalId: row.approval_id,
  contacts: row.contacts,
  listType: row.list_type || 'unknown',
  messageText: row.message_template,
  session: row.reply_session,
  outreachSession: row.sending_session,
  fromNotesChat: row.from_notes_chat,
  setAt: new Date(row.created_at).getTime(),
  expiresAt: new Date(row.expires_at).getTime(),
  restoredFromStore: true,
})

/** Persist a new preview; any older PENDING preview of this operator is superseded. */
async function savePending({ approvalId, adminPhone, replySession, sendingSession, listType, contacts, messageText, fromNotesChat, expiresAt }) {
  await q(`UPDATE outreach_pending_approvals SET state='SUPERSEDED', decided_at=NOW() WHERE admin_phone=$1 AND state='PENDING'`, [String(adminPhone)])
  await q(
    `INSERT INTO outreach_pending_approvals
       (approval_id, admin_phone, reply_session, sending_session, list_type, contacts, message_template, from_notes_chat, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)
     ON CONFLICT (approval_id) DO NOTHING`,
    [approvalId, String(adminPhone), replySession, sendingSession, listType || null, JSON.stringify(contacts), messageText, fromNotesChat !== false, new Date(expiresAt)])
}

/** The operator's actionable preview after a restart (null if none). Marks a stale one EXPIRED. */
async function loadPending(adminPhone, now = Date.now()) {
  const res = await q(`SELECT * FROM outreach_pending_approvals WHERE admin_phone=$1 AND state='PENDING' LIMIT 1`, [String(adminPhone)])
  const row = res?.rows?.[0]
  if (!row) return null
  return rowToState(row)
}

/**
 * The single place a YES becomes a run: PENDING -> APPROVED in one
 * conditional UPDATE. Returns 'claimed' | 'already_decided' | 'unavailable'.
 * 'unavailable' (no table / DB error) lets the in-memory path proceed — the
 * run itself is still idempotent on approvalId as triggerId.
 */
async function claim(approvalId) {
  const res = await q(`UPDATE outreach_pending_approvals SET state='APPROVED', decided_at=NOW()
                        WHERE approval_id=$1 AND state='PENDING' AND expires_at > NOW() RETURNING approval_id`, [approvalId])
  if (!res) return 'unavailable'
  if (res.rows.length) return 'claimed'
  const known = await q(`SELECT state, expires_at <= NOW() AS expired FROM outreach_pending_approvals WHERE approval_id=$1`, [approvalId])
  const row = known?.rows?.[0]
  if (!row) return 'unavailable'
  if (row.state === 'PENDING' && row.expired) {
    await close(approvalId, 'EXPIRED')
    return 'expired'
  }
  return 'already_decided'
}

async function attachRun(approvalId, runId) {
  await q(`UPDATE outreach_pending_approvals SET run_id=$2 WHERE approval_id=$1`, [approvalId, runId])
}

async function close(approvalId, state, reason = null) {
  if (!approvalId) return
  await q(`UPDATE outreach_pending_approvals SET state=$2, refusal_reason=$3, decided_at=NOW() WHERE approval_id=$1 AND state='PENDING'`, [approvalId, state, reason])
}

async function cancelPendingFor(adminPhone) {
  await q(`UPDATE outreach_pending_approvals SET state='CANCELLED', decided_at=NOW() WHERE admin_phone=$1 AND state='PENDING'`, [String(adminPhone)])
}

/** Last decision for this operator within `withinMs` — answers a YES after restart. */
async function lastDecision(adminPhone, withinMs = 15 * 60 * 1000) {
  const res = await q(`SELECT state, run_id, decided_at, created_at, jsonb_array_length(contacts) AS count, sending_session
                         FROM outreach_pending_approvals
                        WHERE admin_phone=$1 AND state <> 'PENDING' AND decided_at > NOW() - ($2 || ' milliseconds')::interval
                        ORDER BY decided_at DESC LIMIT 1`, [String(adminPhone), String(withinMs)])
  const row = res?.rows?.[0]
  if (!row) return null
  const outcome = { APPROVED: 'approved', CANCELLED: 'cancelled', EXPIRED: 'expired', REFUSED: 'refused' }[row.state]
  if (!outcome) return null
  return { outcome, at: new Date(outcome === 'expired' ? row.created_at : row.decided_at).getTime(), count: Number(row.count), session: row.sending_session, runId: row.run_id }
}

module.exports = { savePending, loadPending, claim, attachRun, close, cancelPendingFor, lastDecision, _isDisabled: () => _disabledReason }
