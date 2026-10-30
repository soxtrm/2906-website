'use strict'
// ============================================================================
// services/ownerSendGate.js — "may the bot write to this owner right now?"
// ONE place for it (Kev's 2026-09-15 hotfix item 7, extended by the 2026-09-21
// owner-bot hotfix). Reads the state that ALREADY exists; owns only two things
// that had no home: the HUMAN_REVIEW_REQUIRED stand-down and the "cancel every
// queued thing for this owner" sweep.
//
// State it reads (never a third copy of it):
//   - owner_auto_conversations.status / automation_disabled  (autoOwnerConversation.js)
//   - owner_assistant_state.status                            (ownerAssistant.js)
//   - owner_contacts.do_not_contact / status='do_not_contact', blacklist
//   - properties.available_status                             (the canonical listing state)
//
// Reason strings returned by getStandDownReason():
//   human_active               Kev (or an admin) typed in the chat / OWNERGROUPS HUMAN_ACTIVE
//   cancelled_chat             !ca / !c
//   automation_disabled        the hard-stop flag alone
//   automation_failure_paused  autoOwnerConversation Point I (owner complained about the bot)
//   human_review_required      the frustration stand-down below (only a human resumes it)
//   needs_human_contact        the owner asked for a person / a call
//   owner_assistant_disabled   OWNERGROUPS switched off
// ============================================================================
const db = require('../db')
const log = require('../logger')
const { isTemporaryHumanPauseActive } = require('./ownerPausePolicy')

const digits = (v) => String(v || '').replace(/\D/g, '')
// A LID is 14-15 digits; a phone is at most 13. Anything longer must never be
// compared by its trailing digits — it could collide with a real number.
const realPhoneOf = (v) => {
  const d = digits(String(v || '').replace(/@.*/, ''))
  return d.length >= 8 && d.length <= 13 ? d : null
}

// Statuses of owner_auto_conversations that mean "stand down".
const AUTOCONVO_STAND_DOWN = {
  human_paused: 'human_active',
  cancelled_chat: 'cancelled_chat',
  automation_failure_paused: 'automation_failure_paused',
  human_review_required: 'human_review_required',
  needs_human_contact: 'needs_human_contact',
}

// Bot stand-downs an agent's own explicit board / !av action is allowed through.
const AGENT_PASSES_STAND_DOWN = new Set([
  'human_active', 'automation_disabled', 'cancelled_chat', 'owner_assistant_disabled',
  'automation_failure_paused', 'needs_human_contact', 'permanent_owner_stop',
])

// A viewing is only ever requested for a listing that is actually open.
const VIEWING_OK = new Set(['available', 'available_confirmed', 'upcoming'])
// Asking an owner anything about a listing we already KNOW is gone contradicts state.
const NOT_ASKABLE = new Set(['rented', 'not_available', 'archived'])

// Kev, 2026-09-16 (real live incident, the "Clifford"/Rabat chat): !ca did
// NOT stop availability.js's chatter, even though !ca's own webhook.js
// handler cancels the SAME chat's owner_auto_conversations row. Root cause:
// !ca's cancelChatAutomation() sets status='cancelled_chat' (+
// automation_disabled=TRUE), never 'human_paused' -- that status string is
// only ever written by a PLAIN human message (handleFromMeMessage). Both
// tables' "a human/admin stopped this" signal and "a human is mid-conversation"
// signal are TWO different status strings each; every terminal status each
// table actually writes has to be checked, not just the one a test used.
async function getStandDownReason(phone) {
  if (!phone) return null
  try {
    const [autoConvo, ownerAssist, permanentBlock] = await Promise.all([
      // Most recent row only -- a phone can have many owner_auto_conversations
      // rows across past outreach cycles; an ancient !ca from months ago must
      // never permanently silence a brand new, unrelated conversation.
      db.query(
        `SELECT status, automation_disabled, updated_at FROM owner_auto_conversations
          WHERE phone = $1 ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 1`,
        [phone]),
      db.query(
        `SELECT status, pause_until FROM owner_assistant_state
          WHERE owner_phone = $1 ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 1`,
        [phone]),
      db.query(
        `SELECT reason FROM owner_automation_blocks
          WHERE phone_normalized = $1 AND active = TRUE LIMIT 1`,
        [phone]),
    ])

    if (permanentBlock.rows[0]) return 'permanent_owner_stop'

    const ac = autoConvo.rows[0]
    if (ac) {
      // A plain human message is a temporary overlap guard. It must not become
      // a permanent owner/property shutdown merely because the owner replied
      // hours later. Explicit stops, complaints and review states remain hard.
      if (ac.status === 'human_paused') {
        if (isTemporaryHumanPauseActive(ac.updated_at)) return 'human_active'
      } else if (AUTOCONVO_STAND_DOWN[ac.status]) {
        return AUTOCONVO_STAND_DOWN[ac.status]
      }
      if (ac.automation_disabled === true && ac.status !== 'human_paused') return 'automation_disabled'
    }

    const oa = ownerAssist.rows[0]
    if (oa) {
      // DISABLED (set by !ca or the manual toggle) has no auto-resume job
      // behind it -- unlike HUMAN_ACTIVE it stays off until someone
      // explicitly re-enables it, so no pause_until/expiry check applies.
      if (oa.status === 'DISABLED') return 'owner_assistant_disabled'
      if (oa.status === 'HUMAN_ACTIVE') {
        if (!oa.pause_until || new Date(oa.pause_until).getTime() > Date.now()) return 'human_active'
      }
    }
    return null
  } catch (err) {
    // Safety-critical contact permission is fail-closed. The caller can put
    // the item into human review; it must never guess that contact is allowed.
    log.error('ownerSendGate: stand-down check failed — blocking owner send', { err: err.message })
    return 'gate_unavailable'
  }
}

