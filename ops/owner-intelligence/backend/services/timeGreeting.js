'use strict'
// ============================================================================
// services/timeGreeting.js — one send-time rule for time-of-day wording in
// every 1:1 WhatsApp message (Kev, 2026-10-30).
//
// Evidence: an owner received "Good evening" at 12:53. Five services carry
// their own maltaGreeting() (availability, boardAsk, bookingOwnerAsk,
// fbOwnerSave, outreachSchedule), LLM replies pick a greeting with no clock
// at all, and autoOwnerConversation's FALL1 decline text ends in a fixed
// "have a good evening" at any hour. A greeting chosen when a draft was
// written is also wrong once the send is delayed (queue, retry, bridge down).
//
// waha.sendText() calls fixForSend() right before the wire, so the wording
// always matches the Malta time of the actual send. Deliberately narrow:
//   - opening: only "Good morning/afternoon/evening/night/day" at the very
//     start (optionally after "Hi"/"Hello"); a sentence that merely starts
//     with "Evening viewings …" is untouched
//   - closings: only the time word inside "have a nice evening", "enjoy your
//     afternoon", "good night" … is swapped; weekend/week wishes, the rest of
//     the sentence and its punctuation stay as written
//   - groups, broadcasts and newsletters are never touched
// Periods (Europe/Malta): 05:00–11:59 morning, 12:00–17:59 afternoon,
// 18:00–04:59 evening (the outreach window rule in outreachSchedule.js is
// separate: it decides WHEN outreach may send, this decides the WORDING).
// ============================================================================
const { maltaParts } = require('./outreachSchedule')

function periodAt(now = new Date()) {
  const h = maltaParts(now).hour
  if (h >= 5 && h < 12) return 'morning'
  if (h >= 12 && h < 18) return 'afternoon'
  return 'evening'
}

const OPENING_RE = /^(\s*(?:(?:hi|hello|hey)[\s,!]+)?)(good)(\s+)(morning|afternoon|evening|night|day)\b/i
// "have a nice evening", "have a lovely rest of your afternoon", "enjoy your
// morning", "wishing you a pleasant evening" — the time word is group 3.
const CLOSING_RE = /\b((?:have|enjoy|wishing\s+you)\s+(?:a\s+|an\s+|your\s+|the\s+)?(?:(?:very|really|lovely|nice|great|wonderful|good|pleasant|beautiful|relaxing|productive|fantastic|blessed)\s+){0,2}(?:rest\s+of\s+(?:your|the)\s+)?)(day|morning|afternoon|evening|night)\b/gi
const GOOD_NIGHT_RE = /\bgood\s*night\b(?=[\s!.,]*$)/i

const matchCase = (sample, word) => (sample[0] === sample[0].toUpperCase() ? word[0].toUpperCase() + word.slice(1) : word)

function isDirectChat(chatId) {
  const id = String(chatId || '')
  return !/@g\.us$|@newsletter$|@broadcast$|^status@/i.test(id)
}

// Returns { text, changed, period }. Pure; `now` is the send instant.
function fixTimeWording(text, now = new Date()) {
  const original = String(text == null ? '' : text)
  const period = periodAt(now)
  if (!original.trim()) return { text: original, changed: false, period }
  const opening = { morning: 'morning', afternoon: 'afternoon', evening: 'evening' }[period]
  let out = original.replace(OPENING_RE, (_, lead, good, space, word) => `${lead}${good}${space}${matchCase(word, opening)}`)
  // Closings: "day" is fine until 18:00; in the evening it becomes "evening".
  // A morning/afternoon/evening/night wish is moved to the current period.
  out = out.replace(CLOSING_RE, (whole, lead, word) => {
    const w = word.toLowerCase()
    if (w === 'day') return period === 'evening' ? `${lead}${matchCase(word, 'evening')}` : whole
    if (w === period) return whole
    if (w === 'night' && period === 'evening') return whole
    return `${lead}${matchCase(word, period === 'morning' ? 'day' : period)}`
  })
  if (period !== 'evening') out = out.replace(GOOD_NIGHT_RE, m => matchCase(m, period === 'morning' ? 'have a nice day' : 'have a nice afternoon'))
  return { text: out, changed: out !== original, period }
}

// The send hook. Never throws: a wording fix must never block a message.
function fixForSend(chatId, text, now = new Date()) {
  if (typeof text !== 'string' || !isDirectChat(chatId)) return text
  try { return fixTimeWording(text, now).text } catch (_) { return text }
}

module.exports = { periodAt, fixTimeWording, fixForSend, isDirectChat }
