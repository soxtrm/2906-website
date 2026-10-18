'use strict'
// ============================================================================
// availability.js — !av / !avstatus availability check with timed follow-ups.
//
// OPEN commands: anyone, any chat. No admin gate.
//
// Isolated by design: this file owns its own WAHA calls instead of reusing
// waha.js sendReaction / sendText, because
//   • waha.js sendReaction PUTs /api/reactions with a nested body; this WAHA
//     build (2026.7.1, GOWS) only has PUT /api/reaction with a FLAT body, so
//     the shared helper 404s and swallows it as "non-fatal". Reactions are
//     load-bearing here (👍/👎/😡), so we hit the real route ourselves.
//   • waha.js sendText has no reply_to, and "Still on market" must quote the
//     listing message in the category group.
// Nothing in this file mutates shared modules.
//
// LID / casing traps this file has to survive (see memory notes):
//   • owner_account_labels holds BOTH 'Kevthirdd' and 'kevthirdd', and rows for
//     sessions that are FAILED or absent in WAHA (Jasmine, Cedric, Olga).
//     resolveLiveSession() maps a DB name onto a live WORKING session name.
//   • group traffic only ever reaches the 'default' session, so reactions and
//     replies in groups go out through the session that received the command.
// ============================================================================

const db     = require('../db')
const config = require('../config')
const log    = require('../logger')
const redis  = require('../redis')
const waha   = require('../waha')
const { QUEUES, addJob } = require('../queues')
const { normalizePhone } = require('./phoneNormalizer')
// Owner-bound replies go out ~30s later, never in the same second the owner
// wrote. See services/humanDelay.js — Kev's call, and the cheapest realism fix
// in the system.
const humanDelay = require('./humanDelay')
const geoTowns = require('./geoTowns')
const ownerSendGate = require('./ownerSendGate')
// Read the owner chat before writing into it, and vary the wording accordingly.
// Both are soft: a failed scan falls back to the original spec sentence, which
// is variant index 0 of every set. See services/ownerMessageVariants.js for the
// rule that every variant must also appear in OWNER_TEXTS at the bottom of this
// file — bookRelay's human-takeover check compares against it literally.
const ownerChatScan        = require('./ownerChatScan')
const ownerMessageVariants = require('./ownerMessageVariants')
// ^2906Bot tagging + the review-queue alert to Kev when a requester's real
// private number is unknown — see notifyOpenRequesters / postToRequester.
const botTag = require('./botTag')
// Fire-and-forget copy into the admin request dashboard + requester-agent DM.
// See services/dashboardReport.js — never throws into this file's own flow.
const dashboardReport = require('./dashboardReport')
const ownerPortfolioCheck = require('./ownerPortfolioCheck')
const {
  withPropertyLink,
  withAvailableActions,
  classifyAgentAvailabilityDecision,
  agentDecisionPrompt,
} = require('./agentPropertyLinks')

const QUEUE_NAME = 'availability'
const MALTA_TZ   = 'Europe/Malta'

// ── Exact copy required by spec — do not reword ─────────────────────────────
// (2026-09-14: these are still the base sentences, unreworded — but every
// send site now runs them through composeOwnerCheckText(), which appends a
// "(#ref · town · price)" tag and, in urgent mode, one client-interest
// sentence. See spec items 5 and 6.)
const MSG_OWNER_CHECK =
  'Hey, just wanted to check if your property is still available? I just got a request for it?'
const MSG_OWNER_MORNING =
  'Good morning, I tried to reach you yesterday to check if your property is still on market. ' +
  'My clients are very interested about it.'
const MSG_OWNER_RENTED_THANKS =
  "Ok, thank you, don't worry, thanks for letting me know & hope you found the right tenants, " +
  'please keep me posted for new stuff.'
// Kev, 2026-09-14 (conversation-fixes spec, item 4): the old wording ("When
// would you find time to view it") read as if a viewing was already booked.
// AVAILABLE ≠ VIEWING BOOKED — this is still just gathering possible viewing
// windows so we can go back to clients, not promising anyone a viewing.
const MSG_OWNER_STILL_AVAILABLE =
  'Thank you for the update. When would you generally have some time over the next couple of days, ' +
  'so we can speak with our clients and potentially arrange a viewing? ' +
  'And could you tell me when the entrance date would be possible?'
// Kev, 2026-09-15 (decision-layer spec, items 5-7): "owner said yes" must not
// mechanically cascade into both questions every time — MSG_OWNER_STILL_
// AVAILABLE above is now only sent when BOTH the entrance date and the
// viewing window are genuinely unknown (see decideStillAvailableFollowUp).
// These two cover the other cases: only one of the two still missing.
const MSG_OWNER_VIEWING_WINDOW_ONLY =
  'Perfect, thank you. When are you generally available over the next couple of days in case we ' +
  'have clients who would like to arrange a viewing?'
const MSG_OWNER_ENTRANCE_DATE_ONLY =
  'Perfect, thank you — and could you let me know when the entrance date would be possible?'
const MSG_STILL_ON_MARKET = 'Still on market'

// RETIRED 2026-09-22 — no longer sent: the 'first_contact' fallback that used it (the
// central default identity opening a chat with an owner nobody had spoken to) was
// removed with the source-session rule (see pickSourceSession). Was: sent ONLY via
// pickOwnerAccount()'s 'first_contact' fallback (2026-08-20):
// the central Default identity, never an account with history on this owner,
// so it introduces itself instead of asking cold like MSG_OWNER_CHECK does.
// Kev, 2026-09-04: this used to introduce as "2906 Estate Agency" -- every
// account in this system (default/Kevsecond/kevthirdd, plus Cedric) is a
// PERSON, never a company brand, and `firstContact` always resolves to
// config.waha.session1 ('default' = Kevin's primary), so the intro just
// says who's actually texting. No em dash either (Kev's explicit style ask).
const MSG_OWNER_FIRST_CONTACT =
  'Hi, this is Kevin, checking in on your property listing. Is it still available? ' +
  'I have a client asking about it.'
// 2026-09-22: the intro for an owner nobody has written to yet, sent by an allowed outreach
// account (see FIRST_CONTACT_ACCOUNTS). Deliberately NO 'I have a client asking' — a robot
// or a plain button click must not invent client interest (spec 2026-09-14: default GENERAL).
const MSG_OWNER_FIRST_CONTACT_NEUTRAL =
  'Hi, this is Kevin, checking in on your property listing. Is it still available?'

// Kev, 2026-09-11 (Schedule Board "Still Available" escalation): sent ONLY
// when an agent explicitly asks again after the once-a-day guard already
// refused ("already_checked_today") — see requestOwnerAvailability's `force`
// param. Which of the two goes out depends on whether TODAY'S existing
// availability_checks row already got a reply (reply_at IS NOT NULL): a
// clean re-ask reads as nagging once she's already said something, so that
// case gets the softer "just a small check" line instead of the "any update"
// nudge meant for total silence.
const MSG_OWNER_ESCALATE_NOT_REPLIED =
  'Hey, just wanna check if you have any update regarding my request?'
const MSG_OWNER_ESCALATE_REPLIED =
  'Hi, Just a small check, is it still on market?'

// Kev, 2026-09-10 (av time-rules): a property whose available_date is still
// well over the horizon makes "is it still available" the wrong question --
// asking "still on market" AND when a viewing might be possible reads far
// more natural for something available months out. {{GREETING}} is filled
// in per Malta local time, same "Good X" pattern MSG_OWNER_MORNING already uses.
const MSG_OWNER_CHECK_FUTURE_TEMPLATE =
  '{{GREETING}}, just wanted to check if your property is still on market and ' +
  'if you know an estimated time when it could be possible to see it?'

function maltaGreeting() {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: MALTA_TZ }).format(new Date()))
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

// Kev, 2026-09-14 (far-future availability guardrail — supersedes the
// 2026-09-10 flat 2mo/3mo rule): a hard block past 3 months stopped agents
// from checking a genuinely far-out listing at all, and a single soft
// threshold at 2 months didn't distinguish "worth a gentle heads-up note"
// from "you should probably stop and think before pinging this owner".
// Three tiers instead of two thresholds:
//   0-60 days    -> normal, no warning
//   61-100 days  -> allowed normally, soft note only
//   >100 days    -> requires explicit confirmation before sending at all
const { daysUntilAvailable, isFarFuture } = require('./futureAvailability')
function farFutureTier(days, dateStr = null) {
  if (dateStr && isFarFuture(dateStr)) return 'confirm'
  if (days == null || days <= 60) return 'normal'
  return 'soft'
}
function isMoreThanMonthsAway(dateStr) { return isFarFuture(dateStr) }

function buildOwnerCheckMessage(prop, { urgent = false } = {}) {
  const days = daysUntilAvailable(prop.available_date)
  const tier = farFutureTier(days, prop.available_date)
  let base = MSG_OWNER_CHECK
  if (tier === 'soft') {
    base = MSG_OWNER_CHECK_FUTURE_TEMPLATE.replace('{{GREETING}}', maltaGreeting())
  } else if (tier === 'confirm') {
    // Spec: "do not write as if availability is urgent" this far out --
    // never "I have someone asking", always future-oriented, month-named
    // phrasing. Falls back to the 'soft' wording if the date somehow can't
    // resolve to a month (should not happen once tier === 'confirm', which
    // already required a valid date).
    const month = new Date(prop.available_date).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' })
    base = `Hi, just checking ahead regarding #${prop.ref} in ${prop.town || 'your area'} — ` +
      `is it still expected to become available around ${month}?`
  }
  return composeOwnerCheckText(base, prop, { urgent, skipTag: tier === 'confirm' })
}

// Asked when the owner said something negative-sounding that is not actually
// "it is rented". Three variants so a second listing does not get the identical
// sentence.
const MSG_OWNER_CLARIFY = [
  'Got it — has it been rented, or just temporarily unavailable?',
  'Sorry to hear — is it rented, or just on a break for now?',
  'Thanks for the update. Is it rented, or just not available right now?',
]

const FOLLOWUP_CALL_DELAY_MS = 30 * 60 * 1000
const MAX_REPINGS            = 2          // !avstatus → "Yes" cap per check
const REPING_PROMPT_TTL_S    = 15 * 60    // how long a "Yes/No" answer is accepted

// Where the "coming on market in <month>" note goes for the SOON case.
// 'requester' = the chat where !av was run (the person who asked needs to know).
// 'owner'     = the chat the owner replied in (literal reading of the spec).
// See report: this was the one genuinely ambiguous line in the spec.
const SOON_NOTE_TARGET = 'requester'

// ── WAHA plumbing ───────────────────────────────────────────────────────────