async function isHumanActiveForPhone(phone) {
  return !!(await getStandDownReason(phone))
}

// chat id → real phone. '@c.us' is its own answer; a '@lid' is asked of WAHA
// (GET /api/{session}/lids/{lid} → { lid, pn }, verified live 2026-09-21).
// null when it cannot be resolved — callers then fall back to what they have.
async function resolveChatPhone(session, chatId) {
  const raw = String(chatId || '')
  if (/@(?:c\.us|s\.whatsapp\.net)$/i.test(raw)) return realPhoneOf(raw)
  if (!/@lid$/i.test(raw) || !session) return null
  try {
    const config = require('../config')
    const res = await fetch(
      `${config.waha.url}/api/${encodeURIComponent(session)}/lids/${encodeURIComponent(raw)}`,
      { headers: { 'X-Api-Key': process.env.WAHA_API_KEY || '' }, signal: AbortSignal.timeout(4000) })
    if (!res.ok) return null
    const j = await res.json()
    return realPhoneOf(j && j.pn)
  } catch (err) {
    log.debug('ownerSendGate: lid resolve failed', { err: err.message })
    return null
  }
}

// ── the pre-send hard gate ──────────────────────────────────────────────────
// checkOwnerSend({ phone | ownerId, propertyId, kind }) → { allow, reason }
//
//   kind 'reply'    the bot answering something the owner just wrote
//        'followup' a proactive nudge (morning / call-ping)
//        'check'    a fresh availability question (!av, board)
//        'viewing'  a viewing request going to the owner
//        'relay'    an agent's own words, mid-conversation, passed on
//
// Block rules, in order:
//   1. DNC / blacklist                                        — every kind
//   2. stand-down (see getStandDownReason)                    — every kind, except
//      that a plain human_active does not stop 'viewing'/'relay': that is a
//      human AGENT talking, not the bot, and Kev being in the chat is the
//      case bookRelay's own takeover logic already handles
//   3. the listing itself: 'viewing' needs an open listing; 'relay'/'followup'
//      never go out for one we already know is rented / not_available / archived
async function getAutomationMode() {
  const r = await db.query(`SELECT value FROM settings WHERE key = 'owner_automation_mode' LIMIT 1`)
  return String(r.rows[0]?.value || 'LIVE').trim().toUpperCase()
}

async function hasCurrentApproval({ approvalId, contextHash, phone }) {
  if (!approvalId || !contextHash || !phone) return false
  const r = await db.query(
    `SELECT 1 FROM owner_recheck_tasks
      WHERE id = $1 AND owner_phone = $2
        AND state = 'APPROVED'
        AND context_hash = $3
        AND approval_context_hash = $3
        AND approved_at IS NOT NULL
      LIMIT 1`,
    [approvalId, phone, contextHash])
  return !!r.rows.length
}

