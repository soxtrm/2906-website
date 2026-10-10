'use strict'
// ============================================================================
// boardAsk.js — turn an agent's raw question into the message that actually
// goes out from the Schedule Board.
//
// Agents type shorthand: "pets ok?", "when free", "parking???". That is fine
// for a colleague and wrong for an owner, so Gemini rewrites it into one
// polite WhatsApp line. The agent then sees the exact text and confirms it —
// nothing reaches an owner unseen (routes/crmScheduleBoard.js does the
// confirming half).
//
// Failure is always soft. No key, timeout, bad answer → the agent's own words
// go through, lightly wrapped. A question must never fail to send because the
// model was unavailable.
// ============================================================================

const { GoogleGenAI } = require('@google/genai')
const log    = require('../logger')
const config = require('../config')

const MODEL           = process.env.GEMINI_MODEL_ASK || 'gemini-2.5-flash'
const CALL_TIMEOUT_MS = 20_000
const MAX_OUT_CHARS   = 700

const apiKey = () => process.env.GEMINI_API_KEY || config?.gemini?.apiKey || null

// Malta contact window. Outside it the message is queued for the next 08:00
// rather than dropped — an agent working at 23:00 should not lose the thought.
const WINDOW_START_HOUR = 8
const WINDOW_END_HOUR   = 21

// Details that determine whether an owner will consider a tenant must survive
// the rewrite. The model is useful for tone, never for deciding which client
// facts matter. These vocabularies are deliberately narrow: numeric facts are
// protected generically below, while these words cover the profile facts most
// often entered without numbers.
const PROFILE_TERMS = new Set(`
  couple couples family families single singles sharing friends child children
  kid kids baby babies pet pets dog dogs cat cats student students professional
  professionals employed employment retired retiree retirees
  russian ukrainian maltese italian german french british english irish spanish
  portuguese polish romanian bulgarian hungarian czech slovak serbian croatian
  slovenian albanian greek turkish cypriot georgian armenian israeli lebanese
  syrian egyptian libyan tunisian moroccan indian pakistani nepali filipino
  filipina chinese japanese korean nigerian ghanaian brazilian american canadian
  australian
`.trim().split(/\s+/))

// The container runs UTC; every wall-clock decision has to be made in Malta
// time or the window silently drifts by an hour twice a year.
function maltaParts(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Malta', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {})
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour % 24, mm: +p.minute }
}

function maltaGreeting(d = new Date()) {
  const { hh } = maltaParts(d)
  if (hh < 12) return 'Good morning'
  if (hh < 18) return 'Good afternoon'
  return 'Good evening'
}