async function wahaFetch(method, endpoint, body) {
  const res = await fetch(`${config.waha.url}${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.waha.apiKey },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`WAHA ${method} ${endpoint} → ${res.status}: ${text.slice(0, 300)}`)
  try { return JSON.parse(text) } catch { return null }
}

let _liveSessionCache = { names: null, ts: 0 }

// Sessions that must NEVER be selected for anything in this module (2026-09-22,
// Kev: "Exclude Jasmine completely from session selection"). Jasmine is another
// person's account with her own conversation history; nothing here may send from
// her, pick her as an owner's source account, or fall back to her. Filtered at the
// one place every live-session lookup goes through, so no caller can forget.
const EXCLUDED_SESSIONS = new Set(['jasmine'])
const isExcludedSession = (name) => EXCLUDED_SESSIONS.has(String(name || '').toLowerCase())

// WAHA is the authority on session names AND on which are usable. The DB stores
// historical names with inconsistent casing, so never pass a DB name to WAHA raw.
async function liveSessions() {
  if (_liveSessionCache.names && Date.now() - _liveSessionCache.ts < 60_000) {
    return _liveSessionCache.names
  }
  const list = await wahaFetch('GET', '/api/sessions')
  const names = (Array.isArray(list) ? list : [])
    .filter(s => (s.status === 'WORKING' || s.status === 'CONNECTED') && !isExcludedSession(s.name))
    .map(s => s.name)
  _liveSessionCache = { names, ts: Date.now() }
  return names
}

// 'kevthirdd' → 'Kevthirdd'. Returns null when no live session matches.
async function resolveLiveSession(dbName) {
  if (!dbName) return null
  const names = await liveSessions()
  const want = String(dbName).toLowerCase()
  return names.find(n => n.toLowerCase() === want) || null
}

// Kev priority order (2026-08-25) for admin-facing sends that have no specific
// preferred session — an owner/agent alert to Kev, or a fresh-shortcut notify
// with no thread to answer in. Previously these fell back to
// `getWorkingSessions()[0]`, which is WAHA's own listing order and can just as
// easily be Cedric or Jasmine (not Kev's identity) as it can be Kevsecond.
// default -> Kevsecond -> kevthirdd only, matching CLAUDE.md's Kev rotation;
// never Olga (fully independent) or Jasmine/Cedric (not Kev's accounts).
// Self-heals: re-checked live on every call via resolveLiveSession, no cached
// "we failed over, stay failed over" state.
async function pickAdminSession() {
  return (await resolveLiveSession(config.waha.session1 || 'default'))
      || (await resolveLiveSession(config.waha.session2 || 'Kevsecond'))
      || (await resolveLiveSession(config.waha.session3 || 'kevthirdd'))
      || null
}

// Public-property status messages sent to agents contain no owner contact or
// reply text. Prefer the dedicated Argus4 identity for those messages; if that
// session is awaiting a QR or otherwise offline, Argus5 keeps the flow alive.
// Kevin's own accounts remain the final transport fallback only.
async function pickAgentAlertSession() {
  return (await resolveLiveSession('Argus4'))
      || (await resolveLiveSession('Argus5'))
      || (await pickAdminSession())
}

const toChatId = (v) => {
  const s = String(v || '').trim()
  // Already addressed — '…@c.us', '…@g.us', '…@lid'. Hand it back untouched.
  //
  // Do NOT "normalise" these. Stripping non-digits from an id that already has a
  // domain eats the domain itself: '120363…@g.us' becomes '120363…@', which WAHA
  // rejects with "no LID found for 120363…@s.whatsapp.net" — an error that reads
  // like a broken group and is really a broken id. That is what took out every
  // group listing-reply on 2026-08-14.
  if (s.includes('@')) return s
  // A bare phone: drop the +, the spaces and anything else a masked log left
  // behind. WAHA GOWS hangs silently on a malformed chatId and fetch here has no
  // client timeout, so this much normalisation is load-bearing.
  const digits = s.replace(/\D/g, '')
  return digits ? `${digits}@c.us` : s
}

// Kev, 2026-09-14 (reliability spec item 2, real error live: "WAHA POST
// /api/sendText 500 no LID found for 356994448862@s.whatsapp.net"): the
// session WAHA itself reports WORKING can still fail to resolve a LID for
// one specific recipient at the protocol layer -- a live-session check
// before sending (pickOwnerAccount's own job) cannot catch this, it only
// surfaces as this exact error on the send call. A message that fails here
// silently killed the whole business action; this only retries when the
// failure is unambiguous (wahaFetch throws only on a WAHA-rejected request,
// never on an ambiguous timeout, so a retry can never double-send) and only
// ever substitutes another of KEVIN'S OWN accounts -- never Cedric/Olga/
// Jasmine, whose conversation history belongs to a different real person and
// must never get silently reassigned to a Kevin identity.
function isSendTransportFailure(err) {
  return /no LID found|WAHA POST \/api\/sendText → 5\d\d/i.test(String(err && err.message || ''))
}
// "no LID found" specifically (not a generic 5xx) means WhatsApp's own device
// hasn't finished propagating that recipient's LID mapping yet — observed live
// to often clear itself within seconds. A same-session retry costs nothing
// (no identity change, e.g. still Cedric->Cedric) and needs no live-session
// probe, so try it before falling back to a different Kevin account.
function isLidPropagationFailure(err) {
  return /no LID found/i.test(String(err && err.message || ''))
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// opts.failover === false: the message may ONLY go out through `session`. Owner-bound
// availability checks use it — a transport error must fail the check (it is retried
// later on the SAME session), never silently reroute the owner's conversation to
// another account (2026-09-22: "never silently reroute through default").
async function sendTextAs(session, chatId, text, replyToMessageId = null, opts = {}) {
  const body = { session, chatId: toChatId(chatId), text }
  if (replyToMessageId) body.reply_to = replyToMessageId
  await require('./outreachIdentity').assertOutboundIdentity(session, body.chatId, text)
  let res
  try {
    res = await wahaFetch('POST', '/api/sendText', body)
  } catch (err) {
    if (isLidPropagationFailure(err)) {
      await sleep(4000)
      try {
        res = await wahaFetch('POST', '/api/sendText', body)
        log.info('[av] send succeeded on same-session LID retry', { session })
      } catch (err2) {
        err = err2 // same-session retry also failed — fall through below with its error
      }
    }
    if (!res) {
      if (opts.failover === false
          || !isSendTransportFailure(err) || !config.waha.kevinAccounts.some(k => k.toLowerCase() === String(session).toLowerCase())) {
        throw err
      }
      // Match on the LIVE (WAHA-reported) casing, not config.waha.kevinAccounts'
      // own spelling — same "never pass a DB/config name to WAHA raw" rule
      // liveSessions()'s own header comment already states.
      const live = await liveSessions()
      const fallback = live.find(n =>
        n.toLowerCase() !== String(session).toLowerCase()
        && config.waha.kevinAccounts.some(k => k.toLowerCase() === n.toLowerCase()))
      if (!fallback) throw err
      log.warn('[av] send transport failure — retrying via a fallback Kevin account', {
        planned: session, failure: err.message.slice(0, 160), fallback,
      })
      // the fallback account must be allowed to say this text too (its
      // persona may differ from the planned one — kevinAccounts includes Cedric)
      await require('./outreachIdentity').assertOutboundIdentity(fallback, body.chatId, text)
      body.session = fallback
      res = await wahaFetch('POST', '/api/sendText', body)
      log.info('[av] sent via fallback session', { planned: session, sentVia: fallback })
    }
  }
  // Register with waha.js's echo guard. This module bypasses waha.sendText on
  // purpose (reply_to, flat-body reactions), and the price was that every
  // message it sent came back through routes/webhook.js as fresh input. That
  // became a live defect on 2026-08-16: an availability notify landed in an
  // agent's chat, the !book relay read the bot's own line as the agent's next
  // message, and forwarded it to the owner. Marking the id here makes
  // webhook.js:235 drop the echo for every listener at once.
  try { waha.markSentByBackend(res?.id || res?.key?.id) } catch { /* non-fatal */ }
  // This path bypasses waha.sendText, so the inactivity clock must be reset here too:
  // the software just wrote to this owner (services/contactTouch.js).
  try { require('./contactTouch').recordOutbound(body.chatId, body.session).catch(() => {}) } catch { /* non-fatal */ }
  return res
}

// PUT /api/reaction — flat body { session, messageId, reaction }.
// Non-fatal: a failed reaction must never abort the surrounding flow.
async function reactAs(session, messageId, emoji) {
  if (!session || !messageId) return false
  try {
    await wahaFetch('PUT', '/api/reaction', { session, messageId, reaction: emoji })
    log.info('[av] reaction sent', { session, emoji, msg: String(messageId).slice(-24) })
    return true
  } catch (err) {
    log.warn('[av] reaction failed', { session, emoji, err: err.message })
    return false
  }
}

// ── Outbound call support probe ──────────────────────────────────────────────
// The +30min follow-up is a ~1 second WhatsApp call ping. Ask the running WAHA
// build whether it can place an outbound call AT ALL, rather than assuming.
// Cached per process; re-probed if it ever returns supported.
let _callSupport = null

async function callPingSupport() {
  if (_callSupport) return _callSupport
  try {
    const auth = 'Basic ' + Buffer.from(
      `${process.env.WAHA_DASHBOARD_USERNAME || 'admin'}:${process.env.WAHA_DASHBOARD_PASSWORD || ''}`
    ).toString('base64')
    const res = await fetch(`${config.waha.url}/-json`, { headers: { Authorization: auth } })
    if (!res.ok) throw new Error(`spec fetch ${res.status}`)
    const spec = await res.json()
    const paths = Object.keys(spec.paths || {})
    // An outbound call route would be a POST that starts/offers a call.
    // /calls/reject is INCOMING-only and does not count.
    const outbound = paths.filter(p =>
      /call/i.test(p) && !/reject/i.test(p) && Object.keys(spec.paths[p]).includes('post'))
    _callSupport = outbound.length
      ? { supported: true, endpoint: outbound[0], evidence: `OpenAPI exposes POST ${outbound[0]}` }
      : {
          supported: false,
          endpoint: null,
          evidence: `WAHA ${spec.info?.version || '?'} exposes ${paths.filter(p => /call/i.test(p)).join(', ') || 'no call routes'} — incoming-reject only, no outbound-call route`,
        }
  } catch (err) {
    _callSupport = { supported: false, endpoint: null, evidence: `probe failed: ${err.message}` }
  }
  log.info('[av] call-ping support', _callSupport)
  return _callSupport
}

// ── Time helpers ────────────────────────────────────────────────────────────

// Malta-local wall-clock parts of a UTC instant.
function maltaParts(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: MALTA_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {})
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour % 24, mm: +p.minute }
}

// ms until the next 09:00 Malta time. Container runs UTC, so the offset has to
// be derived rather than hardcoded (+02:00 in summer, +01:00 in winter).
function msUntilNextMorning(hour = 9, from = new Date()) {
  const { y, m, d, hh, mm } = maltaParts(from)
  const todayTargetUtc = utcForMaltaWallClock(y, m, d, hour, 0)
  if (hh * 60 + mm < hour * 60 && todayTargetUtc > from.getTime()) {
    return todayTargetUtc - from.getTime()
  }
  const next = new Date(todayTargetUtc + 24 * 3600 * 1000)
  const np = maltaParts(next)
  return utcForMaltaWallClock(np.y, np.m, np.d, hour, 0) - from.getTime()
}

// Given a Malta wall-clock time, find the UTC epoch ms for it.
function utcForMaltaWallClock(y, m, d, hh, mi) {
  let guess = Date.UTC(y, m - 1, d, hh, mi)
  for (let i = 0; i < 3; i++) {
    const p = maltaParts(new Date(guess))
    const driftMin = (p.hh * 60 + p.mm) - (hh * 60 + mi)
    const dayDrift = (p.d - d) + (p.m - m) * 31 + (p.y - y) * 372
    if (driftMin === 0 && dayDrift === 0) break
    guess -= (driftMin + dayDrift * 24 * 60) * 60_000
  }
  return guess
}

// ── Lookups ─────────────────────────────────────────────────────────────────

// Refs look like '2906-042'. Accept '2906-042', '#2906-042', '042', '42'.
// Anything that does not resolve is INVALID → caller ignores silently.
async function resolveProperty(rawRef) {
  if (!rawRef) return null
  const ref = String(rawRef).trim().replace(/^#/, '')
  if (!ref || !/^[\w-]{1,24}$/.test(ref)) return null

  let r = await db.query(
    `SELECT id, ref, owner_id, available_status, published, town, bedrooms, listed_by_phone,
            last_confirmed_available_at, available_date, longlet_price
       FROM properties WHERE LOWER(ref) = LOWER($1) LIMIT 1`, [ref])
  if (r.rows.length) return r.rows[0]

  // Bare numeric suffix — '42' / '042' matches ref '2906-042'.
  if (/^\d{1,6}$/.test(ref)) {
    r = await db.query(
      `SELECT id, ref, owner_id, available_status, published, town, bedrooms, listed_by_phone,
            last_confirmed_available_at, available_date, longlet_price
         FROM properties
        WHERE ref ILIKE '%-' || LPAD($1, GREATEST(3, LENGTH($1)), '0')
        ORDER BY id DESC LIMIT 1`, [ref])
    if (r.rows.length) return r.rows[0]
  }
  return null
}

// ── property identification (spec item 5, 2026-09-14) ──────────────────────
// Never send a generic "is your property available?" to an owner who may
// have more than one listing with us. Every outbound availability check now
// carries enough for a human AND this module's own reply-matching logic to
// know exactly which unit is meant: ref, locality, price. One formatter, used
// at every send site, so the tag can never drift between !av and the board.
function priceLabel(prop) {
  const n = prop && prop.longlet_price != null ? Number(prop.longlet_price) : null
  return Number.isFinite(n) ? `€${n.toLocaleString('en-US')}` : null
}
function propertyTag(prop) {
  return ['#' + prop.ref, prop.town || null, priceLabel(prop)].filter(Boolean).join(' · ')
}
// Appends the identifying tag (and, for urgent mode, a client-interest line)
// to whichever base sentence was already chosen for tone/variety — never
// rewrites the hand-tuned wording itself, just makes sure every variant ends
// up naming the exact listing. `urgent` defaults to GENERAL (no fabricated
// client interest) per spec item 6 — only an agent explicitly asking again
// (the board's escalate step) sets it.
function composeOwnerCheckText(baseText, prop, { urgent = false, skipTag = false } = {}) {
  // skipTag: the far-future ('confirm' tier) sentence already names the
  // ref and town inline ("#2906-XXXX in Sliema") — appending the same
  // "(#ref · town · price)" tag right after it would just repeat itself.
  const tag = skipTag ? null : propertyTag(prop)
  const urgentLine = urgent ? ' I have clients interested in it.' : ''
  return tag ? `${baseText} (${tag})${urgentLine}` : `${baseText}${urgentLine}`
}

// ── The SOURCE session of an owner (2026-09-22) ──────────────────────────────
//
// Kev: "Still Available must NOT use default. Send through the WhatsApp account the
// owner/property originally came from. If that session is offline, queue the check
// and wait until that same session reconnects. Never silently reroute through
// default. Exclude Jasmine completely from session selection."
//
// An owner's source session is the account that actually has a relationship with
// them — a row in owner_account_labels with real outreach/reply history, on an
// account that is a configured, active WhatsApp account (whatsapp_accounts). If the
// owner has talked to several, the one they REPLIED to wins (that is the chat they
// are in), then the most recent touch. Exactly ONE session is ever returned:
//
//   live            → { session, dbSession, reason:'source_session' }
//   source offline  → { session:null, dbSession, waiting:true, reason:'source_offline' }
//                     the caller QUEUES the check for that same session — there is no
//                     second choice, no pool member, no default.
//   never contacted → { session, dbSession, firstContact:true } — an explicitly allowed,
//                     WORKING outreach account (FIRST_CONTACT_ACCOUNTS: never default,
//                     never Jasmine), least used in the last 24h. claimOwnerCheck() binds
//                     the owner to it permanently; from then on it is their source.
//   unusable        → { session:null, reason:'no_source_session' } — only Jasmine / a
//                     disabled account ever talked to them, or no allowed account is up.
//
// Retired with this change: the requester-session preference, the `default`
// first-contact fallback and the kevinAccounts "pool_fallback" that could land an
// owner's conversation on a different number (and, via config.kevinAccounts, on
// Jasmine).

// Accounts that may OPEN a conversation with an owner nobody has written to yet. Explicit
// allow-list, never derived from WAHA's session list: Kev's two outreach numbers. Not
// `default` (its own history / rescan problem), not Jasmine (excluded everywhere), not
// Cedric / Olga (different personas). Override with AV_FIRST_CONTACT_ACCOUNTS=a,b.
const FIRST_CONTACT_ACCOUNTS = (process.env.AV_FIRST_CONTACT_ACCOUNTS || 'Kevsecond,kevthirdd')
  .split(',').map(s => s.trim()).filter(s => s && s.toLowerCase() !== 'default' && !isExcludedSession(s))
// Only used when no FIRST_CONTACT_ACCOUNTS session is WORKING (Kev 2026-09-25).
const LAST_RESORT_ACCOUNTS = ['default', 'Kevsecond', 'kevthirdd']

async function pickSourceSession(ownerId) {
  const r = await db.query(
    `SELECT wa.session_name AS db_session,
            GREATEST(oal.last_reply_at, oal.last_outreach_at, oal.last_we_sent_at, oal.created_at) AS last_touch,
            (oal.last_reply_at IS NOT NULL) AS replied
       FROM owner_account_labels oal
       JOIN whatsapp_accounts wa ON LOWER(wa.session_name) = LOWER(oal.account_session)
      WHERE oal.contact_id = $1
        AND wa.is_active = true
        AND (oal.source = 'first_contact' OR oal.last_outreach_at IS NOT NULL OR oal.last_reply_at IS NOT NULL OR oal.last_we_sent_at IS NOT NULL)
      ORDER BY (oal.last_reply_at IS NOT NULL) DESC, last_touch DESC NULLS LAST`, [ownerId])
  const seen = new Set()
  const rows = r.rows.filter(x => {
    const k = String(x.db_session).toLowerCase()
    if (isExcludedSession(k) || seen.has(k)) return false
    seen.add(k); return true
  })

  if (!rows.length) {
    // History that exists but is unusable (Jasmine, a disabled or unknown account) can never
    // flush a queue — that account is not coming back. Kev 2026-09-25: "solange der owner
    // hinterlegt ist muss er outreached werden. Wenn es keine Queue gibt, dann machts halt
    // der einzig aktive Zugang." So it is treated like a first contact from a Kev account
    // (intro text, owner re-bound to that account); the old chat is simply not used.
    const any = await db.query(
      `SELECT 1 FROM owner_account_labels
        WHERE contact_id = $1
          AND (source = 'first_contact' OR last_outreach_at IS NOT NULL OR last_reply_at IS NOT NULL OR last_we_sent_at IS NOT NULL) LIMIT 1`, [ownerId])
    const rebind = any.rows.length > 0

    // Never contacted (or rebind) → an allowed, WORKING outreach account, the least used for
    // first contacts in the last 24h. claimOwnerCheck() binds the owner to it permanently.
    const active = await db.query(
      `SELECT session_name FROM whatsapp_accounts WHERE is_active = true AND LOWER(session_name) = ANY($1)`,
      [FIRST_CONTACT_ACCOUNTS.map(s => s.toLowerCase())])
    const allowed = active.rows.map(x => x.session_name)
    const workingList = []
    for (const name of allowed) {
      let live = null
      try { live = await resolveLiveSession(name) } catch { live = null }
      if (live) workingList.push({ dbSession: name, session: live })
    }
    // Kev 2026-09-25: none of the outreach numbers is up → whichever Kev account IS up
    // (default included). Never Jasmine (liveSessions filters her), never Cedric/Olga
    // (different people — the identity guard would refuse a Kevin-signed text anyway).
    if (!workingList.length) {
      for (const name of LAST_RESORT_ACCOUNTS) {
        let live = null
        try { live = await resolveLiveSession(name) } catch { live = null }
        if (live) { workingList.push({ dbSession: name, session: live }); break }
      }
    }
    if (!workingList.length) return { session: null, dbSession: null, reason: 'no_source_session', firstContact: true, unusableHistory: rebind, tried: allowed }
    const load = await db.query(
      `SELECT LOWER(account_session) AS s, COUNT(*)::int AS n FROM owner_account_labels
        WHERE source = 'first_contact' AND created_at > NOW() - INTERVAL '24 hours' GROUP BY 1`)
    const used = new Map(load.rows.map(x => [x.s, x.n]))
    workingList.sort((p, q) => (used.get(p.dbSession.toLowerCase()) || 0) - (used.get(q.dbSession.toLowerCase()) || 0))
    return { session: workingList[0].session, dbSession: workingList[0].dbSession, reason: rebind ? 'rebind_unusable_source' : 'first_contact_bind', firstContact: true, rebind, tried: [] }
  }

  const source = rows[0]
  let live = null
  try { live = await resolveLiveSession(source.db_session) } catch { live = null } // WAHA unreachable == offline: wait
  if (live) return { session: live, dbSession: source.db_session, lastTouch: source.last_touch, reason: 'source_session', tried: [] }
  return { session: null, dbSession: source.db_session, waiting: true, reason: 'source_offline', tried: [source.db_session] }
}

// Kept under its old name/signature for handlers/av.js-era callers; the second
// argument (the requester's own session) is ignored now — the owner's chat lives on
// the owner's source account, not on whichever account the agent happens to watch.
async function pickOwnerAccount(ownerId /* , preferredSession */) {
  return pickSourceSession(ownerId)
}

// fallbackPhone: properties.listed_by_phone for the SAME property being
// resolved — populated at listing-creation time (handlers/upload.js,
// handlers/uploadListing.js) and already used as a contact fallback
// elsewhere (routes/crm.js, services/googleAgentSheet.js). owner_contacts
// is checked first; this never guesses across a different owner/property.
async function ownerPhone(ownerId, fallbackPhone = null) {
  const r = await db.query('SELECT id, phone_normalized, name FROM owner_contacts WHERE id = $1', [ownerId])
  const row = r.rows[0] || null
  if (row && !row.phone_normalized && fallbackPhone) {
    return { ...row, phone_normalized: fallbackPhone, phone_source: 'listed_by_phone' }
  }
  if (!row && fallbackPhone) {
    return { id: ownerId, phone_normalized: fallbackPhone, name: null, phone_source: 'listed_by_phone' }
  }
  return row
}

// ── Reply classification — CLEAR replies only, never guess ──────────────────

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december']
const MONTHS_SHORT = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec']

const POSITIVE = /\b(yes|yeah|yep|yup|sure|of course|still available|available|still free|still on market|on market|still there|still vacant|vacant|it is free)\b/i
const NEGATIVE = /\b(no|nope|rented|taken|gone|let out|leased|sold|not available|no longer|already rented|already gone|off market)\b/i

// ── the ambiguous middle ────────────────────────────────────────────────────
// A bare "no", "sorry", "nothing right now" is NOT a confession that the flat
// was rented. Treating it as one killed listings whose owner only meant "I have
// nothing free at the moment". So: an unambiguous rented VERB is a NO, and a
// merely negative-sounding reply earns a clarifying question instead of a
// verdict.
const RENTED_VERB = /\b(?:rented|let out|leased|taken|sold|gone|under offer|off the market|withdrawn|given away)\b/i
const UNCLEAR_TRIGGERS = /\b(?:no|nope|not really|sorry|unfortunately|nothing|nada|nah|not at the moment|right now|for now)\b/i

// Negated availability — "no longer available", "not on the market anymore".
// These trip POSITIVE on the bare word "available"/"market", which would read as
// contradictory and land in 'unclear'. They are unambiguous NOs, so they win
// outright before the positive/negative tie-break.
const NEGATED_AVAILABILITY =
  /\b(?:no longer|not|isn'?t|is not|nt)\s+(?:be\s+)?(?:available|free|vacant|there|on\s+(?:the\s+)?market)\b|\balready\s+(?:rented|gone|taken|let|leased)\b|\b(?:off|out of)\s+(?:the\s+)?market\b/i

// Bare "rent" used as the predicate — "the property is already rent", "it's
// rent". Maltese owners write this constantly and RENTED_VERB, which only knows
// the inflected form, sailed straight past it. Check id 45 (property 167) is
// the case that proved it: "the property is already rent sorry … my next one
// available" was filed as AVAILABLE and the flat stayed on the board rented.
//
// Narrow on purpose. It requires a copula (or "already") immediately before the
// word, so the phrases that mean the OPPOSITE stay clear of it:
//   "the flat is for rent"  → "for" sits in between, no match  (= available)
//   "I want to rent it"     → no copula                        (= available)
//   "the rent is 900"       → "rent" is the subject, not the predicate
// The lookahead keeps "rented"/"renting"/"rental"/"rent-free" out; "rented" is
// RENTED_VERB's job and "rent-free" means the opposite.
const BARE_RENT = /(?:\bis|\bare|\bwas|\bwere|\bbeen|\balready|'s)\s+(?:already\s+)?rent(?![a-z-])/i

// A rented verb with a negation in front of it is the owner saying the flat is
// FREE — "not rented yet", "nobody rented it", "it isn't let out". Before this,
// the bare word "rented" voted NO in both RENTED_VERB and NEGATIVE, so those
// replies took the listing off the board and thanked the owner for finding
// tenants they had just said they had not found.
//
// Bare "no" is deliberately NOT a negator here. "No sorry it's rented" is a real
// owner reply in this table and must stay a NO. Only explicit negative words
// count, and the gap stops at clause punctuation so "not sure, it's gone" is
// not read as a negated "gone".
const NEGATED_RENTED =
  /\b(?:not|never|nobody|no\s+one|isn'?t|wasn'?t|aren'?t|weren'?t|hasn'?t|haven'?t|hadn'?t|didn'?t|doesn'?t|don'?t)\b[^.!?;,]{0,15}?\b(?:rent|rented|let\s+out|leased|taken|sold|gone)\b/i

function monthIndex(raw) {
  const r = String(raw || '').toLowerCase().replace(/^sept$/, 'sep')
  const full = MONTHS.find(x => x.startsWith(r))
  return full ? MONTHS.indexOf(full) : -1
}
function monthLabel(raw) {
  const r = String(raw || '').toLowerCase().replace(/^sept$/, 'sep')
  const full = MONTHS.find(x => x.startsWith(r)) || r
  return full.charAt(0).toUpperCase() + full.slice(1)
}
// Resolves a month (+ optional day, + optional explicit year) into a real
// calendar date. No explicit year → the next future occurrence of that month
// (an owner saying "until March" in September always means the next March,
// never one already past). An explicit year is trusted outright, even if it
// reads oddly far out — "till 1st March 2027" is the owner's own words, not
// ours to second-guess.
function resolveMonthDate({ monthRaw, day, year }) {
  const mi = monthIndex(monthRaw)
  if (mi < 0) return null
  const now = new Date()
  let y = year ? parseInt(year, 10) : now.getUTCFullYear()
  if (!year) {
    const candidate = Date.UTC(y, mi, day || 1)
    if (candidate <= Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) y += 1
  }
  const d = new Date(Date.UTC(y, mi, day || 1))
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

// A future-facing timeframe = the SOON case ("tenant until September").
// Requires a forward marker so "rented last month" does not read as SOON.
// → { label, date } | null — `date` (ISO yyyy-mm-dd) is set whenever a month
// could be resolved to a real calendar date (item 1, 2026-09-14: "rented
// until 1st March 2027" has to become a real available_date, not just a
// pretty label), `label` is always the human-readable fallback.
function extractTimeframeDetail(text, baseDate = new Date()) {
  const t = String(text || '').toLowerCase()
  const marker = '(?:until|untill|til|till|from|as of|after|beginning of|end of|start of|in|by|on)'
  // Optional day-of-month ("1st", "01", "1") between the marker and the month,
  // and an optional trailing year — "till 1st March 2027", "until March 2027",
  // "from 1 March".
  const monthRe = new RegExp(
    `\\b${marker}\\s+(?:the\\s+)?(?:(\\d{1,2})(?:st|nd|rd|th)?\\s+)?(${[...MONTHS, ...MONTHS_SHORT].join('|')})\\b(?:\\s*,?\\s*(\\d{4})\\b)?`,
    'i')
  const m = t.match(monthRe)
  if (m) {
    const [, day, monthRaw, year] = m
    const label = monthLabel(monthRaw)
    return { label, date: resolveMonthDate({ monthRaw, day: day ? parseInt(day, 10) : null, year }) }
  }
  if (/\bnext month\b/.test(t))      return { label: 'next month', date: null }
  if (/\bnext week\b/.test(t))       return { label: 'next week', date: null }
  if (/\bin (?:a|one) month\b/.test(t)) return { label: 'a month', date: null }
  const relative = t.match(/\b(in|for|another|other|some\s+other|about|around|roughly|approximately|approx\.?)\s+(\d{1,2})\s+(weeks?|months?)\b/i)
  if (relative) {
    const introducer = relative[1].toLowerCase()
    const amount = Number(relative[2])
    const unit = relative[3].toLowerCase()
    const base = new Date(baseDate)
    const approx = Number.isNaN(base.getTime()) ? null : new Date(base)
    if (approx) {
      if (unit.startsWith('week')) approx.setUTCDate(approx.getUTCDate() + amount * 7)
      else approx.setUTCMonth(approx.getUTCMonth() + amount)
    }
    return {
      label: `${/^(?:another|other|some\s+other|about|around|roughly|approximately|approx)/.test(introducer) ? 'about ' : ''}${amount} ${unit.replace(/s$/, '')}${amount > 1 ? 's' : ''}`,
      date: approx ? approx.toISOString().slice(0, 10) : null,
      precision: 'approximate',
      relative: true,
    }
  }
  // Bare month name with no marker still counts if the text also says the place
  // is occupied now — "tenant september", "tenants leaving september".
  if (/\b(tenant|tenants|lease|contract)\b/.test(t)) {
    const bare = t.match(new RegExp(`\\b(${[...MONTHS, ...MONTHS_SHORT].join('|')})\\b`, 'i'))
    if (bare) {
      const monthRaw = bare[1]
      return { label: monthLabel(monthRaw), date: resolveMonthDate({ monthRaw, day: null, year: null }) }
    }
  }
  return null
}
// Back-compat label-only accessor — still used by renderStatus().
function extractTimeframe(text) {
  const d = extractTimeframeDetail(text)
  return d ? d.label : null
}

// → { status, timeframe } | { status: 'unclear' }
function classifyReply(text, { messageDate = new Date() } = {}) {
  const raw = String(text || '').trim()
  if (!raw) return { status: 'unclear' }

  // "tenant until September" / "rented until September" both mean: comes back
  // on market at that point → SOON, not a flat no. Read from the untouched
  // text, before the negation blanking below can eat a month name.
  const tf = extractTimeframeDetail(raw, messageDate)
  // A statement can confirm that a listing is still on the market while also
  // saying the current tenants leave in roughly N weeks. Keep the positive
  // market verdict and attach the approximate move-in fact; occupancy alone
  // is never a rented/off-market signal.
  if (tf && POSITIVE.test(raw) && !NEGATED_AVAILABILITY.test(raw)) {
    return { status: 'replied_available', timeframe: tf.label, date: tf.date, precision: tf.precision || 'stated' }
  }
  if (tf) return { status: 'replied_soon', timeframe: tf.label, date: tf.date, precision: tf.precision || 'stated' }

  // Blank out a negated rented verb before ANYTHING reads the text. Deleting
  // the phrase is what makes the rest of this function correct: leaving it in
  // means "still available, not rented" still trips NEGATIVE on the word
  // "rented", `pos && !neg` fails, and a plain yes lands in 'unclear'.
  const notRented = NEGATED_RENTED.test(raw)
  const t = notRented ? raw.replace(NEGATED_RENTED, ' ') : raw

  const neg = NEGATIVE.test(t)
  const pos = POSITIVE.test(t)
  const rented = RENTED_VERB.test(t) || BARE_RENT.test(t)

  // "no longer available" is a NO, not a contradiction. It has to win before the
  // UNCLEAR branch, because it contains the word "no" and would otherwise look
  // like a merely negative-sounding reply.
  if (NEGATED_AVAILABILITY.test(t)) return { status: 'replied_no' }
  // Rented AND positive in the same message: do not pick a side, ask. This is
  // the property-167 shape — the owner reports one flat rented and mentions a
  // different one as available, and whichever signal the code happened to test
  // first decided the board. Guessing here is what "CLEAR replies only" exists
  // to prevent, and the clarifying question costs one message.
  if (rented && pos) return { status: 'replied_unclear' }
  // An explicit rented verb (rented, let out, leased, taken, sold, gone, under
  // offer, withdrawn) or a bare "is already rent" is an unambiguous NO.
  if (rented) return { status: 'replied_no' }
  // A clear yes comes BEFORE the unclear branch on purpose: "sorry for the late
  // reply, still available" contains "sorry" and would otherwise be sent back to
  // the owner as a question they have already answered — and, worse, the
  // confirmation would never reach the board.
  if (pos && !neg) return { status: 'replied_available' }
  // "not rented yet" with nothing negative around it IS a yes, even though the
  // owner never said the word available.
  if (notRented && !neg) return { status: 'replied_available' }
  // Negative-sounding, but with no rented verb in it: ask, do not conclude.
  if (UNCLEAR_TRIGGERS.test(t)) return { status: 'replied_unclear' }
  if (neg && !pos) return { status: 'replied_no' }
  return { status: 'unclear' }   // ambiguous or contradictory → stay awaiting
}

// ── ARGUS OWNER + PROPERTY STATE FINAL PASS, item 1 (the "Vanessa Borg"
// regression) ────────────────────────────────────────────────────────────
// classifyReply() above is deliberately tuned for a REPLY to a yes/no
// question we just sent — its NEGATIVE regex includes bare "no", and its
// final `neg && !pos` branch treats ANY negative-sounding word as a NO
// because, in that context, the owner is answering something. A spontaneous
// message that is not a reply to anything has no such context: "no worries,
// I'll send photos tomorrow" or "nothing to add for now" would trip that
// same NEGATIVE regex on "no"/"nothing" and must never be read as "the flat
// is rented". So this reuses the same rented-verb/negation regexes
// classifyReply() already has (never a second keyword list to keep in sync)
// but only ever fires on the unambiguous branches — an explicit rented verb
// (rented/let out/leased/taken/sold/gone/under offer/withdrawn), "is
// already rent", or an explicit "no longer available"/"off the market" —
// never on a bare negative word alone.
//
// This is what closes the actual gap: availability.js:handleOwnerReply only
// ever runs when there is an 'awaiting' availability_checks row to match
// against, and ownerAssistant.js's detectAndSyncOwnerUpdate (the one hook
// that DOES run on every owner DM) extracts price/date/pets but has no
// rented/status signal at all. An owner who volunteers "it's not available
// anymore" outside of being asked was therefore never caught anywhere —
// properties.available_status never flipped, so every downstream
// automation (auto-reachout, the OWNERGROUPS check-in cadence, the board)
// kept treating the listing as live and could ask again later. That is
// exactly the regression: "owner said the property is unavailable, yet the
// bot asked again later."
function isUnambiguousRentedStatement(text) {
  const raw = String(text || '').trim()
  if (!raw) return false
  // Same length/shape sanity check runAvCommand's caller uses elsewhere in
  // this file (looksLikeARealAnswer) — generous enough for a full sentence
  // ("Hi, just to let you know the apartment got rented yesterday, thanks
  // for your help") but not a long, rambling message where "rented" could
  // easily be about something else entirely (someone else's flat, a story,
  // a past tenancy). Never guess on a message this shape wasn't tuned for.
  const words = raw.split(/\s+/).filter(Boolean)
  if (raw.length > 220 || words.length > 40) return false

  const notRented = NEGATED_RENTED.test(raw)
  if (notRented) return false // "not rented yet" / "nobody's rented it" — the opposite signal
  const t = raw

  // NEGATED_AVAILABILITY has to win FIRST, exactly like classifyReply()
  // itself does — "no longer available"/"not available anymore" both
  // contain the bare word "available", which POSITIVE also matches. Only
  // the RENTED_VERB/BARE_RENT branch below needs the contradiction guard
  // (a message that mentions BOTH a rented verb and a genuine positive is
  // the property-167 shape — ambiguous, stay silent).
  if (NEGATED_AVAILABILITY.test(t)) return true
  if (POSITIVE.test(t)) return false // contradicting positive — stay silent, let a human read it
  if (RENTED_VERB.test(t) || BARE_RENT.test(t)) return true
  return false
}

// ── CRITICAL OWNER FLOW FIX (Kev, 2026-09-16, real incident: Joseph/Viani) ──
// Property availability and viewing availability are two SEPARATE state
// machines. Real failure: property already known UPCOMING (available_from
// 1 Nov, viewings allowed by appointment). Bot asks "when are you generally
// available... in case clients want a viewing?" Owner replies "I'm available
// but will have to check with my tenant before confirming back." — a
// completely on-topic, unambiguous answer to the VIEWING question. It is 13
// words long, so classifyReply()'s length safety gate (added 2026-08-31 for
// the Elaine Pughe false-positive) shunted it into the generic 'unclear'
// path, which asks "is it rented, or on a break?" — a question about a
// different thing entirely, because nothing tracked that a VIEWING question
// (not a PROPERTY_AVAILABILITY one) was the thing actually pending.
//
// classifyReply() above is UNCHANGED and still owns property-availability
// replies. This is a second, independent classifier for a second, tracked
// question type (availability_checks.pending_question_type — migration
// 20260916d) — handleOwnerReply branches on that BEFORE either classifier
// ever runs, so a reply is only ever read through the lens of what was
// actually asked. Same "clear replies only, never guess" posture: anything
// that doesn't match a known viewing-reply shape comes back 'unclear' and
// gets a short generic ack, never invented.
const VIEWING_TENANT_CHECK = /\b(?:check|ask|confirm)\b[^.!?;,]{0,30}\b(?:tenant|renter|occupant|lodger|them)\b|\btenant\b[^.!?;,]{0,25}\b(?:first|before|confirm)/i
const VIEWING_APPOINTMENT_ONLY = /\bby\s+appointment\b|\bappointment\s+only\b|\bappointment\s+basis\b/i
const VIEWING_ADVANCE_NOTICE = /\blet\s+(?:me|us)\s+know\s+(?:before|in\s+advance|ahead)\b|\bwith\s+(?:some\s+)?notice\b|\badvance\s+notice\b|\banytime\b.{0,20}\blet.{0,10}know\b/i
const VIEWING_DECLINE = /\bno\s+viewings?\b|\bnot\s+possible\s+to\s+view|\bcan'?t\s+(?:do|allow)\s+(?:a\s+)?viewings?\b|\bdon'?t\s+want\s+viewings?\b/i
const VIEWING_POSITIVE = /\b(?:yes|yeah|sure|available|anytime|any\s+time|works?\s+for\s+me|fine|ok|okay)\b/i

function classifyViewingReply(text) {
  const raw = String(text || '').trim()
  if (!raw) return { status: 'unclear' }

  if (VIEWING_DECLINE.test(raw)) {
    return { status: 'declined', viewingsAllowed: false, confirmationStatus: 'declined' }
  }

  const needsTenant = VIEWING_TENANT_CHECK.test(raw)
  const appointmentOnly = VIEWING_APPOINTMENT_ONLY.test(raw)
  const advanceNotice = VIEWING_ADVANCE_NOTICE.test(raw)
  const positive = VIEWING_POSITIVE.test(raw)
  const viewingMode = appointmentOnly ? 'by_appointment' : (advanceNotice ? 'advance_notice' : null)

  // "I need to check with my tenant" — the Joseph case. Viewing is possible
  // in principle, but conditional on someone else's confirmation. This is
  // NEVER a property-availability signal, no matter how it reads.
  if (needsTenant) {
    return { status: 'conditional', viewingsAllowed: true, confirmationStatus: 'conditional', tenantConfirmationRequired: true, viewingMode }
  }
  if (appointmentOnly || advanceNotice || positive) {
    return { status: 'confirmed', viewingsAllowed: true, confirmationStatus: 'confirmed', tenantConfirmationRequired: false, viewingMode }
  }
  return { status: 'unclear' }
}

// Owner replied to a VIEWING-availability question. Writes ONLY properties.
// viewing_* columns — NEVER available_status/available_date — and the
// acknowledgement is short and final (spec: "Then stop. No further
// questionnaire."). check.status is closed here so the SAME follow-up
// question is never re-asked; an 'unclear' viewing reply is logged for
// review rather than escalated into a rented/break question.
async function onViewingReply(check, text, { ownerSession, ownerChat, replyMsgId }) {
  const c = classifyViewingReply(text)
  const ref = check.ref || check.property_id

  await db.query(
    `UPDATE availability_checks SET status = $2, reply_at = NOW(), reply_text = $3, reply_message_id = $4, updated_at = NOW() WHERE id = $1`,
    [check.id, `viewing_${c.status}`, String(text).slice(0, 2000), replyMsgId])

  if (c.status === 'unclear') {
    log.info('[av] viewing reply unclear — no property-availability question asked, no rented/break escalation', { checkId: check.id, ref, text: String(text).slice(0, 160) })
    await reactOnRequest(check, '🤔')
    return
  }

  if (check.property_id) {
    await db.query(
      `UPDATE properties SET
         viewings_allowed = $2, viewing_mode = COALESCE($3, viewing_mode),
         viewing_tenant_confirmation_required = $4, viewing_confirmation_status = $5,
         viewing_window_note = $6, updated_at = NOW()
       WHERE id = $1`,
      [check.property_id, c.viewingsAllowed, c.viewingMode, c.tenantConfirmationRequired || false, c.confirmationStatus, String(text).trim().slice(0, 300)])
  }

  const ack = c.status === 'conditional'
    ? 'Perfect, noted — I\'ll check with you before arranging anything 👍'
    : c.status === 'declined'
      ? 'Understood, thank you for letting us know.'
      : '👍 Perfect, thank you!'

  await humanDelay.queueOwnerMessage({
    session: ownerSession, chatId: ownerChat, text: ack,
    reactTo: replyMsgId, reactEmoji: '👍',
    label: 'viewing_reply_ack', jobId: `av-viewing-ack-${check.id}`,
  })

  log.info('[av] viewing reply processed', { checkId: check.id, ref, status: c.status, tenantConfirmationRequired: !!c.tenantConfirmationRequired })
}

// Owner replied to a MOVE_IN_DATE-only follow-up (the entrance-date
// question asked alone, spec's MSG_OWNER_ENTRANCE_DATE_ONLY). Only ever
// writes available_date — reuses the SAME date extraction classifyReply
// already trusts (extractTimeframeDetail), never the rented/available
// verdicts, because a reply to "when's the entrance date" was never a
// candidate for "is it rented?" either.
async function onMoveInDateReply(check, text, { ownerSession, ownerChat, replyMsgId }) {
  const ref = check.ref || check.property_id
  const tf = extractTimeframeDetail(String(text || ''))

  await db.query(
    `UPDATE availability_checks SET status = $2, reply_at = NOW(), reply_text = $3, reply_message_id = $4, updated_at = NOW() WHERE id = $1`,
    [check.id, tf?.date ? 'entrance_date_known' : 'entrance_date_unclear', String(text).slice(0, 2000), replyMsgId])

  if (!tf?.date) {
    log.info('[av] move-in-date reply unclear — left as-is, no rented/break escalation', { checkId: check.id, ref })
    await reactOnRequest(check, '🤔')
    return
  }

  if (check.property_id) {
    await db.query(`UPDATE properties SET available_date = $2, updated_at = NOW() WHERE id = $1`, [check.property_id, tf.date])
  }
  await humanDelay.queueOwnerMessage({
    session: ownerSession, chatId: ownerChat, text: '👍 Perfect, thank you!',
    reactTo: replyMsgId, reactEmoji: '👍',
    label: 'entrance_date_ack', jobId: `av-entrance-ack-${check.id}`,
  })
  log.info('[av] move-in-date reply processed', { checkId: check.id, ref, date: tf.date })
}

// Pure decision — given what's already known, which follow-up (if any) does
// a "still available" confirmation actually need? Extracted out of
// onStillAvailable so the branch itself is unit-testable without a DB.
// Kev, 2026-09-15 (decision-layer spec, items 5-7): "yes" alone never
// justifies asking everything at once — only what is genuinely still
// missing, and never both mechanically forced into one message unless both
// really are unknown.
function decideStillAvailableFollowUp({ needsEntranceDate, needsViewingWindow }) {
  if (needsEntranceDate && needsViewingWindow) return { text: MSG_OWNER_STILL_AVAILABLE, asked: 'both' }
  if (needsViewingWindow) return { text: MSG_OWNER_VIEWING_WINDOW_ONLY, asked: 'viewing' }
  if (needsEntranceDate) return { text: MSG_OWNER_ENTRANCE_DATE_ONLY, asked: 'entrance' }
  return { text: null, asked: 'none' }
}

// ── Status rendering ────────────────────────────────────────────────────────

function renderStatus(check, prop) {
  const ref = prop?.ref ? `#${prop.ref}` : `property ${check.property_id}`
  if (check.status === 'replied_available') return `✅ ${ref} — owner confirmed it is STILL AVAILABLE.`
  if (check.status === 'replied_no')        return `🔴 ${ref} — owner said it is RENTED / gone.`
  if (check.status === 'replied_soon') {
    const tf = check.reply_text ? extractTimeframe(check.reply_text) : null
    return `🟡 ${ref} — available later${tf ? ` (from ${tf})` : ''}. Owner: "${(check.reply_text || '').slice(0, 120)}"`
  }
  const bits = [`⏳ ${ref} — asked owner, no reply yet.`]
  if (check.call_pinged_at)   bits.push('call ping attempted')
  if (check.call_ping_status === 'unsupported') bits.push('call ping not supported by engine')
  if (check.morning_sent_at)  bits.push('morning follow-up sent')
  return bits.join(' • ')
}

const STATUS_DEFAULT_LINE = "Default: Available — owner didn't give us an update since post."
const REPING_QUESTION     = 'Should I reping the owner? Yes or No'

// ── !av ─────────────────────────────────────────────────────────────────────

async function runAvCommand({ text, chatId, session, senderPhone, messageId }) {
  // Kev, 2026-09-14 (spec item 6): an agent typing the raw command can mark a
  // request urgent the same way the board's escalate step does — order
  // doesn't matter ("!av 2906-042 urgent" or "!av urgent 2906-042") — the
  // keyword is stripped before the ref is parsed either way. Default stays
  // GENERAL; nothing claims client interest unless this is set.
  const urgent = /\burgent\b/i.test(text)
  // Kev, 2026-09-14 (far-future guardrail): the >100-day gate below no
  // longer blocks outright -- it requires this explicit "confirm" the same
  // way "urgent" is an explicit opt-in, stripped before the ref is parsed
  // either way, order-independent.
  const confirmedFarFuture = /\bconfirm\b/i.test(text)
  const arg = text.trim().replace(/\burgent\b/gi, '').replace(/\bconfirm\b/gi, '').trim().split(/\s+/)[1] || null
  const prop = await resolveProperty(arg)

  // Troll protection: no ref / bad ref → absolute silence.
  if (!prop) {
    log.info('[av] !av ignored — missing/invalid ref', { arg: arg || '(none)', chat: String(chatId).slice(0, 18) })
    return
  }

  // ARGUS OWNER + PROPERTY STATE FINAL PASS, item 2: same guard as
  // requestOwnerAvailability() below — runAvCommand is a SEPARATE
  // implementation of "ask the owner", not a caller of that function, so the
  // rented/archived refusal has to be applied here too or !av alone bypasses
  // it entirely.
  if (['rented', 'archived'].includes(prop.available_status)) {
    await sendTextAs(session, chatId,
      `ℹ️ #${prop.ref} is already marked ${prop.available_status} — not messaging the owner.`)
    log.info('[av] !av refused — property already rented/archived', { ref: prop.ref, status: prop.available_status })
    return
  }

  // Kev, 2026-09-14 (far-future availability guardrail — supersedes the flat
  // 3-month block): still checkable, but >100 days out needs an explicit
  // "confirm" first, not a silent send. WhatsApp has no button here, so the
  // warning IS the confirmation prompt: type "confirm" to actually ask.
  const daysOut = daysUntilAvailable(prop.available_date)
  if (isFarFuture(prop.available_date) && !confirmedFarFuture) {
    const dateLabel = prop.available_date instanceof Date ? prop.available_date.toISOString().slice(0, 10) : String(prop.available_date)
    await sendTextAs(session, chatId,
      `⚠️ FUTURE AVAILABILITY\n#${prop.ref}${prop.town ? ` · ${prop.town}` : ''}\n\n` +
      `This property is only expected to become available in ${daysOut} days (${dateLabel}).\n\n` +
      `Reply "!av ${prop.ref} confirm" if you want to ask the owner already.`)
    log.info('[av] far-future confirmation required — not sent', { ref: prop.ref, available_date: dateLabel, daysOut })
    return
  }

  // Spam protection: an !av for this property already went out today.
  const today = await db.query(
    `SELECT * FROM availability_checks
      WHERE property_id = $1 AND sent_at >= date_trunc('day', NOW())
      ORDER BY id DESC LIMIT 1`, [prop.id])
  if (today.rows.length) {
    const c = today.rows[0]
    log.info('[av] !av same-day repeat — showing status instead of re-messaging owner',
      { ref: prop.ref, checkId: c.id })
    await sendTextAs(session, chatId,
      `${renderStatus(c, prop)}\n\n(already checked today — owner not messaged again)`)
    return
  }

  if (!prop.owner_id) {
    await sendTextAs(session, chatId, `❌ #${prop.ref} has no owner linked — cannot check availability.`)
    return
  }
  const owner = await ownerPhone(prop.owner_id, prop.listed_by_phone)
  if (!owner?.phone_normalized) {
    await sendTextAs(session, chatId, `❌ #${prop.ref} — owner has no phone number on file.`)
    return
  }

  // `session` is the account that saw the !av — prefer it when it already knows
  // this owner, so the reply lands where the asking agent is looking.
  const picked = await pickOwnerAccount(prop.owner_id)
  if (!picked.session) {
    if (picked.waiting) {
      await sendTextAs(session, chatId,
        `The owner is reached through ${picked.dbSession}, which is offline right now — not sent from any other account. Use Still Available on the board to queue it for when ${picked.dbSession} is back.`)
    } else {
      await sendTextAs(session, chatId, 'No account is in contact with this owner yet')
    }
    log.info('[av] no sending account', { ref: prop.ref, reason: picked.reason, tried: picked.tried })
    return
  }

  const ownerChatId = toChatId(owner.phone_normalized)
  let sent
  try {
    sent = await sendTextAs(picked.session, ownerChatId, buildOwnerCheckMessage(prop, { urgent }), null, { failover: false })
  } catch (err) {
    log.error('[av] owner send failed', { ref: prop.ref, session: picked.session, err: err.message })
    await sendTextAs(session, chatId, `❌ #${prop.ref} — could not message the owner via ${picked.session}: ${err.message.slice(0, 120)}`)
    return
  }

  const ins = await db.query(
    `INSERT INTO availability_checks
       (property_id, owner_id, account_session, requester_chat_id, requester_phone,
        requester_session, requester_message_id, owner_chat_id, sent_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),'awaiting')
     RETURNING id, sent_at`,
    [prop.id, prop.owner_id, picked.session, chatId, senderPhone, session, messageId, ownerChatId])
  const checkId = ins.rows[0].id

  await scheduleFollowUps(checkId)

  // Fire-and-forget copy into the admin request dashboard — never blocks or
  // fails this command. runAvCommand has no agent login, so the dashboard
  // report resolves a name/DM target from senderPhone if it can.
  dashboardReport.reportRequest({
    requesterPhone: senderPhone, ref: prop.ref, action: 'availability',
    ownerId: prop.owner_id, accountSession: picked.session,
  }).catch(() => {})

  log.info('[av] check created', {
    checkId, ref: prop.ref, ownerId: prop.owner_id, via: picked.session,
    requesterChat: String(chatId).slice(0, 18), ownerMsgId: (sent?.id || sent?.key?.id || '').slice(-16),
  })

  await sendTextAs(session, chatId,
    `✅ #${prop.ref} — availability check sent to the owner via ${picked.session}.\n` +
    `Follow-ups armed: call ping in 30 min, message tomorrow 09:00 (only if no reply).\n` +
    `Check back with !avstatus ${prop.ref}`)
}

// Job ids are dash-separated, NOT colon-separated. BullMQ rejects some
// colon-bearing custom ids with "Custom Id cannot contain :" — and it does so
// inconsistently (probed live 2026-08-16: 'a:b' rejected, 'a:b:c' accepted,
// 'a:b:c:d' rejected), so a colon here is a live grenade rather than a style
// choice. It matters on this path in particular: a throw from addJob lands
// AFTER the availability_checks row is written, so the check would exist with
// no follow-ups armed and the caller would see an error for a message that did
// go out.
async function scheduleFollowUps(checkId) {
  await addJob(QUEUE_NAME, { kind: 'call_ping', checkId },
    { jobId: `av-call-${checkId}`, delay: FOLLOWUP_CALL_DELAY_MS })
  await addJob(QUEUE_NAME, { kind: 'morning', checkId },
    { jobId: `av-morning-${checkId}`, delay: msUntilNextMorning(9) })
}

// ── !avstatus ───────────────────────────────────────────────────────────────

async function runAvStatusCommand({ text, chatId, session, senderPhone }) {
  const arg = text.trim().split(/\s+/)[1] || null
  const prop = await resolveProperty(arg)
  if (!prop) {
    log.info('[av] !avstatus ignored — missing/invalid ref', { arg: arg || '(none)' })
    return
  }

  const r = await db.query(
    `SELECT * FROM availability_checks WHERE property_id = $1 ORDER BY id DESC LIMIT 1`, [prop.id])
  const check = r.rows[0] || null

  // Resolved → just show the outcome.
  if (check && ['replied_available', 'replied_no', 'replied_soon'].includes(check.status)) {
    await sendTextAs(session, chatId, renderStatus(check, prop))
    return
  }

  // Awaiting, or never checked at all ("unknown") → default line + reping offer.
  const lines = [`#${prop.ref} — ${STATUS_DEFAULT_LINE}`]
  if (check) lines.push('', renderStatus(check, prop))
  else       lines.push('', 'No availability check has been run for this listing yet.')
  await sendTextAs(session, chatId, lines.join('\n'))
  await sendTextAs(session, chatId, REPING_QUESTION)

  // Arm the Yes/No capture for this sender in this chat.
  await redis.set(
    repingKey(chatId, senderPhone),
    JSON.stringify({ propertyId: prop.id, ref: prop.ref, checkId: check?.id || null }),
    'EX', REPING_PROMPT_TTL_S)
}

const repingKey = (chatId, phone) => `av:reping:${chatId}:${phone || 'anon'}`

// Yes/No answer to "Should I reping the owner?" — returns true if consumed.
async function handleRepingAnswer({ text, chatId, session, senderPhone, messageId }) {
  const key = repingKey(chatId, senderPhone)
  const raw = await redis.get(key)
  if (!raw) return false

  const t = text.trim().toLowerCase()
  const yes = /^(yes|y|ja|yep|yeah|sure|ok|okay)\b/.test(t)
  const no  = /^(no|n|nope|nein)\b/.test(t)
  if (!yes && !no) return false        // unrelated message — leave the prompt armed

  await redis.del(key)
  const ctx = JSON.parse(raw)

  if (no) {
    await sendTextAs(session, chatId, 'Ok, no reping. 👍')
    return true
  }

  const prop = await resolveProperty(ctx.ref)
  if (!prop) return true

  // Reping respects spam protection: cap the total, and never twice in a day.
  const r = await db.query(
    `SELECT * FROM availability_checks WHERE property_id = $1 ORDER BY id DESC LIMIT 1`, [prop.id])
  const check = r.rows[0] || null

  if (check && ['replied_available', 'replied_no', 'replied_soon'].includes(check.status)) {
    await sendTextAs(session, chatId, `Owner already replied — ${renderStatus(check, prop)}`)
    return true
  }
  if (check && (check.reping_count || 0) >= MAX_REPINGS) {
    await sendTextAs(session, chatId,
      `Already reping'd ${check.reping_count}× on this check — not sending more (anti-spam).`)
    return true
  }
  if (check) {
    const lastTouch = check.morning_sent_at || check.sent_at
    if (lastTouch && (Date.now() - new Date(lastTouch).getTime()) < 12 * 3600 * 1000) {
      await sendTextAs(session, chatId,
        'Owner was already contacted about this within the last 12h — not repinging (anti-spam).')
      return true
    }
  }

  // No open check at all → this is a fresh !av (spam protection applies inside).
  if (!check) {
    await runAvCommand({ text: `!av ${prop.ref}`, chatId, session, senderPhone, messageId })
    return true
  }

  const picked = await pickOwnerAccount(check.owner_id)
  if (!picked.session) {
    await sendTextAs(session, chatId, picked.waiting
      ? `The owner is reached through ${picked.dbSession}, which is offline right now — not reping'd from any other account.`
      : 'No account is in contact with this owner yet')
    return true
  }
  try {
    await sendTextAs(picked.session, check.owner_chat_id || toChatId(''), MSG_OWNER_CHECK, null, { failover: false })
  } catch (err) {
    await sendTextAs(session, chatId, `❌ Reping failed: ${err.message.slice(0, 120)}`)
    return true
  }
  await db.query(
    `UPDATE availability_checks
        SET reping_count = COALESCE(reping_count,0) + 1, sent_at = NOW(), updated_at = NOW()
      WHERE id = $1`, [check.id])
  await sendTextAs(session, chatId, `🔄 Owner reping'd via ${picked.session}.`)
  log.info('[av] reping sent', { checkId: check.id, via: picked.session })
  return true
}

// ── Owner reply handling ────────────────────────────────────────────────────

// Called for every inbound owner DM. NEVER consumes the message — the existing
// owner-DM path (outreach, labels, avCapture) must keep running.
// Kev, 2026-09-07 (live-observed): a busy WA session can easily have 8-9
// simultaneous 'awaiting' checks. When an owner's reply carries no phone
// alt (LID not yet resolved for this account/contact pair) the session
// fallback below used to just give up the moment there was more than one
// candidate — so on a busy account EVERY LID-only owner reply was silently
// dropped, not just the rare true-ambiguous one. This alerts Kev once per
// chat per day instead of leaving it as a WARN line nobody reads, so the
// "show it to a human" half of the spec is actually met.
const AMBIGUOUS_REPLY_ALERT_TTL_SEC = 24 * 3600
async function alertAdminAmbiguousReply({ session, chatId, candidates, text }) {
  const key = `av:ambiguous-alert:${session}:${chatId}`
  try {
    const set = await redis.set(key, '1', 'EX', AMBIGUOUS_REPLY_ALERT_TTL_SEC, 'NX')
    if (!set) return // already alerted for this chat within the window
  } catch (err) {
    log.debug('[av] ambiguous-reply alert dedupe skipped', { err: err.message })
  }
  try {
    const to = config.admin.botNumber
    if (!to) return
    const adminSession = await pickAdminSession()
    if (!adminSession) return
    const refs = candidates.map(c => c.ref || c.property_id).filter(Boolean).join(', ')
    await waha.sendText(adminSession, toChatId(to),
      `⚠️ Owner reply on ${session} could not be matched (no phone alt, ${candidates.length} open checks: ${refs}). ` +
      `Chat: ${String(chatId).slice(0, 24)}. Text: "${String(text || '').slice(0, 140)}"\n` +
      `Not auto-applied to any listing — needs manual look.`)
  } catch (err) {
    log.warn('[av] ambiguous-reply admin alert failed', { err: err.message })
  }
}

function inboundEventMs(payload) {
  const raw = Number(payload?.timestamp || payload?._data?.Info?.Timestamp || 0)
  if (!Number.isFinite(raw) || raw <= 0) return null
  return raw > 10_000_000_000 ? raw : raw * 1000
}

function isContactOrTransportOnly(payload, text) {
  const type = String(payload?.type || payload?._data?.Info?.Type || '').toLowerCase()
  if (type === 'contact' || type === 'contacts' || type === 'vcard') return true
  if (payload?.vCards?.length || payload?.vcard || payload?.contact) return true
  const t = String(text || '').trim()
  if (!t) return true
  // A pasted/shared phone number is contact data, not an answer to an
  // availability question. Never let it consume a clarify attempt or trigger
  // the rented/unavailable follow-up.
  return /^(?:tel(?:ephone)?\s*[:.-]?\s*)?\+?[\d\s().-]{7,}$/i.test(t)
}

function asksAboutClient(text) {
  return /\b(?:who|what)\s+(?:is|are)?\s*(?:the|your|my)?\s*clients?\b|\bwhat\s+clients?\s+(?:do\s+you\s+have|have\s+you\s+got)\b/i.test(String(text || ''))
}

async function answerClientQuestion(check, { ownerSession, ownerChat, replyMsgId }) {
  const linked = await db.query(
    `SELECT c.nationalities, c.profession, c.budget_min, c.budget_max,
            c.move_in_date, c.group_size
       FROM property_matches pm
       JOIN clients c ON c.id = pm.client_id
      WHERE pm.property_id = $1
        AND COALESCE(c.is_active, TRUE) = TRUE
        AND pm.status IN ('interested','approved','shortlisted')
      ORDER BY pm.updated_at DESC NULLS LAST, pm.created_at DESC
      LIMIT 1`, [check.property_id])
  const c = linked.rows[0]
  if (!c) {
    await postToRequester(check,
      `⚠️ Owner of #${check.ref || check.property_id} asked who the clients are. No genuinely linked interested/approved client request exists, so ARGUS did not invent a profile. Please answer manually.`)
    return { answered: false, reason: 'no_linked_client' }
  }
  const nationality = Array.isArray(c.nationalities) ? c.nationalities.filter(Boolean).join('/') : String(c.nationalities || '').trim()
  const parts = []
  if (nationality) parts.push(nationality)
  if (c.profession) parts.push(String(c.profession).trim())
  if (c.group_size) parts.push(`${c.group_size} ${Number(c.group_size) === 1 ? 'person' : 'people'}`)
  if (c.budget_min || c.budget_max) {
    const budget = c.budget_min && c.budget_max ? `€${c.budget_min}–€${c.budget_max}` : `up to €${c.budget_max || c.budget_min}`
    parts.push(`${budget}/month`)
  }
  if (c.move_in_date) parts.push(`move-in ${String(c.move_in_date).slice(0, 10)}`)
  if (!parts.length) {
    await postToRequester(check,
      `⚠️ Owner of #${check.ref || check.property_id} asked for client details. A linked client exists but its shareable profile is empty; please answer manually.`)
    return { answered: false, reason: 'linked_profile_empty' }
  }
  await humanDelay.queueOwnerMessage({
    session: ownerSession, chatId: ownerChat,
    text: `The linked request is for ${parts.join(', ')}. I don't have any other confirmed client details on file.`,
    reactTo: replyMsgId, reactEmoji: null,
    label: 'av_client_context', jobId: `av-client-context-${check.id}`,
  })
  return { answered: true }
}

async function verifiedInboundOwnerPhone({ session, senderPhone, chatId }) {
  const chat = String(chatId || '')
  let phone = normalizePhone(senderPhone) || null
  // A raw LID is an opaque transport id, never a phone number. Ask WAHA for
  // its PN mapping; if WAHA cannot prove it, callers may only use an exact
  // stored-chat match and must never fall back to "the one open check".
  if (/@lid$/i.test(chat) && (!phone || phone === chat.replace(/@.*/, ''))) {
    phone = await ownerSendGate.resolveChatPhone(session, chat)
  }
  if (!phone) return null
  phone = String(phone).replace(/\D/g, '')
  if (phone.length < 8 || phone.length > 13) return null
  return (await botTag.isOwnerOnly(phone)) ? phone : null
}

async function handleOwnerReply({ payload, session, text, senderPhone, chatId }) {
  if (payload?.fromMe || isContactOrTransportOnly(payload, text)) {
    log.info('[av] inbound ignored before classification — self/contact/transport payload', {
      session, chat: String(chatId || '').slice(0, 24), type: payload?.type || null,
    })
    return { matched: false, ignored: 'not_owner_text' }
  }

  const verifiedPhone = await verifiedInboundOwnerPhone({ session, senderPhone, chatId })
  const chatStr = String(chatId || '')
  const eventMs = inboundEventMs(payload)
  const norm = verifiedPhone ? (normalizePhone(verifiedPhone) || verifiedPhone) : ''
  let r = { rows: [] }
  if (verifiedPhone) {
    r = await db.query(
      `SELECT ac.*, p.ref, p.available_status
         FROM availability_checks ac
         JOIN owner_contacts oc ON oc.id = ac.owner_id
         LEFT JOIN properties p ON p.id = ac.property_id
        WHERE ac.status = 'awaiting'
          AND (oc.phone_normalized = $1 OR oc.phone_normalized = $2)
          AND LOWER(ac.account_session) = LOWER($3)
          AND ac.sent_at >= NOW() - INTERVAL '5 days'
          AND (
            ac.owner_chat_id = $4
            OR right(regexp_replace(COALESCE(ac.owner_chat_id,''), '\\D', '', 'g'), 9)
               = right(regexp_replace($1, '\\D', '', 'g'), 9)
          )
        ORDER BY ac.id DESC
        LIMIT 1`, [norm, verifiedPhone, session, chatStr])
  }

  // Kev, 2026-09-05 (first-reach-out LID gap): a brand-new WAHA account that
  // has never talked to this owner before gets no SenderAlt/remoteJidAlt/
  // senderPn from WAHA (see senderIdentity.js) -- WhatsApp hasn't resolved
  // the LID<->phone mapping for THIS account/contact pair yet. `senderPhone`
  // then arrives as either null or the LID's raw digits, which can never
  // match owner_contacts.phone_normalized above. That silently ate the
  // owner's actual availability answer on the very check that matters most
  // (their first reply), with zero log trace. Same failure class as the
  // outbound #2906-129/Michael fix in pickOwnerAccount() -- that one covers
  // sending; this is the missing inbound half.
  //
  // Fallback: identify the check purely from which account received this DM.
  // Only safe when there is EXACTLY ONE 'awaiting' check on this exact
  // session within a recent window -- multiple candidates means genuine
  // ambiguity, and per this file's own "never guess" rule that gets logged
  // for manual review instead of picked at random.
  //
  // 2026-09-21: the fallback is ONLY for a sender we could not identify. It used
  // to run for ANY sender that matched no awaiting check — including a fully
  // resolved phone that simply is not this owner (Olga's number, Kevsecond's own
  // number, a stranger) and WhatsApp Status posts (chat status@broadcast). Every
  // one of those was matched to the lone open check on the session: #2906-004
  // (rented) got "replied_available" from Olga's number and the requesting agent
  // was told it was open. A resolved phone that is not the owner's is a
  // DIFFERENT person; broadcast/group/newsletter chats are never an owner DM.
  const _chatStr = chatStr
  const _nonDmChat = /@(?:g\.us|broadcast|newsletter)$/i.test(_chatStr)
  const _senderDigits = String(verifiedPhone || '').replace(/\D/g, '')
  const _lidDigits = _chatStr.replace(/@.*/, '').replace(/\D/g, '')
  const _senderResolved = !!verifiedPhone
  if (!r.rows.length && (_nonDmChat || _senderResolved)) {
    log.info('[av] reply not matched — sender is not an owner with an open check, session fallback refused', {
      session, chat: _chatStr.slice(0, 24), nonDm: _nonDmChat, senderPhone: _senderDigits.slice(-4) || '(none)',
    })
  } else if (!r.rows.length && String(text || '').trim() && /@lid$/i.test(_chatStr)) {
    // LID-only safety fallback: an opaque sender may match only the exact
    // chat and exact sending session stored on the pending check. The old
    // session-wide fallback attached any stranger/internal chat to the lone
    // open check on that account.
    const bySession = await db.query(
      `SELECT ac.*, p.ref, p.available_status, p.town
         FROM availability_checks ac
         LEFT JOIN properties p ON p.id = ac.property_id
        WHERE ac.status = 'awaiting'
          AND LOWER(ac.account_session) = LOWER($1)
          AND ac.owner_chat_id = $2
          AND ac.sent_at >= NOW() - INTERVAL '5 days'
        ORDER BY ac.id DESC`, [session, _chatStr])
    if (bySession.rows.length === 1) {
      log.info('[av] owner reply matched by session fallback — sender had no phone alt (first-contact LID)', {
        checkId: bySession.rows[0].id, ref: bySession.rows[0].ref, session,
        chat: String(chatId || '').slice(0, 20), senderPhone: senderPhone || '(none)',
      })
      r = bySession
    } else if (bySession.rows.length > 1) {
      // Kev, 2026-09-07: before giving up, does the reply itself name one of
      // THESE candidates by ref or town? An explicit "2906-042" or "Sliema"
      // in the text is a real signal, not a guess — same trust level the
      // owner-scoped disambiguation further down this function already
      // gives that exact match. Only a UNIQUE hit counts.
      let named = null
      const refHits = String(text || '').match(/#?2906-\d{2,4}|\b\d{2,4}\b/gi) || []
      for (const c of refHits) {
        const resolved = await resolveProperty(c)
        if (resolved) {
          const hit = bySession.rows.find(row => row.property_id === resolved.id)
          if (hit) { named = hit; break }
        }
      }
      if (!named) {
        const towns = [...new Set(bySession.rows.map(row => row.town).filter(Boolean))]
        for (const town of towns) {
          const re = new RegExp(`\\b${town.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
          if (re.test(String(text || ''))) {
            const matches = bySession.rows.filter(row => row.town === town)
            if (matches.length === 1) { named = matches[0]; break }
          }
        }
      }
      if (named) {
        log.info('[av] owner reply matched by session fallback — ref/town named among multiple candidates', {
          checkId: named.id, ref: named.ref, session,
          chat: String(chatId || '').slice(0, 20), candidates: bySession.rows.map(row => row.id),
        })
        r = { rows: [named] }
      } else {
        log.warn('[av] owner reply unmatched (no phone alt) — multiple awaiting checks on this session, refusing to guess', {
          session, candidates: bySession.rows.map(row => row.id),
          chat: String(chatId || '').slice(0, 20),
        })
        await alertAdminAmbiguousReply({ session, chatId, candidates: bySession.rows, text }).catch(() => {})
      }
    }
  }
  if (!r.rows.length) return { matched: false }

  let check = r.rows[0]

  // A delayed/redelivered message from before the question is not its answer.
  // Allow two minutes of clock skew between WAHA and Postgres, but never an
  // older chat event or a reply to a different session/chat.
  if (eventMs && check.sent_at && eventMs + 120_000 < new Date(check.sent_at).getTime()) {
    log.info('[av] inbound ignored — event predates the pending question', {
      checkId: check.id, session, chat: _chatStr.slice(0, 24),
    })
    return { matched: false, ignored: 'event_before_question' }
  }

  if (asksAboutClient(text)) {
    const ownerSessionQ = await resolveLiveSession(check.account_session) || session
    await answerClientQuestion(check, {
      ownerSession: ownerSessionQ,
      ownerChat: check.owner_chat_id || chatId,
      replyMsgId: payload?.id || null,
    })
    return { matched: true, handled: 'client_question' }
  }

  // ── Don't read a BOOKING reply as an AVAILABILITY verdict ──────────────────
  // This function matches the newest awaiting check for a phone, whatever the
  // owner was actually answering. With the !book relay live that became a real
  // mis-read: on 2026-08-16 the owner answered a viewing request with "Yes
  // Thursday afternoon works for me", and because an unrelated availability
  // check for a DIFFERENT listing was still awaiting for the same owner, the
  // word "Yes" flipped that listing to available_confirmed and sent the asking
  // agent a confirmation nobody had given.
  //
  // If a brokered booking conversation is open with this owner, their words
  // belong to it. The check stays 'awaiting' — which is honest, because they
  // have not answered the availability question — and the >60h reachout still
  // counts it as unanswered.
  try {
    const rel = await db.query(
      `SELECT t.id, t.ref FROM book_relay_threads t
         JOIN owner_contacts oc ON oc.id = t.owner_id
        WHERE t.status = 'relaying'
          AND t.updated_at > NOW() - INTERVAL '48 hours'
          AND regexp_replace(COALESCE(oc.phone_normalized,''), '\D', '', 'g') = $1::text
        LIMIT 1`, [String(norm || '').replace(/\D/g, '')])
    if (rel.rows.length) {
      log.info('[av] owner reply left to the book relay — not read as an availability verdict', {
        checkId: check.id, avRef: check.ref, relayThread: rel.rows[0].id, relayRef: rel.rows[0].ref,
      })
      return
    }
  } catch (err) {
    // Missing table / bad query must not stop an owner reply being classified.
    log.debug('[av] book-relay cross-check skipped', { err: err.message })
  }

  // Same guard, one more table (Kev, 2026-08-27): a dated !book / board
  // booking survey (services/bookingSurvey.js) is exactly the same shape of
  // mis-read risk the block above exists for — "yes" meant for a pending
  // viewing ask must not flip an unrelated listing's availability instead.
  // property_viewings has no FK to owner_contacts, so this joins through
  // properties.owner_id the way services/bookingSurvey.js's own phone match
  // does, rather than assuming a column that is not there.
  try {
    const pv = await db.query(
      `SELECT v.id, p.ref FROM property_viewings v
         JOIN properties p ON p.id = v.property_id
         JOIN owner_contacts oc ON oc.id = p.owner_id
        WHERE v.status = 'pending'
          AND v.owner_survey_status IN ('sent', 'time_proposed')
          AND regexp_replace(COALESCE(oc.phone_normalized,''), '\D', '', 'g') = $1::text
        LIMIT 1`, [String(norm || '').replace(/\D/g, '')])
    if (pv.rows.length) {
      log.info('[av] owner reply left to a booking survey — not read as an availability verdict', {
        checkId: check.id, avRef: check.ref, viewingId: pv.rows[0].id, viewingRef: pv.rows[0].ref,
      })
      return
    }
  } catch (err) {
    log.debug('[av] booking-survey cross-check skipped', { err: err.message })
  }

  // ── CRITICAL OWNER FLOW FIX (Kev, 2026-09-16, real incident: Joseph/Viani) ──
  // "Interpret every Owner reply IN THE CONTEXT OF THE QUESTION THAT WAS
  // ASKED." This check row already says exactly what question it is
  // awaiting an answer to (pending_question_type, set when the row was
  // created — see onStillAvailable's follow-up INSERT). A VIEWING_
  // AVAILABILITY or MOVE_IN_DATE row is a single-property, single-purpose
  // follow-up with none of the multi-unit ambiguity the disambiguation
  // guard below exists for, and its reply must NEVER be run through
  // classifyReply()/the rented-or-not pipeline — that IS the bug: a
  // perfectly clear viewing answer ("I'm available but will have to check
  // with my tenant") got read as an unparseable AVAILABILITY reply and
  // triggered "is it rented, or on a break?". Handled and returned here,
  // before any generic classifier runs.
  if (check.pending_question_type === 'VIEWING_AVAILABILITY') {
    const ownerSessionV = await resolveLiveSession(check.account_session) || session
    await onViewingReply(check, text, { ownerSession: ownerSessionV, ownerChat: check.owner_chat_id || chatId, replyMsgId: payload?.id || null })
    return
  }
  if (check.pending_question_type === 'MOVE_IN_DATE') {
    const ownerSessionM = await resolveLiveSession(check.account_session) || session
    await onMoveInDateReply(check, text, { ownerSession: ownerSessionM, ownerChat: check.owner_chat_id || chatId, replyMsgId: payload?.id || null })
    return
  }
  // ARGUS item 1: "which property was your rented statement about" — this
  // row has no property_id of its own (see maybeHandleSpontaneousRentedStatement),
  // so it must be resolved here too, before classifyReply (which needs a
  // property to apply a verdict to) ever runs.
  if (check.pending_question_type === 'PROPERTY_IDENTITY') {
    const ownerSessionP = await resolveLiveSession(check.account_session) || session
    await onPropertyIdentityReply(check, text, { ownerSession: ownerSessionP, ownerChat: check.owner_chat_id || chatId, replyMsgId: payload?.id || null })
    return
  }

  // Kev, 2026-08-31 (real incident: Elaine Pughe). classifyReply() is a
  // bag-of-words matcher with no real context: a bare "yes" ANYWHERE in a
  // longer message ("Hello Kev. Yes this app is very irritating, please
  // don't use it to communicate with me") still reads as a clear
  // "available" signal, even though the message has nothing to do with
  // availability. A genuine availability answer is short and on-topic
  // ("yes", "sorry it's rented", "still available") — a longer, multi-
  // sentence message never takes that shape, so length is an independent
  // second signal the keyword match alone cannot provide. Computed ONCE,
  // up front, so it governs BOTH the multi-unit disambiguation below AND
  // the final verdict handling — gating only the disambiguation question
  // and letting the same false-positive verdict flow through unchanged
  // into a real property-status update was the mistake an earlier pass at
  // this exact fix made.
  const trimmedReply = String(text || '').trim()
  const looksLikeARealAnswer = trimmedReply.length <= 70 && trimmedReply.split(/\s+/).length <= 12
  let verdict = looksLikeARealAnswer
    ? classifyReply(text, { messageDate: eventMs ? new Date(eventMs) : new Date() })
    : { status: 'unclear' }

  // ── Multi-unit ambiguity guard (Kev 2026-08-29) ─────────────────────────
  // The SELECT above matches the NEWEST 'awaiting' check for this owner's
  // PHONE only — nothing scopes it to a property. An owner with two or more
  // units can easily have two checks open at once (different agents, different
  // days), and a bare "it's rented" would silently apply to whichever check
  // happens to have the higher id — not necessarily the unit the owner meant.
  // Same "CLEAR replies only, never guess" principle classifyReply already
  // applies to WHAT the owner said now applies to WHICH property it is about.
  //
  // Not a risk during an active !book relay: the guard above already returns
  // before this point whenever book_relay_threads has a 'relaying' row for
  // this owner, so the clarify message sent here can never land inside that
  // relay's humanTookOver() polling window — which is why, unlike
  // MSG_OWNER_CLARIFY, it does not need to be a fixed sentence registered in
  // OWNER_TEXTS (its text is dynamic, one line per open unit).
  const openForOwner = await db.query(
    `SELECT ac.*, p.ref, p.available_status, p.town, p.longlet_price
       FROM availability_checks ac
       JOIN properties p ON p.id = ac.property_id
      WHERE ac.owner_id = $1 AND ac.status = 'awaiting'
      ORDER BY ac.id DESC`,
    [check.owner_id])
  const distinctProps = [...new Map(openForOwner.rows.map(row => [row.property_id, row])).values()]

  // Kev 2026-09-05 (Owner-System-Cleanup 1/4 point 3): distinctProps above
  // only covers checks that are CURRENTLY awaiting. An owner with several
  // properties can volunteer a DIFFERENT one that was never asked about —
  // "asked about Swieqi, owner replies 'Sliema? Yes, Sliema is available'" —
  // and Sliema has no open check, so it was invisible to the guard below and
  // the "yes" landed on Swieqi, the one actually asked. Pull every property
  // this owner is known to have (not just open checks) so a reply naming any
  // of them — by ref OR by town — can be told apart from the one asked about.
  const allOwnerProps = (await db.query(
    `SELECT id AS property_id, ref, town, available_status, longlet_price
       FROM properties WHERE owner_id = $1`, [check.owner_id])).rows

  // One shared resolver, reused for both the multi-open-check switch below
  // AND the cross-all-properties mismatch check further down — one place
  // that decides "did the owner name a specific known property", not two
  // parallel ref-matchers. Reuses resolveProperty's own ref grammar
  // ('2906-042', '#2906-042', '042', '42'); town matching is a plain
  // word-boundary, case-insensitive match against this owner's distinct
  // towns — it does not attempt full address/building-name parsing.
  async function findNamedProperty(replyText) {
    const candidates = String(replyText || '').match(/#?2906-\d{2,4}|\b\d{2,4}\b/gi) || []
    for (const c of candidates) {
      const resolved = await resolveProperty(c)
      if (resolved) {
        const hit = allOwnerProps.find(row => row.property_id === resolved.id)
        if (hit) return hit
      }
    }
    const towns = [...new Set(allOwnerProps.map(row => row.town).filter(Boolean))]
    for (const town of towns) {
      const re = new RegExp(`\\b${town.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
      if (re.test(String(replyText || ''))) return allOwnerProps.find(row => row.town === town) || null
    }
    return null
  }
  const namedAny = await findNamedProperty(text)

  // Kev's 2026-09-15 hotfix (spec item 8, the "Clifford" incident): does
  // this reply mention a REAL Malta locality that is not any of THIS
  // owner's own known towns? Reuses services/geoTowns.js's town table (the
  // same one matchEngine.js's locality-scoring hotfix ported from the CRM
  // map) instead of hand-rolling a second town list. A real, unrecognised
  // locality name is a strong, self-contained signal that the owner has
  // switched subject to a property we don't have on file yet -- checked as
  // 1- and 2-word windows so "St Julian's"-style names still resolve.
  function detectSubjectSwitch(replyText) {
    const knownTowns = new Set(allOwnerProps.map(row => geoTowns.townKey(row.town)).filter(Boolean))
    const tokens = String(replyText || '').split(/\s+/).filter(Boolean)
    for (let i = 0; i < tokens.length; i++) {
      const spans = [tokens[i], `${tokens[i]} ${tokens[i + 1] || ''}`.trim()]
      for (const span of spans) {
        const key = geoTowns.townKey(span)
        if (key && !knownTowns.has(key)) return { town: geoTowns.TOWNS[key].label }
      }
    }
    return null
  }

  // ── Owner asking US which listing we mean (spec item 7, 2026-09-14) ───────
  // "Which one of them?" is a clarification REQUEST, not an availability
  // answer — classifyReply has no signal for it (no yes/no/rented word) and
  // used to fall through to onUnclearReply's "is it rented, or just on a
  // break?" question, a non-sequitur to someone who just asked US a
  // question. Detected on the raw text, ahead of every verdict branch, so it
  // can never be misread as a negative/rented signal and never burns a
  // clarify_attempts strike (spec: "do not interpret a clarification
  // question as a negative availability answer").
  const WHICH_ONE_RE = /\b(which one|which property|which unit|which flat|which listing|welche[sn]?)\b/i
  if (WHICH_ONE_RE.test(trimmedReply) && trimmedReply.length <= 80) {
    const pool = distinctProps.length ? distinctProps
      : allOwnerProps.filter(p => !['rented', 'archived'].includes(p.available_status))
    const tagOf = p => ['#' + p.ref, p.town || null, priceLabel(p)].filter(Boolean).join(' · ')
    const only = pool[0] || check
    const answer = pool.length <= 1
      ? `${only.town ? `The ${only.town} one` : `#${only.ref}`} — ${tagOf(only)}.`
      : `I mean one of these:\n${pool.map((p, i) => `${i + 1}. ${tagOf(p)}`).join('\n')}\n\n` +
        `If you have anything else available as well, feel free to send it over.`
    await humanDelay.queueOwnerMessage({
      session, chatId, text: answer,
      reactTo: payload?.id || null, reactEmoji: payload?.id ? '👍' : null,
      label: 'which_one_answer', jobId: `av-human-whichone-${check.owner_id}-${Date.now()}`,
    }).catch(err => log.warn('[av] which-one answer queue failed', { err: err.message }))
    log.info('[av] owner asked which listing — answered instead of running the classifier', {
      ownerId: check.owner_id, checkId: check.id, poolSize: pool.length,
    })
    return
  }

  if (distinctProps.length > 1) {
    // Does the reply already name one of the currently-open ones unambiguously?
    const named = namedAny ? distinctProps.find(row => row.property_id === namedAny.property_id) || null : null

    if (!named) {
      // Root cause of the Elaine Pughe incident: this guard used to ask
      // "which unit?" for ANY reply that didn't literally name a ref,
      // without ever checking whether the reply was even ABOUT
      // availability at all. Now it only disambiguates when the shared
      // `verdict` above (already gated on looking like a real, on-topic
      // answer) found a genuine, clear signal (yes/no/rented/soon) but
      // couldn't tell which property it was about; anything else falls
      // through to the exact same "no owner-facing message, flag for a
      // human" treatment a single-open-check owner already gets further
      // down, instead of firing a confusing question — or worse, silently
      // applying a false-positive verdict to the wrong property — at
      // someone who was never asked anything to begin with.
      if (verdict.status === 'unclear') {
        log.info('[av] owner reply among multiple open units is not a clear, on-topic availability answer — not asking to disambiguate', {
          ownerId: check.owner_id, checks: distinctProps.map(row => row.id),
          phone: String(senderPhone).slice(-4),
        })
      } else {
        // Kev's 2026-09-15 hotfix, item 8: a real, not-yet-known locality in
        // this reply means the owner has moved on to a DIFFERENT property --
        // forcing the old open-check candidates onto it (the exact "which
        // one, Sliema or Gzira" non-sequitur Kev hit live right after the
        // owner said "this property is in Rabat") is worse than saying
        // nothing. Cancel the disambiguation branch entirely: log the
        // reply text for a human to see, send nothing, let the NEXT message
        // establish what this new property actually is.
        const subjectSwitch = detectSubjectSwitch(text)
        if (subjectSwitch) {
          log.info('[av] owner reply introduces a new/unknown locality — not forcing disambiguation onto old open units', {
            ownerId: check.owner_id, checks: distinctProps.map(row => row.id),
            mentionedTown: subjectSwitch.town, phone: String(senderPhone).slice(-4),
          })
          await db.query(
            `UPDATE availability_checks SET reply_text = $2, updated_at = NOW() WHERE id = $1`,
            [check.id, String(text).slice(0, 2000)])
          return
        }

        // Kev's 2026-09-15 hotfix, item 10 ("never repeat an unanswered
        // clarification"): reuses the SAME clarify_attempts counter the
        // single-open-check unclear-reply path further below already uses
        // as its own one-question-then-escalate gate -- same column, same
        // one-shot contract, not a second counter. This exact check's
        // multi-unit clarify had none at all before (Kev live-observed the
        // identical question sent twice), so a second ambiguous reply in a
        // row now escalates instead of repeating the question.
        if ((check.clarify_attempts || 0) >= 1) {
          log.info('[av] multi-unit clarify already asked once and still unanswered — escalating to a human instead of repeating it', {
            ownerId: check.owner_id, checkId: check.id,
          })
          try {
            const boardAction = require('./boardAction')
            const plan = await boardAction.markPendingCheck({
              propertyId: check.property_id, agentId: null, changedBy: 'ai',
              oldStatus: check.available_status || null,
              reason: `Owner reply still ambiguous across ${distinctProps.length} open units after one clarifying question — needs a human: "${String(text).trim().slice(0, 160)}"`,
            })
            if (plan.ok) {
              const upd = await db.query(plan.update.sql, plan.update.params)
              if (upd.rows.length) await db.query(plan.activity.sql, plan.activity.params)
            }
          } catch (err) {
            log.warn('[av] multi-unit escalation pending_check flag failed', { checkId: check.id, err: err.message })
          }
          return
        }

        const options = distinctProps
          .map(row => `#${row.ref}${row.town ? ` in ${row.town}` : ''}`)
          .join(' or ')
        log.info('[av] owner reply ambiguous across multiple open units — asking instead of guessing', {
          ownerId: check.owner_id, checks: distinctProps.map(row => row.id),
          phone: String(senderPhone).slice(-4),
        })
        // Kev, 2026-09-01 (DELAY BUG, live-observed): this used to call
        // sendTextAs() directly, bypassing humanDelay entirely -- a real
        // owner with 2+ open units got this clarify question inside the
        // same second as their reply landed, no matter what the rest of
        // this file's send paths do. Every other owner-reactive reply in
        // this file already goes through humanDelay.queueOwnerMessage;
        // this was the one that didn't.
        await db.query(
          `UPDATE availability_checks SET clarify_attempts = clarify_attempts + 1, updated_at = NOW() WHERE id = $1`,
          [check.id])
        await humanDelay.queueOwnerMessage({
          session, chatId,
          text: `Thanks for letting me know — which one do you mean, ${options}?`,
          reactTo: payload?.id || null, reactEmoji: payload?.id ? '👍' : null,
          label: 'multi_unit_clarify', jobId: `av-human-multiunit-${check.owner_id}-${Date.now()}`,
        }).catch(err => log.warn('[av] multi-unit clarify queue failed', { err: err.message }))
        return
      }
    }

    // Owner named a specific unit — route the reply to THAT check, not
    // whichever one merely had the highest id. `named` can now also be null
    // here (the "not a clear/on-topic answer, fell through instead of
    // returning" path above) — guarded, since that path deliberately leaves
    // `check` as originally matched for the same unclear-handling further
    // down that a single-open-check owner already gets.
    if (named && named.id !== check.id) {
      log.info('[av] owner named a specific unit among several open — switching check', {
        from: check.id, to: named.id, ref: named.ref,
      })
      check = named
    }
  }

  // ── Cross-property mismatch (Kev 2026-09-05, point 3) ───────────────────
  // Runs AFTER the multi-open-check switch above, against the (possibly just
  // switched) `check` — so a reply that already resolved to one of two open
  // checks is not re-flagged here. This is the guard that actually closes the
  // Swieqi/Sliema gap: namedAny is resolved against ALL of the owner's known
  // properties, so it catches a reply naming one that has NO open check at
  // all, which distinctProps above can never see. Gated on the same
  // clear-and-on-topic verdict as everything else in this function — an
  // unclear reply is handled by the existing 'unclear' branch below.
  if (verdict.status !== 'unclear' && namedAny && namedAny.property_id !== check.property_id) {
    // `check` came off the original SELECT at the top of this function,
    // which never selects p.town (only openForOwner/allOwnerProps do) — look
    // it up from allOwnerProps rather than widening that query for one field.
    const checkTown = (allOwnerProps.find(row => row.property_id === check.property_id) || {}).town
    log.info('[av] owner reply names a DIFFERENT known property than the one asked about — not applying verdict to the asked-about listing', {
      askedId: check.property_id, askedRef: check.ref, askedTown: checkTown,
      namedId: namedAny.property_id, namedRef: namedAny.ref, namedTown: namedAny.town,
      ownerId: check.owner_id,
    })
    // Leave the asked-about check's own status untouched — never silently
    // mark it available/rented off a reply that was actually about a
    // different property. Record the raw text for context and route the
    // asked-about listing to the same human review queue the 'unclear' path
    // uses further down; a verdict the classifier CAN read but cannot safely
    // apply here is not a safer guess than one it cannot read at all.
    await db.query(
      `UPDATE availability_checks SET reply_text = $2, updated_at = NOW() WHERE id = $1`,
      [check.id, String(text).slice(0, 2000)])
    if (check.property_id) {
      try {
        const boardAction = require('./boardAction')
        const plan = await boardAction.markPendingCheck({
          propertyId: check.property_id,
          agentId: null,
          changedBy: 'ai',
          oldStatus: check.available_status || null,
          reason: `Owner replied about a different property (#${namedAny.ref}${namedAny.town ? ` in ${namedAny.town}` : ''}) — not applied to #${check.ref}: "${String(text).trim().slice(0, 160)}"`,
        })
        if (plan.ok) {
          const upd = await db.query(plan.update.sql, plan.update.params)
          if (upd.rows.length) await db.query(plan.activity.sql, plan.activity.params)
        }
      } catch (err) {
        log.warn('[av] cross-property pending_check flag failed', { checkId: check.id, err: err.message })
      }
    }
    const askedLabel = checkTown ? `the ${checkTown} property` : `#${check.ref}`
    const namedLabel = namedAny.town || `#${namedAny.ref}`
    await humanDelay.queueOwnerMessage({
      session, chatId,
      text: `Got it, you mean the ${namedLabel} property. Is ${askedLabel} no longer available, and what do you currently have in ${namedLabel}?`,
      reactTo: payload?.id || null, reactEmoji: payload?.id ? '👍' : null,
      label: 'cross_property_clarify', jobId: `av-human-crossprop-${check.owner_id}-${Date.now()}`,
    }).catch(err => log.warn('[av] cross-property clarify queue failed', { err: err.message }))
    return
  }

  // verdict was already computed above (before the multi-unit guard), so
  // both paths agree on the exact same reading of this reply.
  log.info('[av] owner reply matched', {
    checkId: check.id, ref: check.ref, phone: String(senderPhone).slice(-4),
    verdict: verdict.status, timeframe: verdict.timeframe,
  })

  // CANONICAL STATE FIRST (2026-09-21). A clear "no" / "rented" / "not before
  // <date>" from the owner makes everything still queued for them wrong: a
  // delayed "is it available?" nudge, the +30min ping, the morning follow-up, an
  // already-queued clarifying question. Drop them BEFORE this handler queues its
  // own (correct) response below, so nothing contradictory can fire after it.
  if (verdict.status === 'replied_no' || verdict.status === 'replied_soon') {
    await ownerSendGate.invalidateQueuedForOwner({
      phone: check.owner_chat_id, chatIds: [chatId, check.owner_chat_id],
    })
  }

  const replyMsgId = payload?.id || null

  // ── the classifier could not read this reply ────────────────────────────
  // Covers both flavours: 'unclear' (truly unparseable/contradictory) and
  // 'replied_unclear' (rented+positive contradiction, or a negative-sounding
  // reply with no rented verb — "no", "sorry", "nothing right now"). Both
  // used to get treated differently (the first went straight to pending_check
  // with zero clarifying attempt, the second asked forever and never
  // escalated) — merged here so both get exactly ONE clarifying question
  // first (Kev, 2026-09-10: "needs recheck nur wenn man zweimal nicht
  // erkannt hat was der owner meint"). clarify_attempts starts at 0 on every
  // fresh check; only a SECOND unclear reply in a row — the owner's answer to
  // that very clarifying question still not reading as yes/no/rented/soon —
  // takes the listing off the board and into the review queue. Leaving the
  // check 'awaiting' throughout is what lets the owner's next message match
  // straight back to this same check and count as attempt #2.
  if (verdict.status === 'unclear' || verdict.status === 'replied_unclear') {
    await db.query(
      `UPDATE availability_checks
          SET reply_text = $2, reply_message_id = $3, updated_at = NOW()
        WHERE id = $1`,
      [check.id, String(text).slice(0, 2000), replyMsgId])

    if ((check.clarify_attempts || 0) < 1) {
      await db.query(
        `UPDATE availability_checks SET clarify_attempts = clarify_attempts + 1, updated_at = NOW() WHERE id = $1`,
        [check.id])
      const ownerSessionU = await resolveLiveSession(check.account_session) || session
      await onUnclearReply(check, { ownerSession: ownerSessionU, ownerChat: chatId })
      return
    }

    // Second strike — put the LISTING in front of a human. The owner replied
    // twice and the classifier still cannot tell whether it was a yes or a
    // no. Leaving the card sitting on the active board as if nothing happened
    // is a quiet guess in favour of "available", which is the guess that puts
    // an agent in front of a flat that is gone. 'pending_check' takes it off
    // the active board and into GET /review-queue, where the reply text is
    // waiting.
    //
    // Never destructive and never applied to a decided listing: boardAction's
    // guard refuses on 'rented' and 'archived', so a machine verdict that has
    // already landed is not talked over by a shrug.
    if (check.property_id) {
      try {
        const boardAction = require('./boardAction')
        const plan = await boardAction.markPendingCheck({
          propertyId: check.property_id,
          agentId: null,                  // no human took this decision
          changedBy: 'ai',
          oldStatus: check.available_status || null,
          reason: `Owner replied twice but the classifier could not read it: "${String(text).trim().slice(0, 160)}"`,
        })
        if (plan.ok) {
          const upd = await db.query(plan.update.sql, plan.update.params)
          if (upd.rows.length) await db.query(plan.activity.sql, plan.activity.params)
          log.info('[av] unclear reply (2nd strike) → pending_check', {
            checkId: check.id, ref: check.ref, moved: upd.rows.length > 0,
          })
        }
      } catch (err) {
        // An unreadable reply must not take the inbound message path down with
        // it — the board is recoverable by hand, a thrown handler is not.
        log.warn('[av] pending_check flag failed', { checkId: check.id, err: err.message })
      }
    }
    return
  }

  await db.query(
    `UPDATE availability_checks
        SET status = $2, reply_at = NOW(), reply_text = $3, reply_message_id = $4, updated_at = NOW()
      WHERE id = $1`,
    [check.id, verdict.status, String(text).slice(0, 2000), replyMsgId])
  // Keep the in-memory evidence identical to the row just persisted. The
  // mutation/audit layer below must record the current owner text, never the
  // stale pre-reply snapshot loaded at the start of the handler.
  check = { ...check, status: verdict.status, reply_text: String(text).slice(0, 2000), reply_message_id: replyMsgId }

  // Tell every agent who asked, BEFORE the owner-facing chain runs. That chain
  // reacts in groups, replies under listings and cancels Facebook jobs — a
  // dozen network calls the requesting agent should not be queued behind, and
  // one failure in it must not cost them the answer entirely.
  //
  // Wrapped: a notify problem must never turn a successful owner reply into a
  // thrown handler. The emoji chain and the CRM removal below are untouched.
  try {
    await notifyOpenRequesters({
      propertyId: check.property_id,
      ref: check.ref || check.property_id,
      verdict: verdict.status,
      matchedCheckId: check.id,
    })
  } catch (err) {
    log.warn('[av] requester notify pass failed', { checkId: check.id, err: err.message })
  }

  const ownerSession = await resolveLiveSession(check.account_session) || session
  const ownerChat    = check.owner_chat_id || chatId

  if (verdict.status === 'replied_no')        await onRented(check, { ownerSession, ownerChat, replyMsgId })
  if (verdict.status === 'replied_available') await onStillAvailable(check, {
    ownerSession, ownerChat, replyMsgId,
    timeframe: verdict.timeframe, date: verdict.date, precision: verdict.precision,
    replyText: text,
  })
  if (verdict.status === 'replied_soon')      await onComingSoon(check, { ownerSession, ownerChat, replyMsgId, timeframe: verdict.timeframe, date: verdict.date, replyText: text })
}

// React on the requester's original !av message, through the session that saw it.
async function reactOnRequest(check, emoji) {
  const s = await resolveLiveSession(check.requester_session) || check.requester_session
  if (!check.requester_message_id) {
    log.warn('[av] no requester_message_id stored — cannot react on the !av request', { checkId: check.id })
    return false
  }
  return reactAs(s, check.requester_message_id, emoji)
}

async function postToRequester(check, text) {
  // Kev 2026-08-21: `requester_chat_id` is now always either a private DM or
  // NULL (see requestOwnerAvailability) — never a group. Nothing to fall back
  // to here on purpose: notifyOpenRequesters() is what raises the review-queue
  // alert for a NULL row, this function just has nowhere safe left to post.
  if (!check.requester_chat_id) return
  // Kev 2026-08-21, item 5: always the 2906 default account, not whichever
  // account happened to see the !av — and always ^2906Bot-tagged so the agent
  // can tell a machine sent it. 2026-08-25: default -> Kevsecond -> kevthirdd
  // via pickAdminSession(), not whatever WAHA lists first (could be Cedric).
  const s = await pickAgentAlertSession()
  if (!s) {
    log.warn('[av] requester post skipped — no working account', { checkId: check.id })
    return
  }
  try {
    const linked = withPropertyLink(text, check.ref || check.property_id)
    const tagged = await botTag.forAgent(linked, { toPhone: check.requester_chat_id })
    await sendTextAs(s, check.requester_chat_id, tagged)
  }
  catch (err) { log.warn('[av] requester post failed', { checkId: check.id, err: err.message }) }
}

const AGENT_REVIEW_TTL_SEC = 7 * 24 * 3600
const agentReviewKey = chatId => `av:agent-review:${String(chatId || '').toLowerCase()}`

async function rememberAgentReview(check) {
  if (!check.requester_chat_id || !check.id) return
  await redis.set(agentReviewKey(check.requester_chat_id), JSON.stringify({
    checkId: check.id,
    propertyId: check.property_id,
    ref: check.ref || check.property_id,
  }), 'EX', AGENT_REVIEW_TTL_SEC)
}

async function handleAgentReviewAnswer({ payload, session, text, isGroup, chatId, senderPhone }) {
  if (isGroup || payload?.fromMe) return false
  const decision = classifyAgentAvailabilityDecision(text)
  if (!decision) return false

  let pending = null
  try {
    const raw = await redis.get(agentReviewKey(chatId))
    if (!raw) return false
    pending = JSON.parse(raw)
  } catch (err) {
    log.warn('[av] agent review context read failed', { err: err.message })
    return false
  }

  const check = (await db.query(
    `SELECT ac.*, p.ref, p.available_status, p.town
       FROM availability_checks ac
       JOIN properties p ON p.id = ac.property_id
      WHERE ac.id = $1 AND ac.property_id = $2
        AND ac.requester_chat_id = $3
      LIMIT 1`,
    [pending.checkId, pending.propertyId, toChatId(chatId)])).rows[0]
  if (!check) {
    await redis.del(agentReviewKey(chatId))
    return false
  }

  const ref = check.ref || pending.ref || check.property_id
  const sendDecisionReply = async body => {
    const outSession = await pickAgentAlertSession()
    if (!outSession) throw new Error('no working agent notification session')
    const tagged = await botTag.forAgent(body, { toPhone: chatId })
    await sendTextAs(outSession, chatId, tagged)
  }

  if (decision === 'rented') {
    const rentedDetector = require('./rentedDetector')
    const result = await rentedDetector.markRented(
      check.property_id, ref, senderPhone, session, check,
      { source: 'agent_review', trigger: 'Rented' })
    if (!result.skipped) {
      await replyUnderListing(check.property_id,
        withPropertyLink(`🔴 #${ref} — now rented. No longer available.`, ref))
    }
    await db.query(
      `UPDATE availability_checks
          SET status = 'replied_no', needs_review = FALSE, notified_at = NOW(), updated_at = NOW()
        WHERE id = $1`, [check.id])
    await sendDecisionReply(withPropertyLink(`✅ #${ref} set to RENTED and removed from active inventory.`, ref))
  } else if (decision === 'available') {
    const boardAction = require('./boardAction')
    const plan = await boardAction.checkIn({
      propertyId: check.property_id,
      agentId: check.requester_agent_id || null,
      changedBy: check.requester_agent_id ? 'agent' : 'system',
      method: 'agent_review',
      oldStatus: check.available_status || null,
    })
    if (!plan.ok) throw new Error(plan.reason || 'availability update refused')
    const upd = await db.query(plan.update.sql, plan.update.params)
    if (!upd.rows.length) throw new Error('listing is already rented or archived')
    await db.query(plan.activity.sql, plan.activity.params)
    await db.query(
      `UPDATE availability_checks
          SET status = 'replied_available', needs_review = FALSE, notified_at = NOW(), updated_at = NOW()
        WHERE id = $1`, [check.id])
    await replyUnderListing(check.property_id,
      withPropertyLink(`🟢 #${ref} — ${MSG_STILL_ON_MARKET}`, ref))
    await sendDecisionReply(withAvailableActions(
      `✅ #${ref} confirmed STILL AVAILABLE${check.town ? ` in ${check.town}` : ''}.`, ref))
  } else {
    const boardAction = require('./boardAction')
    const plan = await boardAction.markPendingCheck({
      propertyId: check.property_id,
      agentId: check.requester_agent_id || null,
      changedBy: check.requester_agent_id ? 'agent' : 'system',
      oldStatus: check.available_status || null,
      reason: 'Agent selected Not sure after an ambiguous owner reply',
    })
    if (plan.ok) {
      const upd = await db.query(plan.update.sql, plan.update.params)
      if (upd.rows.length) await db.query(plan.activity.sql, plan.activity.params)
    }
    await db.query(
      `UPDATE availability_checks
          SET status = 'needs_review', needs_review = TRUE, notified_at = NOW(), updated_at = NOW()
        WHERE id = $1`, [check.id])
    await sendDecisionReply(withPropertyLink(
      `🟡 #${ref} left as NOT SURE and moved to manual review. No availability claim was made.`, ref))
  }

  await redis.del(agentReviewKey(chatId))
  log.info('[av] ambiguous reply resolved by agent', { checkId: check.id, ref, decision })
  return true
}

// ── Agent notify on an owner's answer ───────────────────────────────────────
//
// An owner's reply resolves ONE check — handleOwnerReply matches the newest
// awaiting check for that phone. But two agents can each have asked about the
// same listing, and the owner answers once. The second agent's request stays
// 'awaiting' forever and they never hear the answer that already exists.
//
// So the notify is keyed on the PROPERTY, not on the matched check: every open
// requester for that listing is told and closed together.
//
// WHO IS NOT NOTIFIED
//   * auto_reachout rows. The 60h scan has no agent waiting on it — it updates
//     the board and the log silently, which is the whole point of the source
//     column.
//   * rows with no requester address at all. A board-only agent whose
//     agents.whatsapp_phones is empty (kevinsony1 today) has nowhere to be
//     reached; the request is still closed so it cannot linger as 'awaiting'.
//
// FIREWALL
//   The text is the ref and the verdict. Nothing else — no owner name, no
//   number, no address, no reply text. These messages go to every agent who
//   asked, including agents who must never see owner data.
// Kev 2026-08-21: "available" is now the exact one-liner he asked for
// ("Apartment <nr> is available in <Ort>"), town included when we have one.
const NOTIFY_TEXT = {
  replied_available: (ref, town) => withAvailableActions(
    `Apartment #${ref} is available${town ? ` in ${town}` : ''}.`, ref),
  replied_no:        ref => withPropertyLink(`Sorry — #${ref} was just rented.`, ref),
}

// ── self-explanatory enrichment (2026-08-19) ────────────────────────────────
// A plain "#204 was just rented" means nothing to an agent who filed ten
// requests this week — they have to go back to the board to remember which
// flat "204" was. This adds ONE best-effort photo message with the listing's
// own public facts, on top of the (unchanged, tested) text notify above.
async function sendImageAs(session, chatId, base64Data, mimeType, caption) {
  const body = {
    session, chatId: toChatId(chatId), caption: caption || '',
    file: { mimetype: mimeType || 'image/jpeg', filename: 'property.jpg', data: base64Data },
  }
  await require('./outreachIdentity').assertOutboundIdentity(session, body.chatId, caption)
  const res = await wahaFetch('POST', '/api/sendImage', body)
  try { waha.markSentByBackend(res?.id || res?.key?.id) } catch { /* non-fatal */ }
  return res
}

// town/beds/price — the same public facts the board card shows. NEVER
// street/apt/owner: this rides the notify, which every open requester gets,
// including agents who must never see owner data.
function propertyDescriptor(p) {
  const parts = []
  if (p.town) parts.push(p.town)
  if (p.bedrooms != null) parts.push(`${p.bedrooms} bed${p.bedrooms === 1 ? '' : 's'}`)
  if (p.longlet_price) parts.push(`€${Number(p.longlet_price).toLocaleString()}/month`)
  else if (p.sale_price) parts.push(`€${Number(p.sale_price).toLocaleString()}`)
  return parts.join(' · ')
}

// Returns null on ANYTHING short of a clean image (no property, no image in
// public_payload, download failure) — the caller treats null as "skip the
// second message", never as an error worth surfacing.
async function buildEnrichedCaption(propertyId, ref, verdictText) {
  try {
    const p = (await db.query(
      `SELECT town, bedrooms, longlet_price, sale_price,
              public_payload->'images'->>0 AS image_url
         FROM properties WHERE id = $1`, [propertyId])).rows[0]
    if (!p || !p.image_url) return null
    const ctl = AbortSignal.timeout ? AbortSignal.timeout(15_000) : undefined
    const res = await fetch(p.image_url, { signal: ctl })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length) return null
    const mime = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim()
    const descriptor = propertyDescriptor(p)
    const caption = [`📍 #${ref}${descriptor ? ` — ${descriptor}` : ''}`, '', verdictText].join('\n')
    return { data: buf.toString('base64'), mime, caption }
  } catch (err) {
    log.warn('[av] enriched caption build failed', { propertyId, ref, err: err.message })
    return null
  }
}

// `text` and `closeStatus` exist for services/boardFeedback.js: the same people
// are owed the same kind of message when an AGENT takes a listing off the board,
// and that path must share this function's notified_at bookkeeping or the two
// could each announce the same change to the same agent. It does NOT reuse
// verdict for the status write, because nobody replied — see CLOSED_STATUS
// there. Default behaviour (owner reply) is unchanged.
async function notifyOpenRequesters({
  propertyId, ref, verdict, matchedCheckId = null,
  text: textOverride = null, closeStatus = null,
}) {
  const build = NOTIFY_TEXT[verdict]
  if ((!build && !textOverride) || !propertyId) {
    return { notified: 0, closed: 0, skipped: 'no_text_for_verdict' }
  }
  const writeStatus = closeStatus || verdict
  if (!writeStatus) return { notified: 0, closed: 0, skipped: 'no_close_status' }

  // The matched check has just had its status set to the verdict, so it is no
  // longer 'awaiting' — include it explicitly by id.
  const r = await db.query(
    `SELECT id, requester_chat_id, requester_phone, requester_session, source, status,
            requester_agent_id
       FROM availability_checks
      WHERE property_id = $1
        AND notified_at IS NULL
        AND COALESCE(source, 'manual') <> 'auto_reachout'
        AND (status = 'awaiting' OR id = $2)
      ORDER BY id ASC`, [propertyId, matchedCheckId])
  if (!r.rows.length) return { notified: 0, closed: 0 }

  // One message per destination, however many requests that agent filed.
  // 'replied_available' needs the town for Kev's exact wording — a cheap
  // single-row lookup, only done for the verdicts that use it.
  let town = null
  if (!textOverride && verdict === 'replied_available') {
    try {
      const t = await db.query('SELECT town FROM properties WHERE id = $1', [propertyId])
      town = (t.rows[0] && t.rows[0].town) || null
    } catch (err) { log.warn('[av] town lookup failed', { propertyId, err: err.message }) }
  }
  const text = textOverride || build(ref, town)
  // WHICH ACCOUNT TELLS THEM
  //   Kev 2026-08-21, item 5: always the 2906 default account — never
  //   `row.requester_session` (which used to be preferred so the answer
  //   landed in whatever thread the agent already had open; that thread is
  //   sometimes a group, which is exactly what must stop happening here).
  //   Falls back to any working session only if default itself is down, same
  //   as before (2026-08-14: default sat at SCAN_QR_CODE and the old
  //   single-session lookup silently told nobody anything). 2026-08-25: that
  //   fallback is now default -> Kevsecond -> kevthirdd via pickAdminSession(),
  //   not whatever WAHA lists first.
  const session = await pickAgentAlertSession()
  const sentTo = new Set()
  let notified = 0, closed = 0

  // ── self-explanatory enrichment (2026-08-19) ────────────────────────────────
  // The plain verdict line above is the tested, unchanged contract. This is a
  // best-effort SECOND message: the listing's own photo + its public facts
  // (town/beds/price — same firewall as the board itself, nothing owner-side),
  // so an agent who asked about "#204" sees WHICH flat that was without going
  // back to the site. A property with no image, or a failed download, just
  // means this second message never goes out — the plain text above already
  // told them the outcome.
  const enrichedCaption = await buildEnrichedCaption(propertyId, ref, text)

  for (const row of r.rows) {
    let dest = row.requester_chat_id
      || (row.requester_phone ? toChatId(row.requester_phone) : null)
    // Website requests carry requester_agent_id (migration 022). Only looked
    // up when the row itself has no address — agents.notify_whatsapp
    // (migration 016) is where that agent actually wants to be reached, e.g.
    // a board-only agent whose whatsapp_phones is empty and would otherwise
    // close 'unreachable' below without ever being told.
    if (!dest && row.requester_agent_id) {
      try {
        const a = await db.query(
          `SELECT notify_whatsapp FROM agents WHERE id = $1`, [row.requester_agent_id])
        const nw = a.rows[0] && a.rows[0].notify_whatsapp
        if (nw) dest = toChatId(nw)
      } catch (err) {
        log.warn('[av] notify_whatsapp lookup failed', { checkId: row.id, ref, err: err.message })
      }
    }
    if (dest && session && !sentTo.has(dest)) {
      try {
        const tagged = await botTag.forAgent(text, { toPhone: dest })
        await sendTextAs(session, dest, tagged)
        sentTo.add(dest)
        notified++
        log.info('[av] agent notified', {
          checkId: row.id, ref, verdict, via: session, to: String(dest).slice(-8),
        })
        // Best-effort only: the agent already has the outcome from the line
        // above, so a failure here (no image, download hiccup, etc.) must
        // never affect `notified`/`closed` or retry logic.
        if (enrichedCaption) {
          try {
            const taggedCaption = await botTag.forAgent(enrichedCaption.caption, { toPhone: dest })
            await sendImageAs(session, dest, enrichedCaption.data, enrichedCaption.mime, taggedCaption)
          } catch (imgErr) {
            log.warn('[av] agent notify photo skipped', { checkId: row.id, ref, err: imgErr.message })
          }
        }
      } catch (err) {
        // Do NOT mark it notified — a send that failed should be retried by the
        // next reply rather than silently swallowed.
        log.warn('[av] agent notify failed', { checkId: row.id, ref, err: err.message })
        continue
      }
    } else if (dest && !session) {
      log.warn('[av] agent notify skipped — no working account at all', { checkId: row.id, ref })
      continue
    } else if (!dest) {
      log.info('[av] no requester address on file — closing without a notify', { checkId: row.id, ref })
      // Kev 2026-08-21, item 4: a group !av whose sender resolved to no real
      // phone has NOTHING to answer into — never the group. Tell Kev once per
      // check instead of letting the answer disappear silently. Skipped for
      // requester_agent_id rows: that is the pre-existing, accepted
      // board-only-agent-with-no-WhatsApp gap, not a new "unknown sender".
      if (!row.requester_agent_id) {
        try {
          const already = await db.query(
            'SELECT review_alerted_at FROM availability_checks WHERE id = $1', [row.id])
          if (!already.rows[0]?.review_alerted_at) {
            const to = config.admin.botNumber
            // Was `shared` — an undefined variable, so this threw a
            // ReferenceError on every single hit (caught by the surrounding
            // try/catch, logged as "review-queue alert failed", found live
            // during 2026-09-08's multi-unit-rented proof test). `session`
            // is this same loop's own picked/working admin session,
            // exactly like the `dest && !session` check just above uses.
            if (to && session) {
              await waha.sendText(session, toChatId(to),
                `⚠️ #${ref} — owner replied (${verdict}), but the requesting agent's private ` +
                `number is unknown (asked from a group, no real phone in the payload). ` +
                `Nothing was posted to the group. availability_checks id ${row.id}.`)
            }
            await db.query(
              `UPDATE availability_checks SET needs_review = TRUE, review_alerted_at = NOW()
                WHERE id = $1`, [row.id])
          }
        } catch (err) {
          log.warn('[av] review-queue alert failed', { checkId: row.id, ref, err: err.message })
        }
      }
    }

    // Closed either way: told, or unreachable. What must not happen is the row
    // sitting at 'awaiting' and being notified again on the owner's next reply.
    //
    // reply_at is only stamped when an owner actually replied ($3). On the board
    // path nobody did, and a reply_at on a row nobody answered would count as an
    // answered check in every report built on this table.
    await db.query(
      `UPDATE availability_checks
          SET notified_at = NOW(),
              status = CASE WHEN status = 'awaiting' THEN $2 ELSE status END,
              reply_at = CASE WHEN $3 THEN COALESCE(reply_at, NOW()) ELSE reply_at END,
              updated_at = NOW()
        WHERE id = $1`, [row.id, writeStatus, !textOverride])
    closed++
  }

  log.info('[av] requester notify pass', { ref, verdict, notified, closed, candidates: r.rows.length })
  return { notified, closed, candidates: r.rows.length }
}

// ── OWNER REPLY WAS NEGATIVE BUT NOT "RENTED" ───────────────────────────────
//
// "sorry, nothing at the moment", "no", "not really". The bot asks which it is
// and marks NOTHING: the listing stays exactly where it is, so an owner who
// meant "not this week" can still recover it. The agent is told we are waiting
// rather than left to assume a verdict landed.
async function onUnclearReply(check, { ownerSession, ownerChat }) {
  const ref = check.ref || check.property_id
  const variant = MSG_OWNER_CLARIFY[Math.abs(check.id) % MSG_OWNER_CLARIFY.length]

  // Queued with a ~30s human pause rather than sent inline. This one matters
  // most of the three: "is it rented, or just on a break?" fired 200ms after the
  // owner's own sentence reads as an interrogation by a machine, which is
  // exactly the moment we are asking them to be candid with us.
  //
  // Note the changed failure shape — we no longer know here whether the send
  // succeeded, so this function no longer returns early on a send failure. The
  // activity row and the agent notice below now always happen; the queue logs a
  // failed delivery under [av] delayed owner send failed.
  const queued = await humanDelay.queueOwnerMessage({
    session: ownerSession, chatId: ownerChat,
    text: variant,
    label: 'unclear_clarify', jobId: `av-human-unclear-${check.id}`,
  })
  if (!queued.queued) {
    // Kev, 2026-09-01 (DELAY BUG): the queue being down must not also mean
    // the delay itself disappears — an instant send here is the exact "bot
    // answered in under a second" symptom, just from a rarer trigger (queue
    // failure instead of a missed queueOwnerMessage call). A durable delayed
    // job isn't available right now BY DEFINITION, so this in-process wait
    // is the best available substitute for this one degraded-mode send —
    // still better than none at all, never instant.
    log.warn('[av] clarify could not be queued — sending after an in-process pause instead', { checkId: check.id, reason: queued.reason })
    await new Promise(res => setTimeout(res, humanDelay.humanPauseMs()))
    try { await sendTextAs(ownerSession, ownerChat, variant) }
    catch (err) {
      log.warn('[av] unclear clarify-send failed', { checkId: check.id, err: err.message })
      return
    }
  }

  try {
    await db.query(
      `INSERT INTO property_activities (property_id, activity_type, details, is_significant, created_at)
       VALUES ($1, 'owner_unclear', $2::jsonb, FALSE, NOW())`,
      [check.property_id, JSON.stringify({
        source: 'av_owner_reply', changed_by: 'owner_reply', check_id: check.id,
        account_session: check.account_session,
        owner_reply: String(check.reply_text || '').slice(0, 500),
        clarification_sent: variant,
      })])
  } catch (err) { log.warn('[av] unclear activity log failed', { err: err.message }) }

  await postToRequester(check,
    `🟡 #${ref} — the owner's reply was ambiguous. Asked them whether it is rented or ` +
    `just not available right now. Nothing has been marked; the listing stays on the board.\n\n` +
    agentDecisionPrompt(ref))
  await rememberAgentReview(check)

  log.info('[av] unclear reply handled', { checkId: check.id, ref })
}

// ── OWNER SAID RENTED ───────────────────────────────────────────────────────

async function onRented(check, { ownerSession, ownerChat, replyMsgId }) {
  const ref = check.ref || check.property_id

  // Final mutation firewall. Re-read the canonical row after the reply was
  // recorded and require the exact check, property, owner and current message
  // id to still agree. A stale worker, wrong chat or cross-property reply can
  // therefore never mark a listing rented even if it reached this function.
  const proof = (await db.query(
    `SELECT ac.id
       FROM availability_checks ac
       JOIN properties p ON p.id = ac.property_id
      WHERE ac.id = $1 AND ac.property_id = $2
        AND ac.owner_id = p.owner_id
        AND ac.status = 'replied_no'
        AND ac.reply_message_id IS NOT DISTINCT FROM $3
      LIMIT 1`, [check.id, check.property_id, replyMsgId || null])).rows[0]
  if (!proof) {
    log.warn('[av] rented mutation refused — current owner/check/message proof failed', {
      checkId: check.id, propertyId: check.property_id,
    })
    return { applied: false, reason: 'owner_context_not_proven' }
  }

  // 1. Thank the owner, same account, same chat — after a ~30s human pause, with
  // the 👎 in the same job. An instant "thanks for letting me know" on the
  // second an owner writes "it's rented" is the most-read message in this whole
  // flow and the one that most needs to look typed. See services/humanDelay.js.
  await humanDelay.queueOwnerMessage({
    session: ownerSession, chatId: ownerChat,
    text: MSG_OWNER_RENTED_THANKS,
    reactTo: replyMsgId, reactEmoji: '👎',
    label: 'rented_thanks', jobId: `av-human-rented-${check.id}`,
  })

  // 2. Agent-bound reaction stays immediate.
  await reactOnRequest(check, '👎')

  // 3a. CRM / DB — through boardAction.markRecentlyRented, not a raw UPDATE.
  // The builder is what also sets recently_rented_at and lifecycle_state, and
  // recently_rented_at is what puts the card in the board's 48h "what just
  // went?" view. Writing available_status by hand here left the owner path out
  // of that view entirely — an owner's own "it's rented" was the one verdict the
  // board could not show.
  //
  // The builder's own audit row is skipped deliberately: the
  // 'marked_rented_via_av' row below carries the owner's actual words and the
  // old status, which is strictly more than the generic one, and two audit rows
  // for one event is noise.
  const boardAction = require('./boardAction')
  const rentedPlan = await boardAction.markRecentlyRented({
    propertyId: check.property_id,
    agentId: null,
    changedBy: 'owner_reply',
    oldStatus: check.available_status || null,
    reason: `Owner replied: "${String(check.reply_text || '').trim().slice(0, 160)}"`,
  })
  let applied = false
  if (rentedPlan.ok) {
    try {
      const upd = await db.query(rentedPlan.update.sql, rentedPlan.update.params)
      applied = upd.rows.length > 0
    }
    catch (err) { log.warn('[av] rented state write failed', { checkId: check.id, err: err.message }) }
  } else {
    log.warn('[av] rented plan refused', { checkId: check.id, reason: rentedPlan.reason })
  }
  if (!applied) return { applied: false, reason: rentedPlan.reason || 'state_write_not_applied' }
  try {
    await db.query(
      `INSERT INTO property_activities (property_id, activity_type, details, is_significant, created_at)
       VALUES ($1, 'marked_rented_via_av', $2::jsonb, TRUE, NOW())`,
      [check.property_id, JSON.stringify({
        source: 'av_owner_reply', changed_by: 'owner_reply', check_id: check.id,
        account_session: check.account_session, owner_reply: String(check.reply_text || '').slice(0, 500),
        old_status: check.available_status, new_status: 'rented',
      })])
  } catch (err) { log.warn('[av] activity log insert failed', { err: err.message }) }

  // 3b. Website — the builder already unpublished it. Belt and braces for the
  // case where its guard held (already archived): an archived listing must not
  // come back to the public site because this line was skipped.
  await db.query('UPDATE properties SET published = FALSE WHERE id = $1', [check.property_id])

  // 3c. Property chats — 😡 on the bot's description message in each group, and
  // a worded correction under the listing itself. The emoji alone was invisible
  // to anyone scrolling: it is a reaction on a message that still reads as a
  // live offer. Neutral wording only — the group is public, so no reason and no
  // owner details (see services/boardFeedback.js for the same rule).
  const groupResult = await reactAngryInPropertyGroups(check.property_id)
  const groupText = await replyUnderListing(check.property_id,
    withPropertyLink(`🔴 #${ref} — now rented. No longer available.`, ref))

  // 3d. Facebook — cancel everything still pending.
  const fbResult = await cancelFacebookJobs(check.property_id)

  log.info('[av] rented flow complete', {
    checkId: check.id, ref, groups: groupResult, groupText, fb: fbResult,
  })

  await postToRequester(check,
    `🔴 #${ref} — owner says RENTED.\n` +
    `• CRM: off the board, marked rented (48h "recently rented")\n` +
    `• Website: unpublished\n` +
    `• Facebook: ${fbResult.cancelled} pending post(s) cancelled\n` +
    `• Groups: 😡 on ${groupResult.reacted}/${groupResult.total} listing message(s), ` +
    `correction posted under ${groupText.replied}/${groupText.total}` +
    (groupResult.total === 0 ? ' — no stored message id for this listing' : ''))
}

// ── OWNER SAID RENTED, UNPROMPTED (ARGUS item 1) ────────────────────────────
// Same side-effect bundle onRented() above applies (boardAction, website,
// property-chat correction, Facebook cancellation, admin alert) but callable
// without an availability_checks `check` row — there is no pending question
// this is answering, no requester to report back to, so those two pieces of
// onRented() (reactOnRequest, postToRequester) do not apply and are left out
// rather than faked with a synthetic check object. Everything reused here is
// the exact same function onRented() itself calls; this is not a second
// implementation of "mark rented", just a second caller.
async function applyRentedVerdictFromOwnerChat({ propertyId, ownerId, ref, ownerSession, ownerChat, replyMsgId, replyText }) {
  const ownsProperty = (await db.query(
    `SELECT 1 FROM properties
      WHERE id = $1 AND owner_id = $2
        AND COALESCE(available_status, 'available') NOT IN ('rented','archived')
      LIMIT 1`, [propertyId, ownerId])).rows.length > 0
  if (!ownsProperty) {
    log.warn('[av] spontaneous rented mutation refused — property/owner proof failed', { propertyId, ownerId })
    return { applied: false, reason: 'owner_property_not_proven' }
  }
  await humanDelay.queueOwnerMessage({
    session: ownerSession, chatId: ownerChat,
    text: MSG_OWNER_RENTED_THANKS,
    reactTo: replyMsgId || null, reactEmoji: replyMsgId ? '👎' : null,
    label: 'rented_thanks_spontaneous', jobId: `av-spontaneous-rented-${propertyId}-${Date.now()}`,
  }).catch(err => log.warn('[av] spontaneous rented thank-you queue failed', { propertyId, err: err.message }))

  const boardAction = require('./boardAction')
  const rentedPlan = await boardAction.markRecentlyRented({
    propertyId, agentId: null, changedBy: 'owner_reply',
    reason: `Owner said, unprompted: "${String(replyText || '').trim().slice(0, 160)}"`,
  })
  let applied = false
  if (rentedPlan.ok) {
    try {
      const upd = await db.query(rentedPlan.update.sql, rentedPlan.update.params)
      applied = upd.rows.length > 0
    } catch (err) { log.warn('[av] spontaneous rented state write failed', { propertyId, err: err.message }) }
  } else {
    log.warn('[av] spontaneous rented plan refused', { propertyId, reason: rentedPlan.reason })
  }
  if (!applied) return { applied: false }

  try {
    await db.query(
      `INSERT INTO property_activities (property_id, activity_type, details, is_significant, created_at)
       VALUES ($1, 'marked_rented_via_owner_chat', $2::jsonb, TRUE, NOW())`,
      [propertyId, JSON.stringify({
        source: 'owner_chat_spontaneous', changed_by: 'owner_reply',
        owner_reply: String(replyText || '').slice(0, 500), new_status: 'rented',
      })])
  } catch (err) { log.warn('[av] spontaneous rented activity log failed', { err: err.message }) }

  await db.query('UPDATE properties SET published = FALSE WHERE id = $1', [propertyId])

  const groupResult = await reactAngryInPropertyGroups(propertyId)
  const groupText = await replyUnderListing(propertyId,
    withPropertyLink(`🔴 #${ref} — now rented. No longer available.`, ref))
  const fbResult = await cancelFacebookJobs(propertyId)

  log.info('[av] spontaneous rented flow complete', {
    propertyId, ref, groups: groupResult, groupText, fb: fbResult,
  })

  try {
    const adminSession = await pickAdminSession()
    if (adminSession) {
      await sendTextAs(adminSession, config.admin.botNumber,
        `🔴 #${ref} — owner said RENTED, unprompted (no pending availability check was open).\n` +
        `• CRM: off the board, marked rented (48h "recently rented")\n` +
        `• Website: unpublished\n` +
        `• Facebook: ${fbResult.cancelled || 0} pending post(s) cancelled\n` +
        `• Groups: 😡 on ${groupResult.reacted}/${groupResult.total} listing message(s), ` +
        `correction posted under ${groupText.replied}/${groupText.total}` +
        (groupResult.total === 0 ? ' — no stored message id for this listing' : ''))
    }
  } catch (err) { log.warn('[av] spontaneous rented admin alert failed', { err: err.message }) }

  return { applied: true }
}

// The owner named which property a disambiguation question (below) was
// about. Reuses the exact ref/town matching grammar the multi-unit
// awaiting-check guard already uses (findNamedProperty, further up in
// handleOwnerReply) — not a second parser — plus a bare numbered choice
// ("1" / "2"), since the question itself is a numbered list.
async function onPropertyIdentityReply(check, text, { ownerSession, ownerChat, replyMsgId }) {
  const candidateIds = check.pending_identity_candidates || []
  if (!candidateIds.length) {
    await db.query(
      `UPDATE availability_checks SET status = 'needs_review', reply_at = NOW(), reply_text = $2, updated_at = NOW() WHERE id = $1`,
      [check.id, text])
    log.warn('[av] property-identity check had no candidates recorded', { checkId: check.id })
    return
  }

  const propsR = await db.query(
    `SELECT id, ref, town, available_status FROM properties WHERE id = ANY($1::int[])`, [candidateIds])
  const candidates = propsR.rows

  let named = null
  const refHits = String(text || '').match(/#?2906-\d{2,4}|\b\d{2,4}\b/gi) || []
  for (const c of refHits) {
    const resolved = await resolveProperty(c)
    if (resolved) {
      const hit = candidates.find(p => p.id === resolved.id)
      if (hit) { named = hit; break }
    }
  }
  if (!named) {
    for (const p of candidates) {
      if (!p.town) continue
      const re = new RegExp(`\\b${p.town.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
      if (re.test(String(text || ''))) { named = p; break }
    }
  }
  if (!named) {
    const numM = String(text || '').trim().match(/^(\d+)$/)
    if (numM) {
      const idx = parseInt(numM[1], 10) - 1
      if (candidates[idx]) named = candidates[idx]
    }
  }

  if (!named) {
    // Ask once, per spec — do not re-fire the same question. An
    // unrecognised answer goes to a human instead of guessing or nagging.
    await db.query(
      `UPDATE availability_checks SET status = 'needs_review', reply_at = NOW(), reply_text = $2, updated_at = NOW() WHERE id = $1`,
      [check.id, text])
    log.info('[av] property-identity disambiguation reply not recognised — flagged for manual review, not re-asked', {
      checkId: check.id, ownerId: check.owner_id, text: String(text).slice(0, 160),
    })
    try {
      const adminSession = await pickAdminSession()
      if (adminSession) {
        await sendTextAs(adminSession, config.admin.botNumber,
          `🟡 An owner said a property is rented but their answer to "which one?" didn't match any of the candidates — needs manual review.\n` +
          `Owner reply: "${String(text).slice(0, 200)}"\nCandidates: ${candidates.map(p => '#' + p.ref).join(', ')}`)
      }
    } catch (err) { log.warn('[av] identity-clarify admin alert failed', { err: err.message }) }
    return
  }

  if (['rented', 'archived'].includes(named.available_status)) {
    await db.query(
      `UPDATE availability_checks SET status = 'answered', reply_at = NOW(), reply_text = $2, updated_at = NOW() WHERE id = $1`,
      [check.id, text])
    log.info('[av] property-identity disambiguation resolved to an already-settled listing — no-op', {
      checkId: check.id, ref: named.ref, status: named.available_status,
    })
    return
  }

  await db.query(
    `UPDATE availability_checks SET status = 'answered', reply_at = NOW(), reply_text = $2, updated_at = NOW() WHERE id = $1`,
    [check.id, text])
  await applyRentedVerdictFromOwnerChat({
    propertyId: named.id, ownerId: check.owner_id, ref: named.ref, ownerSession, ownerChat, replyMsgId, replyText: text,
  })
  log.info('[av] property-identity disambiguation resolved', { checkId: check.id, ref: named.ref })
}

// Entry point for a message that is NOT a reply to anything the bot is
// waiting on (handleWebhookMessage only calls this when its own
// hadAwaitingCheck lookup came back empty — see there for why). Resolves
// the owner from the raw sender phone (the same normalizePhone() every
// other owner lookup in this file uses), then applies the SAME 0/1/many
// branching the rest of this codebase already uses for "which property does
// this reply concern" (see the multi-unit guard inside handleOwnerReply):
// no active property → nothing to do; exactly one → apply directly; more
// than one → ask ONCE, tagged as a PROPERTY_IDENTITY availability_checks
// row (migration 20260916d reserved the question type, never wired up
// until now) so the owner's next message resolves it through the normal
// handleOwnerReply dispatch, not a second polling mechanism.
async function maybeHandleSpontaneousRentedStatement({ session, text, senderPhone, chatId, replyMsgId = null }) {
  if (!isUnambiguousRentedStatement(text)) return { handled: false }
  const verifiedPhone = await verifiedInboundOwnerPhone({ session, senderPhone, chatId })
  if (!verifiedPhone) return { handled: false }

  const norm = normalizePhone(verifiedPhone) || verifiedPhone
  const ownerRow = await db.query(
    `SELECT id FROM owner_contacts WHERE phone_normalized = $1 OR phone_normalized = $2 LIMIT 1`,
    [norm, senderPhone])
  const ownerId = ownerRow.rows[0]?.id
  if (!ownerId) return { handled: false }

  const propsR = await db.query(
    `SELECT id, ref, town, longlet_price, available_status FROM properties
      WHERE owner_id = $1 AND COALESCE(available_status, 'available') NOT IN ('rented', 'archived')`,
    [ownerId])
  const active = propsR.rows
  if (!active.length) return { handled: false }

  if (active.length === 1) {
    const prop = active[0]
    const result = await applyRentedVerdictFromOwnerChat({
      propertyId: prop.id, ownerId, ref: prop.ref, ownerSession: session, ownerChat: chatId,
      replyMsgId, replyText: text,
    })
    log.info('[av] spontaneous owner rented statement applied', { propertyId: prop.id, ref: prop.ref, ownerId })
    return { handled: result.applied, propertyId: prop.id }
  }

  // Several active properties require a portfolio-wide answer. The old path
  // below asked "which one?" from this one chat, emitted #null for incomplete
  // rows and let the generic owner automation reply again. The persisted
  // portfolio check scans every live account first, creates one share link per
  // property and interprets ALL / numbered selections without changing an
  // omitted property's canonical status until an admin reviews it.
  const portfolio = await ownerPortfolioCheck.startFromRentedStatement({
    ownerContactId: ownerId,
    ownerPhone: verifiedPhone,
    session,
    chatId,
    messageId: replyMsgId,
  })
  if (portfolio.handled) return { ...portfolio, portfolio: true }

  const list = active
    .map((p, i) => `${i + 1}. #${p.ref}${p.town ? ` · ${p.town}` : ''}${priceLabel(p) ? ` · ${priceLabel(p)}` : ''}`)
    .join('\n')
  await humanDelay.queueOwnerMessage({
    session, chatId, text: `Sorry to hear — which one do you mean?\n${list}`,
    reactTo: replyMsgId, reactEmoji: null,
    label: 'rented_clarify_which', jobId: `av-rented-clarify-${ownerId}-${Date.now()}`,
  }).catch(err => log.warn('[av] rented-clarify queue failed', { ownerId, err: err.message }))
  await db.query(
    `INSERT INTO availability_checks
       (property_id, owner_id, account_session, owner_chat_id, sent_at, status,
        source, pending_question_type, pending_question_sent_at, pending_identity_candidates)
     VALUES (NULL, $1, $2, $3, NOW(), 'awaiting',
             'owner_chat_spontaneous', 'PROPERTY_IDENTITY', NOW(), $4)`,
    [ownerId, session, chatId, active.map(p => p.id)])
  log.info('[av] spontaneous rented statement ambiguous — asked owner to disambiguate once', {
    ownerId, candidates: active.map(p => p.ref),
  })
  return { handled: true, disambiguating: true }
}

// 😡 on the bot's original description message, per category group, using the
// message ids stored at post time in property_publishing_status.external_ref.
// NOTE the channel is 'category_groups' (plural) — that is what categoryPublisher
// writes. services/rentedDetector.js queries the singular form and is dead code.
async function reactAngryInPropertyGroups(propertyId) {
  const r = await db.query(
    `SELECT target_ref, external_ref, session
       FROM property_publishing_status
      WHERE property_id = $1 AND channel = 'category_groups'
        AND status = 'posted' AND external_ref IS NOT NULL`, [propertyId])

  const total = r.rows.length
  if (!total) {
    log.warn('[av] no stored group message id — 😡 skipped (listing predates external_ref capture)',
      { propertyId })
    return { total: 0, reacted: 0 }
  }

  // The account that actually SENT a given group message is the only one
  // that can react to it (Kev, 2026-08-27: !upload can now post via a
  // fallback account when Default is down — services/categoryPublisher.js
  // records which one in `session`). Pre-fallback rows have session=NULL
  // and fall back to the old primary-only behaviour.
  const primary = await waha.getGroupReactionSession()

  let reacted = 0
  for (const row of r.rows) {
    let session = row.session
    if (session) {
      const status = await waha.getSessionStatus(session)
      if (!(status?.status === 'WORKING' || status?.status === 'CONNECTED')) session = null
    }
    session = session || primary
    if (!session) {
      log.warn('[av] no live session to react as — 😡 skipped', { propertyId, group: row.target_ref, recorded: row.session })
      continue
    }
    const ok = await reactAs(session, row.external_ref, '😡')
    if (ok) reacted++
    else log.warn('[av] 😡 failed for group', { group: row.target_ref, session, msg: String(row.external_ref).slice(-24) })
  }
  return { total, reacted }
}

// Cancel pending Facebook jobs. Mirrors facebookCampaign's own scheme
// (jobId `fb:<propertyId>:<postIndex>`); killSwitch.cancelAllPending uses a
// non-existent queue.removeJob() and a different id format, so it is not reused.
// The FB worker also re-checks available_status='rented' before posting, so the
// DB flip alone already stops anything this misses.
async function cancelFacebookJobs(propertyId) {
  // Cancel pending Facebook channel rows AND pending FB-group-share rows.
  // The owner said the property is rented, so any queued or in-flight FB
  // post (page campaign OR groups share) is now a waste of effort and a
  // risk of posting stale data to the public. We do NOT touch already-
  // posted rows: the post is live and the "rented" mark lives on the
  // website and in the CRM; reversing the post is the operator's call.
  const pending = await db.query(
    `SELECT run_index, target_ref, channel FROM property_publishing_status
      WHERE property_id = $1 AND channel IN ('facebook','fb_groups')
        AND status IN ('scheduled','pending','failed')`, [propertyId])

  if (pending.rows.length) {
    await db.query(
      `UPDATE property_publishing_status
          SET status = 'cancelled', updated_at = NOW()
        WHERE property_id = $1 AND channel IN ('facebook','fb_groups')
          AND status IN ('scheduled','pending','failed')`, [propertyId])
  }

  const queue = QUEUES['facebook-posts']
  if (queue) {
    for (const row of pending.rows.filter(r => r.channel === 'facebook')) {
      const idx = row.run_index || Number(String(row.target_ref).split('#')[1]) || 0
      try { await queue.remove(`fb:${propertyId}:${idx}`) } catch { /* already gone */ }
    }
  }
  // For the FB-group-share queue, the run_id is what we need to remove. We
  // do not have it directly here; the worst case is the worker picks up
  // the cancelled run and short-circuits in fbShareBacklog.kick() because
  // status is no longer 'queued'. This is a no-op-on-success; we do not
  // need to remove the BullMQ job.
  return { cancelled: pending.rows.length }
}

// ── OWNER SAID STILL AVAILABLE ──────────────────────────────────────────────

async function onStillAvailable(check, { ownerSession, ownerChat, replyMsgId, timeframe, date, precision, replyText }) {
  const ref = check.ref || check.property_id

  // Kev, 2026-09-15 (decision-layer spec, items 5-7): what do we actually
  // still need? available_date already on file (past, today, or a specific
  // future date — any of those means we already know it) → entrance date is
  // not missing, asking again is exactly the "questionnaire behaviour" the
  // spec calls out. No dedicated "viewing window known" column exists yet,
  // so a PRIOR replied_available check on this same property is the proxy:
  // if the still-available flow already ran for this property before, the
  // viewing-window question was already asked once — asking again every
  // time the owner reconfirms is the nagging item 6 warns about.
  const propRow = (await db.query(
    `SELECT available_date, field_provenance FROM properties WHERE id = $1`, [check.property_id])).rows[0] || {}
  if (timeframe && check.property_id) {
    const fact = {
      value: timeframe,
      approximate_date: date || null,
      precision: precision || 'stated',
      source: 'owner_whatsapp',
      raw: String(replyText || '').slice(0, 500),
      observed_at: new Date().toISOString(),
    }
    await db.query(
      `UPDATE properties SET
         field_provenance = jsonb_set(COALESCE(field_provenance, '{}'::jsonb), '{available_date}', $2::jsonb, true),
         internal_notes = CASE
           WHEN COALESCE(internal_notes,'') ILIKE '%' || $3 || '%' THEN internal_notes
           ELSE TRIM(BOTH ' | ' FROM COALESCE(internal_notes,'') || ' | Approximate move-in: ' || $3)
         END,
         updated_at = NOW()
       WHERE id = $1`,
      [check.property_id, JSON.stringify(fact), timeframe])
    propRow.field_provenance = { ...(propRow.field_provenance || {}), available_date: fact }
  }
  const needsEntranceDate = !propRow.available_date && !propRow.field_provenance?.available_date
  const priorAsked = (await db.query(
    `SELECT 1 FROM availability_checks
      WHERE property_id = $1 AND status = 'replied_available' AND id < $2 LIMIT 1`,
    [check.property_id, check.id])).rows[0]
  const needsViewingWindow = !priorAsked
  const followUp = decideStillAvailableFollowUp({ needsEntranceDate, needsViewingWindow })

  // 1. Ask whatever's actually still missing (or nothing) — and the 👍 on
  // their message — after a ~30s human pause. Answering an owner in the same
  // second they wrote is the clearest automation tell we have; see
  // services/humanDelay.js. The reaction rides in the same job so the emoji
  // and the question (if any — queueOwnerMessage accepts text:null, a
  // reaction-only send) arrive together. jobId keyed on the check so a
  // retried webhook cannot double-ask.
  await humanDelay.queueOwnerMessage({
    session: ownerSession, chatId: ownerChat,
    text: followUp.text,
    reactTo: replyMsgId, reactEmoji: '👍',
    label: 'still_available_question', jobId: `av-human-avail-${check.id}`,
  })

  // CRITICAL OWNER FLOW FIX (Kev, 2026-09-16): this follow-up question used
  // to be a bare text send with NO tracked state at all — the owner's reply
  // to it had nothing correct to match against, so it fell through to the
  // generic property-availability classifier and could trigger "is it
  // rented, or on a break?" for a plain viewing-scheduling answer. A fresh
  // 'awaiting' row, tagged with the REAL question type, lets
  // handleOwnerReply() route the reply correctly before any generic
  // classifier runs. 'both' is tagged VIEWING_AVAILABILITY — viewing replies
  // are the higher-misclassification-risk case, and onViewingReply() also
  // opportunistically extracts an entrance date from the same message.
  if (followUp.asked !== 'none' && check.property_id) {
    const questionType = followUp.asked === 'entrance' ? 'MOVE_IN_DATE' : 'VIEWING_AVAILABILITY'
    await db.query(
      `INSERT INTO availability_checks
         (property_id, owner_id, account_session, requester_chat_id, requester_phone,
          requester_session, requester_message_id, requester_agent_id, owner_chat_id,
          sent_at, status, source, pending_question_type, pending_question_sent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),'awaiting','viewing_followup',$10,NOW())`,
      [check.property_id, check.owner_id, check.account_session, check.requester_chat_id, check.requester_phone,
       check.requester_session, check.requester_message_id, check.requester_agent_id, ownerChat, questionType])
  }

  // 2. The requester's 👍 is NOT delayed — that is agent-bound feedback, and an
  // agent watching for an answer should see it land immediately.
  await reactOnRequest(check, '👍')

  // 3. "Still on market" as a REPLY to the listing message in each property chat.
  const posted = await replyUnderListing(check.property_id,
    withPropertyLink(`🟢 #${ref} — ${MSG_STILL_ON_MARKET}`, ref))

  // 4. THE BOARD. The owner just said yes, so the Schedule Board's freshness
  // clock resets: available_confirmed + last_confirmed_available_at = NOW(),
  // which is what turns the Available button bright green again.
  //
  // This is what closes the loop. Without it the owner's confirmation lands in
  // availability_checks and nowhere else, the board still shows a stale
  // timestamp, and the >60h auto-reachout asks the same owner the same question
  // again in three days — forever.
  //
  // changed_by='owner_reply' and no agent id: nobody clicked anything.
  try {
    const boardAction = require('./boardAction')
    // Kev, 2026-09-14 (far-future availability guardrail, spec item "UPCOMING
    // PROPERTY STATE"): a plain "yes" from an owner whose listing is already
    // 'upcoming' is a RECONFIRMATION of the same future date, not a report
    // that the flat is free right now — checkIn() unconditionally sets
    // 'available_confirmed', which would silently flip a property occupied
    // until January back to "available now" on the board the moment the
    // owner reaffirms it. markUpcoming() with no new date COALESCEs onto the
    // existing available_date and leaves the status alone, refreshing only
    // last_confirmed_available_at (so "Confirmed today" is still accurate).
    const wasUpcoming = check.available_status === 'upcoming'
    const plan = wasUpcoming
      ? await boardAction.markUpcoming({
          propertyId: check.property_id,
          agentId: null,
          changedBy: 'owner_reply',
          availableDate: null,
          reason: 'Owner reconfirmed the same future availability',
          oldStatus: check.available_status || null,
        })
      : await boardAction.checkIn({
          propertyId: check.property_id,
          agentId: null,
          changedBy: 'owner_reply',
          method: 'owner_confirmed',
          oldStatus: check.available_status || null,
        })
    if (plan.ok) {
      const upd = await db.query(plan.update.sql, plan.update.params)
      if (upd.rows.length) await db.query(plan.activity.sql, plan.activity.params)
      log.info('[av] board confirmation refreshed', {
        checkId: check.id, ref, moved: upd.rows.length > 0,
      })
    } else {
      log.warn('[av] board confirmation plan refused', { checkId: check.id, reason: plan.reason })
    }
  } catch (err) {
    // The owner has already been thanked and the groups already updated — a
    // board write failing here must not turn a successful flow into a throw.
    log.warn('[av] board confirmation refresh failed', { checkId: check.id, err: err.message })
  }

  log.info('[av] still-available flow complete', { checkId: check.id, ref, listingReplies: posted, asked: followUp.asked })

  const askedLine = {
    both:     'Asked them for a viewing slot + entrance date.',
    viewing:  'Asked them for a viewing slot (entrance date already on file).',
    entrance: 'Asked them for the entrance date (viewing window already asked before).',
    none:     'Nothing further to ask — already have both on file.',
  }[followUp.asked]
  await postToRequester(check,
    `✅ #${ref} — owner confirms STILL AVAILABLE. ${askedLine}\n` +
    `• Groups: "Still on market" posted under ${posted.replied}/${posted.total} listing message(s)` +
    (posted.total === 0 ? ' — no stored message id for this listing' : ''))
}

async function replyUnderListing(propertyId, text) {
  const r = await db.query(
    `SELECT target_ref, external_ref
       FROM property_publishing_status
      WHERE property_id = $1 AND channel = 'category_groups'
        AND status = 'posted' AND external_ref IS NOT NULL`, [propertyId])

  const total = r.rows.length
  if (!total) {
    log.warn('[av] no stored group message id — listing reply skipped', { propertyId })
    return { total: 0, replied: 0 }
  }

  // WHICH ACCOUNT REPLIES
  //   A quoted reply has to come from the account that owns the quoted message.
  //   The stored id carries its sender:
  //     true_<group>@g.us_<msgid>_<senderPhone>@c.us
  //   Every one of the 107 stored listing messages was posted by Kevsecond, not
  //   by sessions[0] — and sessions[0] is `default`, which is currently sitting
  //   at SCAN_QR_CODE. Quoting from the wrong account is what produced
  //   "no LID found for <group>@s.whatsapp.net", i.e. a failure that looks like a
  //   group problem and is really a session mismatch.
  const working = await waha.getWorkingSessions()          // [{ name, phone }]
  const byPhone = new Map(working.filter(s => s.phone).map(s => [String(s.phone), s.name]))
  const fallback = (await waha.getGroupReactionSession())
    || (working[0] && working[0].name)
    || null
  if (!fallback && !byPhone.size) {
    log.warn('[av] no working session — listing reply skipped', { propertyId, total })
    return { total, replied: 0 }
  }

  let replied = 0, plain = 0
  for (const row of r.rows) {
    const owner = String(row.external_ref || '').match(/_(\d{6,})@c\.us$/)
    const session = (owner && byPhone.get(owner[1])) || fallback
    if (!session) {
      log.warn('[av] no session available for group reply', { group: row.target_ref })
      continue
    }
    try {
      await sendTextAs(session, row.target_ref, text, row.external_ref)
      replied++
    } catch (err) {
      // A quoted reply can fail for a reason that has nothing to do with the
      // group being wrong: the account that POSTED the listing may be offline
      // (all 107 stored messages were posted by an account that is FAILED
      // today), and quoting somebody else's message id is what WhatsApp refuses
      // with "no LID found". The correction still matters more than the quote,
      // so try once as a plain group message before giving up on this group.
      log.warn('[av] quoted listing reply failed — trying unquoted',
        { group: row.target_ref, session, err: err.message })
      try {
        await sendTextAs(session, row.target_ref, text)
        replied++
        plain++
      } catch (err2) {
        log.warn('[av] listing reply failed', { group: row.target_ref, session, err: err2.message })
      }
    }
  }
  return { total, replied, plain }
}

// ── OWNER SAID AVAILABLE BUT LATER ──────────────────────────────────────────

async function onComingSoon(check, { ownerSession, replyMsgId, timeframe, date, replyText }) {
  const ref  = check.ref || check.property_id
  const when = timeframe || 'later'
  const note = `It's coming on market but in ${when}`

  // 👍 on the owner's reply, after the same human pause as the other two owner
  // outcomes. (Spec: SOON case gets no owner text reply, so this job carries the
  // reaction only.) The requester's 👍 stays immediate.
  await humanDelay.queueOwnerMessage({
    session: ownerSession, chatId: check.owner_chat_id,
    reactTo: replyMsgId, reactEmoji: '👍',
    label: 'coming_soon_ack', jobId: `av-human-soon-${check.id}`,
  })
  await reactOnRequest(check, '👍')

  if (SOON_NOTE_TARGET === 'requester') await postToRequester(check, `🟡 #${ref} — ${note}`)
  else {
    await humanDelay.queueOwnerMessage({
      session: ownerSession, chatId: check.owner_chat_id, text: note,
      label: 'coming_soon_note', jobId: `av-human-soonnote-${check.id}`,
    })
  }

  // ── Kev, 2026-09-14 (spec item 1): future availability overrides "available
  // now" ────────────────────────────────────────────────────────────────────
  // Before this, a "rented till March 2027" reply reacted and sent a note but
  // never touched the property row — the board kept the listing exactly as
  // before, isMoreThanMonthsAway() had nothing to gate on, and September's
  // cadence went on asking "still available?" about a flat the owner had
  // already told us is occupied for another 18 months. One shared write path
  // (boardAction.markUpcoming), same as every other status change on this
  // file — never a second copy of the status SQL.
  if (check.property_id) {
    try {
      const boardAction = require('./boardAction')
      const plan = await boardAction.markUpcoming({
        propertyId: check.property_id,
        agentId: null,
        changedBy: 'owner_reply',
        oldStatus: check.available_status || null,
        availableDate: date || null,
        reason: `Owner: "${String(replyText || '').trim().slice(0, 160)}"`,
      })
      if (plan.ok) {
        const upd = await db.query(plan.update.sql, plan.update.params)
        if (upd.rows.length) await db.query(plan.activity.sql, plan.activity.params)
        log.info('[av] coming-soon → upcoming', {
          checkId: check.id, ref, date: date || null, moved: upd.rows.length > 0,
        })
      }
    } catch (err) {
      // A failed property write must not swallow the owner-facing reply that
      // already went out above — recoverable by hand, a thrown handler is not.
      log.warn('[av] mark-upcoming write failed', { checkId: check.id, err: err.message })
    }
  }

  // ── AVAILABILITY != CONTACT PERMISSION (2026-09-21) ──────────────────────────
  // The listing is now 'upcoming' (still matchable, still on the board). What it
  // must NOT do is keep getting asked: an owner who has just told us "free from
  // 1 March" is not to be nudged again until the date is near. The pause is on the
  // LISTING (property_contact_paused_until), so it never touches available_status
  // and never silences the owner about any other flat. Until = 14 days before the
  // stated date, only when that is still in the future.
  if (check.property_id && date) {
    try {
      const avail = new Date(String(date).slice(0, 10) + 'T00:00:00Z')
      if (!Number.isNaN(avail.getTime())) {
        const until = new Date(avail.getTime() - 14 * 86400000)
        if (until.getTime() > Date.now() + 86400000) {
          await ownerSendGate.setContactPause({
            scope: 'property', id: check.property_id, until,
            note: `Owner said available ${String(date).slice(0, 10)} — no contact until 14 days before`, by: 'owner_reply',
          })
        }
      }
    } catch (err) { log.warn('[av] coming-soon contact pause failed', { checkId: check.id, err: err.message }) }
  }

  log.info('[av] coming-soon flow complete', { checkId: check.id, ref, timeframe: when, date: date || null })
}

// ── Follow-up jobs ──────────────────────────────────────────────────────────

async function processAvailabilityJob(data) {
  const { kind, checkId } = data || {}
  if (!kind) return { skipped: 'bad_job' }

  // ── delayed owner-bound send (services/humanDelay.js) ─────────────────────
  // Carries its own target, so it is handled before the checkId requirement
  // below — it is not tied to one availability check and is also used by the
  // !book relay. This is what puts the ~30s human pause between an owner's
  // message and our answer; see humanDelay.js for why the same second is a tell.
  if (kind === 'human_send') return humanSendJob(data)

  if (!checkId) return { skipped: 'bad_job' }

  const r = await db.query(
    `SELECT ac.*, p.ref FROM availability_checks ac
       LEFT JOIN properties p ON p.id = ac.property_id
      WHERE ac.id = $1`, [checkId])
  const check = r.rows[0]
  if (!check) return { skipped: 'check_gone' }

  // The 7-9 day robot asks ONCE and waits: it never gets the call ping / next-morning
  // nudge (executeOwnerCheck does not arm them; this refuses any that exist anyway).
  if (String(check.source) === 'auto_inactivity') {
    log.info('[av] follow-up skipped — robot checks are one message only', { checkId, kind })
    return { skipped: 'robot_no_followups' }
  }

  // Both follow-ups fire ONLY while the owner still hasn't replied.
  if (check.status !== 'awaiting' || check.reply_at) {
    log.info('[av] follow-up skipped — owner already replied', { checkId, kind, status: check.status })
    return { skipped: 'already_replied' }
  }

  const session = await resolveLiveSession(check.account_session)
  if (!session) {
    log.warn('[av] follow-up skipped — sending account not live', { checkId, kind, want: check.account_session })
    return { skipped: 'session_offline' }
  }

  // ── the CRM switch reaches already-queued follow-ups too ──────────────────
  //
  // Turning the robot off has to stop the messages it has ALREADY armed, not
  // just the next scan. Each auto check queues a 09:00-next-morning text at the
  // moment it is sent, so on 2026-08-16 there were 20 of them sitting in the
  // queue for the following morning — switching the flow to 'never' would have
  // looked broken when they all went out anyway.
  //
  // Scoped to source='auto_reachout' ON PURPOSE. A follow-up belonging to an
  // agent's own !av / board request is part of a flow a human started, and the
  // schedule switch is not about that.
  if (AUTO_SOURCES.has(String(check.source || 'manual'))) {
    // Lazy require: availabilityReachout requires this module back.
    const { getSchedule } = require('./availabilityReachout')
    const schedule = await getSchedule()
    if (!schedule.enabled) {
      log.info('[av] robot follow-up suppressed — reachout flow is off', {
        checkId, kind, ref: check.ref, schedule: schedule.mode,
      })
      return { skipped: 'flow_disabled' }
    }
  }

  // ── PRE-SEND HARD GATE (2026-09-21) ────────────────────────────────────────
  // These follow-ups were queued when the check was sent. Between then and now
  // the owner may have gone DNC, complained (HUMAN_REVIEW_REQUIRED), been taken
  // over by a human, or the listing may have been rented — none of which the
  // job knew. Re-read the state at the last possible moment.
  {
    const g = await ownerSendGate.checkOwnerSend({
      ownerId: check.owner_id, propertyId: check.property_id, kind: 'followup',
      session, chatId: check.owner_chat_id, automated: true,
    })
    if (!g.allow) {
      log.info('[av] follow-up skipped — pre-send gate', { checkId, kind, ref: check.ref, reason: g.reason })
      return { skipped: `gate_${g.reason}` }
    }
  }

  if (kind === 'call_ping')  return callPingFollowUp(check, session)
  if (kind === 'morning')    return morningFollowUp(check, session)
  return { skipped: 'unknown_kind' }
}

// The delayed owner-bound send. Reaction first, then the text, in one job so
// the 👍 and the sentence it belongs to arrive together rather than half a
// minute apart. The session name is re-resolved because a 30-second-old name
// can have gone offline (or changed case) since the job was queued.
async function humanSendJob(data) {
  const { session, chatId, text, reactTo, reactEmoji, label } = data
  const live = await resolveLiveSession(session) || session
  const out = { label, reacted: false, sent: false }

  // Kev's 2026-09-15 hotfix, item 7 ("Human Active Chat = Bot Silence", the
  // "Martin" incident): this job was queued 1-2 minutes ago (humanDelay's
  // whole point). A human can easily have started actively talking to this
  // owner in the meantime -- checking only at ENQUEUE time would miss that
  // race entirely. This is the actual send, the last possible moment to
  // stay silent, so it's checked here, not just at queueOwnerMessage().
  // data.relayThreadId is set ONLY by bookRelay.js's own queueOwnerMessage
  // calls (a human AGENT's own words being relayed to the owner through the
  // bot) -- that is the human talking, not the bot, so it is deliberately
  // NOT gated here even though it shares this same queue/worker.
  //
  // 2026-09-21: this is now the full PRE-SEND HARD GATE, for relay sends too.
  //  - the check used to compare the chat id's digits with a phone column; an
  //    inbound owner DM is a @lid chat (15 digits), so it never matched and the
  //    gate silently never fired for the most common case. checkOwnerSend
  //    resolves the LID to the real phone first.
  //  - relay sends (relayThreadId) stay exempt from plain "human active" (that is
  //    a human AGENT's own words) but not from DNC / cancelled / HUMAN_REVIEW_
  //    REQUIRED / a rented listing.
  {
    let propertyId = null
    if (data.relayThreadId) {
      try {
        const tr = await db.query('SELECT property_id FROM book_relay_threads WHERE id = $1', [data.relayThreadId])
        propertyId = (tr.rows[0] && tr.rows[0].property_id) || null
      } catch (err) { log.debug('[av] relay thread lookup for gate failed', { err: err.message }) }
    }
    const g = await ownerSendGate.checkOwnerSend({
      chatId, session: live, propertyId, kind: data.relayThreadId ? 'relay' : 'reply',
    })
    if (!g.allow) {
      log.info('[av] delayed owner send skipped — pre-send gate', {
        label, chat: String(chatId).slice(-8), reason: g.reason,
      })
      out.skippedGate = g.reason
      out.skippedHumanActive = g.reason === 'human_active'
      return out
    }
  }

  if (reactTo && reactEmoji) {
    out.reacted = await reactAs(live, reactTo, reactEmoji)
  }
  if (text) {
    try {
      const sent = await sendTextAs(live, chatId, text)
      out.sent = true
      out.messageId = (sent?.id || sent?.key?.id || null)
    } catch (err) {
      log.warn('[av] delayed owner send failed', {
        label, session: live, chat: String(chatId).slice(-8), err: err.message.slice(0, 160),
      })
      out.error = err.message.slice(0, 160)
    }
  }
  // A relay send has to be logged against its thread, or the "did Kev type this
  // himself?" test in bookRelay.humanTookOver() would see our own delayed
  // message as a human takeover and shut the relay down. The require is lazy on
  // purpose: bookRelay requires this module at load time, so a top-level require
  // here would be circular — by the time a job actually runs, both are loaded.
  if (data.relayThreadId && out.messageId) {
    try { await require('./bookRelay').rememberBotMessage(data.relayThreadId, out.messageId) }
    catch (err) { log.warn('[av] relay id bookkeeping failed', { err: err.message }) }
  }

  log.info('[av] delayed owner send done', out)
  return out
}

// ~1 second WhatsApp call, then hang up — it must RING, not connect.
// If the engine cannot place outbound calls we log, flag it, and send NOTHING.
// Explicitly no text substitute here (spec).
async function callPingFollowUp(check, session) {
  const support = await callPingSupport()

  if (!support.supported) {
    await db.query(
      `UPDATE availability_checks
          SET call_ping_status = 'unsupported', updated_at = NOW()
        WHERE id = $1`, [check.id])
    log.warn('[av] CALL PING UNSUPPORTED — skipped, no text substituted', {
      checkId: check.id, ref: check.ref, evidence: support.evidence,
    })
    return { callPing: 'unsupported', evidence: support.evidence }
  }

  // Forward-compatible: if a future WAHA build exposes an outbound call route,
  // ring for ~1s and hang up. Untested against a real endpoint by definition.
  try {
    const started = await wahaFetch('POST', support.endpoint.replace('{session}', session),
      { session, chatId: check.owner_chat_id })
    await new Promise(res => setTimeout(res, 1000))
    const callId = started?.id || started?.callId
    for (const p of [`/api/${session}/calls/${callId}/hangup`, `/api/${session}/calls/reject`]) {
      try { await wahaFetch('POST', p, { session, callId, chatId: check.owner_chat_id }); break } catch {}
    }
    await db.query(
      `UPDATE availability_checks
          SET call_pinged_at = NOW(), call_ping_status = 'sent', updated_at = NOW()
        WHERE id = $1`, [check.id])
    log.info('[av] call ping sent (~1s)', { checkId: check.id, endpoint: support.endpoint })
    return { callPing: 'sent' }
  } catch (err) {
    await db.query(
      `UPDATE availability_checks
          SET call_ping_status = 'failed', updated_at = NOW()
        WHERE id = $1`, [check.id])
    log.warn('[av] call ping failed', { checkId: check.id, err: err.message })
    return { callPing: 'failed', err: err.message }
  }
}

async function morningFollowUp(check, session) {
  // Scanned first, like every other owner-bound message. This one matters most:
  // it is the SECOND thing we say about the same listing, so repeating the first
  // sentence verbatim is exactly the robot tell Kev asked to remove. The scan
  // also catches the case where the owner has since written to us in the
  // meantime and a nudge would talk over them.
  const scan = await ownerChatScan.scanOwnerChat({ session, chatId: check.owner_chat_id })
  const chosen = ownerMessageVariants.pickVariant('morning_followup', { scan })
  log.info('[av] morning follow-up text chosen', {
    checkId: check.id, ref: check.ref, variant: chosen.variantId, why: chosen.reason,
    scanOk: scan.ok, ownerWroteLast: scan.ownerWroteLast,
  })
  try {
    await sendTextAs(session, check.owner_chat_id, chosen.text)
  } catch (err) {
    log.warn('[av] morning follow-up send failed', { checkId: check.id, err: err.message })
    throw err   // let BullMQ retry
  }
  await db.query(
    `UPDATE availability_checks SET morning_sent_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [check.id])
  log.info('[av] morning follow-up sent', { checkId: check.id, ref: check.ref, via: session })
  return { morning: 'sent' }
}

// ── Webhook entry point ─────────────────────────────────────────────────────
// Returns TRUE only when the message was an !av / !avstatus / Yes-No answer,
// i.e. when nothing else should look at it. Owner replies always return FALSE
// so the existing owner-DM pipeline keeps running untouched.
async function handleWebhookMessage({ payload, session, text, isGroup, chatId, senderPhone }) {
  const t = (text || '').trim()

  if (/^!avstatus(\s|$)/i.test(t)) {
    await runAvStatusCommand({ text: t, chatId, session, senderPhone })
    return true
  }
  if (/^!av(\s|$)/i.test(t)) {
    await runAvCommand({ text: t, chatId, session, senderPhone, messageId: payload?.id })
    return true
  }

  if (await handleAgentReviewAnswer({ payload, session, text: t, isGroup, chatId, senderPhone })) {
    return true
  }

  // Yes/No answering an !avstatus reping prompt.
  if (t.length <= 12 && await handleRepingAnswer({ text: t, chatId, session, senderPhone, messageId: payload?.id })) {
    return true
  }

  // Inbound owner DM → try to match an awaiting check. Never consumes.
  // Kev, 2026-09-05: was gated on `senderPhone` truthy — harmless most of the
  // time (a LID-only sender still yields raw LID digits, see senderIdentity.js),
  // but the one payload shape where every candidate is genuinely empty used to
  // skip this entirely instead of reaching handleOwnerReply's session fallback.
  if (!isGroup && !payload?.fromMe && (senderPhone || chatId)) {
    // A reply to the fixed portfolio list is command-like input. Consume it
    // here so the generic owner-conversation hooks cannot add a second,
    // unrelated thank-you or checklist message after ALL / 1,3,6.
    try {
      const portfolioReply = await ownerPortfolioCheck.handleOwnerReply({
        senderPhone,
        text: t,
        session,
        chatId,
        messageId: payload?.id || null,
      })
      if (portfolioReply.handled) return true
    } catch (err) {
      log.warn('[av] owner portfolio reply handling failed', { err: err.message })
    }

    // ARGUS item 1: was this message already something handleOwnerReply owns
    // (a reply to a check it is currently awaiting)? Checked BEFORE calling
    // it, not after — handleOwnerReply may itself flip the row off 'awaiting'
    // as a side effect of processing it (e.g. onRented), and checking after
    // would then wrongly look like "nothing was awaiting" and let the
    // spontaneous path below re-process the exact same message a second
    // time, possibly against the WRONG property if this owner has more than
    // one. An owner with no awaiting check at all is the only case the
    // spontaneous path is for.
    let hadAwaitingCheck = false
    if (senderPhone) {
      try {
        const norm = normalizePhone(senderPhone) || senderPhone
        const aw = await db.query(
          `SELECT 1 FROM availability_checks ac
             JOIN owner_contacts oc ON oc.id = ac.owner_id
            WHERE ac.status = 'awaiting' AND (oc.phone_normalized = $1 OR oc.phone_normalized = $2)
            LIMIT 1`, [norm, senderPhone])
        hadAwaitingCheck = aw.rows.length > 0
      } catch (err) { log.debug('[av] awaiting-check pre-check failed', { err: err.message }) }
    }

    try { await handleOwnerReply({ payload, session, text: t, senderPhone, chatId }) }
    catch (err) { log.warn('[av] owner reply handling failed', { err: err.message }) }

    // Spontaneous "it's rented" / "not available anymore" with NO pending
    // question at all (the "Vanessa Borg" regression: an owner's own
    // unprompted statement never updated the canonical property state, so
    // every downstream automation kept treating the listing as live).
    if (!hadAwaitingCheck) {
      try {
        const spontaneous = await maybeHandleSpontaneousRentedStatement({
          session, text: t, senderPhone, chatId, replyMsgId: payload?.id || null,
        })
        if (spontaneous?.handled) return true
      } catch (err) { log.warn('[av] spontaneous rented check failed', { err: err.message }) }
    }
  }
  return false
}

// ── Board-triggered owner availability check (Schedule Board "Fall A") ──────
//
// Same owner-write path as `!av`, but triggered from the CRM Schedule Board
// instead of a WhatsApp chat. Differences from runAvCommand():
//
//   - There is no requester chat to talk back into, so every outcome is
//     RETURNED as a structured object for the HTTP caller to turn into a
//     toast, instead of being sent as chat text.
//   - The requesting agent's own WhatsApp number is recorded as the
//     requester, so the existing follow-up machinery (postToRequester)
//     echoes the owner's eventual reply straight to that agent. Agents with
//     no phone on file simply get no echo — postToRequester no-ops on a
//     NULL requester_chat_id.
//
// Everything else — same-day spam guard, "account that last talked to this
// owner" selection, availability_checks row, armed follow-ups — is the
// identical path `!av` takes, deliberately reused rather than reimplemented.
//
// dryRun: resolve the full plan (owner, sending account, message text) and
// return it WITHOUT sending anything and WITHOUT writing a check row. This
// is the default for the board until SCHEDULE_BOARD_FALL_A_LIVE=1 is set,
// so a mis-wired button cannot message a real owner.
// `source` distinguishes a robot check from a human one ('manual' = !av or the
// board button, 'auto_reachout' = the >60h staleness scan). The scan counts its
// own unanswered attempts with it, so it must be recorded, not inferred.
//
// Kev 2026-08-22: env-configurable, not hardcoded, so the window can be
// retuned (.env + restart) without a code change. Default 12h, his number.
// Kev, 2026-09-11: bumped 12 -> 30 to match the Schedule Board card's own
// freshness gauge (page.tsx FRESH_HOURS) — a card the board still shows as
// "fresh/green" should answer the same "is it still available?" question
// instantly rather than the owner getting pinged again for a window the UI
// itself is telling the agent is still trustworthy.
const FRESH_CONFIRM_HOURS = Number(process.env.AV_FRESH_CONFIRM_HOURS) || 30

// `force` (Kev, 2026-09-11): the Schedule Board's "Still Available" button
// escalation path — the agent already got "already_checked_today" once and
// deliberately chose to ask again anyway. Every other guard (no_owner,
// no_owner_phone, no_account, and the fresh-confirmation shortcut above)
// still applies exactly as before; force only lifts the once-a-day refusal.
async function requestOwnerAvailability({
  ref, requester = {}, dryRun = false, source = 'manual', force = false, urgent = false, confirmed = false,
}) {
  const prop = await resolveProperty(ref)
  if (!prop) return { ok: false, status: 'not_found', ref }

  // ARGUS OWNER + PROPERTY STATE FINAL PASS, item 2 (chat-aware pre-send
  // check): the property's own canonical state outranks every other reason
  // to send. Before this, nothing on this shared send path refused a rented/
  // archived listing at all — only availabilityReachout.js's own candidate
  // SQL filtered those out, which protects the automated 60h-stale scan but
  // not a manual !av or a Schedule Board click on a ref that is already
  // marked rented/archived in the CRM. That is exactly "do not ask 'still
  // available?' when the owner already said rented/unavailable" — the owner
  // already answered, whether that answer came in through this same flow or
  // through the new spontaneous-statement path below.
  if (['rented', 'archived'].includes(prop.available_status)) {
    return {
      ok: false, status: `already_${prop.available_status}`, ref: prop.ref,
      message: `#${prop.ref} is already marked ${prop.available_status} — no message sent to the owner.`,
    }
  }

  // Kev, 2026-09-14 (far-future availability guardrail): >100 days out no
  // longer blocks outright — it needs an explicit confirmation first,
  // surfaced to the agent as a CHECK ANYWAY / CANCEL prompt (status
  // 'confirm_required' below), same idiom the board already uses for
  // "already asked today" (`force`). `confirmed` is deliberately its own
  // flag, not reused from `force` — the two mean different things (asking
  // again vs. asking something this far out at all) and an agent should be
  // able to hit one without silently tripping the other.
  const daysOut = daysUntilAvailable(prop.available_date)
  if (!confirmed && !force && isFarFuture(prop.available_date)) {
    return {
      ok: false, status: 'confirm_required', ref: prop.ref,
      availableDate: prop.available_date, daysUntilAvailable: daysOut,
      message: `#${prop.ref} is only expected to become available in ${daysOut} days ` +
        `(${prop.available_date}). Are you sure you want to ask the owner already?`,
    }
  }

  // ── Kev 2026-08-22: fresh-confirmation shortcut, checked FIRST ────────────
  // The board already knows this listing was confirmed available inside the
  // last FRESH_CONFIRM_HOURS — either an owner's own !av "yes" (onStillAvailable
  // -> boardAction.checkIn) or a manual board check-in click; both write the
  // same last_confirmed_available_at, and both are real confidence the
  // listing is still on. Asking the owner again inside that window is exactly
  // the double-ping this exists to avoid, so answer the requester straight
  // away and never touch the owner chat. Not gated on prop.owner_id — a
  // confirmed listing answers instantly even if the owner link is stale.
  if (prop.last_confirmed_available_at
      && !['rented', 'archived'].includes(prop.available_status)
      && (Date.now() - new Date(prop.last_confirmed_available_at).getTime()) <= FRESH_CONFIRM_HOURS * 3600_000) {
    let requesterChatId = requester.realPhone
      ? toChatId(requester.realPhone)
      : (requester.phone ? toChatId(requester.phone) : null)
    // Same board-only-agent fallback notifyOpenRequesters uses further down —
    // this instant path never reaches that function, so it needs its own copy.
    if (!requesterChatId && requester.agentId) {
      try {
        const a = await db.query(`SELECT notify_whatsapp FROM agents WHERE id = $1`, [requester.agentId])
        const nw = a.rows[0] && a.rows[0].notify_whatsapp
        if (nw) requesterChatId = toChatId(nw)
      } catch (err) {
        log.warn('[av] fresh-shortcut notify_whatsapp lookup failed', { ref: prop.ref, err: err.message })
      }
    }
    const needsReview = !requesterChatId
    const text = withAvailableActions(
      `Apartment #${prop.ref} is available${prop.town ? ` in ${prop.town}` : ''}.`, prop.ref)

    const ins = await db.query(
      `INSERT INTO availability_checks
         (property_id, owner_id, account_session, requester_chat_id, requester_phone,
          requester_session, requester_message_id, owner_chat_id, sent_at, status, source,
          requester_agent_id, needs_review, reply_at, notified_at, reply_text)
       VALUES ($1,$2,'skipped_fresh',$3,$4,$5,$6,NULL,NOW(),'replied_available',$7,$8,$9,NOW(),NOW(),$10)
       RETURNING id`,
      [prop.id, prop.owner_id || null, requesterChatId,
       requester.realPhone || requester.phone || null, requester.session || null,
       requester.messageId || null, source, requester.agentId || null, needsReview,
       `shortcut — board already showed available as of ${prop.last_confirmed_available_at.toISOString()}`])
    const checkId = ins.rows[0].id

    if (dryRun) {
      return {
        ok: true, status: 'dry_run', ref: prop.ref, checkId, via: 'fresh_shortcut',
        message: `DRY RUN — board confirmed available ${FRESH_CONFIRM_HOURS}h ago or less; would answer ` +
          `the requester instantly and NOT contact the owner.`,
      }
    }

    // Fire-and-forget copy into the admin request dashboard. The owner was
    // NOT contacted here (that's the point of the shortcut), so there is no
    // account_session to show as the handling profile — dashboardReport
    // renders that slot as 'unbekannt'.
    dashboardReport.reportRequest({
      requesterName: requester.name || null, requesterPhone: requester.realPhone || requester.phone || null,
      ref: prop.ref, action: 'availability', ownerId: prop.owner_id || null, accountSession: null,
      requesterAgentId: requester.agentId || null,
    }).catch(() => {})

    if (requesterChatId) {
      try {
        const session = await pickAgentAlertSession()
        if (session) {
          const tagged = await botTag.forAgent(text, { toPhone: requesterChatId })
          await sendTextAs(session, requesterChatId, tagged)
          if (requester.messageId) {
            const rs = (await resolveLiveSession(requester.session)) || requester.session
            await reactAs(rs, requester.messageId, '👍').catch(() => {})
          }
        } else {
          log.warn('[av] fresh-shortcut notify skipped — no working account', { checkId, ref: prop.ref })
        }
      } catch (err) {
        log.warn('[av] fresh-shortcut notify failed', { checkId, ref: prop.ref, err: err.message })
      }
    } else {
      // Same review-queue alert notifyOpenRequesters raises for "no dest" —
      // never fall back to whatever chat !av was typed in.
      try {
        const to = config.admin.botNumber
        if (to) {
          const adminSession = await pickAdminSession()
          if (adminSession) {
            await waha.sendText(adminSession, toChatId(to),
              `⚠️ #${prop.ref} — fresh-confirmed available (shortcut), but the requesting agent's ` +
              `private number is unknown. Nothing was posted to the group. availability_checks id ${checkId}.`)
          }
        }
        await db.query(`UPDATE availability_checks SET review_alerted_at = NOW() WHERE id = $1`, [checkId])
      } catch (err) {
        log.warn('[av] fresh-shortcut review alert failed', { checkId, ref: prop.ref, err: err.message })
      }
    }

    log.info('[av] fresh-confirmation shortcut used — owner not contacted', {
      checkId, ref: prop.ref, confirmedAt: prop.last_confirmed_available_at, windowHours: FRESH_CONFIRM_HOURS,
    })
    return {
      ok: true, status: 'sent', ref: prop.ref, checkId, via: 'fresh_shortcut',
      message: `Owner confirmed available within the last ${FRESH_CONFIRM_HOURS}h — answered instantly, owner not asked again.`,
    }
  }

  // Spam protection: an availability check for this property already went
  // out today (from the board OR from !av — same table, same guard).
  // account_session='skipped_fresh' rows (the shortcut above) never actually
  // contacted the owner, so they must not count here — a second agent asking
  // the same day would otherwise get "already contacted" instead of the
  // instant answer the fresh-confirmation shortcut exists to give them (it
  // never reaches this query in that case, since the shortcut check above
  // runs first and re-fires — this guard is what stalks a REAL owner-contact
  // row from earlier in the day, e.g. once the freshness window has expired).
  const today = await db.query(
    `SELECT * FROM availability_checks
      WHERE property_id = $1 AND sent_at >= date_trunc('day', NOW())
        AND account_session <> 'skipped_fresh'
      ORDER BY id DESC LIMIT 1`, [prop.id])
  const todayCheck = today.rows[0] || null
  if (todayCheck && !force) {
    return {
      ok: false, status: 'already_checked_today', ref: prop.ref,
      checkId: todayCheck.id, checkStatus: todayCheck.status,
      // Told up front so the board can offer "ask again anyway" without a
      // second round trip — repliedBefore decides which of the two
      // escalation lines goes out if the agent takes that option.
      repliedBefore: !!todayCheck.reply_at,
      message: `Owner already contacted today for #${prop.ref} — not messaged again.`,
    }
  }

  if (!prop.owner_id) return { ok: false, status: 'no_owner', ref: prop.ref }

  // PRE-SEND HARD GATE (2026-09-21): DNC, "a human is handling this owner",
  // HUMAN_REVIEW_REQUIRED after a complaint, !ca — an agent's !av / board request
  // must not put a fresh question in front of an owner in any of those states. The
  // refusal goes to the requester ("owner_paused"), nothing goes to the owner.
  {
    const gate = await ownerSendGate.checkOwnerSend({ ownerId: prop.owner_id, propertyId: prop.id, kind: 'check' })
    if (!gate.allow) {
      log.info('[av] owner check refused — pre-send gate', { ref: prop.ref, reason: gate.reason })
      return {
        ok: false, status: 'owner_paused', ref: prop.ref, reason: gate.reason,
        message: `#${prop.ref} — not asked: ${ownerSendGate.describeBlock(gate.reason)}. It is with a person / on hold; nothing went to the owner.`,
      }
    }
  }
  const owner = await ownerPhone(prop.owner_id, prop.listed_by_phone)
  if (!owner?.phone_normalized) return { ok: false, status: 'no_owner_phone', ref: prop.ref }

  const picked = await pickSourceSession(prop.owner_id)
  if (!picked.dbSession) {
    return {
      ok: false, status: 'no_source_session', ref: prop.ref, reason: picked.reason, tried: [],
      message: `#${prop.ref} — no Kev WhatsApp account (${[...new Set([...FIRST_CONTACT_ACCOUNTS, ...LAST_RESORT_ACCOUNTS])].join(', ')}) is online right now. Nothing was sent — try again once one is back.`,
    }
  }

  const ownerChatId = toChatId(owner.phone_normalized)
  // The chat to answer in. Kev 2026-08-21: NEVER `requester.chatId` — that is
  // whatever chat the command was typed in, a GROUP more often than not, and
  // the owner's answer must never land somewhere every colleague can forward
  // it. `requester.realPhone` (handlers/av.js, LID-resolved fresh from the
  // WhatsApp payload) is the requester's own private number and the only
  // thing this is allowed to answer into. `requester.phone` stays as the
  // board / auto-reachout / batch-script path's own real number — those
  // callers have no chat to derive from in the first place and are unaffected
  // by this change. A requester with neither (a group !av from a sender
  // WhatsApp gave us no phone alt for) gets requesterChatId = null; the check
  // still goes to the owner, but notifyOpenRequesters() below routes the
  // answer to a review queue instead of ever falling back to the group.
  const requesterChatId = requester.realPhone
    ? toChatId(requester.realPhone)
    : (requester.phone ? toChatId(requester.phone) : null)

  // What to say is decided at SEND time (executeOwnerCheck), from these options —
  // that way a check that had to wait for its source session composes its text
  // against the chat as it is when it actually goes out, not as it was hours ago.
  const opts = {
    urgent: !!urgent,
    escalation: (force && todayCheck)
      ? { fromCheckId: todayCheck.id, repliedBefore: !!todayCheck.reply_at }
      : null,
  }

  if (dryRun) {
    log.info('[av] board Fall-A DRY RUN — nothing sent', {
      ref: prop.ref, via: picked.session || `${picked.dbSession} (offline — would queue)`, agent: requester.name || requester.agentId,
    })
    const plan = await composeCheckText({ prop, ownerChatId, session: picked.session, opts: { ...opts, firstContact: !!picked.firstContact } })
    return {
      ok: true, status: 'dry_run', ref: prop.ref,
      plan: {
        wouldMessageOwnerId: prop.owner_id,
        viaAccount: picked.dbSession,
        sourceOnline: !!picked.session,
        wouldQueue: !picked.session,
        text: plan.textToSend,
        variantId: plan.chosen.variantId,
        chatScan: plan.scan.ok ? {
          ourMessagesInWindow: plan.scan.ourMessageCount,
          hoursSinceWeWrote: plan.scan.hoursSinceOutbound,
          hoursSinceTheyWrote: plan.scan.hoursSinceInbound,
          ownerWroteLast: plan.scan.ownerWroteLast,
        } : { unavailable: true },
        echoRepliesTo: requesterChatId ? 'requesting agent' : null,
      },
      message: picked.session
        ? `Dry run — would message the owner of #${prop.ref} via ${picked.session}. Nothing was sent.`
        : `Dry run — the owner's source account (${picked.dbSession}) is offline; the check would be queued for it. Nothing was sent.`,
    }
  }

  // ONE pending check per property (and, for the robot, per owner) — claimed under
  // an advisory lock so a double-click, or the scanner racing an agent, cannot both
  // get through. The row is the claim; everything after this point works on it.
  const claim = await claimOwnerCheck({
    prop, picked, ownerChatId, requester, requesterChatId, checkSource: source, opts, force,
  })
  if (claim.duplicate) {
    const d = claim.duplicate
    log.info('[av] duplicate check suppressed', { ref: prop.ref, pendingId: d.id, pendingStatus: d.status, source, sameDay: !!claim.sameDay })
    if (claim.sameDay) {
      return {
        ok: false, status: 'already_checked_today', ref: prop.ref, checkId: d.id, checkStatus: d.status,
        repliedBefore: !!d.reply_at,
        message: `Owner already contacted today for #${prop.ref} — not messaged again.`,
      }
    }
    return {
      ok: false, status: 'already_pending', ref: prop.ref, checkId: d.id, checkStatus: d.status,
      message: d.status === WAITING
        ? `#${prop.ref} — a check is already queued and will go out as soon as the owner's account is back online. Not queued twice.`
        : `#${prop.ref} — a check to the owner is already in progress. Not sent twice.`,
    }
  }

  // Source offline at claim time → the row is already 'queued'; nothing to execute now.
  const done = claim.status === WAITING ? { status: WAITING } : await executeOwnerCheck(claim.id, { fromClaim: true })

  if (done.status === WAITING) {
    return {
      ok: true, status: WAITING, ref: prop.ref, checkId: claim.id, via: picked.dbSession,
      message: `The owner of #${prop.ref} is reached through ${picked.dbSession}, which is offline right now. ` +
        `The check is queued and goes out the moment that same account reconnects — it is not sent from any other account.`,
    }
  }
  if (done.status === 'send_failed') {
    return { ok: false, status: 'send_failed', ref: prop.ref, via: done.via || picked.dbSession, error: done.error }
  }
  if (done.status === 'owner_paused') {
    return {
      ok: false, status: 'owner_paused', ref: prop.ref, reason: done.reason,
      message: `#${prop.ref} — not asked: ${ownerSendGate.describeBlock(done.reason)}. It is with a person / on hold; nothing went to the owner.`,
    }
  }
  if (done.status !== 'sent') {
    log.error('[av] check ended in an unexpected state', { ref: prop.ref, checkId: claim.id, done })
    return { ok: false, status: 'send_failed', ref: prop.ref, checkId: claim.id, error: `unexpected state: ${done.status}` }
  }
  return {
    ok: true, status: 'sent', ref: prop.ref, checkId: claim.id, via: done.via,
    message: `Availability check sent to the owner of #${prop.ref} via ${done.via}.`,
  }
}

// ── compose (shared by dry-run and the real send) ───────────────────────────
async function composeCheckText({ prop, ownerChatId, session, opts = {} }) {
  // read the chat before writing into it (Kev's rule, 2026-08-16): we are not the
  // only writer in an owner chat, so the sentence is chosen with the recent history
  // in hand — never the same line twice in a row, no "Good morning" in the
  // afternoon. READ-ONLY and soft: a failed/impossible scan degrades to the plain
  // wording, it never stops the message.
  let scan = { ok: false, ourMessageCount: 0 }
  if (session) {
    try { scan = await ownerChatScan.scanOwnerChat({ session, chatId: ownerChatId }) } catch { /* soft */ }
  }
  const esc = opts.escalation
  const chosen = opts.firstContact
    ? { text: MSG_OWNER_FIRST_CONTACT_NEUTRAL, variantId: 'first_contact_intro', reason: 'first_contact', repeat: false }
    : esc
    ? (esc.repliedBefore
        ? { text: MSG_OWNER_ESCALATE_REPLIED, variantId: 'escalate_replied', reason: 'escalate_force', repeat: true }
        : { text: MSG_OWNER_ESCALATE_NOT_REPLIED, variantId: 'escalate_not_replied', reason: 'escalate_force', repeat: true })
    : ownerMessageVariants.pickVariant('availability_check', { scan })
  // Kev, 2026-09-14 (spec item 5 + 6): every outbound text gets the same
  // ref/locality/price tag and the same optional urgent line, applied once here.
  const textToSend = composeOwnerCheckText(chosen.text, prop, { urgent: !!opts.urgent })
  return { scan, chosen, textToSend }
}

// ── one pending check per property / owner ──────────────────────────────────
// 'queued'  waiting for its source session         (blocks: always)
// 'sending' a send is in flight                    (blocks: while fresh — a crash
//           mid-send leaves this behind, so it stops blocking after 10 minutes and
//           the reaper in flushQueuedChecks marks it for review)
// 'awaiting' asked, no answer yet                  (blocks the ROBOT for 14 days;
//           an agent's manual ask is governed by the existing once-a-day rule, so
//           asking again the next day still works exactly as before)
// The state of a check whose source WhatsApp session is offline: kept, never dropped and
// never rerouted; sent automatically when that exact session is WORKING again.
const WAITING = 'waiting_for_source_session'
const AUTO_SOURCES = new Set(['auto_inactivity', 'auto_reachout'])
const AWAITING_BLOCKS_ROBOT_DAYS = 14
const SENDING_STALE_MINUTES = 10

async function claimOwnerCheck({ prop, picked, ownerChatId, requester, requesterChatId, checkSource, opts, force = false }) {
  const robot = AUTO_SOURCES.has(String(checkSource))
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    // fixed order (owner, then property) so two claimers can never deadlock. The owner lock
    // is taken for EVERY source: it also serialises the first-contact binding below.
    await client.query('SELECT pg_advisory_xact_lock(7312, $1::int)', [prop.owner_id])
    await client.query('SELECT pg_advisory_xact_lock(7311, $1::int)', [prop.id])

    const pend = await client.query(
      `SELECT id, status, property_id, owner_id FROM availability_checks
        WHERE account_session <> 'skipped_fresh'
          AND (property_id = $1 OR ($3::boolean AND owner_id = $2))
          AND ( status = '${WAITING}'
             OR (status = 'sending' AND COALESCE(updated_at, created_at) > NOW() - ($4 || ' minutes')::interval)
             OR ($3::boolean AND status = 'awaiting'
                 AND COALESCE(sent_at, created_at) > NOW() - ($5 || ' days')::interval) )
        ORDER BY id DESC LIMIT 1`,
      [prop.id, prop.owner_id, robot, String(SENDING_STALE_MINUTES), String(AWAITING_BLOCKS_ROBOT_DAYS)])
    if (pend.rows.length) {
      await client.query('ROLLBACK')
      return { duplicate: pend.rows[0] }
    }
    // The once-a-day rule, re-checked HERE under the lock: two requests can both pass the
    // early check in requestOwnerAvailability before either has written a row, and a fast
    // first send leaves nothing 'sending' for the second to bump into.
    if (!force) {
      const today = await client.query(
        `SELECT id, status, reply_at FROM availability_checks
          WHERE property_id = $1 AND sent_at >= date_trunc('day', NOW()) AND account_session <> 'skipped_fresh'
          ORDER BY id DESC LIMIT 1`, [prop.id])
      if (today.rows.length) {
        await client.query('ROLLBACK')
        return { duplicate: today.rows[0], sameDay: true }
      }
    }

    // FIRST CONTACT — an owner nobody has ever written to has no source session. The one
    // chosen by pickSourceSession (an explicitly allowed, WORKING outreach account; never
    // default, never Jasmine) becomes their source PERMANENTLY: the label row is written
    // here, under the owner lock, so every later check — manual or robot, on any of their
    // listings — finds it as the source and waits for it if it is offline. If another
    // claim bound this owner a moment ago, that binding wins.
    let pk = picked
    let firstContact = false
    if (picked.firstContact && picked.dbSession) {
      const ex = await client.query(
        `SELECT wa.session_name FROM owner_account_labels oal
           JOIN whatsapp_accounts wa ON LOWER(wa.session_name) = LOWER(oal.account_session) AND wa.is_active = true
          WHERE oal.contact_id = $1
            AND (oal.source = 'first_contact' OR oal.last_outreach_at IS NOT NULL OR oal.last_reply_at IS NOT NULL OR oal.last_we_sent_at IS NOT NULL)
          ORDER BY oal.created_at ASC LIMIT 1`, [prop.owner_id])
      if (ex.rows.length) {
        const name = ex.rows[0].session_name
        let live = null
        try { live = await resolveLiveSession(name) } catch { live = null }
        pk = { ...picked, dbSession: name, session: live, firstContact: false }
      } else {
        await client.query(
          `INSERT INTO owner_account_labels (contact_id, account_session, label, source, notes)
           VALUES ($1, $2, 'cold', 'first_contact', 'bound as source session by availability first contact')
           ON CONFLICT (contact_id, account_session) DO NOTHING`, [prop.owner_id, picked.dbSession])
        firstContact = true
        log.info('[av] first contact — owner bound to a source session', { ownerId: prop.owner_id, session: picked.dbSession })
      }
    }

    // Kev 2026-08-21: flag rows with no private reply channel so
    // notifyOpenRequesters() can alert Kev instead of silently closing them —
    // the "review queue" for a group !av whose sender resolved to a LID only.
    const needsReview = !requesterChatId && !robot
    const status = pk.session ? 'sending' : WAITING
    const ins = await client.query(
      `INSERT INTO availability_checks
         (property_id, owner_id, account_session, requester_chat_id, requester_phone,
          requester_session, requester_message_id, owner_chat_id, sent_at, status, source,
          requester_agent_id, needs_review, queued_at, queue_reason, queued_opts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9::text,$10,$11,$12,
               CASE WHEN $9::text = '${WAITING}' THEN NOW() END,
               CASE WHEN $9::text = '${WAITING}' THEN 'WAITING_FOR_SOURCE_SESSION' END,
               $13::jsonb)
       RETURNING id`,
      [prop.id, prop.owner_id,
       // the SOURCE session (canonical casing) — the follow-ups and the send both
       // resolve it case-insensitively against WAHA, and a waiting check must remember
       // exactly which account it is waiting for.
       pk.dbSession,
       requesterChatId,
       requester.realPhone || requester.phone || null,
       // requester_session is the account that will have to react on the asking
       // agent's message, so it is theirs — not the owner account. Falls back to the
       // source account for the robot, which has no requester at all.
       requester.session || pk.dbSession,
       // The agent's own request message, so reactOnRequest() can put the 👍/👎
       // verdict on it.
       requester.messageId || null,
       ownerChatId, status, checkSource,
       // Website (board) requests carry the logged-in agent's id — see migration 021.
       requester.agentId || null, needsReview,
       JSON.stringify({ ...(opts || {}), firstContact, requesterName: requester.name || null })])
    await client.query('COMMIT')
    return { id: ins.rows[0].id, status, source: pk.dbSession, firstContact }
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* already rolled back */ }
    throw err
  } finally {
    client.release()
  }
}

// ── the one send path ───────────────────────────────────────────────────────
// Used by the board button, by !av (via requestOwnerAvailability), by the 7-9 day
// robot AND by the queue flush. A check is always sent by the session it was
// claimed for (check.account_session) and by no other: offline → it stays
// 'waiting_for_source_session' (or goes back to it), send error → it does NOT fail over
// to another account.
//
// ROBOT CHECKS (source auto_inactivity) are ONE polite question and then silence: no
// 30-minute call ping, no next-morning follow-up (see processAvailabilityJob, which also
// refuses them). A robot check that waited for its session is dropped if anyone
// touched the owner in the meantime — the timer restarted, so the check is no longer due.
const MAX_SEND_ATTEMPTS = 3
const NO_FOLLOWUP_SOURCES = new Set(['auto_inactivity'])

async function executeOwnerCheck(checkId, { fromClaim = false } = {}) {
  let row
  if (fromClaim) {
    row = (await db.query(`SELECT * FROM availability_checks WHERE id = $1 AND status = 'sending'`, [checkId])).rows[0]
  } else {
    // atomic waiting → sending: two flushers (or a flusher and the reaper) cannot both send
    row = (await db.query(
      `UPDATE availability_checks SET status = 'sending', updated_at = NOW()
        WHERE id = $1 AND status = '${WAITING}' RETURNING *`, [checkId])).rows[0]
  }
  if (!row) return { status: 'skipped', reason: 'not_claimable' }

  const opts = row.queued_opts || {}
  const attempts = Number(opts.attempts || 0)
  const backToWaiting = async (why) => {
    await db.query(
      `UPDATE availability_checks
          SET status = '${WAITING}', queued_at = COALESCE(queued_at, NOW()), queue_reason = $2,
              queued_opts = COALESCE(queued_opts, '{}'::jsonb) || $3::jsonb, updated_at = NOW()
        WHERE id = $1`, [checkId, String(why).slice(0, 120), JSON.stringify({ attempts: attempts + (why === 'WAITING_FOR_SOURCE_SESSION' ? 0 : 1) })])
    return { status: WAITING, reason: why }
  }
  const finish = async (status, why) => {
    await db.query(
      `UPDATE availability_checks SET status = $2, queue_reason = $3, updated_at = NOW() WHERE id = $1`,
      [checkId, status, String(why || '').slice(0, 160)])
  }

  // the property, as resolveProperty() reads it (composeOwnerCheckText needs these)
  const pr = await db.query(
    `SELECT id, ref, owner_id, available_status, published, town, bedrooms, listed_by_phone,
            last_confirmed_available_at, available_date, longlet_price
       FROM properties WHERE id = $1`, [row.property_id])
  const prop = pr.rows[0]
  if (!prop) { await finish('cancelled', 'property_gone'); return { status: 'skipped', reason: 'property_gone' } }

  // The source session — the one stored on the check, never re-picked. Offline (or
  // WAHA unreachable) means WAIT.
  let session = null
  try { session = await resolveLiveSession(row.account_session) } catch { session = null }
  if (!session || isExcludedSession(row.account_session)) {
    return backToWaiting('WAITING_FOR_SOURCE_SESSION')
  }

  const robot = AUTO_SOURCES.has(String(row.source))

  // A robot check that sat in the queue: is the owner STILL silent? Anything since it was
  // queued (Kev/an agent typing, a software message, an owner reply, a request) restarted
  // the 7-9 day timer — asking now would break the "shut up for 7-9 days" rule.
  if (robot && !fromClaim && row.queued_at) {
    const c = await db.query(
      `SELECT (${require('./contactTouch').lastContactSql('oc', 'p')}) > ($3::timestamptz + interval '2 seconds') AS touched
         FROM owner_contacts oc JOIN properties p ON p.id = $1 WHERE oc.id = $2`,
      [row.property_id, row.owner_id, row.queued_at])
    if (c.rows[0] && c.rows[0].touched) {
      await finish('cancelled', 'contact_since_queued')
      log.info('[av] waiting robot check dropped — owner was contacted meanwhile', { checkId, ref: prop.ref })
      return { status: 'cancelled', reason: 'contact_since_queued' }
    }
  }

  // PRE-SEND HARD GATE, re-read at the last moment. A check that waited for its
  // session may now face a DNC, a human taking over, a contact pause, or a listing
  // that was rented in the meantime — the immediate path is refused at the top of
  // requestOwnerAvailability already, this is the same rule for the delayed one.
  const gate = await ownerSendGate.checkOwnerSend({
    ownerId: row.owner_id, propertyId: row.property_id, kind: (robot || !fromClaim) ? 'followup' : 'check',
    automated: robot || !fromClaim,
  })
  if (!gate.allow) {
    await finish('cancelled', `gate:${gate.reason}`)
    log.info('[av] check cancelled at send time — pre-send gate', { checkId, ref: prop.ref, reason: gate.reason })
    return { status: 'owner_paused', reason: gate.reason }
  }

  const ownerChatId = row.owner_chat_id
  const plan = await composeCheckText({ prop, ownerChatId, session, opts })
  log.info('[av] owner text chosen', {
    ref: prop.ref, variant: plan.chosen.variantId, why: plan.chosen.reason,
    repeat: plan.chosen.repeat, scanOk: plan.scan.ok, oursInChat: plan.scan.ourMessageCount,
    hSinceOurs: plan.scan.hoursSinceOutbound, ownerWroteLast: plan.scan.ownerWroteLast,
    via: session, source: row.source, waited: !fromClaim,
  })

  let sent
  try {
    // failover:false — this owner's conversation stays on this account
    sent = await sendTextAs(session, ownerChatId, plan.textToSend, null, { failover: false })
  } catch (err) {
    log.error('[av] owner check send failed', { checkId, ref: prop.ref, session, err: err.message })
    if (!fromClaim && attempts + 1 < MAX_SEND_ATTEMPTS) return backToWaiting(`send_failed: ${err.message}`)
    await finish('send_failed', err.message)
    return { status: 'send_failed', via: session, error: err.message.slice(0, 200) }
  }

  const upd = await db.query(
    `UPDATE availability_checks
        SET status = 'awaiting', sent_at = NOW(), account_session = $2, updated_at = NOW(), queue_reason = NULL
      WHERE id = $1 RETURNING id`, [checkId, session])
  if (!upd.rows.length) log.warn('[av] check row vanished after send', { checkId })

  // robot: one question, then wait for the owner. Everything else gets the usual pair
  // (call ping after 30 min if unanswered, a message at 09:00 next morning).
  if (!NO_FOLLOWUP_SOURCES.has(String(row.source))) await scheduleFollowUps(checkId)

  // Fire-and-forget copy into the admin request dashboard. Covers the board
  // (Fall A) path AND every automated source — the shared tail of every send.
  dashboardReport.reportRequest({
    requesterName: opts.requesterName || null, requesterPhone: row.requester_phone || null,
    ref: prop.ref, action: 'availability', ownerId: row.owner_id, accountSession: session,
    requesterAgentId: row.requester_agent_id || null,
  }).catch(() => {})

  log.info('[av] check sent', {
    checkId, ref: prop.ref, ownerId: row.owner_id, via: session, source: row.source, waitedInQueue: !fromClaim,
    followUps: !NO_FOLLOWUP_SOURCES.has(String(row.source)), firstContact: !!opts.firstContact,
    ownerMsgId: (sent?.id || sent?.key?.id || '').slice(-16),
  })
  return { status: 'sent', via: session }
}

// ── the queue: checks waiting for their source session ──────────────────────
// Runs from cron (every 2 min). A waiting check is released ONLY when the session it
// is waiting for is live again — there is no timeout that reroutes it. Manual checks go
// out at the next tick after the reconnect. ROBOT checks additionally obey the robot's
// own rails when they are released — the arming flag, the 08-20 Malta window, the shared
// daily cap and 2 per tick — so an account coming back after days offline cannot dump
// its whole backlog on owners at once; what does not fit simply keeps waiting.
// Also reaps 'sending' rows a crash left behind: whether that message went out is
// unknowable, so it is marked for review, never re-sent.
let _flushing = false
const ROBOT_RELEASE_PER_TICK = 2
async function flushQueuedChecks({ limit = 5, gapMs = null, robotGate = null } = {}) {
  const out = { released: 0, stillWaiting: 0, reaped: 0, errors: 0, robotHeld: 0 }
  if (_flushing) return { ...out, skipped: 'already_running' }
  _flushing = true
  try {
    const reaped = await db.query(
      `UPDATE availability_checks
          SET status = 'send_failed', queue_reason = 'stale_sending (crash mid-send — not resent, check chat)', updated_at = NOW()
        WHERE status = 'sending' AND COALESCE(updated_at, created_at) < NOW() - ($1 || ' minutes')::interval
        RETURNING id`, [String(SENDING_STALE_MINUTES)])
    out.reaped = reaped.rowCount || 0

    // manual rows first, so robot rows held outside the window can never starve them
    const q = await db.query(
      `SELECT id, account_session, source FROM availability_checks
        WHERE status = '${WAITING}'
        ORDER BY (source IN ('auto_inactivity', 'auto_reachout')) ASC, queued_at ASC NULLS FIRST, id ASC LIMIT 60`)

    // the robot's rails, evaluated once per tick (injectable for tests)
    let robotRoom = 0
    if (q.rows.some(r => AUTO_SOURCES.has(String(r.source)))) {
      const gate = robotGate ? await robotGate() : await (async () => {
        const reach = require('./availabilityReachout')
        const sched = await reach.getSchedule()
        const sent = await reach.sentToday()
        return { open: reach.ARMED && sched.dailyCap > 0 && reach.insideWindow(), room: Math.max(0, sched.dailyCap - sent) }
      })()
      robotRoom = gate.open ? Math.min(gate.room, ROBOT_RELEASE_PER_TICK) : 0
    }

    let manualReleased = 0
    for (const c of q.rows) {
      const isRobot = AUTO_SOURCES.has(String(c.source))
      if (isRobot ? robotRoom <= 0 : manualReleased >= limit) { if (isRobot) out.robotHeld++; else out.stillWaiting++; continue }
      let live = null
      try { live = await resolveLiveSession(c.account_session) } catch { live = null }
      if (!live) { out.stillWaiting++; continue }
      try {
        const r = await executeOwnerCheck(c.id)
        if (r.status === 'sent') { out.released++; if (isRobot) robotRoom--; else manualReleased++ }
        else if (r.status === WAITING) out.stillWaiting++
      } catch (err) {
        out.errors++
        log.error('[av] waiting check release failed', { checkId: c.id, err: err.message })
      }
      // never a burst: a re-connected account must not fire its whole backlog at once
      await sleep(gapMs != null ? gapMs : 20_000 + Math.floor(Math.random() * 20_000))
    }
  } catch (err) {
    log.error('[av] flushQueuedChecks failed', { err: err.message })
    out.errors++
  } finally {
    _flushing = false
  }
  if (out.released || out.reaped || out.errors) log.info('[av] queue flush', out)
  return out
}


module.exports = {
  handleWebhookMessage,
  processAvailabilityJob,
  requestOwnerAvailability,
  notifyOpenRequesters,
  // handlers/av.js:isFreshlyConfirmed() mirrors the shortcut check above so
  // !av can skip the Yes/No prompt for a fact the board already knows.
  FRESH_CONFIRM_HOURS,
  // exported for tests / diagnostics
  handleOwnerReply,
  // P0 sender/context firewall helpers — pure pieces are exported so the
  // phone-card, stale-event and transport-id regressions stay testable.
  inboundEventMs, isContactOrTransportOnly, verifiedInboundOwnerPhone,
  // ARGUS item 1 — exported for direct testing without a live webhook.
  isUnambiguousRentedStatement, maybeHandleSpontaneousRentedStatement,
  applyRentedVerdictFromOwnerChat, onPropertyIdentityReply,
  // services/bookRelay.js:sendToAgentPrivate() needs the same DB-name→live-
  // WAHA-session mapping this module already owns, for the same default-
  // account rule (Kev 2026-08-21, item 5).
  resolveLiveSession,
  // default -> Kevsecond -> kevthirdd picker for admin-facing sends with no
  // specific preferred session (2026-08-25). bookRelay.js's two admin-alert
  // call sites (sendToAgentPrivate, ~L346 and ~L823) still call bare
  // resolveLiveSession(session1 || 'default') with no further fallback —
  // that file was off-limits for this task (patched separately today) but
  // switching those two call sites to av.pickAdminSession() is the direct
  // follow-up once it's safe to touch again.
  pickAdminSession,
  classifyReply, extractTimeframe, extractTimeframeDetail, asksAboutClient,
  resolveProperty, pickOwnerAccount, pickSourceSession,
  // 2026-09-22: the one send path, the queue for offline source sessions, the shared
  // session exclusion (Jasmine) — services/availabilityReachout.js + cron + tests.
  executeOwnerCheck, flushQueuedChecks, claimOwnerCheck, isExcludedSession, EXCLUDED_SESSIONS, WAITING, FIRST_CONTACT_ACCOUNTS,
  liveSessions, __resetLiveSessionCache: () => { _liveSessionCache = { names: null, ts: 0 } },
  // CRITICAL OWNER FLOW FIX (2026-09-16): exported for direct testing of the
  // viewing/move-in-date reply classifiers independently of a live webhook.
  classifyViewingReply, onViewingReply, onMoveInDateReply,
  callPingSupport, msUntilNextMorning, reactAngryInPropertyGroups,
  cancelFacebookJobs, replyUnderListing, renderStatus, QUEUE_NAME,
  __reactOnRequest: reactOnRequest, __reactAs: reactAs, __sendTextAs: sendTextAs,
  // Every fixed sentence this module can put in an OWNER chat.
  //
  // services/bookRelay.js:humanTookOver() needs it. That function decides "did
  // Kev type this himself?" by looking for a fromMe message in the owner chat
  // that the relay did not send — and an owner chat is shared ground: this
  // module writes into it too, from a different code path with its own ids.
  // On 2026-08-16 a delayed 'still available' question was therefore read as Kev
  // taking over, and the relay collapsed from 5 messages to 1 on its first run.
  //
  // These are literal constants, so matching on them is exact, not a guess.
  // ownerMessageVariants.ALL_TEXTS is spread in FIRST-CLASS, not as an extra:
  // since 2026-08-16 the sentence actually sent is picked from there, so a list
  // that held only the five originals would make every VARIANT look like a
  // human interjection to bookRelay and kill the relay mid-conversation. If you
  // add a variant, this is the line that must already cover it — and it does,
  // because it enumerates the whole table rather than naming sentences.
  OWNER_TEXTS: [
    MSG_OWNER_CHECK, MSG_OWNER_MORNING, MSG_OWNER_RENTED_THANKS,
    MSG_OWNER_STILL_AVAILABLE, MSG_STILL_ON_MARKET, MSG_OWNER_FIRST_CONTACT,
    MSG_OWNER_ESCALATE_NOT_REPLIED, MSG_OWNER_ESCALATE_REPLIED,
    // 2026-09-15: onStillAvailable's two new split-out variants (see
    // decideStillAvailableFollowUp) go into the SAME owner chat MSG_OWNER_
    // STILL_AVAILABLE always did — they need to be in this list for exactly
    // the reason above, or bookRelay misreads one as Kev typing.
    MSG_OWNER_VIEWING_WINDOW_ONLY, MSG_OWNER_ENTRANCE_DATE_ONLY,
    ...MSG_OWNER_CLARIFY,
    ...ownerMessageVariants.ALL_TEXTS,
  ],
  // exported for tests — the pure branch behind onStillAvailable's
  // "what do we actually still need to ask" decision.
  decideStillAvailableFollowUp,
}