async function checkOwnerSend({
  phone = null, ownerId = null, propertyId = null, kind = 'reply', session = null,
  chatId = null, automated = false, reviewRequired = automated, approvalId = null, contextHash = null,
} = {}) {
  try {
    let p = realPhoneOf(phone)
    if (!p && ownerId) {
      const r = await db.query('SELECT phone_normalized FROM owner_contacts WHERE id = $1', [ownerId])
      p = realPhoneOf(r.rows[0] && r.rows[0].phone_normalized)
    }
    // An inbound owner DM arrives as a @lid chat; the reply job is queued against
    // THAT chat id. Without resolving it the DNC / stand-down lookups below would
    // compare a 15-digit LID against phone columns and silently never match — which
    // is exactly how the pre-2026-09-21 human-active gate never fired for LID chats.
    if (!p && chatId) p = await resolveChatPhone(session, chatId)

    if (reviewRequired) {
      const mode = await getAutomationMode()
      if (mode === 'REVIEW_ONLY' && !(await hasCurrentApproval({ approvalId, contextHash, phone: p }))) {
        return { allow: false, reason: 'review_only' }
      }
    }

    if (p) {
      const dnc = await db.query(
        `SELECT 1 FROM owner_contacts
          WHERE right(regexp_replace(COALESCE(phone_normalized,''), '\\D', '', 'g'), 9) = $1
            AND (do_not_contact IS TRUE OR status = 'do_not_contact')
          UNION ALL
         SELECT 1 FROM blacklist
          WHERE right(regexp_replace(COALESCE(phone,''), '\\D', '', 'g'), 9) = $1
          LIMIT 1`, [p.slice(-9)])
      if (dnc.rows.length) return { allow: false, reason: 'dnc' }
    }

    // CONTACT PAUSE != AVAILABILITY (2026-09-21). "Do not contact until <date>" is
    // a permission on the OWNER / the LISTING, independent of available_status: the
    // listing stays available / upcoming, matchable and on the board; we simply do
    // not write first. An owner who writes to us is still answered ('reply').
    // Either pause blocks; the date rides in the reason ("owner_contact_paused:2026-11-01").
    if (kind !== 'reply') {
      const pause = await db.query(
        `SELECT 'owner_contact_paused' AS why, owner_contact_paused_until::text AS until
           FROM owner_contacts
          WHERE owner_contact_paused_until > CURRENT_DATE
            AND (id = $1 OR ($2::text IS NOT NULL
                 AND right(regexp_replace(COALESCE(phone_normalized,''), '\\D', '', 'g'), 9) = $2::text))
         UNION ALL
         SELECT 'property_contact_paused', property_contact_paused_until::text
           FROM properties
          WHERE id = $3 AND property_contact_paused_until > CURRENT_DATE
         ORDER BY 2 DESC LIMIT 1`,
        [ownerId, p ? p.slice(-9) : null, propertyId])
      if (pause.rows.length) return { allow: false, reason: `${pause.rows[0].why}:${pause.rows[0].until}` }
    }

    if (p) {
      const sd = await getStandDownReason(p)
      if (sd) {
        const humanAgentKind = kind === 'viewing' || kind === 'relay'
        // !s blocks the conversational AI permanently, while explicit agent
        // actions (Still available / viewing / relay) remain usable.
        const explicitAgentAction = !automated && (kind === 'check' || humanAgentKind)
        // Kev, 2026-10-19: "a person is handling this owner right now" blocked the
        // board's own Still available? / Ask for 40 h after anybody typed in the
        // owner chat. These stand-downs exist to keep the BOT quiet; an agent
        // clicking on the board IS the person. Explicit agent actions pass them.
        // Still blocking: DNC + contact pause (above), and an owner who
        // complained about the bot (human_review_required — resume with !o first).
        if (explicitAgentAction && AGENT_PASSES_STAND_DOWN.has(sd)) {
          // explicit agent action: allowed
        } else if (!(sd === 'human_active' && humanAgentKind)) {
          return { allow: false, reason: sd }
        }
      }
    }

    if (propertyId && (kind === 'viewing' || kind === 'relay' || kind === 'followup')) {
      const pr = await db.query('SELECT available_status FROM properties WHERE id = $1', [propertyId])
      const st = pr.rows[0] && pr.rows[0].available_status
      if (kind === 'viewing' && st && !VIEWING_OK.has(st)) return { allow: false, reason: `property_${st}` }
      if (st && NOT_ASKABLE.has(st) && kind !== 'viewing') return { allow: false, reason: `property_${st}` }
    }
    return { allow: true }
  } catch (err) {
    log.error('ownerSendGate: checkOwnerSend failed — blocking owner send', { err: err.message })
    return { allow: false, reason: 'gate_unavailable', degraded: true }
  }
}