function tidyAgentText(raw) {
  return String(raw || '')
    .trim()
    .replace(/^(?:hi|hello|hey)\s*[,!.:-]*\s*/i, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
}

function normalizedDigits(value) {
  return String(value || '').replace(/\D/g, '')
}

function protectedFacts(rawNote) {
  const text = String(rawNote || '')
  const numbers = [...new Set((text.match(/\d[\d.,]*/g) || []).map(normalizedDigits).filter(Boolean))]
  const words = (text.toLowerCase().match(/[a-z]+/g) || [])
  const terms = [...new Set(words.filter(word => PROFILE_TERMS.has(word)))]

  // Jobs are often written as "working in IT", "employed as a nurse", etc.
  // Preserve the actual occupation words even when they are not in a fixed
  // profession list. Stop at punctuation or at the next sentence-like clause.
  const occupations = []
  const jobRe = /\b(?:work(?:ing|s)?|employed)\s+(?:as|in|at|for)\s+(?:a\s+|an\s+|the\s+)?([a-z][a-z0-9 &/+.-]{0,40})/gi
  for (const match of text.matchAll(jobRe)) {
    const phrase = match[1].split(/\b(?:and|but|with|who|their|his|her|budget|looking|interested)\b|[?!,;]/i)[0].trim()
    if (phrase) occupations.push(phrase.toLowerCase())
  }
  return { numbers, terms, occupations: [...new Set(occupations)] }
}

function preservesCriticalFacts(rawNote, candidate) {
  const facts = protectedFacts(rawNote)
  const out = String(candidate || '').toLowerCase()
  const outDigits = normalizedDigits(out)
  if (facts.numbers.some(n => !outDigits.includes(n))) return false
  if (facts.terms.some(term => !new RegExp(`\\b${term}\\b`, 'i').test(out))) return false
  if (facts.occupations.some(job => {
    const meaningful = job.match(/[a-z0-9]+/g) || []
    return meaningful.some(word => !new RegExp(`\\b${word}\\b`, 'i').test(out))
  })) return false
  return true
}

// The Malta-local date, as YYYY-MM-DD. This is the value owner_contact_log
// counts on — never the UTC date, or a 23:30 Malta message lands on tomorrow.
function maltaDay(d = new Date()) {
  const { y, m, d: dd } = maltaParts(d)
  return `${y}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
}

function insideWindow(d = new Date()) {
  const { hh } = maltaParts(d)
  return hh >= WINDOW_START_HOUR && hh < WINDOW_END_HOUR
}

// Wall-clock 08:00 Malta expressed as a UTC instant, by probing the offset —
// same trick availability.js uses, and the only one that survives DST.
function utcForMaltaWallClock(y, m, d, hour, minute) {
  const guess = Date.UTC(y, m - 1, d, hour, minute)
  const p = maltaParts(new Date(guess))
  const drift = (p.hh * 60 + p.mm) - (hour * 60 + minute)
  return guess - drift * 60_000
}

// When a message composed now may actually go out.
function nextSendTime(from = new Date()) {
  if (insideWindow(from)) return from
  const { y, m, d, hh } = maltaParts(from)
  // Before 08:00 → today at 08:00. At or after 21:00 → tomorrow at 08:00.
  if (hh < WINDOW_START_HOUR) {
    return new Date(utcForMaltaWallClock(y, m, d, WINDOW_START_HOUR, 0))
  }
  const tomorrow = new Date(utcForMaltaWallClock(y, m, d, WINDOW_START_HOUR, 0) + 24 * 3600_000)
  const t = maltaParts(tomorrow)
  return new Date(utcForMaltaWallClock(t.y, t.m, t.d, WINDOW_START_HOUR, 0))
}

// ── prompt ──────────────────────────────────────────────────────────────────
// Constraints mirror the house rules in CLAUDE.md: first name only, never a
// title. Internal operational notes stay private, while tenant facts that let
// the recipient make a decision (including budget) must remain in the message.
function buildPrompt({ mode, ref, agentName, recipientName, rawNote, isReachout, now = new Date() }) {
  const audience = mode === 'owner'
    ? 'the property OWNER (a private landlord, not a colleague)'
    : `a COLLEAGUE — ${recipientName || 'the listing agent'}, who manages this listing`

  return `You are writing one short WhatsApp message on behalf of a Maltese estate agent.

WHO IT GOES TO: ${audience}
LISTING REFERENCE: #${ref}
THE AGENT ASKING: ${agentName || 'an agent'}
${recipientName ? `RECIPIENT FIRST NAME: ${recipientName}` : ''}
${isReachout
    ? 'THIS IS A FOLLOW-UP — there is prior conversation history with this recipient. Do not add a new time-of-day greeting or re-introduce yourself.'
    : mode === 'owner'
      ? `THIS IS THE FIRST CONTACT with this owner. Begin exactly with "${maltaGreeting(now)}, I hope you're well."`
      : 'This is the first contact about this listing.'}

WHAT THE AGENT TYPED (shorthand, may be rude or unclear):
"""
${rawNote}
"""

Rewrite it as ONE polite, natural WhatsApp message.

RULES:
- English, friendly and direct. No corporate padding.
- Use the FIRST NAME only if one is given. Never "Mr", "Mrs", "Ms", "Dr", never a surname.
- If a recipient name is given, use only their first name. Never write "Hi ,".
- For a first owner contact, use the exact Malta-time greeting stated above even when no owner name is available.
- Keep it concise, ideally under 500 characters. One question, or two at most.
- Refer to the property as #${ref}. Never invent an address, price, or detail that is not in the agent's text.
- PRESERVE every decision-relevant client fact from the agent's text: budget/range, nationality, profession/job, household/group composition, pets, move-in timing and flexibility. These facts are elementary to the question and must never be shortened away.
- DROP only genuinely internal material: commission, other agents' names, private contact details, or opinions about the owner. A client's budget is NOT internal and must be kept.
- If the agent's text is abusive or nonsense, return a neutral polite enquiry about the listing instead.
- Do NOT sign off with a company name or add a signature.

Return ONLY JSON:
{"message": "<the message>", "dropped": "<short note on anything you removed, or empty string>"}`
}

// A usable message even with no model in the loop: the agent's own words,
// greeted and referenced. Deliberately plain — a fallback that tries to be
// clever is worse than one that is obviously literal.
function fallbackMessage({ mode, ref, recipientName, rawNote, isReachout = false, now = new Date() }) {
  const note = tidyAgentText(rawNote)
  let opening = ''
  if (mode === 'owner' && !isReachout) opening = `${maltaGreeting(now)}, I hope you're well. `
  else if (recipientName) opening = `Hi ${String(recipientName).trim().split(/\s+/)[0]}, `
  return `${opening}Regarding #${ref}, ${note}`.slice(0, MAX_OUT_CHARS)
}

/**
 * Rewrite one agent question. Never throws.
 * @returns {{ text: string, dropped: string|null, model: string|null, rewritten: boolean }}
 */
async function composeQuestion({ mode, ref, agentName, recipientName, rawNote, isReachout = false, now = new Date() }) {
  const note = String(rawNote || '').trim()
  if (!note) throw new Error('Empty question')

  const key = apiKey()
  if (!key) {
    log.info('[boardAsk] no GEMINI_API_KEY — sending the agent text as typed', { ref })
    return { text: fallbackMessage({ mode, ref, recipientName, rawNote: note, isReachout, now }), dropped: null, model: null, rewritten: false }
  }

  try {
    const ai = new GoogleGenAI({ apiKey: key })
    const response = await Promise.race([
      ai.models.generateContent({
        model: MODEL,
        contents: [{ role: 'user', parts: [{ text: buildPrompt({ mode, ref, agentName, recipientName, rawNote: note, isReachout, now }) }] }],
        config: { responseMimeType: 'application/json', temperature: 0.4 },
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('gemini timeout')), CALL_TIMEOUT_MS)),
    ])
    const raw = (response.text || '').replace(/^```json\s*/i, '').replace(/```\s*$/g, '').trim()
    const parsed = JSON.parse(raw)
    const text = String(parsed.message || '').trim()
    if (!text) throw new Error('empty message from model')
    const finalText = text.slice(0, MAX_OUT_CHARS)
    if (!preservesCriticalFacts(note, finalText)) throw new Error('rewrite dropped decision-relevant client facts')
    if (mode === 'owner' && !isReachout && !finalText.startsWith(`${maltaGreeting(now)},`)) {
      throw new Error('rewrite omitted the required first-contact greeting')
    }
    return {
      text: finalText,
      dropped: parsed.dropped ? String(parsed.dropped).slice(0, 200) : null,
      model: MODEL,
      rewritten: true,
    }
  } catch (err) {
    log.warn('[boardAsk] rewrite failed — falling back to the agent text', { ref, err: err.message })
    return { text: fallbackMessage({ mode, ref, recipientName, rawNote: note, isReachout, now }), dropped: null, model: null, rewritten: false }
  }
}

module.exports = {
  composeQuestion,
  maltaDay,
  insideWindow,
  nextSendTime,
  maltaGreeting,
  protectedFacts,
  preservesCriticalFacts,
  fallbackMessage,
  buildPrompt,
  WINDOW_START_HOUR,
  WINDOW_END_HOUR,
}
