'use strict'
// ============================================================================
// services/ownerTurnRouter.js — decide WHAT to do with an owner's message burst
// before any text is generated (Claude, 2026-11-09, ARGUS owner-intelligence
// recovery).
//
// Evidence (production screenshots, 2026-11-08/09):
//   - Cedric: owner asked "are u an agent n malta / or u have ur own properties"
//     and later "i asked u a questions lol / r u an agent or urs"; the bot sent
//     "Roughly what's the rent per month?", "How many bedrooms…", "And how many
//     bathrooms?". agentIdentityRegistry.AGENCY_QUESTION_RE only knew "are you an
//     agent", so the identity branch in processStep never fired and the intake
//     questionnaire ran instead.
//   - Gabriela: "Please let me [know] who you represent … nothing for sale but
//     might have for rent" got the decline closure "No worries, thank you for
//     your feedback…": "who you represent" did not match, and "nothing for sale"
//     won as a decline.
//   - Kevin: "…obtained my number illegally. Please remove my details from your
//     database." must be a global stop with no reply.
//
// The router is pure (no I/O): the caller supplies the burst, the verified
// sender identity and the thread state. It returns a typed decision. The
// priority order is fixed in code, not left to an LLM:
//   1 privacy stop  2 human handoff / review  3 answer the owner's question
//   4 correction    5 availability            6 new offer   7 facts   8 no reply
// Thread gates (duplicate, global DNC, paused account, human takeover, agent
// drafting, offline session, outside the send window) never let a reply out;
// only a privacy stop overrides them, because it must always be recorded.
// ============================================================================

const { isOptOut, isDataSourceQuestion } = require('./ownerOptOut')
const { isAgencyQuestion } = require('./agentIdentityRegistry')

const ROUTER_VERSION = 'owner-turn-router/2026-11-09.1'

const ROUTES = Object.freeze({
  PRIVACY_STOP: 'PRIVACY_STOP',
  HUMAN_HANDOFF: 'HUMAN_HANDOFF',
  HUMAN_REVIEW: 'HUMAN_REVIEW',
  ANSWER_QUESTION: 'ANSWER_QUESTION',
  CORRECT_FACT: 'CORRECT_FACT',
  AVAILABILITY_UPDATE: 'AVAILABILITY_UPDATE',
  PROPERTY_DRAFT: 'PROPERTY_DRAFT',
  FACT_UPDATE: 'FACT_UPDATE',
  ACK_ONLY: 'ACK_ONLY',
  NO_REPLY: 'NO_REPLY',
  NO_REPLY_HUMAN_ACTIVE: 'NO_REPLY_HUMAN_ACTIVE',
})