// Plain-English reason for an agent-facing refusal.
function describeBlock(reason) {
  const r = String(reason || '')
  const pausedEarly = /^(owner|property)_contact_paused:(\d{4}-\d{2}-\d{2})$/.exec(r)
  if (pausedEarly) return `contact is on hold until ${pausedEarly[2]} (the listing itself is unaffected)`
  if (r.startsWith('property_')) {
    const st = r.slice('property_'.length)
    return st === 'pending_check'
      ? 'the owner has not confirmed it is available yet'
      : `it is currently marked ${st.replace(/_/g, ' ')}`
  }
  if (r === 'dnc') return 'this owner asked not to be contacted'
  if (r === 'review_only') return 'owner automation is in review-only mode'
  if (r === 'gate_unavailable') return 'the final safety check could not be completed'
  if (r === 'human_review_required') return 'this owner complained about the automated messages — resume them with !o before asking again'
  const paused = /^(owner|property)_contact_paused:(\d{4}-\d{2}-\d{2})$/.exec(r)
  if (paused) return `contact is on hold until ${paused[2]} (the listing itself is unaffected)`
  return 'a person is handling this owner right now'
}

// ── contact pause: set / clear / parse ──────────────────────────────────────
// scope 'owner' → owner_contacts.owner_contact_paused_until (every listing of that
// owner); scope 'property' → properties.property_contact_paused_until (this
// listing only). The listing's available_status / available_date are NEVER touched
// here — that is the whole point of the split.
const PAUSE_COLS = {
  owner:    { tbl: 'owner_contacts', until: 'owner_contact_paused_until',    note: 'owner_contact_pause_note',    by: 'owner_contact_paused_by',    at: 'owner_contact_paused_at' },
  property: { tbl: 'properties',     until: 'property_contact_paused_until', note: 'property_contact_pause_note', by: 'property_contact_paused_by', at: 'property_contact_paused_at' },
}

async function setContactPause({ scope, id, until, note = null, by = 'system' } = {}) {
  const c = PAUSE_COLS[scope]
  if (!c || !id) return { ok: false, reason: 'bad_target' }
  const iso = normalizeIsoDate(until)
  if (!iso) return { ok: false, reason: 'bad_date' }
  await db.query(
    `UPDATE ${c.tbl} SET ${c.until} = $2, ${c.note} = $3, ${c.by} = $4, ${c.at} = NOW() WHERE id = $1`,
    [id, iso, note ? String(note).slice(0, 500) : null, String(by).slice(0, 60)])
  log.info('ownerSendGate: contact pause set', { scope, id, until: iso, by })
  return { ok: true, until: iso }
}

async function clearContactPause({ scope, id, by = 'system' } = {}) {
  const c = PAUSE_COLS[scope]
  if (!c || !id) return { ok: false, reason: 'bad_target' }
  await db.query(
    `UPDATE ${c.tbl} SET ${c.until} = NULL, ${c.note} = NULL, ${c.by} = $2, ${c.at} = NOW() WHERE id = $1`,
    [id, String(by).slice(0, 60)])
  return { ok: true }
}

