'use strict'

// ============================================================================
// services/agentIdentityRegistry.js — who the SENDING account is.
//
// Kev, 2026-10-22 (P0, conversation #5598 on Argus5): an owner asked "what is
// the name of your agency please?" twice; the bot answered with the intake
// question and then escalated "couldn't determine intent". Agency identity is
// not an LLM question — it is an account-scoped fact:
//   - The persona comes from whatsapp_accounts.account_persona of the sending
//     session (the same source outreachIdentity.js uses). Conversation text and
//     recipient history never choose it.
//   - Identities are keyed by PERSONA, so every Kevin account (default,
//     Kevsecond, kevthirdd, Argus1-5 …) answers as Kevin Eich / 2906 Estate
//     without listing each session here. The previous session-keyed table had
//     no Argus* entries and spelled Gabriela's session "gabriella", so those
//     accounts got null → escalation.
//   - One canonical, editable place: ARGUS_AGENT_IDENTITIES_JSON may override
//     any persona (or a single session) without a code change.
//   - A persona without an identity (olga, jasmine …) returns null: the caller
//     escalates instead of inventing a biography.
// ============================================================================

const CLIENT_DESCRIPTION = 'clients looking for long-term rentals, including working professionals and families depending on the property'

const PERSONA_IDENTITIES = Object.freeze({
  // Kev, 2026-10-30: Kevin is self-employed and works WITH 2906 Estate, a
  // collective of independent agents — never "representing"/employed by an
  // agency. The two answers are Kev's own wording; the email is his verified
  // address (the account owner's own). Never invent registration details.
  kev: Object.freeze({
    persona: 'kev', name: 'Kevin', fullName: 'Kevin Eich', agency: '2906 Estate', brand: '2906',
    roleNoun: 'a real estate agent', position: 'Independent Real Estate Agent', experience: 'four years',
    clientDescription: CLIENT_DESCRIPTION,
    introAnswer: "I'm a self-employed real estate agent working with 2906 Estate, a collective of independent property agents here in Malta. We work together to connect property owners with suitable tenants and buyers.",
    shortIntroAnswer: "I'm an independent real estate agent working with the 2906 Estate collective here in Malta, mainly assisting clients with rentals and property sales.",
    email: 'kevinsony1@gmail.com',
  }),
  // Cedric / Gabriela: no email yet. Kev dictated one address for both on
  // 2026-10-30 and asked to verify its spelling first; until then an email
  // question goes to a human (ARGUS_AGENT_IDENTITIES_JSON can add it).
  cedric: Object.freeze({
    persona: 'cedric', name: 'Cedric', fullName: 'Cedric Reiter', agency: 'QuickLets',
    roleNoun: 'a rental agent', position: 'Rental Agent', clientDescription: CLIENT_DESCRIPTION,
  }),
  gabriela: Object.freeze({
    persona: 'gabriela', name: 'Gabriela', fullName: 'Gabriela', agency: "Sotheby's",
    roleNoun: 'a real estate agent', position: 'Real Estate Agent',
    clientDescription: 'clients looking for suitable long-term rentals, depending on the property',
  }),
})

// Last-resort mirror of whatsapp_accounts.account_persona (2026-10-22) for
// synchronous callers and for a DB outage. The database row always wins.
const SESSION_PERSONA_FALLBACK = Object.freeze({
  default: 'kev', kevsecond: 'kev', kevthirdd: 'kev', kev40: 'kev',
  argus1: 'kev', argus2: 'kev', argus3: 'kev', argus4: 'kev', argus5: 'kev',
  cedric: 'cedric', gabriela: 'gabriela', gabriella: 'gabriela',
  olga: 'olga', jasmine: 'jasmine',
})

// Kept for callers that imported the old table; values are persona identities.
const DEFAULT_IDENTITIES = Object.freeze(Object.fromEntries(
  Object.entries(SESSION_PERSONA_FALLBACK).filter(([, p]) => PERSONA_IDENTITIES[p]).map(([s, p]) => [s, PERSONA_IDENTITIES[p]])))

