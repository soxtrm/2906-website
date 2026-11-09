'use strict'
// ============================================================================
// services/outreachIdentity.js — one campaign, one sender (Kev, 2026-09-24).
//
// Incident 2026-09-24: plan 73 (session Cedric) fired batch #125 with a saved
// template that ends "Kevin Eich Agent", in parallel with Cedric's manual
// batch #124. 12 owners who already knew the Cedric number got a message
// signed Kevin from it. Nothing in the send path had ever compared the
// template's sign-off with the account that sends it. Identity was
// "whatever session + whatever free text", and the saved-template library is
// shared across all accounts.
//
// Rules:
//   - The sender persona comes ONLY from whatsapp_accounts.account_persona of
//     the sending session (frozen once per batch). Owner/contact metadata
//     (last_known_account_id, prior history, etc.) never participates.
//   - A template/message that SIGNS or INTRODUCES itself as another persona is
//     refused. Addressing the recipient by a name ("Good Afternoon Kevin") is
//     not a self-identification and passes.
// ============================================================================
const db = require('../db')

// persona → names that identify that persona as the SENDER
const PERSONA_NAMES = {
  kev: ['Kevin Eich', 'Kevin', 'Kev'],
  cedric: ['Cedric'],
  gabriela: ['Gabriela'],
  jasmine: ['Jasmine'],
  olga: ['Olga'],
}

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

async function resolveSenderIdentity(sessionName) {
  const r = await db.query(
    `SELECT id, session_name, account_persona, label FROM whatsapp_accounts
      WHERE LOWER(session_name) = LOWER($1) ORDER BY (session_name = $1) DESC LIMIT 1`,
    [sessionName])
  const row = r.rows[0]
  if (!row) return null
  const persona = (row.account_persona || '').toLowerCase() || null
  return Object.freeze({
    accountId: row.id,
    session: sessionName,
    persona,
    names: Object.freeze([...(PERSONA_NAMES[persona] || [])]),
  })
}

// Returns [{ persona, name, match }] for every OTHER persona the text
// identifies itself as. `recipientName` (the contact's own name) is ignored.
function findForeignSignatures(text, persona, { recipientName = null } = {}) {
  const t = String(text || '')
  if (!t.trim()) return []
  const recipient = String(recipientName || '').trim().toLowerCase()
  const hits = []
  for (const [p, names] of Object.entries(PERSONA_NAMES)) {
    if (p === persona) continue
    for (const name of names) {
      if (recipient && recipient.split(/\s+/)[0] === name.toLowerCase()) continue
      const n = esc(name)
      const patterns = [
        new RegExp(`\\b(?:my name is|name'?s|i am|i'm|iam|this is|it'?s)\\s+${n}\\b`, 'i'),
        new RegExp(`\\b${n}(?:\\s+[A-Z][a-z]+)?\\s*[,|/-]?\\s*(?:rental\\s+|real estate\\s+|letting\\s+)?(?:agent|specialist)\\b`, 'i'),
        new RegExp(`(?:regards|cheers|thanks|thank you|best)[,!.]?\\s+${n}\\b`, 'i'),
        new RegExp(`(?:^|[\\n.!?]\\s*)[-–—]?\\s*${n}(?:\\s+[A-Z][a-z]+)?\\s*[.!]?\\s*$`, 'i'),  // bare sign-off at the very end
      ]
      if (name.includes(' ')) patterns.push(new RegExp(`\\b${n}\\b`, 'i'))  // full name (Kevin Eich) anywhere
      for (const re of patterns) {
        const m = t.match(re)
        if (m) { hits.push({ persona: p, name, match: m[0].trim() }); break }
      }
    }
  }
  // one hit per persona is enough to explain
  const seen = new Set()
  return hits.filter(h => (seen.has(h.persona) ? false : seen.add(h.persona)))
}

function describeMismatch(identity, hits) {
  const who = hits.map(h => `${h.persona} ("${h.match}")`).join(', ')
  return `template signs as ${who} but sends via ${identity.session} (${identity.persona || 'no persona'})`
}

