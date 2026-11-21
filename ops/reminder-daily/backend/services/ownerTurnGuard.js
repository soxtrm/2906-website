'use strict'
// ============================================================================
// services/ownerTurnGuard.js — one owner turn, at most one automated reply
// (Kev, 2026-11-21: Andrew Zammit got "No worries…" from autoOwnerConversation AND
// "Ok, thank you… I won't ask again" from availability.js for one message; Barbara
// got an intake question next to the same "won't ask again").
//
// Called by waha.sendText for every 1:1 send. Only REPLY GENERATORS are limited
// (availability.js incl. its delayed humanDelay jobs, autoOwnerConversation,
// ownerRecheck7d, conversationIntelligence, ownerAssistant, ownerPortfolioCheck);
// a person writing from the CRM, outreach first contacts and Reminder Due are not
// blocked — but every send counts as "the reply" to the current owner turn.
//   rule 1: the owner's latest turn was FINAL (plain no / I'll let you know /
//           callback / stop / closing) → no automated message for 24 h
//   rule 2: an automated or human message already answered this turn → no second one
// A blocked send returns { blocked: true } (callers carry on as if sent) and is
// written to owner_reply_guard_events with the module and the text.
// ============================================================================
const log = require('../logger')

const REPLY_MODULES = /services[\\/](autoOwnerConversation|availability|ownerRecheck7d|conversationIntelligence|ownerAssistant|ownerPortfolioCheck|ownerScopeReply|ownerFactEngine|humanDelay)\.js/
const TTL = 24 * 3600
const ids = chat => {
  const d = String(chat || '').replace(/@.*$/, '').replace(/\D/g, '')
  return d ? [d.slice(-9)] : []
}
const k = (kind, session, id) => `turn:${kind}:${String(session || '').toLowerCase()}:${id}`
const redis = () => require('../redis')
const enabled = () => process.env.OWNER_TURN_GUARD !== '0'

// webhook: every owner DM, before any handler runs
async function noteInbound({ session, phone, chatId, final = false, at = Date.now() }) {
  for (const id of new Set([...ids(phone), ...ids(chatId)])) {
    await redis().set(k('in', session, id), String(at), 'EX', TTL).catch(() => {})
    if (final) await redis().set(k('final', session, id), String(at), 'EX', TTL).catch(() => {})
    else await redis().del(k('final', session, id)).catch(() => {})
  }
}

function callerModule(stack = null) {
  if (!stack) { const prev = Error.stackTraceLimit; Error.stackTraceLimit = 80; stack = new Error().stack; Error.stackTraceLimit = prev }
  if (/routes[\\/]/.test(stack) && !REPLY_MODULES.test(stack)) return { automated: false, module: 'person_or_route' }
  const m = REPLY_MODULES.exec(stack)
  return m ? { automated: true, module: m[1] } : { automated: false, module: 'initiated' }
}

async function check(session, chatId, text, { caller = null } = {}) {
  if (!enabled() || /@g\.us$|@newsletter$|@broadcast$|^status@/i.test(String(chatId || ''))) return { allow: true }
  caller = caller || callerModule()
  const keys = ids(chatId)
  if (!keys.length) return { allow: true }
  let lastIn = 0, final = 0, lastOut = 0
  for (const id of keys) {
    lastIn = Math.max(lastIn, Number(await redis().get(k('in', session, id)).catch(() => 0)) || 0)
    final = Math.max(final, Number(await redis().get(k('final', session, id)).catch(() => 0)) || 0)
    lastOut = Math.max(lastOut, Number(await redis().get(k('out', session, id)).catch(() => 0)) || 0)
  }
  if (caller.automated) {
    let reason = null
    if (final && final >= lastIn) reason = 'owner_turn_final'
    else if (lastIn && lastOut >= lastIn) reason = 'already_replied_this_turn'
    if (reason) {
      log.info('[turn-guard] automated owner message blocked', { session, chat: String(chatId).slice(-6), module: caller.module, reason, text: String(text || '').slice(0, 80) })
      require('../db').query(
        `INSERT INTO owner_reply_guard_events (session, chat_id, module, reason, text) VALUES ($1,$2,$3,$4,$5)`,
        [session, String(chatId), caller.module, reason, String(text || '').slice(0, 500)]).catch(() => {})
      return { allow: false, reason, module: caller.module }
    }
  }
  return { allow: true, module: caller.module, automated: caller.automated }
}

async function noteSent(session, chatId) {
  for (const id of ids(chatId)) await redis().set(k('out', session, id), String(Date.now()), 'EX', TTL).catch(() => {})
}

// reactions: none on a final owner turn (Kev: no unnecessary 👍)
async function reactionAllowed(session, messageId) {
  if (!enabled()) return true
  const m = /^(?:true|false)_([^_]+)_/.exec(String(messageId || ''))
  if (!m) return true
  let final = 0, lastIn = 0
  for (const id of ids(m[1])) {
    final = Math.max(final, Number(await redis().get(k('final', session, id)).catch(() => 0)) || 0)
    lastIn = Math.max(lastIn, Number(await redis().get(k('in', session, id)).catch(() => 0)) || 0)
  }
  return !(final && final >= lastIn)
}

module.exports = { noteInbound, check, noteSent, callerModule, reactionAllowed, REPLY_MODULES }