function normalizeIsoDate(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10)
  const s = String(v || '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s + 'T00:00:00Z').getTime())) return s
  return null
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
// exact month names / 3-letter abbreviations only — "market" must never become March
function monthNum(word) {
  const w = String(word || '').toLowerCase()
  if (w === 'sept') return 9
  const i = MONTH_NAMES.findIndex(n => n === w || (w.length === 3 && n.startsWith(w)))
  return i >= 0 ? i + 1 : 0
}
// "15 Nov", "15th of November 2026", "November 15", "1/12/2026", "2026-11-15", "November"
// (a bare month means its 1st). No year → this year, or next year if that is already past.
function parsePauseDate(text, now = new Date()) {
  const s = String(text || '').trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/\bof\b/g, ' ')
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const mk = (y, m, d) => {
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null
    let dt = new Date(Date.UTC(y, m - 1, d))
    if (dt.getUTCMonth() !== m - 1) return null
    return dt
  }
  let m, dt = null, yearGiven = false
  if ((m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s))) { dt = mk(+m[1], +m[2], +m[3]); yearGiven = true }
  else if ((m = /\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})\b/.exec(s))) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; dt = mk(y, +m[2], +m[1]); yearGiven = true }
  else if ((m = /\b(\d{1,2})\s+([a-z]{3,9})\.?(?:\s+(\d{4}))?\b/.exec(s)) && monthNum(m[2])) {
    yearGiven = !!m[3]; dt = mk(m[3] ? +m[3] : today.getUTCFullYear(), monthNum(m[2]), +m[1])
  } else if ((m = /\b([a-z]{3,9})\.?\s+(\d{1,2})(?:\s+(\d{4}))?\b/.exec(s)) && monthNum(m[1])) {
    yearGiven = !!m[3]; dt = mk(m[3] ? +m[3] : today.getUTCFullYear(), monthNum(m[1]), +m[2])
  } else if ((m = /\b([a-z]{3,9})\b(?:\s+(\d{4}))?/.exec(s)) && monthNum(m[1])) {
    yearGiven = !!m[2]; dt = mk(m[2] ? +m[2] : today.getUTCFullYear(), monthNum(m[1]), 1)
  }
  if (!dt) return null
  if (!yearGiven && dt <= today) dt = new Date(Date.UTC(dt.getUTCFullYear() + 1, dt.getUTCMonth(), dt.getUTCDate()))
  return dt.toISOString().slice(0, 10)
}

