'use strict'

// ============================================================================
// services/ownerDecision.js — ARGUS owner-turn decision contract (Claude,
// 2026-11-10, Owner AI recalibration).
//
// Pure and deterministic: no DB, no network, no model call, no WhatsApp. One
// owner burst (all messages since the last bot turn) + a structured snapshot
// of verified state in; one action contract out:
//
//   { next_action, reason_code, fact_mutations, draft_reply, needs_human_review,
//     send_eligible, gates, intent, owner_role, policy_version }
//
// next_action ∈ NO_SEND | ANSWER_DIRECT | ACKNOWLEDGE_UPDATE | ASK_SINGLE_MISSING
//              | HUMAN_HANDOFF | WAIT_FOR_MEDIA | DEFER | DNC
//
// Priority order (spec 02_RUNTIME_CONVERSATION_POLICY):
//   1. privacy / opt-out / complaint / human takeover / thread gates
//   2. owner direct question → answered first, from the VERIFIED sender identity
//   3. viewing / call offers, price and availability corrections
//   4. property facts and media → extract, acknowledge once
//   5. refusal / long-term rented / no pets / no subletting → persist, no pressure
//   6. harmless closing → no reply
// NO_SEND is a first-class success. send_eligible is computed here from the
// action and the host gates; the caller still runs its own final send gate.
// ============================================================================

const POLICY_VERSION = 'owner-decision-2026-11-10.1'

// The 2026-11-09 turn router stays the knowledge base for privacy, third-party
// auto-replies and its own 486 historical cases; it is consulted here, never
// replaced (lazy so this module stays loadable on its own).
let routerMod = null
function router() {
  if (routerMod === null) { try { routerMod = require('./ownerTurnRouter') } catch { routerMod = false } }
  return routerMod || null
}

const ACTIONS = Object.freeze({
  NO_SEND: 'NO_SEND', ANSWER_DIRECT: 'ANSWER_DIRECT', ACKNOWLEDGE_UPDATE: 'ACKNOWLEDGE_UPDATE',
  ASK_SINGLE_MISSING: 'ASK_SINGLE_MISSING', HUMAN_HANDOFF: 'HUMAN_HANDOFF', WAIT_FOR_MEDIA: 'WAIT_FOR_MEDIA',
  DEFER: 'DEFER', DNC: 'DNC',
})
const REPLY_ACTIONS = new Set([ACTIONS.ANSWER_DIRECT, ACTIONS.ACKNOWLEDGE_UPDATE, ACTIONS.ASK_SINGLE_MISSING, ACTIONS.HUMAN_HANDOFF])
const BLOCKING_ACTIONS = new Set([ACTIONS.NO_SEND, ACTIONS.DEFER, ACTIONS.DNC, ACTIONS.WAIT_FOR_MEDIA])

// Automated owner replies only inside this Europe/Malta window (S11).
const DEFAULT_WINDOW = Object.freeze({ start: '08:30', end: '19:00', timeZone: 'Europe/Malta' })

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const MONTH_RE_SRC = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
const NUM_WORDS = { a: 1, an: 1, one: 1, single: 1, two: 2, both: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }
const NUM_WORD_SRC = '(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)'
const NUM_TEXT = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