// ── 1. Privacy stops not covered by ownerOptOut.OPT_OUT_RES ──────────────────
const PRIVACY_STOP_EXTRA_RES = [
  /\b(?:you\s+have|you'?ve\s+got|this\s+is)\s+(?:the\s+)?wrong\s+(?:number|person)\b|\bwrong\s+number\b/i,
  /\b(?:do\s*not|don'?t|never)\s+(?:ever\s+)?(?:call|whats\s*app|message|text|contact)\s+(?:or\s+(?:call|whats\s*app|message|text)\s+)?me\b/i,
  /\b(?:do\s*not|don'?t)\s+follow\s*-?\s*up\b/i,
  /\b(?:contacted|messaged|texted)\s+me\s+from\s+(?:\w+\s+)?(?:different\s+)?numbers\b/i,
  /\bgot\s+my\s+number\s+illegally\b|\bobtained\s+my\s+number\s+illegally\b/i,
]
// "Wrong person attached to this number" is a record fix (review), not a stop.
const WRONG_PERSON_RECORD_RE = /\bwrong\s+person\s+attached\b/i

// "Please email dates, do not WhatsApp me" moves the owner to another channel
// (handoff); it is not a stop for every channel.
const CHANNEL_SWITCH_RE = /\b(?:e-?mail|call)\b[\s\S]{0,40}\b(?:do\s*not|don'?t)\s+whats\s*app\s+me\b(?!\s+again)/i

function isPrivacyStop(text) {
  if (WRONG_PERSON_RECORD_RE.test(text)) return false
  if (CHANNEL_SWITCH_RE.test(text) && !isOptOut(text)) return false
  return isOptOut(text) || PRIVACY_STOP_EXTRA_RES.some(re => re.test(text))
}

// ── 2. Human handoff (the owner asks for a person / another channel) ─────────
const HANDOFF_RES = [
  /\b(?:prefer|rather|want|like)\s+(?:dealing|to\s+deal|talking|to\s+talk|speaking|to\s+speak)\s+(?:with|to)\s+(?:a\s+)?(?:real|actual|human)\b/i,
  /\b(?:real|actual)\s+(?:person|human|agent)\b.{0,40}\b(?:email|call|contact)\b|\b(?:can|could)\s+an?\s+(?:real|actual)\s+(?:person|agent|human)\b/i,
  /\b(?:please\s+)?call\s+me\b|\bphone\s+me\b|\bring\s+me\b/i,
  /\b(?:do\s*not|don'?t)\s+want\s+automated\b|\bno\s+(?:more\s+)?automated\s+messages\b/i,
  /\bemail\b.{0,40}\b(?:do\s*not|don'?t)\s+whats\s*app\b/i,
  /\bnot\s+a\s+good\s+start\b|\byou\s+(?:did\s*n'?t|didn'?t|did\s+not)\s+answer\s+my\s+question\b|\bnot\s+answer(?:ed|ing)?\s+my\s+question\b/i,
]

// ── 2b. Human review (only a person may answer / act) ────────────────────────
const REVIEW_RES = [
  /\blicen[cs]e[ds]?\b|\bregistered\s+(?:agent|business|company)\b|\bregistration\s+(?:number|details)\b|\bcompany\s+number\b/i,
  /\bhow\s+long\s+have\s+you\s+(?:worked|been)\b|\byears?\s+of\s+experience\b/i,
  /\b(?:fee|fees|commission|charge\s+me|how\s+much\s+do\s+you\s+charge)\b/i,
  /\blist\s+(?:it\s+)?directly\b|\bwithout\s+an?\s+agent\b/i,
  /\bwhat\s+(?:information|data|details)\s+do\s+you\s+(?:have|hold|keep)\b/i,
  /\bwrong\s+person\s+attached\b/i,
  /\b(?:do\s*not|don'?t)\s+use\s+my\s+(?:photos|pictures|images)\b/i,
  /\b(?:take|remove)\s+my\s+(?:property|listing|flat|apartment)\s+off\b|\boff\s+your\s+website\b/i,
  /\bdelete\s+(?:flat|apartment|unit|the\s+listing)\b/i,
  /\balready\s+listed\s+(?:this|it)?\s*(?:through|with)\s+another\s+agency\b/i,
  /^\s*all\s+(?:are\s+)?rented(?:\s+now)?[.!]*\s*$/i,
  /\bthere\s+are\s+(?:\w+)\s+(?:more\s+)?in\s+[A-Z]\w+,?\s+too\b/i,
  /\b(?:no|not\s+for)\s+(?:indians?|africans?|arabs?|asians?|blacks?|muslims?|foreigners|nationals?|nigerians?|pakistanis?)\b/i,
  /\b(?:do\s*not|don'?t)\s+keep\s+reminding\b|\bstop\s+reminding\b/i,
  /^\s*\?+\s*$/,
  /\b(?:my\s+)?(?:brother|sister|husband|wife|son|daughter|father|mother)'?s?\s+number\b/i,
  /\bpassport\b|\bid\s+card\b|\bidentity\s+card\b/i,
  /\bi\s+am\s+not\s+the\s+owner\b|\bi'?m\s+not\s+the\s+owner\b|\bi\s+am\s+the\s+neighbou?r\b/i,
  /\b(?:do\s*not|don'?t)\s+share\s+(?:the\s+)?(?:photos|pictures)\s+with\s+other\s+agenc/i,
]
// Media with no binding to a known property.
const UNBOUND_MEDIA_RES = [
  /^\s*here\s+is\s+the\s+(?:bedroom|kitchen|bathroom|living\s+room)\s+(?:picture|photo)\.?\s*$/i,
  /\bphotos?\s+of\s+one\s+of\s+my\s+flats\b/i,
]

// ── 3. Questions the sender may answer from the verified registry ────────────
const QUESTION_TYPES = [
  ['identity', [
    /\b(?:which|what)\s+(?:real\s+)?(?:estate\s+)?(?:agency|agencies|company|firm)\b/i,
    /\bwho\s+(?:do\s+|are\s+)?(?:you|u)\s+(?:work(?:ing)?\s+(?:for|with)|represent(?:ing)?)\b/i,
    /\bwho\s+(?:you|u)\s+represent\b/i,
    /\b(?:are|r)\s+(?:you|u)\s+(?:an?\s+)?(?:agent|broker|realtor|freelancer|agency)\b/i,
    /\bagent\s+or\s+(?:urs|yours|owner|private)\b/i,
    /\b(?:do\s+)?(?:you|u)\s+have\s+(?:your|ur)\s+own\s+propert/i,
    /\bprivate\s+(?:client|buyer|person)\s+or\s+(?:a\s+)?(?:broker|agent)\b/i,
    /\bwork\s+only\s+for\s+one\b|\bdo\s+you\s+work\s+(?:independently|for)\b/i,
    /\bname\s+of\s+(?:your|the|ur)\s+(?:real\s+estate\s+|estate\s+)?(?:agency|company|firm)\b/i,
    /\bwhom\s+do\s+you\s+(?:work\s+for|represent)\b/i,
  ]],
  ['automation', [/\b(?:is\s+this|are\s+you)\s+(?:a\s+)?(?:bot|robot|ai|automated|machine)\b/i]],
  ['website', [/\b(?:website|web\s*site|site)\b.{0,20}\b(?:check|see|look)\b|\bdo\s+you\s+have\s+a\s+website\b/i]],
  ['purpose', [/\bwhat\s+(?:exactly\s+)?do\s+you\s+want\s+(?:from\s+me)?\b|\bwhy\s+(?:are\s+you|did\s+you)\s+(?:contact|messag|writ)/i]],
  ['data_source', [/\b(?:how|where)\s+did\s+you\s+get\s+(?:my|this)\s+(?:number|contact|details|phone)\b/i]],
  ['requirements', [/\bwhat\s+(?:information|details)\s+do\s+you\s+need\b/i]],
  ['photos_optional', [/\b(?:no|don'?t\s+have)\s+(?:any\s+)?photos\s+yet\b.{0,40}\b(?:still|note)\b/i]],
  ['client_type', [/\bwhat\s+(?:type|kind)\s+of\s+client/i]],
  ['subletting', [/\b(?:do\s+)?your\s+clients\s+sublet\b/i]],
  ['unclear_message', [/\b(?:i\s+)?(?:do\s*not|don'?t)\s+understand\b/i]],
  ['services', [/\b(?:do\s+you\s+)?handle\s+rentals?\s+and\s+sales?\b/i]],
]

const WHO_ARE_YOU_RE = /\bwho\s+(?:are|r)\s+(?:you|u)\b(?!\s+(?:looking|searching))|\b(?:are|r)\s+(?:you|u)\s+(?:from|with)\s+(?:an?\s+)?(?:agency|company)\b|\bagency\s+or\s+private\b/i

// A third-party auto-responder line ("Thank you for contacting Gabriella! How
// can we help?") is not the owner speaking and never changes our sender.
const THIRD_PARTY_AUTOREPLY_RE = /^\s*thank\s+you\s+for\s+contacting\s+[^!.\n]{1,40}[!.]?\s*(?:(?:please\s+let\s+us\s+know\s+)?how\s+(?:can|may)\s+we\s+help(?:\s+you)?[?.!]?)?\s*$/i

// ── 4. Corrections ──────────────────────────────────────────────────────────
const CORRECTION_RES = [
  /\bno,?\s+i\s+said\b|\bi\s+already\s+told\s+you\b|\bplease\s+read\s+what\s+i\s+wrote\b/i,
  /\bwhy\s+do\s+you\s+keep\s+saying\b/i,
  /\b(?:sorry,?\s+)?meant\s+\w+/i,
  /\bthat\s+price\s+was\s+for\b/i,
  /\bis\s+flat\s+\d+,?\s+not\s+flat\s+\d+\b/i,
]

// ── 5. Numbered replies to a listed availability check ──────────────────────
const NUMBERED_REPLY_RES = {
  both: /^\s*(?:both|both\s+(?:are\s+)?(?:available|free))[.!]*\s*$/i,
  neither: /^\s*(?:neither|none|no\s+one|neither\s+of\s+them)[.!]*\s*$/i,
  second: /^\s*only\s+the\s+second(?:\s+one)?[.!]*\s*$/i,
  first: /^\s*only\s+the\s+first(?:\s+one)?[.!]*\s*$/i,
  index: /^\s*(\d{1,2})\s*$/,
}

// ── Current availability vs. other availability facts ───────────────────────
const AVAILABILITY_NOW_RES = [
  /\bstill\s+available(?:\s+now)?\b(?!.{0,30}\bbut\b)/i,
  /\bis\s+(?:still\s+)?available\s+now\b/i,
  /\bnot\s+available\s+any\s*more\b/i,
  /\b(?:have|has)\s+been\s+rented\b.*\bavailable\b/i,
  /\bon\s+hold\s+until\b/i,
  /\banother\s+agency\s+rented\b|\brented\s+it\s+yesterday\b/i,
  /\btaken\b.{0,40}\bfree\b/i,
]
const AVAILABILITY_NOT_NOW_RES = [
  /\bno\s+viewings?\b/i, /\brenovat/i, /\bmoves?\s+out\b/i, /\buntil\s+\d{1,2}\s+\w+,?\s+free\s+from\b/i,
  /\bnothing\s+(?:is\s+)?signed\b/i, /\bfour\s+years\s+ago\b(?![\s\S]*\bstill\s+available\b)/i, /\bis\s+left\b/i,
]

// ── 6. New property offers ──────────────────────────────────────────────────
const PROPERTY_TYPE_RE = /\b(apartment|flat|studio|penthouse|maisonette|house|villa|office|room|duplex|townhouse|\d\s*(?:br|bed(?:room)?s?)\b|(?:one|two|three|four|1|2|3|4)[- ]?(?:bed(?:room)?s?|br)\b|flats|apartments)\b/i
const OFFER_CUE_RES = [
  /\bi\s+(?:have|might\s+have|may\s+have|got)\s+(?:a|an|one|two|three|four|five|\d|the|another)?\s*\w*/i,
  /\bfor\s+(?:sale|rent)\b/i,
  /\b(?:available|ready)\s+(?:in|from|next|after|immediately)\b/i,
  /\bshould\s+be\s+ready\b/i,
  /€\s?\d|\d\s?€/,
]
const EXISTING_PROPERTY_REF_RE = /\b(?:the\s+same\s+flat|the\s+apartment\s+we\s+discussed|it\s+is\s+(?:flat|on)\b|same\s+building)\b/i

// ── 8. Low-value / non-owner messages ───────────────────────────────────────
const PLEASANTRY_RE = /^\s*(?:thank(?:s|\s+you)(?:,?\s+have\s+a\s+(?:good|nice|great)\s+(?:day|evening|one))?|ok(?:ay)?|cheers|noted|👍|🙏|👌|😊)[\s.!]*$/iu
const SPAM_RE = /\b(?:crypto|forex|trading\s+group|investment\s+opportunity|click\s+(?:here|this\s+link)|earn\s+\$?\d+)\b/i
const NOTHING_NOW_RE = /^\s*(?:nothing|not)\s+(?:at\s+the\s+moment|right\s+now|currently|now)(?:,?\s+thanks?(?:\s+you)?)?[.!]*\s*$/i
const DEFERRED_LATER_RE = /\b(?:not\s+ready|will\s+let\s+you\s+know|let\s+you\s+know\s+(?:when|later))\b/i
const SELF_TAKEOVER_RE = /\bi\s+will\s+handle\s+this\s+owner\s+myself\b/i

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const LOCALITIES = ['Sliema', "St Julian's", 'St Julians', 'Gżira', 'Gzira', 'Msida', 'Mosta', 'Naxxar', 'Qawra', "St Paul's Bay", 'St Pauls Bay',
  'Birkirkara', 'Mellieħa', 'Mellieha', 'Valletta', 'Swieqi', 'Pembroke', 'Bugibba', 'Buġibba', 'Marsaskala', 'Żebbuġ', 'Attard',
  'Balzan', 'Lija', 'Iklin', 'San Ġwann', 'San Gwann', 'Ta’ Xbiex', 'Ta Xbiex', 'Floriana', 'Birgu', 'Rabat', 'Mdina', 'Siġġiewi',
  'Gozo', 'Victoria', 'Xlendi', 'Marsalforn', 'Baħar iċ-Ċagħaq', 'Bahar ic-Caghaq', 'Paceville', 'Tigné', 'Tigne']
const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, single: 1 }

function normApos(s) { return String(s || '').replace(/[‘’ʼ]/g, "'") }

function anyMatch(res, text) { return res.some(re => re.test(text)) }

// ── Fact extraction (deterministic; feeds private drafts and fact deltas) ────
function extractFacts(text) {
  const t = normApos(text)
  const f = {}
  const bed = t.match(/\b(\d|one|two|three|four|five)[- ]?(?:bed(?:room)?s?|br)\b/i) || t.match(/\b(\d)\s*BR\b/)
  if (bed) f.bedrooms = WORD_NUM[bed[1].toLowerCase()] || Number(bed[1])
  if (/\bstudio\b/i.test(t)) { f.type = 'studio'; delete f.bedrooms }
  else {
    const type = t.match(/\b(penthouse|maisonette|villa|house|office|apartment|flat)\b/i)
    if (type) f.type = type[1].toLowerCase() === 'flat' ? 'apartment' : type[1].toLowerCase()
  }
  if (/\b(?:single\s+)?room\s+in\s+(?:a\s+)?shared\b/i.test(t)) f.type = 'room_in_shared_apartment'
  const loc = LOCALITIES.find(l => new RegExp(`\\b${normApos(l).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t))
  if (loc) f.location = normApos(loc)
  const floorWord = t.match(/\b(first|second|third|fourth|fifth|ground)\s+floor\b/i)
  const FLOOR = { ground: 0, first: 1, second: 2, third: 3, fourth: 4, fifth: 5 }
  if (floorWord) f.floor = FLOOR[floorWord[1].toLowerCase()]
  const flat = t.match(/\bflat\s+(\d{1,3})\b/i)
  if (flat) f.flat = flat[1]
  const price = t.match(/€\s?(\d{1,3}(?:[,.]\d{3})+|\d+)(?:\s*(k))?|(\d{1,3}(?:[,.]\d{3})+|\d+)\s?€/)
  if (price) {
    const raw = (price[1] || price[3]).replace(/[,.](?=\d{3}\b)/g, '')
    f.price = Number(raw) * (price[2] ? 1000 : 1)
    f.transaction = /\bfor\s+sale\b|\basking\s+€?\s?\d{3},\d{3}/i.test(t) || f.price >= 20000 ? 'sale' : 'rent'
    if (/\bper\s+(?:day|night)\b/i.test(t)) f.price_unit = 'per_day'
  } else if (/\bfor\s+sale\b/i.test(t)) f.transaction = 'sale'
  else if (/\bfor\s+rent\b|\bonly\s+for\s+rent\b/i.test(t)) f.transaction = 'rent'
  const month = MONTHS.find(m => new RegExp(`\\b${m}\\b`, 'i').test(t))
  if (month) f.month = month[0].toUpperCase() + month.slice(1)
  if (/\bphotos?\s+(?:later|next\s+week|after|when)\b|\bno\s+photos\s+yet\b|\bstill\s+need\s+to\s+take\s+photos\b/i.test(t)) f.photos = 'pending'
  if (/\bwinter\s+let\b/i.test(t)) f.rental_mode = 'winter_let'
  else if (/\blong\s+let\b/i.test(t)) f.rental_mode = 'long_let'
  else if (/\bshort\s+(?:stay|let)\b/i.test(t)) f.rental_mode = 'short_stay'
  if (/\bmight\s+have\b|\bmaybe\b|\bshould\s+be\s+ready\b|\btentative|\bnot\s+sure\b/i.test(t)) f.tentative = true
  return f
}

// Status facts kept separate by time domain (PRP-01/05): historical rental,
// current status, owner's personal absence, viewing windows.
function extractStatusFacts(text) {
  const t = normApos(text)
  const f = {}
  if (/\b(?:rented|let)\b.{0,40}\b(?:years?|months?)\s+ago\b|\b(?:years?|months?)\s+ago\b.{0,40}\brented\b|\bwhen\s+(?:it\s+was\s+)?finished\b.{0,40}\brented\b/i.test(t)) f.past_rented = true
  if (/\b(?:still|is)\s+available(?:\s+now)?\b|\bis\s+free\b|\bfree\s+now\b/i.test(t)) f.current_status = 'available'
  if (/\bnot\s+available\s+any\s*more\b|\banother\s+agency\s+rented\b/i.test(t)) f.current_status = 'unavailable'
  if (/\bon\s+hold\b/i.test(t)) f.current_status = 'hold'
  if (/\bi\s+am\s+not\s+available\b|\bi'?m\s+not\s+available\b|\bi'?m\s+away\b/i.test(t)) f.owner_unavailable = true
  if (/\bno\s+viewings?\b|\bviewing\b/i.test(t)) f.viewing_constraint = true
  return f
}

function isNewOffer(ownerText, facts) {
  if (!ownerText || isOptOut(ownerText)) return false
  return PROPERTY_TYPE_RE.test(ownerText) && !EXISTING_PROPERTY_REF_RE.test(ownerText)
    && (/\bi\s+(?:have|might\s+have|may\s+have|got)\b/i.test(ownerText) || !!facts.location || /\bfor\s+(?:sale|rent)\b|\bwinter\s+let\b|\broom\s+in\b/i.test(ownerText))
    && anyMatch(OFFER_CUE_RES.concat([/\b(?:in|at)\s+[A-Z]/, /\broom\b/i, /\bwinter\s+let\b/i]), ownerText)
    && !/\bsame\s+building\b|\bone\s+flat\s+is\b|\beach\b|\bsold\s+the\s+house\b|\bphotos?\s+of\b|\bhere\s+(?:is|are)\b/i.test(ownerText)
    && !/\bno\s+photos\s+yet\b/i.test(ownerText)
}

function splitBurst(messages) {
  return (Array.isArray(messages) ? messages : [messages]).map(m => String(m || '').trim()).filter(Boolean)
}

function detectQuestions(text) {
  const t = normApos(text)
  const out = []
  for (const [type, res] of QUESTION_TYPES) if (anyMatch(res, t)) out.push(type)
  // One identity detector for both conversation paths (agentIdentityRegistry).
  if (!out.includes('identity') && (isAgencyQuestion(t) || WHO_ARE_YOU_RE.test(t))) out.unshift('identity')
  return out
}

// ── Reply rendering for ANSWER_QUESTION (verified registry facts only) ──────
function renderAnswer(questions, identity, ctx = {}) {
  if (!identity || !identity.name) return null
  const agency = identity.affiliationVerified ? identity.agency : null
  const parts = []
  const add = s => { if (s && !parts.includes(s)) parts.push(s) }
  for (const q of questions) {
    if (q === 'identity') {
      if (!agency) return null
      if (ctx.ownerIsAgent) add(`You're right, I missed your question. I'm ${identity.name}, a real estate professional with ${agency} in Malta. Thanks for clarifying that you're an agent too. Would you prefer to discuss potential collaboration rather than a specific property?`)
      else add(identity.introAnswer || `I'm ${identity.name}, a real estate professional working with ${agency} in Malta. I'm contacting you in that professional capacity, not as the owner of a property.`)
    } else if (q === 'automation') {
      if (!agency) return null
      add(`I'm an automated assistant supporting ${agency}. I can help collect property information, and a human colleague can take over if you prefer.`)
    } else if (q === 'website') {
      if (!identity.website) return null
      add(`Yes. Our website is ${identity.website}. You're welcome to have a look before deciding whether to continue.`)
    } else if (q === 'purpose') {
      add("I'm checking whether you have a property you're considering renting or selling, and whether you'd like to discuss it with an agent. There's no obligation to continue.")
    } else if (q === 'data_source') {
      if (!ctx.contactSourceVerified || !ctx.contactSourceLabel) return null
      add(`That's a fair question. Our records show your contact came from ${ctx.contactSourceLabel}. If you'd rather not be contacted, I'll stop further messages.`)
    } else if (q === 'requirements') {
      add('The essentials are the area, the type of property, the asking rent or price, and when it becomes available. Photos can follow later.')
    } else if (q === 'photos_optional') {
      add("Of course. I'll note it as a private draft with the photos pending, and nothing is published without your approval.")
    } else if (q === 'client_type') {
      add(identity.clientDescription
        ? `We work with ${identity.clientDescription}. The assigned agent will share the specific client's profile before any viewing.`
        : 'The assigned agent will share the specific client profile with you before any viewing.')
    } else if (q === 'subletting') {
      add("Clients don't sublet unless you explicitly agree to it in the contract. If you'd rather not allow it, I'll note that for the property.")
    } else if (q === 'unclear_message') {
      add("Sorry for the confusion. I'm simply asking whether you have a property available to rent or sell, and whether you'd like us to help find a suitable tenant or buyer.")
    } else if (q === 'services') {
      add('Yes, we handle both rentals and sales. Asking prices are always set by you as the owner.')
    }
  }
  return parts.length ? parts.join('\n\n') : null
}

/**
 * @param {object} input
 * @param {string[]|string} input.messages    owner burst, oldest first
 * @param {object|null} input.identity        verified sender identity (agentIdentityRegistry)
 * @param {object} [input.context]            thread state; every flag is optional
 * @returns {object} typed decision
 */
function routeOwnerTurn(input = {}) {
  const decision = routeContent(input)
  // A thread paused by an agent's manual message: intake still routes (a clear
  // offer still becomes a private draft), but nothing is sent (P0 E).
  if (input.context?.threadPaused && decision.shouldSend) {
    return { ...decision, shouldSend: false, holdReason: 'automation_paused_for_thread', policyGates: [...decision.policyGates, 'manual_pause'] }
  }
  return decision
}

function routeContent({ messages, identity = null, context = {} } = {}) {
  const ctx = context || {}
  const burst = splitBurst(messages)
  const text = normApos(burst.join('\n'))
  const decision = (route, extra = {}) => ({
    route,
    shouldSend: false,
    holdReason: null,
    questions: [],
    factsDelta: {},
    replyText: null,
    policyGates: [],
    senderPersona: identity?.persona || null,
    routerVersion: ROUTER_VERSION,
    ...extra,
  })

  if (ctx.duplicateEvent) return decision(ROUTES.NO_REPLY, { holdReason: 'duplicate_event', policyGates: ['idempotency'] })
  if (!text) return decision(ROUTES.NO_REPLY, { holdReason: 'empty' })

  // 1. Privacy stop: always recorded, whatever the thread state.
  if (isPrivacyStop(text)) {
    return decision(ROUTES.PRIVACY_STOP, {
      holdReason: 'privacy_stop', policyGates: ['global_suppression', 'privacy_review'],
      factsDelta: { global_suppress: true },
    })
  }

  const facts = { ...extractFacts(text), ...extractStatusFacts(text) }
  // Intake runs independently of the reply decision: a clear offer becomes a
  // private draft even when a human has taken over or the thread is paused.
  if (isNewOffer(normApos(burst.filter(line => !THIRD_PARTY_AUTOREPLY_RE.test(normApos(line))).join('\n')), facts)) facts.private_draft = true

  // Thread gates: nothing is sent; facts may still be recorded by the caller.
  if (ctx.globallySuppressed) return decision(ROUTES.NO_REPLY, { holdReason: 'global_dnc', factsDelta: facts, policyGates: ['global_suppression'] })
  if (ctx.accountPaused || ctx.automationPaused) return decision(ROUTES.NO_REPLY, { holdReason: 'automation_paused', factsDelta: facts, policyGates: ['manual_pause'] })
  if (ctx.humanActive) return decision(ROUTES.NO_REPLY_HUMAN_ACTIVE, { holdReason: 'human_takeover', factsDelta: facts, policyGates: ['agent_takeover'] })
  if (ctx.agentDrafting || SELF_TAKEOVER_RE.test(text)) return decision(ROUTES.NO_REPLY, { holdReason: 'agent_active', factsDelta: facts, policyGates: ['agent_takeover'] })
  if (ctx.sessionOnline === false) return decision(ROUTES.HUMAN_REVIEW, { holdReason: 'session_offline', policyGates: ['wa_session'] })
  if (ctx.withinSendWindow === false) return decision(ROUTES.NO_REPLY, { holdReason: 'outside_send_window', factsDelta: facts, policyGates: ['send_window'] })

  // Third-party auto-responder lines are removed before routing.
  const ownerLines = burst.filter(line => !THIRD_PARTY_AUTOREPLY_RE.test(normApos(line)))
  if (!ownerLines.length) return decision(ROUTES.NO_REPLY, { holdReason: 'third_party_autoreply', factsDelta: { possible_third_party_autoreply: true } })
  const ownerText = normApos(ownerLines.join('\n'))

  if (SPAM_RE.test(ownerText)) return decision(ROUTES.NO_REPLY, { holdReason: 'unsolicited_promotion' })

  // 2. Handoff / review.
  if (anyMatch(HANDOFF_RES, ownerText)) return decision(ROUTES.HUMAN_HANDOFF, { holdReason: 'owner_requested_human', factsDelta: { handoff_required: true } })
  const dataSourceAsked = isDataSourceQuestion(ownerText)
  if (dataSourceAsked && (!ctx.contactSourceVerified || /\bnever\s+(?:agreed|gave|consented)\b/i.test(ownerText))) {
    return decision(ROUTES.HUMAN_REVIEW, { holdReason: 'contact_source_review', factsDelta: { contact_status: 'permission_review' } })
  }
  if (anyMatch(REVIEW_RES, ownerText) || anyMatch(UNBOUND_MEDIA_RES, ownerText)) {
    return decision(ROUTES.HUMAN_REVIEW, { holdReason: 'needs_human_judgement', factsDelta: facts })
  }

  // 3. Direct questions — answered before any property field is chased.
  const questions = detectQuestions(ownerText)
  if (questions.length) {
    const ownerIsAgent = /\bi\s*(?:am|'m)\s+(?:an?\s+)?agent\b|\bwe\s+have\s+(?:a\s+)?(?:variety|lot|lots)\s+of\s+clients\b/i.test(ownerText)
      && /\b(?:asked\s+(?:u|you)\s+a\s+question|r\s+u|are\s+(?:u|you))\b/i.test(ownerText)
    const replyText = renderAnswer(questions, identity, { ...ctx, ownerIsAgent })
    if (questions.includes('photos_optional')) { facts.private_draft = true; facts.photos = 'pending' }
    const holdReason = replyText ? null
      : (!identity ? 'sender_persona_unknown' : questions.includes('identity') && !identity.affiliationVerified ? 'sender_affiliation_unverified' : 'no_verified_answer')
    return decision(ROUTES.ANSWER_QUESTION, {
      questions, replyText, shouldSend: !!replyText, holdReason, factsDelta: facts,
      policyGates: replyText ? ['verified_registry'] : ['hold_for_admin'],
    })
  }

  // 4. Corrections.
  if (anyMatch(CORRECTION_RES, ownerText)) return decision(ROUTES.CORRECT_FACT, { factsDelta: { ...facts, correction: true } })

  // 5. Numbered availability replies (only with a listed check in context).
  const options = Array.isArray(ctx.numberedOptions) ? ctx.numberedOptions : []
  if (options.length) {
    let available = null
    if (NUMBERED_REPLY_RES.both.test(ownerText) && options.length === 2) available = [1, 2]
    else if (NUMBERED_REPLY_RES.neither.test(ownerText)) available = []
    else if (NUMBERED_REPLY_RES.second.test(ownerText)) available = [2]
    else if (NUMBERED_REPLY_RES.first.test(ownerText)) available = [1]
    else {
      const idx = ownerText.match(NUMBERED_REPLY_RES.index)
      if (idx && Number(idx[1]) >= 1 && Number(idx[1]) <= options.length) available = [Number(idx[1])]
    }
    if (available) {
      return decision(ROUTES.AVAILABILITY_UPDATE, {
        factsDelta: { available_refs: available.map(i => options[i - 1]), unconfirmed_refs: options.filter((_, i) => !available.includes(i + 1)) },
      })
    }
  }

  // Etiquette before offers: a pleasantry or "nothing now" is not a property.
  if (PLEASANTRY_RE.test(ownerText)) return decision(ROUTES.NO_REPLY, { holdReason: 'low_value_message' })
  if (NOTHING_NOW_RE.test(ownerText) || (ownerLines.length > 1 && DEFERRED_LATER_RE.test(ownerText))) {
    return decision(ROUTES.ACK_ONLY, { factsDelta: { ...facts, current_supply: 'none_now' } })
  }

  // 5b. Current availability statements.
  if (anyMatch(AVAILABILITY_NOW_RES, ownerText) && !anyMatch(AVAILABILITY_NOT_NOW_RES, ownerText)) {
    return decision(ROUTES.AVAILABILITY_UPDATE, { factsDelta: facts })
  }

  // 6. New offers become private drafts, even with fields missing.
  if (isNewOffer(ownerText, facts)) {
    return decision(ROUTES.PROPERTY_DRAFT, { factsDelta: { ...facts, private_draft: true } })
  }

  // 7. Everything else with content is a fact update for the linked property.
  return decision(ROUTES.FACT_UPDATE, { factsDelta: facts })
}

module.exports = {
  ROUTER_VERSION, ROUTES, routeOwnerTurn, renderAnswer, detectQuestions, extractFacts, extractStatusFacts, isPrivacyStop,
  THIRD_PARTY_AUTOREPLY_RE,
}