function configuredOverrides() {
  if (!process.env.ARGUS_AGENT_IDENTITIES_JSON) return {}
  try {
    const parsed = JSON.parse(process.env.ARGUS_AGENT_IDENTITIES_JSON)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (_) {
    return {}
  }
}

const personaCache = new Map()   // lower(session) -> { persona, at }
const CACHE_MS = 5 * 60 * 1000

function identityForPersona(persona, sessionKey = '') {
  const overrides = configuredOverrides()
  const base = PERSONA_IDENTITIES[persona] || null
  const override = overrides[sessionKey] || overrides[persona] || null
  if (!base && !override) return null
  return Object.freeze({ ...(base || {}), ...(override || {}), persona: persona || override?.persona || null })
}

// Synchronous: cached DB persona, then the explicit persona argument, then the
// static mirror. Used by conversationIntelligence/conversationPolicy.
function resolveAgentIdentity(senderAccountId, accountPersona = null) {
  const key = String(senderAccountId || '').trim().toLowerCase()
  const cached = personaCache.get(key)
  const persona = String(accountPersona || '').trim().toLowerCase()
    || (cached && cached.persona) || SESSION_PERSONA_FALLBACK[key] || ''
  return identityForPersona(persona, key)
}

// The sending account's persona string (kev, cedric, gabriela, olga …), even
// for personas without a configured identity. Used to keep fallbacks inside
// one persona.
async function resolvePersonaForSession(session, db = null) {
  await resolveIdentityForSession(session, db)
  const cached = personaCache.get(String(session || '').trim().toLowerCase())
  return (cached && cached.persona) || null
}

// Asynchronous, canonical: reads whatsapp_accounts.account_persona.
async function resolveIdentityForSession(session, db = null) {
  const key = String(session || '').trim().toLowerCase()
  if (!key) return null
  const cached = personaCache.get(key)
  if (cached && Date.now() - cached.at < CACHE_MS) return identityForPersona(cached.persona, key)
  let persona = null
  try {
    const conn = db || require('../db')
    const r = await conn.query(
      `SELECT account_persona FROM whatsapp_accounts WHERE LOWER(session_name) = LOWER($1)
        ORDER BY (session_name = $1) DESC LIMIT 1`, [session])
    persona = String(r.rows[0]?.account_persona || '').trim().toLowerCase() || null
  } catch (_) {
    persona = null   // DB unavailable: fall through to the static mirror below
  }
  if (!persona) persona = SESSION_PERSONA_FALLBACK[key] || null
  if (persona) personaCache.set(key, { persona, at: Date.now() })
  return identityForPersona(persona, key)
}

// "Of course. I'm Kevin Eich, a real estate agent representing 2906 Estate in Malta."
// A persona with its own approved wording (introAnswer) always uses that.
function agencyAnswer(identity) {
  if (identity && identity.introAnswer) return identity.introAnswer
  if (!identity || !identity.agency) return null
  const who = identity.fullName || identity.name
  const role = identity.roleNoun || (identity.position ? `a ${identity.position.toLowerCase()}` : 'an agent')
  return `Of course. I'm ${who}, ${role} representing ${identity.agency} in Malta.`
}

// The second time an owner asks: one short line, never the full intro again.
function agencyShortAnswer(identity) {
  if (identity && identity.shortIntroAnswer) return identity.shortIntroAnswer
  if (!identity || !identity.agency) return null
  return `Sure — I'm ${identity.fullName || identity.name} from ${identity.agency}, based in Malta.`
}

// ── Email (Kev, 2026-10-30) ─────────────────────────────────────────────────
// Only a verified, configured address is ever sent. No address → null and the
// caller hands the question to a human. Never construct one from a name or a
// domain.
const EMAIL_QUESTION_RE = /\b(?:your|ur|an?|the)\s+(?:e-?mail|mail\s+address)\b|\be-?mail\s+(?:address|adress|id)\b|\b(?:send|share|give)\s+(?:me\s+)?(?:your\s+)?e-?mail\b|\bwhat(?:'s| is)\s+(?:your\s+)?e-?mail\b/i
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi

function isEmailQuestion(text) {
  return EMAIL_QUESTION_RE.test(String(text || ''))
}

function approvedEmails(identity) {
  if (!identity) return []
  return [identity.email, identity.businessEmail].filter(Boolean).map(e => String(e).toLowerCase())
}

function emailAnswer(identity) {
  const email = identity && identity.email
  return email ? `Of course, my email is ${email}.` : null
}

// Addresses in an outgoing text that are not this sender's approved ones.
function unapprovedEmails(text, identity) {
  const allowed = new Set(approvedEmails(identity))
  return (String(text || '').match(EMAIL_RE) || []).filter(e => !allowed.has(e.toLowerCase()))
}

function clientTypeAnswer(identity) {
  if (!identity?.clientDescription) return null
  return `We work with ${identity.clientDescription}.`
}

// One detector for both conversation paths. Covers the real phrasings that
// fell through the old regexes: "what is the name of your agency", "the agency
// that you are representing", "what estate agency do you work for".
const AGENCY_QUESTION_PATTERNS = [
  /\b(?:which|what)\s+(?:real\s+)?(?:estate\s+)?(?:agency|agencies|company|firm)\b/i,
  /\bname of (?:your|the|ur) (?:real estate |estate )?(?:agency|company|firm)\b/i,
  /\b(?:agency|company|firm) (?:that |which )?you(?:'re| are)? (?:representing|represent|work(?:ing)? (?:for|with))\b/i,
  /\bwho (?:do|are) you (?:work(?:ing)? (?:for|with)|represent(?:ing)?|with)\b/i,
  /\bwhom do you (?:work for|represent)\b/i,
  /\bare you (?:an? )?(?:agent|freelancer|agency)\b/i,
  /\bare you (?:from|with) (?:an?|which|what) (?:agency|company)\b/i,
  /\bdo you work (?:independently|for)\b/i,
  /\bwhich agents?\b/i,
]
const AGENCY_QUESTION_RE = new RegExp(AGENCY_QUESTION_PATTERNS.map(r => r.source).join('|'), 'i')

function isAgencyQuestion(text) {
  return AGENCY_QUESTION_RE.test(String(text || ''))
}

function _clearCache() { personaCache.clear() }

module.exports = {
  PERSONA_IDENTITIES, DEFAULT_IDENTITIES, SESSION_PERSONA_FALLBACK, AGENCY_QUESTION_RE, EMAIL_QUESTION_RE,
  resolveAgentIdentity, resolveIdentityForSession, resolvePersonaForSession, agencyAnswer, agencyShortAnswer, clientTypeAnswer, isAgencyQuestion,
  isEmailQuestion, emailAnswer, approvedEmails, unapprovedEmails, _clearCache,
}
