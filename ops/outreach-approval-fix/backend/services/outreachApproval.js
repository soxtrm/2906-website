'use strict'
// ============================================================================
// services/outreachApproval.js — how the notes-chat YES / EDIT / STOP gates
// in adminCommands.js read the operator's answer.
//
// Incident 2026-10-17 (batch 276, Cedric): the operator answered "Yes" 2 s
// after the preview; the time-only echo filter swallowed it without a word.
// A later "Yes" was accepted but nothing was said back, "!yes" was "Unknown
// command", and an expired preview vanished silently. This module keeps the
// rules for that in one small, testable place:
//
//   • decisionOf()      — yes / edit / stop / null, only ever consulted while
//                         an approval is actually pending (no global YES).
//   • isLikelyEcho()    — the bot's own reply echoes back as fromMe within a
//                         few seconds; a bare decision word is never an echo
//                         (the bot never sends "YES" on its own).
//   • remember/recall   — what just happened to the operator's last approval,
//                         so a repeated or late YES gets a real answer.
// ============================================================================

const ECHO_WINDOW_MS = 4000
const MEMO_TTL_MS = 15 * 60 * 1000

/** 'yes' | 'edit' | 'stop' | null. Accepts Yes / YES / yes / Yes. / !yes / Y. */
function decisionOf(text) {
  const token = String(text || '')
    .trim()
    .replace(/^!/, '')
    .replace(/[\s.!,]+$/u, '')
    .toUpperCase()
  if (token === 'YES' || token === 'Y') return 'yes'
  if (token === 'EDIT' || token === 'E') return 'edit'
  if (token === 'STOP' || token === 'NO' || token === 'N') return 'stop'
  return null
}

function isLikelyEcho(state, text, now = Date.now()) {
  if (!state || !state.setAt) return false
  if (now - state.setAt >= ECHO_WINDOW_MS) return false
  return decisionOf(text) === null
}

// adminPhone → { outcome: 'approved'|'expired'|'cancelled'|'refused', at, count, session, runId }
const _memo = new Map()

function remember(adminPhone, entry, now = Date.now()) {
  _memo.set(String(adminPhone), { ...entry, at: now })
}

function recall(adminPhone, now = Date.now()) {
  const entry = _memo.get(String(adminPhone))
  if (!entry) return null
  if (now - entry.at > MEMO_TTL_MS) { _memo.delete(String(adminPhone)); return null }
  return entry
}

function forget(adminPhone) { _memo.delete(String(adminPhone)) }

const hhmm = at => new Date(at).toLocaleTimeString('en-GB', { timeZone: 'Europe/Malta', hour: '2-digit', minute: '2-digit' })

/** The answer for a YES that arrives when nothing is pending. */
function noPendingMessage(memo) {
  if (memo?.outcome === 'approved') {
    return `✅ Already approved at ${hhmm(memo.at)} — ${memo.count} message(s) via *${memo.session}*${memo.runId ? ` (run ${String(memo.runId).slice(0, 8)})` : ''}. ` +
      'It runs once; another YES changes nothing. You get the report when it finishes. *!cancel* stops it.'
  }
  if (memo?.outcome === 'expired') {
    return `⌛ The outreach preview from ${hhmm(memo.at)} expired after 5 minutes — nothing was sent. Run *!outreach* again.`
  }
  if (memo?.outcome === 'cancelled') return `🛑 That outreach was cancelled at ${hhmm(memo.at)} — nothing was sent.`
  if (memo?.outcome === 'refused') return `❌ That outreach was not armed at ${hhmm(memo.at)}: ${memo.why}`
  return 'ℹ️ There is no outreach waiting for approval. Start one with *!outreach*.'
}

module.exports = { ECHO_WINDOW_MS, MEMO_TTL_MS, decisionOf, isLikelyEcho, remember, recall, forget, noPendingMessage }