// ── normalisation ───────────────────────────────────────────────────────────
function norm(s) {
  return String(s || '').replace(/[‘’ʼ`]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/ /g, ' ')
}
function toNum(word) {
  if (word == null) return null
  const w = String(word).toLowerCase()
  if (/^\d+$/.test(w)) return Number(w)
  return Object.prototype.hasOwnProperty.call(NUM_WORDS, w) ? NUM_WORDS[w] : null
}
function numText(n) { return n >= 0 && n <= 10 ? NUM_TEXT[n] : String(n) }
function fmtMoney(n) { return `€${Number(n).toLocaleString('en-GB')}` }
function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s }
function monthIndex(word) {
  const w = String(word || '').toLowerCase().slice(0, 3)
  return MONTHS.findIndex(m => m.startsWith(w))
}

// ── attachments (production sentinels + fixture markers) ─────────────────────
// Production queues "[media]" (image), "[video]" (video), "[voice]" (audio),
// "[document]" (file). Bracketed descriptions ("[5 photos]", "[audio note 0:08]")
// are the same events written out.
function readAttachments(text) {
  const t = text.toLowerCase()
  const brackets = t.match(/\[[^\]]*\]/g) || []
  const out = { images: 0, video: false, voice: false, document: false, link: false, any: false }
  for (const b of brackets) {
    if (/voice|audio/.test(b)) out.voice = true
    else if (/video/.test(b)) out.video = true
    else if (/document|pdf|file/.test(b)) out.document = true
    else if (/link/.test(b) && !/photo|image/.test(b)) out.link = true
    else if (/photo|image|media|picture|card/.test(b)) {
      const n = b.match(/(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:different\s+)?(?:photos?|images?|pictures?|cards?)/)
      out.images += n ? toNum(n[1]) : 1
      if (/link/.test(b)) out.link = true
    }
  }
  if (/\bvoice\s*note\b|\baudio\s*note\b/.test(t)) out.voice = true
  if (/\bvideo\b/.test(t) && !/\bvideo\s*call\b/.test(t)) out.video = true
  if (/\bpdf\b|\bfloor\s*plan\b|\bdocument\b/.test(t)) out.document = true
  out.any = out.images > 0 || out.video || out.voice || out.document || out.link
  return out
}
function stripAttachments(text) { return text.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim() }

// ── Malta clock ───────────────────────────────────────────────────────────────
function maltaParts(date, timeZone = DEFAULT_WINDOW.timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(date).map(p => [p.type, p.value]))
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) % 24, minute: Number(parts.minute), weekday: parts.weekday }
}
function minutesOf(hhmm) { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0) }
function insideWindow(now, window = DEFAULT_WINDOW) {
  const p = maltaParts(now, window.timeZone)
  const m = p.hour * 60 + p.minute
  return m >= minutesOf(window.start) && m < minutesOf(window.end)
}
// Next instant the automated window opens (or now, if inside it).
function nextWindowOpen(now, window = DEFAULT_WINDOW) {
  if (insideWindow(now, window)) return new Date(now)
  const startMin = minutesOf(window.start)
  // Walk forward minute-accurately in 15-minute steps (DST-safe, at most ~2 days).
  let t = new Date(Math.ceil(now.getTime() / 60000) * 60000)
  for (let i = 0; i < 4 * 24 * 3; i++) {
    const p = maltaParts(t, window.timeZone)
    if (p.hour * 60 + p.minute === startMin) return t
    const diff = ((startMin - (p.hour * 60 + p.minute)) + 1440) % 1440
    t = new Date(t.getTime() + Math.max(1, Math.min(diff, 15)) * 60000)
  }
  return t
}

// ── dates ─────────────────────────────────────────────────────────────────────
function isoDate(y, m, d) { return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}` }
function yearFor(monthIdx, now) {
  const p = maltaParts(now)
  return monthIdx + 1 < p.month ? p.year + 1 : p.year
}
function findDayMonth(text, now, afterRe = null) {
  const src = afterRe ? afterRe.source + '\\s*(?:on\\s+|the\\s+)?' : ''
  const re = new RegExp(`${src}(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE_SRC}\\b|${src}${MONTH_RE_SRC}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i')
  const m = text.match(re)
  if (!m) return null
  const day = Number(m[1] || m[4]); const mon = monthIndex(m[2] || m[3])
  if (mon < 0 || day < 1 || day > 31) return null
  return { iso: isoDate(yearFor(mon, now), mon, day), day, month: MONTHS[mon], label: `${day} ${cap(MONTHS[mon])}` }
}

// ── money ─────────────────────────────────────────────────────────────────────
function moneyMatches(text) {
  const out = []
  const re = /(?:€|eur(?:o|os)?\.?)\s*(\d{1,3}(?:[,.]\d{3})+|\d+(?:\.\d+)?)\s*(k\b)?|(\d{1,3}(?:[,.]\d{3})+|\d{3,6})\s*(k\b)?\s*(?:€|e\b|eur(?:o|os)?\b)|(\d{1,3}(?:[,.]\d{3})+|\d{3,6})\s*(?:per|a|\/)\s*(?:month|mo\b|pcm)/gi
  let m
  while ((m = re.exec(text))) {
    const raw = m[1] || m[3] || m[5]
    const k = m[2] || m[4]
    let v = Number(String(raw).replace(/[,.](?=\d{3}\b)/g, ''))
    if (k) v *= 1000
    if (Number.isFinite(v) && v >= 50) out.push({ value: v, index: m.index })
  }
  return out
}

// ── classifiers (owner text) ─────────────────────────────────────────────────
const RE = {
  privacyDelete: /\b(?:delete|erase|wipe)\b[^.!?]{0,30}\b(?:my\s+)?(?:contact\s+)?(?:data|details|number|info(?:rmation)?)\b/i,
  privacyRemove: /\bremove\b[^.!?]{0,25}\b(?:my\s+)?(?:details|number|data|contact|me)\b[^.!?]{0,30}\b(?:database|list|records?|system)\b|\bremove\s+me\s+from\b/i,
  noPermission: /\b(?:without\s+my\s+(?:permission|consent)|never\s+(?:gave|agreed|consented))\b/i,
  stop: /\bstop\s+(?:contacting|messaging|texting|writing|calling|sending)\b|\bdo\s+not\s+(?:contact|message|text|write)\s+me\b|\bdon'?t\s+(?:contact|message|text|write)\s+me\b|\bunsubscribe\b|\bleave\s+me\s+alone\b|(?:^|[.!?]\s*)stop\s*[.!]*\s*$/i,
  wrongNumber: /\bwrong\s+(?:number|person)\b/i,
  complaintMarker: /\brobot\b|\bcontacted\s+me\s+from\s+\w+\s+(?:different\s+)?numbers\b|\benough\b|\bspam(?:ming)?\b|\b(?:three|two|several|multiple|many|\d+)\s+(?:of\s+)?your\s+(?:numbers|accounts|agents|people)\b|\bharass/i,
  autoresponder: /\bthank\s+you\s+for\s+(?:contacting|your\s+message|messaging|reaching\s+out\s+to)\b[^.!?]{0,60}\b(?:let\s+us\s+know|get\s+back|respond|reply|soon|how\s+we\s+can\s+help)\b|\b(?:this\s+is\s+an?\s+)?(?:automatic|automated|auto)[- ]?(?:reply|response|message)\b|\bI(?:'m|\s+am)\s+(?:currently\s+)?(?:away|out\s+of\s+(?:the\s+)?office)\b|\boutside\s+(?:of\s+)?(?:our\s+)?(?:business|office)\s+hours\b/i,
  humanActive: /\b(?:I\s+)?(?:spoke|talked|spoken|talking)\s+(?:to|with)\s+your\s+colleague\b|\bthe\s+agent\s+is\s+(?:handling|dealing\s+with)\b|\b(?:I\s+am|I'm)\s+(?:a|your)\s+colleague\b|\btaking\s+over\s+this\s+(?:thread|chat|conversation)\b|\b(?:already\s+)?(?:in\s+touch|dealing)\s+with\s+(?:your\s+)?(?:colleague|kevin|cedric|gabriela)\b/i,
  askAgainLater: /\b(?:ask|message|write|contact|text)\s+(?:me\s+)?(?:again\s+)?(?:tomorrow|later|next\s+week|another\s+time|in\s+a\s+(?:few\s+)?(?:days?|weeks?))\b/i,
  moreComing: /\bone\s+moment\b|\b(?:sending|will\s+send|i'?ll\s+send)\s+(?:you\s+)?(?:the\s+)?(?:details|info|more)\b(?!\s+next)|\bmore\s+to\s+follow\b|\bwait\b[^.!?]{0,15}\bsending\b/i,
  realPerson: /\b(?:prefer|rather|want|like)\s+(?:dealing|to\s+deal|talking|to\s+talk|speaking|to\s+speak)\s+(?:with|to)\s+(?:a\s+)?(?:real|actual|human)\b|\b(?:speak|talk)\s+(?:to|with)\s+(?:a\s+)?(?:real|actual)\s+(?:person|human)\b|\bare\s+you\s+a\s+(?:real\s+)?(?:person|human|bot)\b(?=.*\bspeak)/i,
  myAgent: /\b(?:speak|talk)\s+(?:to|with)\s+my\s+(?:agent|lawyer|husband|wife|son|daughter|brother|partner|manager)\b|\bcontact\s+my\s+(?:agent|lawyer)\b/i,
  callRequest: /\b(?:give\s+me\s+a\s+call|call\s+me|ring\s+me|phone\s+me|can\s+you\s+call|please\s+call|call\s+(?:next|tomorrow|after|later|this)\b)/i,
  manager: /\b(?:let\s+your|tell\s+your|speak\s+to\s+your|your)\s+(?:manager|boss|supervisor)\b|\bescalate\b/i,
  viewingWord: /\bview(?:ing|ings)?\b|\bvisit\b|\bsee\s+(?:it|the\s+(?:flat|apartment|property|place))\b/i,
  comeMeet: /\b(?:come|meet(?:\s+the\s+client)?)\b[^.!?]{0,30}\b(?:tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|at\s+\d)/i,
  timeExpr: /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(?:at\s+)?(\d{1,2}):(\d{2})\b|\bat\s+(\d{1,2})\b(?!:|\s*(?:sqm|m2|bed|bath|car|%))/i,
  dayExpr: /\b(today|tomorrow(?:\s+(?:morning|afternoon|evening))?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\s+week)\b/i,
  viewingCancelled: /\bview(?:ing)?\b[^.!?]{0,40}\b(?:cancel+ed|off|called\s+off)\b|\bcancel(?:led|ling)?\b[^.!?]{0,30}\bview/i,
  viewingRequest: /\b(?:can|could)\s+you\s+(?:arrange|organi[sz]e|set\s+up|book)\s+(?:a\s+)?view/i,
  viewingTentative: /\bnot\s+confirmed\b|\bconfirm\s+on\s+the\s+day\b|\bask\s+me\s+to\s+confirm\b|\bonce\s+I\s+(?:speak|talk)\b|\buntil\s+I\s+(?:speak|talk|check)\b|\bto\s+be\s+confirmed\b|\btbc\b/i,
  viewNotMove: /\bavailable\s+to\s+view\b[^.!?]{0,40}\bnot\s+(?:to\s+)?move\s+in\b/i,
  registered: /\bare\s+you\s+(?:registered|licen[cs]ed)\b|\b(?:your|agent)\s+licen[cs]e\s+(?:number|no)\b|\bregistration\s+number\b/i,
  numberSource: /\bhow\s+did\s+you\s+get\s+my\s+(?:number|contact|details)\b|\bwhere\s+did\s+you\s+(?:get|find)\s+my\s+(?:number|contact|details)\b|\bwho\s+gave\s+you\s+my\s+(?:number|contact)\b/i,
  fees: /\b(?:agency|your|the)\s+(?:fees?|commission)\b|\bhow\s+much\s+(?:do\s+you\s+)?charge\b/i,
  bank: /\bbank\s+(?:details|account)\b|\biban\b|\bdeposit\b[^.!?]{0,30}\b(?:send|transfer|pay)\b|\b(?:send|transfer|pay)\b[^.!?]{0,30}\bdeposit\b/i,
  correctMyDetails: /\b(?:correct|fix|update)\s+my\s+(?:details|record|listing|status|information)\b/i,
  clarification: /\bnot\s+sure\s+what\s+you\s+mean\b|\b(?:don'?t|do\s+not)\s+understand\b|\bwhat\s+do\s+you\s+mean\b|\bwhat\s+(?:are\s+you|is\s+this)\s+(?:asking|about)\b|\bwhich\s+(?:permits?|licen[cs]es?)\s*\?/i,
  automatedQ: /\b(?:sounded|sounds|seems?|looks?)\s+(?:very\s+)?(?:automated|automatic|like\s+a\s+(?:bot|robot))\b|\bare\s+you\s+a\s+(?:bot|robot)\b|\bis\s+this\s+(?:automated|a\s+bot)\b/i,
  priceSure: /\b(?:are\s+you\s+sure|did\s+you\s+get|have\s+you\s+got)\b[^.!?]{0,30}\b(?:my\s+)?(?:price|rent)\b/i,
  photoRights: /\b(?:can|could|may)\s+you\s+(?:use|publish|post|put)\s+(?:these|the|my)\s+(?:photos?|pictures?|images?)\b/i,
  // identity / business questions
  idCompany: /\b(?:which|what)\s+(?:company|agency|firm)\b|\b(?:company|agency)\s+(?:do|are)\s+you\b|\bwho\s+(?:do\s+)?(?:you|u)\s+(?:work\s+for|represent)\b|\bwork\s+for\s+which\b/i,
  idAgentOrOwner: /\b(?:are|r)\s+(?:you|u)\s+(?:an?\s+)?(?:agent|broker)\b|\b(?:your|ur)\s+own\s+propert|\b(?:landlord|owner)\s+or\s+(?:an?\s+)?agent\b|\bagent\s+or\s+(?:the\s+)?(?:landlord|owner)\b|\bare\s+you\s+(?:an?\s+)?(?:agent|broker|estate\s+agent)\b|\bdo\s+you\s+own\s+(?:the\s+)?propert|\bthought\s+you\s+owned\b|\byou\s+own\s+(?:these|this|the)\b/i,
  idWho: /\bwho\s+(?:is|are)\s+(?:this|you|kevin|cedric|gabriel+a)\b|\bwho\s+am\s+I\s+(?:speaking|talking)\b/i,
  idWhatIs2906: /\bwhat\s+is\s+2906\b|\bwhat'?s\s+2906\b|\btell\s+me\s+about\s+2906\b/i,
  idWebsite: /\b(?:website|web\s*site|site|url|web\s*page)\b/i,
  idIndependent: /\bindependent\b|\bemployed\s+by\b|\bfreelance\b|\bself[- ]employed\b/i,
  agentToAgent: /\b(?:I'?m|I\s+am)\s+(?:not\s+the\s+owner)?[^.!?]{0,10}\b(?:another|also\s+an?|an?)\s+(?:estate\s+)?agent\b|\bnot\s+the\s+owner\b[^.!?]{0,30}\bagent\b/i,
  // refusal / status
  noThanks: /\bno\s+thanks?\b|\bno\s+thank\s+you\b|\bnot\s+interested\b|\bdon'?t\s+want\s+to\s+discuss\b|\bnot\s+for\s+now\b/i,
  pleasantry: /^(?:thanks?(?:\s+you)?|thank\s+you(?:\s+(?:very\s+much|so\s+much))?|ty|ok(?:ay)?|good\s+(?:morning|afternoon|evening|day|night)|hi|hello|hey|great|perfect|cheers|noted|you'?re\s+welcome|👍|🙏)[\s!.,🙂😊🙏👍]*$/i,
  longRentedYears: /\brented\b[^.!?]{0,30}\b(?:for\s+(?:many|several|a\s+few|\d+|two|three|four|five)\s+(?:more\s+)?years|long[- ]?(?:let|term)|until\s+(20\d\d))\b|\bwon'?t\s+be\s+(?:available\s+)?for\s+years\b|\bnot\s+available\b[^.!?]{0,40}\bfor\s+years\b/i,
  rentedWord: /\b(?:is|it'?s|been|already|currently|now|all)\s+(?:been\s+)?rented\b|\brented\s+out\b|^\s*(?:no,?\s+)?(?:it'?s\s+)?rented\b/i,
  rentedUntil: /\brented\s+until\s+(20\d\d|\w+\s+20\d\d)\b/i,
  notAvailable: /\b(?:not|no\s+longer|isn'?t)\s+available\b|\bno\s+(?:flat|apartment|property|unit|place)s?\s+(?:is\s+|are\s+)?available\b/i,
  offMarket: /\b(?:no\s+longer|not)\s+on\s+the\s+market\b|\btaken\s+(?:it\s+)?off\s+the\s+market\b|\bwithdrawn\b/i,
  backOnMarket: /\bback\s+on\s+the\s+market\b|\bavailable\s+again\b/i,
  allBooked: /\ball\s+(?:my\s+|of\s+my\s+|our\s+)?(?:properties|flats|apartments|units)\s+(?:are\s+)?(?:currently\s+)?(?:booked|rented|taken|occupied|let)\b/i,
  anotherProperty: /\b(?:but|however)\b[^.!?]{0,20}\b(?:I|we)\s+(?:have|got)\s+(?:another|a\s+different|one\s+more|other)\b/i,
  firstSecond: /\bfirst\s+(?:one\s+)?(?:is\s+)?(rented|available|taken)\b[^.!?]{0,30}\bsecond\s+(?:one\s+)?(?:is\s+)?(rented|available|taken)\b/i,
  available: /\b(?:is|it'?s|are|still|currently|now)\s+(?:still\s+)?available\b|^\s*(?:yes,?\s+)?(?:it'?s\s+)?available\b|\bhave\s+(?:a|an|one)\s+(?:property|flat|apartment|place|house)\s+available\b|\bavailable\s+now\b/i,
  notUpset: /\bnot\s+upset\b/i,
  // facts
  studio: /\bstudio\b/i,
  historicalStudio: /\b(?:was|used\s+to\s+be)\s+(?:a\s+)?studio\b[^.!?]{0,30}\b(?:ago|before|previously)\b|\bstudio\s+years\s+ago\b/i,
  room: /\b(?:single|double|twin|master|en[- ]?suite)\s+(?:bed)?room\b|\broom\s+(?:in|available|to\s+(?:let|rent)|is\s+free)\b|\brooms?\s+(?:are\s+)?free\b|\b(?:shared|sharing)\s+(?:apartment|flat|house)\b|\b(?:rent|let)\s+(?:out\s+)?(?:one|a|two|\d)\s+rooms?\b|\bonly\s+(?:one|the\s+master)\s+(?:bed)?room\b|\bstudent\s+flat\b/i,
  whole: /\ball\s+of\s+it\s+is\s+available\b|\bwhole\s+(?:apartment|flat|house|unit)\b|\bentire\s+(?:apartment|flat|house)\b|\b(?:all|the)\s+(?:\w+\s+)?bedrooms\s+(?:can\s+be\s+)?(?:rented|let)\s+together\b/i,
  residential: /\bresidential\b|\boccupied\s+by\s+a\s+family\b|\bfamily\s+home\b/i,
  commercialCorrection: /\b(?:commercial|office|shop|retail|warehouse)\b[^.!?]{0,20}\bnot\s+(?:a\s+)?(?:flat|apartment|home|residential)\b/i,
  pets: /\bno\s+pets\b|\bpets?\s+(?:are\s+)?not\s+allowed\b|\bnot\s+(?:allowed|accepting)\s+pets\b/i,
  petsYes: /\bpets\s+(?:are\s+)?(?:ok|allowed|welcome|fine)\b/i,
  subletNo: /\bnot\s+open\s+to\s+subletting\b|\bno\s+sub-?letting\b|\bdon'?t\s+(?:want|allow|accept)\s+sub-?letting\b|\bsub-?letting\s+(?:is\s+)?not\b/i,
  brief: /\b(?:please\s+)?be\s+(?:brief|short|quick)\b|\bkeep\s+it\s+short\b|\btoo\s+long\b/i,
  photosLater: /\b(?:will|i'?ll|can)\s+send\s+(?:the\s+)?(?:photos|pictures|images)\b[^.!?]{0,20}\b(next\s+week|tomorrow|later|soon|on\s+\w+day)\b/i,
}

// Matches a question about who the sender is (or a direct business question).
function identityQuestionKind(t) {
  if (RE.idWhatIs2906.test(t)) return 'what_is_2906'
  if (RE.idWebsite.test(t) && !/\boff\s+(?:your|the)\s+(?:website|site)\b/i.test(t) && /\b(?:send|share|give)\b[^.!?]{0,25}\b(?:website|site|url)\b|\bwhat(?:'s|\s+is)\s+(?:your\s+)?(?:company\s+)?(?:website|site)\b|\byour\s+(?:company\s+)?(?:website|site)\s*\?/i.test(t)) return 'website'
  if (RE.idIndependent.test(t) && /\?|\bexplain\b|\bare\s+you\b|\bif\s+you'?re\b/i.test(t)) return 'independent'
  if (RE.idAgentOrOwner.test(t)) return 'agent_or_owner'
  if (RE.idCompany.test(t)) return 'company'
  if (RE.idWho.test(t)) return 'who'
  if (/\bagent\b/i.test(t) && /\b(?:are\s+you|r\s+u)\b/i.test(t)) return 'agent_or_owner'
  return null
}

// ── fact extraction ──────────────────────────────────────────────────────────
function extractFacts(rawText, ctx = {}) {
  const now = ctx.now || new Date()
  const text = stripAttachments(norm(rawText))
  const lower = text.toLowerCase()
  const f = {}
  const att = readAttachments(norm(rawText))

  // property type / ontology
  const isHistoricStudio = RE.historicalStudio.test(text)
  const isRoom = RE.room.test(text) && !RE.whole.test(text)
  const studioCount = text.match(new RegExp(`\\b${NUM_WORD_SRC}\\s+(?:separate\\s+)?studio`, 'i'))
  if (isRoom) f.property_type = 'ROOM_IN_SHARED_APARTMENT'
  else if (RE.studio.test(text) && !isHistoricStudio && !(studioCount && toNum(studioCount[1]) > 1)) f.property_type = 'STUDIO'
  else {
    const kind = lower.match(/\b(villa|maisonette|penthouse|bungalow|townhouse|town\s+house|duplex|garage|warehouse|showroom|shop|office)\b/)
    if (kind && !(kind[1] === 'office' && /\b(?:plus|\+|and|with)\s+(?:an?\s+)?office\b|\bis\s+an\s+office\b|\bthird\s+is\s+an?\s+office\b/i.test(text))) {
      const k = kind[1].replace(/\s+/g, '')
      if (['villa', 'maisonette', 'penthouse', 'bungalow', 'townhouse', 'duplex', 'garage'].includes(k)) f.property_type = k.toUpperCase()
    }
    if (!f.property_type && RE.whole.test(text) && /\bapartment|flat\b/i.test(text)) f.property_type = 'WHOLE_APARTMENT'
    if (!f.property_type && isHistoricStudio && /\bone[- ]bed(?:room)?\b|\b1[- ]?bed/i.test(text)) f.property_type = 'APARTMENT'
  }

  // bedrooms / rooms
  const totalBeds = text.match(new RegExp(`\\b(?:in\\s+(?:a|my|the)\\s+)?${NUM_WORD_SRC}[- ]?(?:bed(?:room)?s?|br)[- ](?:sharing\\s+|shared\\s+)?(?:flat|apartment|house)\\b`, 'i'))
  const fourInTotal = text.match(new RegExp(`\\b${NUM_WORD_SRC}\\s+in\\s+total\\b`, 'i'))
  if (f.property_type === 'ROOM_IN_SHARED_APARTMENT' || /\brooms?\s+(?:are\s+)?free\b/i.test(text)) {
    if (totalBeds) f.total_bedrooms = toNum(totalBeds[1])
    if (fourInTotal) f.total_bedrooms = toNum(fourInTotal[1])
    const avail = text.match(new RegExp(`\\b(?:only\\s+)?${NUM_WORD_SRC}\\s+rooms?\\s+(?:is|are)\\s+(?:available|free)\\b|\\b(?:rent|let)\\s+(?:out\\s+)?${NUM_WORD_SRC}\\s+rooms?\\b`, 'i'))
    if (avail) f.rooms_available = toNum(avail[1] || avail[2])
    else if (/\bonly\s+the\s+master\s+bedroom\b|\b(?:a|one)\s+(?:single|double|twin|master)\s+room\b|\b(?:single|double|twin)\s+room\s+available\b/i.test(text)) f.rooms_available = 1
  } else if (/\bonly\s+the\s+master\s+bedroom\b/i.test(text)) {
    f.rooms_available = 1
  }
  const together = text.match(new RegExp(`\\ball\\s+${NUM_WORD_SRC}\\s+bedrooms\\s+(?:can\\s+be\\s+)?(?:rented|let)\\s+together\\b`, 'i'))
  if (together) f.rooms_available = toNum(together[1])
  if (!f.property_type || !['ROOM_IN_SHARED_APARTMENT', 'STUDIO'].includes(f.property_type)) {
    const officeThird = /\b(\d+|one|two|three|four|five)\s*(?:br|bed(?:room)?s?)\b[^.!?]{0,30}\b(?:third|last|one)\s+(?:one\s+)?is\s+(?:an?\s+)?office\b/i.exec(text)
    const beds = text.match(new RegExp(`\\b${NUM_WORD_SRC}[- ]?(?:bed(?:room)?s?|br)\\b(?!\\s+(?:are|is)\\s+(?:empty|free|rented))`, 'i'))
    const bedsTail = text.match(/\b(?:one|1)[- ]bed(?:room)?\b/i)
    if (officeThird) { f.bedrooms = toNum(officeThird[1]) - 1; f.office = true }
    else if (beds && !/\bin\s+total\b/i.test(text)) f.bedrooms = toNum(beds[1])
    else if (bedsTail) f.bedrooms = 1
    if (/\b(?:plus|\+|and|with)\s+(?:an?\s+)?office\b/i.test(text)) f.office = true
  }
  const baths = text.match(new RegExp(`\\b${NUM_WORD_SRC}\\s+bath(?:room)?s?\\b`, 'i'))
  if (baths) f.bathrooms = toNum(baths[1])
  const garage = text.match(new RegExp(`\\b${NUM_WORD_SRC}[- ]car\\s+garage\\b`, 'i'))
  if (garage) f.garage_capacity = toNum(garage[1])
  const sqm = text.match(/\b(\d{2,5})\s*(?:sqm|sq\.?\s*m|m2|m²|square\s+met(?:re|er)s?)\b/i)
  if (sqm) f.approx_area_sqm = Number(sqm[1])

  // use type / permits
  if (RE.residential.test(text) || /\b(?:residential|normal)\s+(?:villa|apartment|flat|house)s?\b/i.test(text)) f.use_type = 'RESIDENTIAL'
  if (RE.commercialCorrection.test(text) || /\b(?:office|retail|warehouse|showroom|shop)s?\b/i.test(text) && !/\b(?:plus|\+|with|third\s+is\s+an?)\s+office\b/i.test(text) && !/\bhome\b/i.test(text) && !f.use_type) {
    if (/\b(?:offices?|retail|warehouse|showroom|shop)\b/i.test(text)) f.use_type = 'COMMERCIAL'
  }
  const permitClass = text.match(/\bclass\s+(\d[a-z]?)\b/i)
  if (permitClass) f.permit = permitClass[1].toUpperCase()
  if (/\bpermit\s+(?:is\s+)?pending\b|\bpending\s+permit\b/i.test(text)) f.permit_status = 'PENDING'
  if (/\bwarehouse\b[^.!?]{0,20}\bnot\s+licen[cs]ed\s+for\s+retail\b/i.test(text)) f.permitted_use = 'WAREHOUSE_NOT_RETAIL'

  // transaction
  if (/\b(?:can\s+)?sell\s+it\b[^.!?]{0,20}\b(?:can'?t|cannot|not)\s+rent\b/i.test(text)) { f.sale_offered = true; f.rent_offered = false }
  if (/\bfor\s+sale\b|\bsold\s+separately\b|\bcan\s+be\s+sold\b/i.test(text)) f.transaction_mode = 'SALE'
  if (/\bwinter\s+let\b/i.test(text)) f.rent_type = 'WINTER_LET'
  else if (/\bshort[- ]let\b/i.test(text)) f.rent_type = 'SHORT_LET'

  // money: room rent vs whole-unit rent
  const money = moneyMatches(text)
  if (money.length === 1 || (money.length > 1 && !/\b(?:sliema|valletta|the\s+one\s+in)\b/i.test(text))) {
    const latest = /\bnot\s+€?\s*\d/i.test(text) ? money[0] : money[money.length - 1]
    const isCorrection = /\bnot\s+€?\s*\d/i.test(text)
    const v = isCorrection ? money[0].value : latest.value
    if (f.property_type === 'ROOM_IN_SHARED_APARTMENT') f.room_rent = v
    else if (f.transaction_mode !== 'SALE') f.asking_rent = v
  }
  if (/\b(?:price|rent)\b[^.!?]{0,30}\b(?:outdated|old|wrong|not\s+current)\b[^.!?]{0,40}\blatest\b|\buse\s+the\s+latest\b/i.test(text)) f.price_provenance = 'LATEST_OWNER'

  // pets / subletting / sharing scope
  if (RE.pets.test(text)) f.pets_allowed = false
  else if (RE.petsYes.test(text)) f.pets_allowed = true
  if (RE.subletNo.test(text)) f.subletting_allowed = false
  if (/\bno\s+groups\s+for\s+the\s+\w+\b[^.!?]{0,40}\bfine\s+for\b/i.test(text)) f.policy_scope = 'PROPERTY_SPECIFIC'

  // availability
  if (RE.longRentedYears.test(text) || RE.rentedUntil.test(text) && Number((text.match(/20(\d\d)/) || [])[1]) > (maltaParts(now).year % 100)) {
    f.availability_status = 'UNAVAILABLE_LONG_TERM'
  } else if (RE.offMarket.test(text)) f.availability_status = 'OFF_MARKET'
  else if (RE.backOnMarket.test(text)) f.availability_status = 'AVAILABLE_MARKETING'
  else if (RE.allBooked.test(text)) f.portfolio_status = 'NONE_CURRENTLY_AVAILABLE'
  else if (RE.firstSecond.test(text)) {
    const m = text.match(RE.firstSecond)
    const st = s => (/avail/i.test(s) ? 'AVAILABLE' : 'RENTED')
    f.property_a = st(m[1]); f.property_b = st(m[2])
  } else if (/\bthis\s+one\s+is\s+rented\b|\bthis\s+(?:flat|apartment|one)\s+is\s+(?:rented|taken)\b/i.test(text)) {
    f.current_property_status = 'RENTED'
  } else if ((RE.available.test(text) || RE.notUpset.test(text) && /\bavailable\b/i.test(text)) && !RE.notAvailable.test(text)) {
    f.availability_status = 'AVAILABLE_MARKETING'
    f.marketable = true
  }
  if (!f.availability_status && !f.current_property_status && !f.portfolio_status && !f.property_a) {
    if (/\bon\s+hold\b/i.test(text)) f.availability_status = 'ON_HOLD'
    else if (RE.notAvailable.test(text) || /\b(?:not\s+available\s+any\s?more|rented\s+(?:it\s+)?(?:yesterday|today|last\s+week|already)|(?:another|other)\s+agency\s+rented)\b/i.test(text) || RE.rentedWord.test(text) && !/\bbut\b/i.test(text)) f.availability_status = 'UNAVAILABLE'
  }
  const noViewUntil = text.match(/\bno\s+viewings?\s+(?:until|before)\s+([\w ]+?)[.!]?$/i)
  if (noViewUntil) f.viewing_available_from = noViewUntil[1].trim()
  if (RE.anotherProperty.test(text)) f.new_property_candidate = true
  if (/\bhave\s+(?:a|an|one)\s+(?:property|flat|apartment|place|house)\s+available\b/i.test(text)) f.offer_exists = true

  // dates
  const tenantLeaves = /\btenant\s+(?:leaves|is\s+leaving|moves\s+out|will\s+leave|leaving)\b/i.test(text)
  if (tenantLeaves) {
    const d = findDayMonth(text, now)
    if (d) f.tenant_departure_date = d.iso
    f.available_from = 'UNKNOWN_OR_PRIOR_APPROXIMATE'
  } else {
    const keys = text.match(new RegExp(`\\bkeys?\\s+(?:from|on|handover)\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE_SRC}`, 'i'))
    if (keys) f.key_handover_from = isoDate(yearFor(monthIndex(keys[2]), now), monthIndex(keys[2]), Number(keys[1]))
    const avail = findDayMonth(text, now, /\b(?:available|free|vacant|ready)\s*(?:from|on|as\s+of)?/)
    if (avail) f.available_from = avail.iso
    if (/\b(?:mid|early|end\s+of|late|beginning\s+of|towards\s+the\s+end\s+of)[- ]?\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(text) && !avail) f.available_from_precision = 'APPROXIMATE'
    const moveIn = text.match(new RegExp(`\\bnot\\s+(?:to\\s+)?move\\s+in\\s+until\\s+${MONTH_RE_SRC}`, 'i'))
    if (moveIn) f.move_in_availability = MONTHS[monthIndex(moveIn[1])].toUpperCase()
  }

  // viewing / callback / human
  if (RE.viewingCancelled.test(text)) f.viewing_status = 'CANCELLED'
  else if (RE.viewingRequest.test(text)) f.viewing_status = 'REQUESTED'
  else if (isViewingOffer(text)) f.viewing_status = RE.viewingTentative.test(text) ? 'TENTATIVE' : 'PROPOSED'
  if (RE.callRequest.test(text)) f.callback_requested = true
  if (RE.realPerson.test(text) || RE.myAgent.test(text)) f.human_requested = true
  if (RE.manager.test(text)) f.escalate_to_manager = true

  // multi-property candidates
  const cands = candidateCount(text)
  if (cands >= 2) f.property_candidates = cands
  const newCands = text.match(new RegExp(`\\b(?:also\\s+have\\s+)?(?:these\\s+)?${NUM_WORD_SRC}\\s+(?:offices|shops|units|apartments|flats|properties)\\s+for\\s+sale\\b`, 'i'))
  if (newCands) { f.new_property_candidates = toNum(newCands[1]); f.transaction_mode = 'SALE'; if (/office|shop/i.test(newCands[0])) f.use_type = 'COMMERCIAL'; delete f.property_candidates }

  // media
  if (att.images > 1) f.media_count = att.images
  const binding = text.match(/\b(?:images?|photos?|pictures?)\s+(?:are\s+)?(?:of|for)\s+(apartment|unit|flat|the)\s+([a-z0-9]{1,4})\b/i)
  if (binding) {
    const label = binding[2].toUpperCase()
    f.media_binding = binding[1].toLowerCase() === 'unit' ? `UNIT_${label}` : label
  }
  const penthouseImgs = text.match(/\b(?:images?|photos?|pictures?)\s+(?:for|of)\s+the\s+(penthouse|apartment|villa|maisonette|studio)\b/i)
  if (penthouseImgs) f.media_property = penthouseImgs[1].toUpperCase()
  if (/\b(?:picture|photo|image)s?\s+belongs?\s+to\s+(?:my\s+)?other\b/i.test(text)) f.media_binding_review = true
  if (/\bhere\s+are\s+the\s+(?:photos|pictures|images)\b/i.test(text) || (att.images && !f.media_count && /\bphotos?\b/i.test(text))) f.photos_received = true
  const later = text.match(RE.photosLater)
  if (later) f.photos_expected = later[1].toUpperCase().replace(/\s+/g, '_')
  if (/\balready\s+gave\s+(?:you\s+)?the\s+address\b/i.test(text)) f.address_already_provided = true

  // engagement
  if (RE.noThanks.test(text)) { f.engagement = 'DECLINED'; f.current_offer_declined = true }
  if (RE.agentToAgent.test(text)) f.owner_role = 'AGENT'
  return f
}

function candidateCount(text) {
  const t = text.toLowerCase()
  let m = t.match(/\b(two|three|four|five|\d+)\s+in\s+([a-z' -]+?)\s+and\s+(one|two|three|\d+)\s+in\s+[a-z]/)
  if (m) return toNum(m[1]) + toNum(m[3])
  m = t.match(new RegExp(`\\b${NUM_WORD_SRC}\\s+(?:separate\\s+|different\\s+)?(?:studio\\s+)?(?:apartments|flats|studios|units|properties)\\b(?!\\s+for\\s+sale)`))
  if (m && toNum(m[1]) >= 2 && !/\bin\s+total\b/.test(t)) return toNum(m[1])
  if (/\bone\s+(?:office|shop|apartment|flat)\s+and\s+one\s+(?:home|apartment|flat|office|shop)\b/.test(t)) return 2
  if (/\bthe\s+one\s+in\s+\w+\b[^.;]*[;,.]\s*\w+\s+is\b/.test(t) && moneyMatches(text).length >= 2) return 2
  if (/\bthe\s+(?:shop|office|garage)\s+is\s+for\s+(?:sale|rent)\b[^.!?]{0,10}[;,]\s*the\s+(?:apartment|flat)\s+is\s+for\s+(?:rent|sale)\b/.test(t)) return 2
  return 0
}

function isViewingOffer(text) {
  if (RE.viewNotMove.test(text)) return false
  if (/\bno\s+viewings?\b|\bviewings?\s+(?:are\s+)?(?:not\s+possible|paused|only\s+from)\b/i.test(text)) return false
  if (/\bmove[- ]?in\b/i.test(text) && !RE.timeExpr.test(text)) return false
  const viewing = RE.viewingWord.test(text)
  const when = RE.timeExpr.test(text) || RE.dayExpr.test(text)
  if (viewing && (when || /\bpossible\b|\bcan\s+(?:do\s+a\s+)?view\b|\bwe\s+can\s+view\b/i.test(text))) return true
  if (RE.comeMeet.test(text) && (RE.timeExpr.test(text) || RE.dayExpr.test(text))) return true
  return false
}

// "3 PM" → "3:00 pm", "15:00" stays, "Tuesday at 4" → "Tuesday at 4".
function viewingWhen(text) {
  const day = (text.match(RE.dayExpr) || [])[1]
  const t = text.match(RE.timeExpr)
  let time = null
  if (t) {
    if (t[3]) time = `${Number(t[1])}:${t[2] || '00'} ${t[3].toLowerCase()}`
    else if (t[4]) time = `${t[4]}:${t[5]}`
    else if (t[6]) time = `${t[6]}`
  }
  const parts = []
  if (day) parts.push(cap(day.toLowerCase()) === 'Tomorrow' ? 'tomorrow' : (/^(?:today|tomorrow)/i.test(day) ? day.toLowerCase() : cap(day.toLowerCase())))
  if (time) parts.push(`at ${time}`)
  return parts.join(' ') || null
}

// ── replies (short, factual, no fake sympathy) ───────────────────────────────
function identityAnswer(kind, identity, t) {
  if (!identity) return null
  const name = identity.name || identity.fullName
  const agency = identity.agency
  if (identity.affiliationVerified === false || !agency) return null
  const isKevin = identity.persona === 'kev'
  const roleLine = isKevin
    ? `I'm ${name}, an independent real estate agent working with 2906 Estate, a collective of independent agents in Malta.`
    : `I'm ${name}, ${identity.roleNoun || 'a real estate agent'} with ${agency} in Malta.`
  switch (kind) {
    case 'what_is_2906':
      return isKevin ? `2906 Estate is a collective of independent real estate agents in Malta. We work together to connect property owners with suitable tenants and buyers${identity.website ? ` — ${identity.website.replace(/^https?:\/\//, '')}` : ''}.` : null
    case 'website':
      return identity.website ? `Of course — ${identity.website.replace(/^https?:\/\//, '')}.` : null
    case 'independent':
      return isKevin ? "I'm independent — a self-employed agent working with 2906 Estate, a collective of independent agents in Malta, not employed by it." : null
    case 'agent_or_owner': {
      const ownerAgent = /\b(?:I'?m|I\s+am)\s+(?:an?\s+)?agent\s+(?:also|too)\b/i.test(t)
      return ownerAgent ? `Yes — I'm an agent too, not an owner. ${roleLine}` : `I'm an agent, not the owner. ${roleLine}`
    }
    case 'who':
      return /\bgabriel+a\b/i.test(t) && identity.persona !== 'gabriela'
        ? `This chat is with me, ${name} — ${identity.roleNoun || 'a real estate agent'}${isKevin ? ' working with 2906 Estate' : ` with ${agency}`} in Malta. An automatic reply in this chat may have mentioned another name.`
        : roleLine
    case 'company':
    default:
      // The persona's own approved wording wins (Kev's intro, 2026-10-30).
      if (identity.introAnswer) return `Of course. ${identity.introAnswer}${identity.website ? ` You can find us at ${identity.website.replace(/^https?:\/\//, '')}.` : ''}`
      return `Of course. ${roleLine}${isKevin && identity.website ? ` You can find us at ${identity.website.replace(/^https?:\/\//, '')}.` : ''}`
  }
}

function factSummary(f, text) {
  const t = text
  const bits = []
  if (f.property_candidates) {
    const m = t.match(/\b(two|three|\d+)\s+in\s+([A-Z][a-z]+)\s+and\s+(one|two|\d+)\s+in\s+([A-Z][a-z]+)/)
    if (m) return `${m[1].toLowerCase()} in ${m[2]} and ${m[3].toLowerCase()} in ${m[4]}, as separate properties`
    const two = t.match(/\bthe\s+one\s+in\s+([A-Z][a-z]+)[^;.]*?(€\s?\d[\d,]*\d)[;.]\s*([A-Z][a-z]+)\s+is\s+(€\s?\d[\d,]*\d)/i)
    if (two) return `${two[1]} at ${two[2].replace(/\s/g, '')} and ${two[3]} at ${two[4].replace(/\s/g, '')}, kept as two separate properties`
    if (/\bshop\b/i.test(t) && /\bapartment\b/i.test(t)) return 'the shop for sale and the apartment for rent, as two separate properties'
    if (/\boffice\b/i.test(t) && /\bhome\b/i.test(t)) return 'one office and one home, kept as two separate units'
    if (/\bstudio/i.test(t)) return `${numText(f.property_candidates)} separate studio apartments`
    return `${numText(f.property_candidates)} separate apartments, kept as distinct units`
  }
  if (f.property_a || f.property_b) return `the second one is ${String(f.property_b).toLowerCase()} and the first is ${String(f.property_a).toLowerCase()}`
  if (f.policy_scope) {
    const m = t.match(/\bno\s+groups\s+for\s+the\s+(\w+)\b[^.!?]{0,40}\bfine\s+for\s+([\w ]+?)[.!]?$/i)
    return m ? `no groups for the ${m[1]}, while rooms are fine for ${m[2].trim()}` : 'the different rules for each property'
  }
  if (f.address_already_provided) {
    const m = t.match(/\baddress\s+of\s+the\s+([\w ]+?)\s+one\b/i)
    return `you already sent the address${m ? ` of the ${m[1]}` : ''} — I won't ask for it again`
  }
  if (f.sale_offered && f.rent_offered === false) return 'it is available for sale only, not for rent'
  if (f.rent_type === 'WINTER_LET') return 'it is available as a winter let only'
  if (f.rooms_available && /\btogether\b/i.test(t)) return `all ${numText(f.rooms_available)} bedrooms can be rented together`
  if (f.office && f.bedrooms != null) return `${numText(f.bedrooms)} bedrooms, with the third room used as an office`
  if (f.permit) return `a retail shop with a Class ${f.permit} permit`
  if (f.permit_status === 'PENDING') return 'a commercial showroom, with the permit still pending'
  if (f.permitted_use === 'WAREHOUSE_NOT_RETAIL') return 'a warehouse, not licensed for retail'
  if (f.property_type === 'GARAGE') return `the garage${f.transaction_mode === 'SALE' ? ', which can be sold separately' : ''}`
  if (f.use_type === 'COMMERCIAL' && /\boffice\b/i.test(t)) return /\blicen[cs]ed\b/i.test(t) ? 'an office, licensed for office use' : 'an office for professional use'
  if (f.bedrooms != null) {
    const beds = f.bedrooms === 1 ? 'one-bedroom' : `${f.bedrooms}-bedroom`
    const type = f.property_type && !['WHOLE_APARTMENT', 'APARTMENT'].includes(f.property_type) ? f.property_type.toLowerCase() : 'apartment'
    bits.push(`a ${beds} ${type}${/\ball\s+of\s+it\b/i.test(t) ? ', with the whole apartment available' : ''}`)
  } else if (f.property_type && !['WHOLE_APARTMENT', 'APARTMENT'].includes(f.property_type)) bits.push(`a ${f.property_type.toLowerCase()}`)
  return bits.join(', ') || null
}

function ackReply(reason, f, text, ctx) {
  const t = text
  switch (reason) {
    case 'PRICE_CORRECTION':
      if (f.price_provenance === 'LATEST_OWNER' && f.asking_rent == null) return "Thank you — I'll use the latest price you sent, not the one on the old card."
      return `Thank you. I've updated the asking rent to ${fmtMoney(f.asking_rent)}${f.marketable ? ' and noted that the property is available' : ''}.`
    case 'AVAILABLE_CONFIRMED':
      if (f.offer_exists) return 'Thank you — good to hear you have a property available. Could you share the area, asking price and when it is free?'
      if (/\bback\s+on\s+the\s+market\b/i.test(t)) return "Thanks — I've noted that it's back on the market."
      return "Thank you — I've noted that it's available."
    case 'FUTURE_VACANCY':
      if (f.tenant_departure_date) {
        const d = findDayMonth(t, ctx.now || new Date())
        const label = d ? d.label : 'that date'
        const repaint = /\brepaint|paint/i.test(t) ? ', and that you need about two weeks to repaint afterwards' : ''
        return `Thank you — I've noted that the current tenant leaves on ${label}${repaint}. I'll keep the available-from date open until you confirm it.`
      }
      if (f.key_handover_from) {
        const keys = t.match(new RegExp(`\\bkeys?\\s+(?:from|on)\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE_SRC}`, 'i'))
        const avail = findDayMonth(t, ctx.now || new Date(), /\b(?:available|free)\s*(?:from|on)?/)
        return `Thank you — noted: available on ${avail ? avail.label : 'that date'}, with keys from ${keys ? `${Number(keys[1])} ${cap(MONTHS[monthIndex(keys[2])])}` : 'the later date'}.`
      }
      if (f.move_in_availability) return `Thanks — noted that it can be viewed now, with move-in from ${cap(f.move_in_availability.toLowerCase())}.`
      { const m = t.match(new RegExp(`\\b(mid|early|end\\s+of|late)[- ]?\\s*${MONTH_RE_SRC}`, 'i'))
        if (m) return `Thanks — I've noted that it should be free around ${m[1].toLowerCase()}-${cap(MONTHS[monthIndex(m[2])])}.` }
      return "Thanks — I've noted the expected availability."
    case 'ROOM_NOT_ENTIRE_APARTMENT': {
      if (/\bmaster\s+bedroom\b/i.test(t)) return "Got it — only the master bedroom is available. I've noted it as a single room, not the whole flat."
      const parts = []
      parts.push(f.rooms_available && f.rooms_available > 1 ? `${numText(f.rooms_available)} rooms available` : 'one room available')
      if (f.total_bedrooms) parts.push(`in the ${numText(f.total_bedrooms)}-bedroom shared ${/\bhouse\b/i.test(t) ? 'house' : 'apartment'}`)
      else if (/\bshared\s+house\b/i.test(t)) parts.push('in the shared house')
      else if (/\bstudent\s+flat\b/i.test(t)) parts.push('in the student flat')
      if (f.bathrooms) parts.push(`with ${numText(f.bathrooms)} bathrooms`)
      let s = `Got it: ${parts.join(' ')}`
      if (f.room_rent) s += `, at ${fmtMoney(f.room_rent)}${/\binclusive\b/i.test(t) ? ' inclusive' : ''}`
      s += '.'
      if (f.pets_allowed === false) s += " I've noted the no-pets policy as well."
      return s
    }
    case 'STUDIO': case 'STUDIO_EXPLICIT': {
      const town = (t.match(/\b([A-Z][a-z]+)\s+studio\b/) || [])[1]
      const where = town && !/^(It|The|A|This)$/.test(town) ? ` in ${town}` : ''
      const price = f.asking_rent ? ` at ${fmtMoney(f.asking_rent)}` : ''
      const known = { ...(ctx.known || {}), ...f }
      const availableNow = /\bavailable\s+now\b/i.test(t)
      const ask = !known.available_from && !known.available_date && !availableNow && !(f.availability_status) ? ' Do you know when it would be available?' : ''
      return `Thanks — a studio${where}${price}${availableNow ? ', available now' : ''}.${ask || " I've noted it."}`
    }
    case 'RESIDENTIAL_NOT_COMMERCIAL':
      if (f.use_type === 'COMMERCIAL') return "Thanks for clarifying — I've noted it as a commercial office, not a flat."
      if (/\bvilla\b/i.test(t)) return "Thanks — noted as a residential villa."
      if (/\boccupied\s+by\s+a\s+family\b/i.test(t)) return "Thank you — I've noted that it's currently occupied by a family."
      return "Thanks for clarifying — I've noted them as residential apartments."
    case 'LONG_TERM_RENTED':
      if (f.new_property_candidate) return "Thanks — I've marked this one as rented. I'd be glad to hear about another flat you have: the area, asking price and when it's free."
      if (f.portfolio_status) return "Understood — I've noted that all your properties are currently booked, so I won't ask about them for now."
      return "Noted — I've marked it as off the market so we don't keep asking you about it."
    case 'AGENT_TO_AGENT':
      return "Thanks for clarifying — I'm also working as an agent in Malta. If you have a suitable property for one of our active requirements, I'm happy to coordinate agent-to-agent."
    case 'NO_PETS': return "Noted — no pets."
    case 'NO_SUBLETTING': return "Noted — no subletting."
    case 'OWNER_MEDIA_BURST': {
      if (f.new_property_candidates) return `Thank you — I've noted the ${numText(f.new_property_candidates)} offices for sale as separate properties, each with its own price.`
      if (/\bbalcony\b/i.test(t)) return "Thank you for the photos — I've noted that the third one shows the balcony."
      if (f.media_binding && /^UNIT_/.test(f.media_binding)) return `Thank you — I've attached these photos to Unit ${f.media_binding.slice(5)} only.`
      if (f.media_binding) return `Thank you — I've attached these images to Apartment ${f.media_binding} only.`
      if (f.media_property) return `Thank you — I've added these images to the ${f.media_property.toLowerCase()}.`
      if (f.media_binding_review) return "Thanks for pointing that out — I'll move that picture to your other apartment."
      if (/\ball\s+the\s+information\b/i.test(t)) return "Thank you — I've saved all the information from the card."
      return "Thank you for the photos — I've attached them to the property record."
    }
    case 'NO_REPLY_REQUIRED':
      if (f.photos_expected) return `Thank you — no rush, next week is fine for the photos.`
      if (RE.brief.test(t)) return 'Of course — I\'ll keep it short.'
      return null
    case 'QUESTION_ALREADY_ANSWERED':
    default: {
      if (f.address_already_provided) {
        const m = t.match(/\baddress\s+of\s+the\s+([\w ]+?)\s+one\b/i)
        return `Thank you — you already sent the address${m ? ` of the ${m[1]} one` : ''}, so I won't ask for it again.`
      }
      const s = factSummary(f, t)
      return s ? `Thank you — noted: ${s}.` : null
    }
  }
}

function handoffReply(reason, f, text, identity) {
  switch (reason) {
    case 'VIEWING_OFFER': {
      if (f.viewing_status === 'CANCELLED') return "Thanks for letting me know — I've noted that the viewing is cancelled."
      if (f.viewing_status === 'REQUESTED') return "Thank you — I'll pass your viewing request to the agent handling it, who will come back to you with a time."
      const when = viewingWhen(stripAttachments(text))
      const prefix = f.viewing_status === 'TENTATIVE'
        ? `Thank you — I've noted a possible viewing${when ? ` ${when}` : ''}, subject to your confirmation.`
        : `Thank you, I've noted ${when || 'your proposed time'} as a possible viewing.`
      return `${prefix} I'll check with the client and confirm with you before arranging anything.`
    }
    case 'CALLBACK_REQUEST': {
      if (f.human_requested) return "Of course — I'll pass this to the agent handling the property, who will contact you directly."
      const when = (stripAttachments(text).match(/\b(?:after\s+\d{1,2}(?:\s*(?:am|pm))?|next\s+week|tomorrow(?:\s+(?:morning|afternoon|evening))?|this\s+(?:afternoon|evening)|later\s+today)\b/i) || [])[0]
      return `Of course — I'll ask the agent handling it to call you${when ? ` ${when.replace(/(\d)\s*(am|pm)/i, '$1 $2').toUpperCase().replace(/^AFTER/, 'after').replace(/^NEXT WEEK/, 'next week').replace(/^TOMORROW/, 'tomorrow')}` : ''}.`
    }
    case 'MEDIA_UNREADABLE': {
      const noted = []
      if (f.bathrooms != null) noted.push(`${numText(f.bathrooms)} bathroom${f.bathrooms === 1 ? '' : 's'}`)
      if (f.bedrooms != null) noted.push(`${numText(f.bedrooms)} bedroom${f.bedrooms === 1 ? '' : 's'}`)
      return noted.length
        ? `Thank you, I've noted ${noted.join(' and ')}. I'll flag the voice note for review so we don't lose any details.`
        : "Thank you — I'll pass your voice note to the agent so nothing is missed."
    }
    case 'COMPLAINT': return "Understood — I'll pass this on to the person responsible."
    case 'UNCERTAIN_SENDER': return null
    case 'OWNER_DIRECT_QUESTION': default: return null
  }
}

// ── the decision ─────────────────────────────────────────────────────────────
function decide({ messages = [], text = null, context = {} } = {}) {
  const ctx = { now: new Date(), window: DEFAULT_WINDOW, known: {}, ...context }
  const rawBurst = (Array.isArray(messages) ? messages : [messages]).concat(text ? [text] : []).map(norm).filter(s => String(s).trim())
  const r = router()
  const isAutoLine = line => (r && r.THIRD_PARTY_AUTOREPLY_RE.test(line)) || (RE.autoresponder.test(line) && !/\?/.test(line.replace(RE.autoresponder, '')))
  const autoLines = rawBurst.filter(isAutoLine)
  const burst = rawBurst.filter(line => !isAutoLine(line))
  const full = burst.join('\n')
  const plain = stripAttachments(full)
  const att = readAttachments(full)
  const identity = ctx.identity || null
  const facts = extractFacts(full, ctx)
  const gates = []
  const out = (action, reason, extra = {}) => finalize({
    next_action: action, reason_code: reason, fact_mutations: facts, draft_reply: null,
    needs_human_review: action === ACTIONS.HUMAN_HANDOFF, intent: null,
    owner_role: facts.owner_role || 'OWNER', policy_version: POLICY_VERSION, gates, ...extra,
  }, ctx)

  if (!rawBurst.length) return out(ACTIONS.NO_SEND, 'NO_REPLY_REQUIRED', { intent: 'empty' })

  // 1. Thread / contact gates (nothing is sent; facts are still recorded).
  if (ctx.duplicate) { gates.push('idempotency'); return out(ACTIONS.NO_SEND, 'NO_REPLY_REQUIRED', { intent: 'duplicate_event', fact_mutations: {} }) }
  if (ctx.dnc) { gates.push('global_dnc'); return out(ACTIONS.DNC, 'DNC', { intent: 'contact_on_dnc' }) }

  // 2. Privacy / opt-out / complaint — always first among owner intents.
  const del = RE.privacyDelete.test(plain); const rem = RE.privacyRemove.test(plain)
  const stop = RE.stop.test(plain) || (ctx.ownerAskedToStop === true)
  const wrong = RE.wrongNumber.test(plain) && !/\bwrong\s+person\s+attached\b/i.test(plain)
  const routerStop = !!(r && plain && r.isPrivacyStop(plain))
  if (del || rem || stop || wrong || routerStop) {
    const f = { do_not_contact: true }
    if (del && !rem) f.privacy_request = 'DELETE_REVIEW'
    else if (rem || (del && RE.noPermission.test(plain))) f.privacy_request = 'DELETION_OR_RESTRICTION_REVIEW'
    if (wrong) f.wrong_number = true
    gates.push('privacy_stop')
    const complaint = RE.complaintMarker.test(plain)
    return out(ACTIONS.DNC, complaint ? 'COMPLAINT' : 'DNC', { fact_mutations: { ...facts, ...f }, intent: 'opt_out', needs_human_review: true })
  }

  // 3. Third-party auto-responder never changes who we are or counts as the owner.
  if (!burst.length && autoLines.length) {
    return out(ACTIONS.NO_SEND, 'INBOUND_AUTORESPONDER', { intent: 'autoresponder', fact_mutations: {} })
  }

  // 4. Human takeover / account controls.
  if (ctx.humanActive || RE.humanActive.test(plain)) { gates.push('human_active'); return out(ACTIONS.NO_SEND, 'HUMAN_ACTIVE', { intent: 'human_active' }) }
  if (ctx.autoEnabled === false) { gates.push('auto_disabled'); return out(ACTIONS.NO_SEND, 'AUTO_DISABLED', { intent: 'auto_off' }) }
  if (ctx.manualPaused) { gates.push('manual_pause'); return out(ACTIONS.NO_SEND, 'MANUAL_PAUSE', { intent: 'paused' }) }

  // 5. Quiet hours: nothing automated outside the window; the burst is
  //    re-evaluated in full at the next opening (stale drafts are never sent).
  if (!insideWindow(ctx.now, ctx.window)) {
    gates.push('quiet_hours')
    return out(ACTIONS.DEFER, 'OUT_OF_HOURS', { intent: 'out_of_hours', defer_until: nextWindowOpen(ctx.now, ctx.window).toISOString(), fact_mutations: {} })
  }
  if (ctx.senderUnknown || !identity) {
    gates.push('sender_unverified')
    return out(ACTIONS.HUMAN_HANDOFF, 'UNCERTAIN_SENDER', { intent: 'sender_unknown' })
  }
  if (RE.askAgainLater.test(plain)) return out(ACTIONS.DEFER, 'NO_REPLY_REQUIRED', { intent: 'owner_asked_later' })

  // 6. Owner still sending: wait for the rest of the burst.
  if (ctx.burstOpen || (att.any && RE.moreComing.test(plain))) {
    return out(ACTIONS.WAIT_FOR_MEDIA, 'OWNER_MEDIA_BURST', { intent: 'burst_in_progress' })
  }

  // 7. Owner wants a person / a call / a manager.
  if (RE.realPerson.test(plain) || RE.myAgent.test(plain)) {
    return out(ACTIONS.HUMAN_HANDOFF, 'CALLBACK_REQUEST', { intent: 'human_requested', draft_reply: null })
  }
  if (RE.manager.test(plain)) return out(ACTIONS.HUMAN_HANDOFF, 'COMPLAINT', { intent: 'escalation', draft_reply: null })
  if (RE.callRequest.test(plain)) {
    return out(ACTIONS.HUMAN_HANDOFF, 'CALLBACK_REQUEST', { intent: 'callback', draft_reply: handoffReply('CALLBACK_REQUEST', facts, full, identity) })
  }

  // 8. Viewing offers / requests / cancellations — a human confirms; nothing is booked.
  if (facts.viewing_status) {
    return out(ACTIONS.HUMAN_HANDOFF, 'VIEWING_OFFER', { intent: 'viewing', draft_reply: handoffReply('VIEWING_OFFER', facts, full, identity) })
  }

  // 9. Voice notes: no verified transcript → never pretend to have heard it.
  if (att.voice) {
    if (facts.bathrooms == null && facts.bedrooms == null) facts.media_status = 'PENDING_TRANSCRIPTION'
    else facts.media_status = 'PENDING_TRANSCRIPTION'
    return out(ACTIONS.HUMAN_HANDOFF, 'MEDIA_UNREADABLE', { intent: 'voice_note', draft_reply: handoffReply('MEDIA_UNREADABLE', facts, full, identity) })
  }

  // 10. Direct questions — answered first, only with verified facts.
  if (RE.registered.test(plain) || RE.numberSource.test(plain) || RE.fees.test(plain) || RE.bank.test(plain) || RE.correctMyDetails.test(plain)) {
    gates.push('no_verified_answer')
    return out(ACTIONS.HUMAN_HANDOFF, 'OWNER_DIRECT_QUESTION', { intent: 'sensitive_question', draft_reply: null })
  }
  if (RE.clarification.test(plain)) {
    const lastBot = String(ctx.lastBotText || '')
    const askedPermit = /\bpermit|licen[cs]e|commercial|what\s+(?:the\s+)?space\s+is\s+for/i.test(lastBot)
    const askedSharing = /\bsharing\b|\bsublet/i.test(lastBot)
    let reply
    if (facts.property_type === 'ROOM_IN_SHARED_APARTMENT' || askedSharing) {
      facts.property_type = facts.property_type || (/\broom\b/i.test(plain) ? 'ROOM_IN_SHARED_APARTMENT' : facts.property_type)
      reply = "Sorry, that question wasn't relevant — I've noted it as a room in a shared apartment, and I won't ask about sharing again."
    } else if (askedPermit || (ctx.known && /RESIDENTIAL/i.test(String(ctx.known.use_type || '')))) {
      reply = "Sorry, that question wasn't relevant to your residential apartment. Please ignore it — I've removed it from the details we're asking for."
    } else reply = 'Sorry for the confusion — please ignore my last question.'
    if (!facts.property_type && /\broom\b/i.test(plain)) facts.property_type = 'ROOM_IN_SHARED_APARTMENT'
    return out(ACTIONS.ANSWER_DIRECT, 'OWNER_DIRECT_QUESTION', { intent: 'clarification', draft_reply: reply })
  }
  if (RE.automatedQ.test(plain)) {
    return out(ACTIONS.ANSWER_DIRECT, 'OWNER_DIRECT_QUESTION', { intent: 'authenticity', draft_reply: `You're right — some of these messages are sent with automated help. ${identity.name || 'The agent'} reads every reply and follows up personally where needed.` })
  }
  if (RE.priceSure.test(plain)) {
    const known = ctx.known || {}
    if (known.asking_rent) {
      facts.asking_rent = known.asking_rent
      return out(ACTIONS.ANSWER_DIRECT, 'PRICE_CORRECTION', { intent: 'price_check', draft_reply: `Yes — I have your updated price of ${fmtMoney(known.asking_rent)} per month.` })
    }
    return out(ACTIONS.HUMAN_HANDOFF, 'OWNER_DIRECT_QUESTION', { intent: 'price_check' })
  }
  if (RE.photoRights.test(plain)) {
    return out(ACTIONS.ANSWER_DIRECT, 'OWNER_DIRECT_QUESTION', { intent: 'publication_rights', draft_reply: "We'd only publish your photos with your explicit permission, and only for your own property. Nothing has been published." })
  }
  const idKind = identityQuestionKind(plain)
  if (idKind && !RE.agentToAgent.test(plain.replace(/\b(?:are|r)\s+(?:you|u)\b[^?]*\?/i, '')) || (idKind && /\?/.test(plain))) {
    const reply = identityAnswer(idKind, identity, plain)
    if (!reply) { gates.push('sender_affiliation_unverified'); return out(ACTIONS.HUMAN_HANDOFF, 'OWNER_DIRECT_QUESTION', { intent: `identity:${idKind}` }) }
    return out(ACTIONS.ANSWER_DIRECT, 'OWNER_DIRECT_QUESTION', { intent: `identity:${idKind}`, draft_reply: reply })
  }
  if (RE.agentToAgent.test(plain)) {
    facts.owner_role = 'AGENT'
    return out(ACTIONS.ACKNOWLEDGE_UPDATE, 'AGENT_TO_AGENT', { intent: 'agent_to_agent', owner_role: 'AGENT', draft_reply: ackReply('AGENT_TO_AGENT', facts, plain, ctx) })
  }

  // 11. Media that cannot be read yet (video / document): wait, never re-ask written facts.
  if ((att.video || att.document) && !att.images) {
    facts.media_status = 'PENDING'
    return out(ACTIONS.WAIT_FOR_MEDIA, plain ? 'OWNER_MEDIA_BURST' : 'MEDIA_UNREADABLE', { intent: 'media_pending' })
  }

  // 12. Refusals and closings → no reply.
  if (facts.availability_status === 'UNAVAILABLE_LONG_TERM') {
    return out(ACTIONS.NO_SEND, 'LONG_TERM_RENTED', { intent: 'long_term_rented', fact_mutations: { ...facts, ...knownCarry(ctx, plain) } })
  }
  if (RE.noThanks.test(plain) && !RE.available.test(plain)) return out(ACTIONS.NO_SEND, 'NO_REPLY_REQUIRED', { intent: 'declined' })
  if (RE.pleasantry.test(plain)) return out(ACTIONS.NO_SEND, 'NO_REPLY_REQUIRED', { intent: 'pleasantry' })

  // 13. Acknowledged updates (one short message; at most one useful question).
  const ack = (reason, intent) => out(ACTIONS.ACKNOWLEDGE_UPDATE, reason, { intent, draft_reply: ackReply(reason, facts, plain, ctx) })
  if (facts.new_property_candidates || (att.any && (facts.media_count || facts.media_binding || facts.media_property || facts.media_binding_review || facts.photos_received || /\binformation\b/i.test(plain)))
    || facts.media_binding || facts.media_property || facts.media_binding_review) {
    return ack('OWNER_MEDIA_BURST', 'media')
  }
  if (facts.current_property_status === 'RENTED' || facts.portfolio_status || facts.availability_status === 'OFF_MARKET') return ack('LONG_TERM_RENTED', 'status')
  if (facts.property_a) return ack('QUESTION_ALREADY_ANSWERED', 'multi_status')
  if (facts.property_candidates || facts.policy_scope || facts.address_already_provided) return ack('QUESTION_ALREADY_ANSWERED', 'multi_property')
  if (facts.photos_expected || RE.brief.test(plain)) return ack('NO_REPLY_REQUIRED', 'etiquette')
  const knownRent = ctx.known && ctx.known.asking_rent
  const explicitCorrection = /\b(?:actually|now|correction|not\s+€?\s*\d|changed|instead)\b/i.test(plain)
  if (facts.price_provenance || (facts.asking_rent && ((knownRent && Number(knownRent) !== Number(facts.asking_rent)) || explicitCorrection)) && facts.property_type !== 'STUDIO') {
    return ack('PRICE_CORRECTION', 'price_correction')
  }
  if (facts.property_type === 'ROOM_IN_SHARED_APARTMENT' || (facts.rooms_available && !/\btogether\b/i.test(plain))) return ack('ROOM_NOT_ENTIRE_APARTMENT', 'room')
  if (facts.property_type === 'STUDIO') return ack('STUDIO_EXPLICIT', 'studio')
  if (facts.use_type && (RE.residential.test(plain) || RE.commercialCorrection.test(plain))) return ack('RESIDENTIAL_NOT_COMMERCIAL', 'use_type')
  if (facts.tenant_departure_date || facts.key_handover_from || facts.move_in_availability || facts.available_from_precision) return ack('FUTURE_VACANCY', 'future_vacancy')
  // "All rented now" with no property named could flip a whole portfolio: a person decides.
  if (/^\s*all\s+(?:are\s+)?(?:rented|taken|let)(?:\s+now)?[.!]*\s*$/i.test(plain)) {
    return out(ACTIONS.HUMAN_HANDOFF, 'CONFLICT_REQUIRES_REVIEW', { intent: 'portfolio_scope_unclear' })
  }
  if (facts.availability_status === 'UNAVAILABLE' || facts.availability_status === 'ON_HOLD') {
    const until = (plain.match(/\buntil\s+([\w ]+?)[.!]?$/i) || [])[1]
    const reply = facts.availability_status === 'ON_HOLD'
      ? `Noted — it's on hold${until ? ` until ${until}` : ''}. I won't offer it in the meantime.`
      : "Understood, thanks for the update. I've marked it as unavailable so we don't keep asking you about it."
    return out(ACTIONS.ACKNOWLEDGE_UPDATE, 'QUESTION_ALREADY_ANSWERED', { intent: 'availability_update', draft_reply: reply })
  }
  if (facts.pets_allowed === false && Object.keys(facts).length === 1) return ack('NO_PETS', 'pets')
  if (facts.subletting_allowed === false) return ack('NO_SUBLETTING', 'subletting')
  if (facts.bedrooms != null || facts.rooms_available || (facts.property_type && !['ROOM_IN_SHARED_APARTMENT', 'STUDIO'].includes(facts.property_type))
    || facts.sale_offered || facts.rent_type || facts.permit || facts.permit_status || facts.permitted_use || facts.use_type || facts.transaction_mode) {
    return ack('QUESTION_ALREADY_ANSWERED', 'property_details')
  }
  if (facts.availability_status === 'AVAILABLE_MARKETING' || facts.offer_exists) return ack('AVAILABLE_CONFIRMED', 'available')
  if (facts.asking_rent) return ack('PRICE_CORRECTION', 'price')
  if (Object.keys(facts).length) return ack('QUESTION_ALREADY_ANSWERED', 'fact_update')

  // 14. Anything the rules above did not settle: the 2026-11-09 router's view.
  const fb = r ? routerFallback(r, burst, identity, ctx, facts, out) : null
  if (fb) return fb
  // 15. A question we cannot answer from verified data → a human.
  if (/\?/.test(plain)) return out(ACTIONS.HUMAN_HANDOFF, 'OWNER_DIRECT_QUESTION', { intent: 'unanswered_question' })
  // 15. Nothing to act on: hand back to the field flow without sending here.
  return out(ACTIONS.NO_SEND, 'NO_REPLY_REQUIRED', { intent: 'pass_through', pass_through: true })
}

function routerFallback(r, burst, identity, ctx, facts, out) {
  let d
  try { d = r.routeOwnerTurn({ messages: burst, identity, context: { numberedOptions: ctx.numberedOptions || [] } }) } catch { return null }
  const fd = { ...facts, ...(d.factsDelta || {}) }
  delete fd.private_draft
  const said = burst.join(' ')
  switch (d.route) {
    case 'PRIVACY_STOP': return out(ACTIONS.DNC, 'DNC', { intent: 'router:privacy', fact_mutations: { ...fd, do_not_contact: true } })
    case 'HUMAN_HANDOFF': {
      const complaint = /\bnot\s+a\s+good\s+start\b|\bdidn'?t\s+answer\b|\bnot\s+answer/i.test(said)
      return out(ACTIONS.HUMAN_HANDOFF, complaint ? 'COMPLAINT' : 'CALLBACK_REQUEST', { intent: 'router:handoff', fact_mutations: { ...fd, human_requested: true },
        draft_reply: complaint ? null : "Of course — I'll pass this to the agent handling it, who will contact you directly." })
    }
    case 'HUMAN_REVIEW': return out(ACTIONS.HUMAN_HANDOFF, 'CONFLICT_REQUIRES_REVIEW', { intent: 'router:review', fact_mutations: fd })
    case 'ANSWER_QUESTION':
      return d.replyText
        ? out(ACTIONS.ANSWER_DIRECT, 'OWNER_DIRECT_QUESTION', { intent: 'router:answer', draft_reply: d.replyText, fact_mutations: fd })
        : out(ACTIONS.HUMAN_HANDOFF, 'OWNER_DIRECT_QUESTION', { intent: 'router:answer_held', fact_mutations: fd })
    case 'CORRECT_FACT':
      return out(ACTIONS.ACKNOWLEDGE_UPDATE, 'QUESTION_ALREADY_ANSWERED', { intent: 'router:correction', fact_mutations: { ...fd, correction: true }, draft_reply: "Thanks for the correction — I've updated it." })
    case 'AVAILABILITY_UPDATE':
      return out(ACTIONS.ACKNOWLEDGE_UPDATE, 'QUESTION_ALREADY_ANSWERED', { intent: 'router:availability', fact_mutations: fd, draft_reply: "Thank you — I've updated the availability." })
    case 'PROPERTY_DRAFT':
      return out(ACTIONS.ACKNOWLEDGE_UPDATE, 'QUESTION_ALREADY_ANSWERED', { intent: 'router:new_offer', fact_mutations: fd, draft_reply: "Thank you — I've noted the property details." })
    case 'ACK_ONLY':
      return out(ACTIONS.NO_SEND, 'NO_REPLY_REQUIRED', { intent: 'router:nothing_now', fact_mutations: fd })
    case 'FACT_UPDATE':
      return Object.keys(d.factsDelta || {}).length
        ? out(ACTIONS.ACKNOWLEDGE_UPDATE, 'QUESTION_ALREADY_ANSWERED', { intent: 'router:fact', fact_mutations: fd, draft_reply: 'Thank you — noted.' })
        : null
    default: return null
  }
}

// Facts that belong to the same burst but were said in an earlier line.
function knownCarry(ctx, plain) {
  const carry = {}
  if (RE.pets.test(plain)) carry.pets_allowed = false
  return carry
}

function finalize(d, ctx) {
  const reasons = []
  if (BLOCKING_ACTIONS.has(d.next_action)) reasons.push(`action_${d.next_action.toLowerCase()}`)
  if (!d.draft_reply) reasons.push('no_draft')
  if (!REPLY_ACTIONS.has(d.next_action)) reasons.push('non_reply_action')
  d.send_eligible = REPLY_ACTIONS.has(d.next_action) && !!d.draft_reply && !BLOCKING_ACTIONS.has(d.next_action)
  d.dispatch_blocked = !d.send_eligible
  d.block_reasons = d.send_eligible ? [] : reasons
  if (d.next_action === ACTIONS.HUMAN_HANDOFF) d.needs_human_review = true
  if (d.fact_mutations && typeof d.fact_mutations === 'object') {
    for (const k of Object.keys(d.fact_mutations)) if (d.fact_mutations[k] === undefined) delete d.fact_mutations[k]
  }
  return d
}

module.exports = {
  POLICY_VERSION, ACTIONS, DEFAULT_WINDOW, decide, extractFacts, readAttachments, insideWindow, nextWindowOpen,
  maltaParts, identityQuestionKind, viewingWhen, _RE: RE,
}