// ── How a sender introduces itself (2026-09-24 global pass) ─────────────
// Replaces hard-coded "Hi, I'm Kevin" / "My name is Kevin Eich" in generated
// texts: the name comes from the SENDING session's persona. null = the
// session has no known persona; callers then use a nameless wording.
const SENDER_DISPLAY = {
  kev: { first: 'Kevin', full: 'Kevin Eich' },
  cedric: { first: 'Cedric', full: 'Cedric' },
  gabriela: { first: 'Gabriela', full: 'Gabriela' },
  jasmine: { first: 'Jasmine', full: 'Jasmine' },
  olga: { first: 'Olga', full: 'Olga' },
}
const _identityCache = new Map()   // lower(session) → { at, identity }
const CACHE_MS = 5 * 60 * 1000
async function cachedIdentity(session) {
  const k = String(session || '').toLowerCase()
  const hit = _identityCache.get(k)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.identity
  const identity = await resolveSenderIdentity(session)
  _identityCache.set(k, { at: Date.now(), identity })
  return identity
}
async function senderNames(session) {
  try {
    const idt = await cachedIdentity(session)
    return (idt && SENDER_DISPLAY[idt.persona]) || null
  } catch (_) { return null }
}

// ── Global last-gate for EVERY outbound message ─────────────────────────
// Called from waha.sendText/sendImage/sendVideo, availability.sendTextAs/
// sendImageAs and reminderPoster.sendQuoted, which together are every path
// a text reaches WhatsApp through. Rule: a message to an owner/contact
// must not introduce or sign itself as a persona other than the sending
// session's own. Groups and our own team's numbers (admins, super-admins,
// agents, our WhatsApp accounts) are out of scope: internal reports quote
// agent names legitimately. A detected mismatch throws (fail closed); a
// lookup failure never blocks a send (fail open, logged).
let _internal = { at: 0, phones: new Set() }
const digits = s => String(s || '').replace(/\D/g, '')
async function internalPhones() {
  if (Date.now() - _internal.at < CACHE_MS) return _internal.phones
  const phones = new Set()
  try {
    const config = require('../config')
    for (const p of (config.admin && config.admin.adminNumbers) || []) phones.add(digits(p))
    if (config.admin && config.admin.botNumber) phones.add(digits(config.admin.botNumber))
  } catch (_) {}
  const qs = [
    `SELECT phone AS p FROM superadmins`,
    `SELECT phone AS p FROM whatsapp_accounts`,
    `SELECT whatsapp_phone AS p FROM agents UNION ALL SELECT public_phone FROM agents`,
  ]
  for (const q of qs) {
    try { for (const r of (await db.query(q)).rows) if (r.p) phones.add(digits(r.p)) } catch (_) {}
  }
  try {
    const r = await db.query(`SELECT whatsapp_phones FROM agents WHERE whatsapp_phones IS NOT NULL`)
    for (const row of r.rows) for (const p of [].concat(row.whatsapp_phones || [])) phones.add(digits(typeof p === 'object' ? (p.phone || p.number) : p))
  } catch (_) {}
  phones.delete('')
  _internal = { at: Date.now(), phones }
  return phones
}

class SenderIdentityError extends Error {
  constructor(msg, detail) { super(msg); this.name = 'SenderIdentityError'; this.code = 'SENDER_IDENTITY_MISMATCH'; this.detail = detail }
}

async function assertOutboundIdentity(session, chatId, text, { recipientName = null } = {}) {
  if (!text || !String(text).trim()) return
  const cid = String(chatId || '')
  if (/@g\.us$|@newsletter$|^status@broadcast$/i.test(cid)) return
  let identity = null
  try {
    if (/@(c\.us|s\.whatsapp\.net)$/i.test(cid) || /^\+?\d+$/.test(cid)) {
      if ((await internalPhones()).has(digits(cid.split('@')[0]))) return
    }
    identity = await cachedIdentity(session)
  } catch (err) {
    try { require('../logger').warn('outboundIdentity: lookup failed, not blocking', { session, err: err.message }) } catch (_) {}
    return
  }
  const persona = identity ? identity.persona : null
  const hits = findForeignSignatures(text, persona, { recipientName })
  if (!hits.length) return
  const why = describeMismatch(identity || { session, persona: null }, hits)
  try { require('../logger').error('OUTBOUND BLOCKED: sender identity mismatch', { session, chat: cid.slice(-8), why }) } catch (_) {}
  try { require('../telegram').sendAlert(`🛑 Outbound blocked — ${why} (chat …${cid.replace(/@.*/, '').slice(-4)})`).catch(() => {}) } catch (_) {}
  throw new SenderIdentityError(`SENDER_IDENTITY_MISMATCH: ${why}`, { session, persona, hits })
}

function _resetCachesForTest() { _identityCache.clear(); _internal = { at: 0, phones: new Set() } }

module.exports = {
  PERSONA_NAMES, SENDER_DISPLAY, resolveSenderIdentity, findForeignSignatures, describeMismatch,
  senderNames, assertOutboundIdentity, SenderIdentityError, _resetCachesForTest,
}