// "do not contact until 15 November", "dnc till 1/12", "don't contact the owner before March"
// → { until, note } or null. Used by the upload path so a pause typed into the ad
// text is set at creation time, and by tests.
const PAUSE_TEXT_RE = /\b(?:do\s*not|don'?t|dnc|no)\s+(?:contact|call|message|text|disturb|ping)(?:\s+(?:the\s+)?(?:owner|landlord))?(?:\s+again)?\s*(?:until|till|before|prior\s+to)\s+([^\n.;!?]{3,40})/i
function parseContactPause(text, now = new Date()) {
  const m = PAUSE_TEXT_RE.exec(String(text || ''))
  if (!m) return null
  const until = parsePauseDate(m[1], now)
  return until ? { until, note: m[0].trim().slice(0, 200) } : null
}

// ── frustration ─────────────────────────────────────────────────────────────
// Deliberately conservative in favour of the owner: confusion about what the
// bot is doing is enough to stand down. Kevin can explicitly resume with !o.
const FRUSTRATION_RES = [
  /\bi\s+(?:really\s+|just\s+)?(?:hate|can'?t\s+stand|despise)\s+(?:this|these|the|that)\b.{0,30}\b(?:system|bot|robot|app|messages?|automation|spam)\b/i,
  /\b(?:stop|quit|enough\s+with)\s+(?:the\s+|all\s+this\s+)?(?:asking|messaging|texting|writing|bothering|spamming|harassing|contacting|sending)\b/i,
  /\b(?:this|it|that)\s+(?:is|was|'?s)\s+(?:so\s+|very\s+|really\s+|extremely\s+|getting\s+)?(?:annoying|irritating|ridiculous|harassment|harassing|spam|spamming|insane|outrageous|unacceptable)\b/i,
  /\b(?:app|system|bot|robot|messages?|automation|spam)\s+(?:is|are)\s+(?:so\s+|very\s+|really\s+|extremely\s+)?(?:annoying|irritating|ridiculous|useless|terrible|awful)\b/i,
  /\b(?:leave\s+me\s+alone|fed\s+up|sick\s+(?:and\s+tired\s+)?of\s+(?:this|you|these|it)|had\s+enough|pissed\s+off)\b/i,
  /\bdo\s*n[o']?t\s+(?:ever\s+)?(?:contact|message|text|write\s+to|bother|disturb)\s+me\b/i,
  /^\s*(?:stop|unsubscribe|remove\s+me|opt\s*out)\s*[.!]*\s*$/i,
  /\b(?:are\s+you|is\s+this)\s+(?:an?\s+)?(?:ai|bot|robot|automatic|automated)\b/i,
  /\bam\s+i\s+(?:speaking|talking)\s+(?:chinese|to\s+myself)\b/i,
  /\bwhat\s+(?:are\s+you\s+talking\s+about|do\s+you\s+mean|is\s+going\s+on)\b/i,
  /\b(?:i\s+do\s*n[o']?t|don'?t)\s+(?:understand|get)\s+(?:you|this|what\s+you)\b/i,
  /\b(?:which|what)\s+(?:apartment|property|listing|place)\b/i,
  /\b(?:which|what)\s+clients?\s+(?:do\s+you\s+have|are\s+you\s+talking\s+about)\b/i,
  /\bwhy\s+are\s+you\s+(?:telling|asking)\s+me\s+(?:this|that)\b/i,
  /\b(?:you\s+(?:didn'?t|do\s*n[o']?t|are\s*n[o']?t)|you'?re\s+not)\s+(?:answering|listening|understanding|reading)\b/i,
  /\bthis\s+(?:(?:does\s*n[o']?t|doesn'?t)\s+make|makes\s+no)\s+sense\b/i,
]

const EXPLICIT_OPT_OUT_RES = [
  /\bplease\s+stop\s+(?:it|the\s+bot|the\s+system|this)\s+from\s+(?:contacting|messaging|texting|writing\s+to)\s+me\b/i,
  /\b(?:do\s*not|don'?t|never)\s+(?:contact|message|text|write\s+to)\s+me(?:\s+again)?\b/i,
  /\bturn\s+(?:your|the|this)\s+(?:bot|automation|system)\s+off\b/i,
  /^\s*(?:stop|unsubscribe|remove\s+me|opt\s*out)\s*[.!?]*\s*$/i,
]

function isExplicitOptOut(text) {
  const s = String(text || '').trim()
  return !!s && EXPLICIT_OPT_OUT_RES.some(re => re.test(s))
}

function isFrustratedText(text) {
  const s = String(text || '').trim()
  if (!s) return false
  return FRUSTRATION_RES.some(re => re.test(s))
}

// ── sweep: cancel every queued / open thing for one owner ───────────────────
// Delayed BullMQ jobs on the 'availability' queue (humanDelay's owner replies
// and the +30min/+morning follow-ups) are the "contradictory queued jobs" of the
// spec: they were correct when queued and are wrong the moment the owner says
// rented / not available / stop. Matches by the phone AND by any chat id the
// caller knows (an inbound owner DM arrives as a @lid chat, the thread stores @c.us).
async function invalidateQueuedForOwner({ phone = null, chatIds = [] } = {}) {
  let removed = 0
  try {
    const p = realPhoneOf(phone)
    const chats = new Set([...chatIds].map(c => digits(String(c || '').replace(/@.*/, ''))).filter(Boolean))
    if (p) chats.add(p)
    if (!chats.size) return 0

    let checkIds = new Set()
    if (p) {
      const r = await db.query(
        `SELECT ac.id FROM availability_checks ac
           JOIN owner_contacts oc ON oc.id = ac.owner_id
          WHERE right(regexp_replace(COALESCE(oc.phone_normalized,''), '\\D', '', 'g'), 9) = $1`, [p.slice(-9)])
      checkIds = new Set(r.rows.map(x => Number(x.id)))
    }

    const { QUEUES } = require('../queues')
    const jobs = await QUEUES.availability.getDelayed(0, 1000)
    for (const job of jobs) {
      const d = job.data || {}
      const jd = digits(String(d.chatId || '').replace(/@.*/, ''))
      const sameChat = d.kind === 'human_send' && jd && (chats.has(jd) || (p && jd.length <= 13 && jd.slice(-9) === p.slice(-9)))
      const sameCheck = d.checkId && checkIds.has(Number(d.checkId))
      if (sameChat || sameCheck) {
        try { await job.remove(); removed++ } catch (e) { log.debug('ownerSendGate: job remove failed', { err: e.message }) }
      }
    }
  } catch (err) {
    log.warn('ownerSendGate: invalidateQueuedForOwner failed', { err: err.message })
  }
  if (removed) log.info('ownerSendGate: queued owner jobs invalidated', { removed })
  return removed
}

// ── stop everything for one chat (the body of !ca, shared by !c and frustration)
// Moved here from routes/webhook.js so the three triggers share ONE
// implementation instead of a second copy. Returns what it actually stopped.
async function stopAllAutomationForChat({ phone, chatId = null, session = null, reason = 'stopped', closeRelays = false } = {}) {
  const out = { autoConvo: false, avCancelled: 0, ogaDisabled: false, relaysClosed: 0, jobsRemoved: 0 }
  const p = digits(phone)
  if (!p) return out

  try {
    const autoConvo = require('./autoOwnerConversation')
    out.autoConvo = !!(await autoConvo.cancelChatAutomation(p))
  } catch (e) { log.warn('ownerSendGate: autoConvo cancel failed', { err: e.message }) }

  // Kev, 2026-08-31 (real incident: Elaine Pughe): "stop" means stop the
  // person being bothered, not one of several independent systems. Also cancels
  // any 'awaiting' availability_checks so an open check cannot keep matching
  // the owner's next reply.
  try {
    const r = await db.query(
      `UPDATE availability_checks SET status='cancelled', updated_at=NOW()
         WHERE status='awaiting'
           AND owner_id IN (SELECT id FROM owner_contacts WHERE phone_normalized=$1)
         RETURNING id`, [p])
    out.avCancelled = r.rows.length
  } catch (e) { log.warn('ownerSendGate: av cancel failed', { err: e.message }) }

  // OWNERGROUPS (owner_assistant_state) — the third independent system.
  try {
    const ownerAssistant = require('./ownerAssistant')
    const oaState = chatId && session ? await ownerAssistant.getState(session, chatId) : null
    if (oaState && oaState.enabled) { await ownerAssistant.disable(oaState, reason); out.ogaDisabled = true }
  } catch (e) { log.warn('ownerSendGate: ownerAssistant disable failed', { err: e.message }) }

  if (closeRelays) {
    try {
      const r = await db.query(
        `UPDATE book_relay_threads
            SET status='closed', closed_at=NOW(), updated_at=NOW(), close_reason=$2
          WHERE status <> 'closed'
            AND (owner_chat_id = $1
                 OR ($3::text IS NOT NULL AND agent_chat_id = $3)
                 OR owner_id IN (SELECT id FROM owner_contacts
                                  WHERE right(regexp_replace(COALESCE(phone_normalized,''), '\\D', '', 'g'), 9) = $4))
          RETURNING id`,
        [`${p}@c.us`, String(reason).slice(0, 120), chatId || null, p.slice(-9)])
      out.relaysClosed = r.rows.length
    } catch (e) { log.warn('ownerSendGate: relay close failed', { err: e.message }) }

    out.jobsRemoved = await invalidateQueuedForOwner({ phone: p, chatIds: [chatId, `${p}@c.us`] })
  }
  return out
}

// !s — permanent conversational-AI stop for one owner. This is separate
// from DNC: explicit agent actions may still contact the owner.
async function permanentlyStopOwnerFlow({ phone, chatId = null, session = null, reason = '!s' } = {}) {
  const p = realPhoneOf(phone) || digits(phone)
  if (!p) return { ok: false, reason: 'no_phone' }
  const stopped = await stopAllAutomationForChat({
    phone: p, chatId, session, reason, closeRelays: true,
  })
  await db.query(
    `INSERT INTO owner_automation_blocks
       (phone_normalized, reason, blocked_by_session, blocked_at, active)
     VALUES ($1, $2, $3, NOW(), TRUE)
     ON CONFLICT (phone_normalized) DO UPDATE SET
       reason = EXCLUDED.reason,
       blocked_by_session = EXCLUDED.blocked_by_session,
       blocked_at = NOW(),
       active = TRUE`,
    [p, String(reason).slice(0, 500), session || null])
  log.info('ownerSendGate: permanent owner flow stop set', { phone: p.slice(-4), session, ...stopped })
  return { ok: true, ...stopped }
}

// Explicit human reset. A bare !o in the owner's chat is the only automatic
// way back from a complaint/confusion stop; DNC remains untouched.
async function resumeOwnerFlow({ phone, session = null, reason = '!o manual resume' } = {}) {
  const p = realPhoneOf(phone) || digits(phone)
  if (!p) return { ok: false, reason: 'no_phone' }
  const block = await db.query(
    `UPDATE owner_automation_blocks
        SET active = FALSE, reason = reason || $2
      WHERE phone_normalized = $1 AND active = TRUE
      RETURNING phone_normalized`,
    [p, ` | resumed: ${String(reason).slice(0, 160)}`]
  )
  const convo = await db.query(
    `UPDATE owner_auto_conversations
        SET status = 'ready_for_kev', automation_disabled = FALSE,
            cancelled_reason = COALESCE(cancelled_reason, '') || $2,
            updated_at = NOW()
      WHERE id = (
        SELECT id FROM owner_auto_conversations
         WHERE phone = $1
           AND (status IN ('human_review_required','automation_failure_paused','cancelled_chat')
                OR automation_disabled = TRUE)
         ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 1
      )
      RETURNING id`,
    [p, ` | resumed by ${String(reason).slice(0, 120)}`]
  )
  log.info('ownerSendGate: owner flow manually resumed', {
    phone: p.slice(-4), session, blockCleared: !!block.rows.length, conversationCleared: !!convo.rows.length,
  })
  return { ok: true, blockCleared: !!block.rows.length, conversationCleared: !!convo.rows.length }
}

// ── HUMAN_REVIEW_REQUIRED ───────────────────────────────────────────────────
// A clearly frustrated owner: stop everything, cancel what is queued, record the
// stand-down where every gate already looks, and tell the human ONCE. The bot
// says nothing to the owner — no apology, no explanation. Only an explicit human
// action resumes automation (a fresh !foutreach cycle, or clearing the row).
async function handleFrustratedOwner({ phone, chatId = null, session = null, text = '', ref = null } = {}) {
  const p = digits(phone)
  if (!p) return { handled: false, reason: 'no_phone' }
  const existing = await getStandDownReason(p)
  if (existing === 'human_review_required' || existing === 'permanent_owner_stop') return { handled: false, reason: 'already_paused' }

  const stopped = await permanentlyStopOwnerFlow({
    phone: p, chatId, session,
    reason: `auto-stop: owner complaint/confusion — ${String(text).replace(/\s+/g, ' ').slice(0, 180)}`,
  })

  // The marker is the LATEST row for the phone, which is what every gate reads.
  await db.query(
    `INSERT INTO owner_auto_conversations
       (phone, session, status, checklist, cancelled_reason, automation_disabled, last_owner_message_at)
     VALUES ($1, $2, 'human_review_required', '{}'::jsonb, $3, TRUE, NOW())`,
    [p, session || null, `HUMAN_REVIEW_REQUIRED: owner complained — "${String(text).replace(/\s+/g, ' ').slice(0, 140)}"`])

  await notifyAssignedHuman(
    `🛑 HUMAN_REVIEW_REQUIRED — owner +${p}${ref ? ` (#${ref})` : ''} complained: ` +
    `"${String(text).replace(/\s+/g, ' ').slice(0, 140)}"\n` +
    `Automation stopped (${stopped.relaysClosed} relay(s) closed, ${stopped.avCancelled} check(s) cancelled, ` +
    `${stopped.jobsRemoved} queued message(s) removed). Nothing was sent to the owner. Take it from here.`)

  log.info('ownerSendGate: owner frustrated — automation stopped, human notified', { phone: p.slice(-4), ...stopped })
  return { handled: true, ...stopped }
}

// The human on the receiving end of every stand-down. Today that is Kev's admin
// number, sent from the first live admin session — the same recipient the !ca
// notice, the ambiguous-reply alert and the relay review alert already use.
async function notifyAssignedHuman(text) {
  try {
    const config = require('../config')
    const to = config.admin && config.admin.botNumber
    if (!to) return false
    const av = require('./availability')
    const waha = require('../waha')
    const session = await av.pickAdminSession()
    if (!session) { log.warn('ownerSendGate: no live admin session to notify'); return false }
    await waha.sendText(session, /@/.test(String(to)) ? to : `${digits(to)}@c.us`, text)
    return true
  } catch (err) {
    log.warn('ownerSendGate: human notify failed', { err: err.message })
    return false
  }
}

module.exports = {
  getAutomationMode, getStandDownReason, isHumanActiveForPhone, resolveChatPhone, checkOwnerSend, describeBlock,
  setContactPause, clearContactPause, parsePauseDate, parseContactPause,
  isFrustratedText, isExplicitOptOut, invalidateQueuedForOwner, stopAllAutomationForChat, permanentlyStopOwnerFlow, resumeOwnerFlow, handleFrustratedOwner,
  notifyAssignedHuman, VIEWING_OK, NOT_ASKABLE,
}
