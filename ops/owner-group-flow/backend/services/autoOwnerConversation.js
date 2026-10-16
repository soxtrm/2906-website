'use strict'
// services/autoOwnerConversation.js — Auto-Owner-Conversation after
// Outreach/Foutreach (2026-08-29).
//
// Scope (hard gate, checked on every inbound owner DM before anything else
// in this file runs):
//   1. phone must have an OPEN outreach_log row (conversation_state IN
//      ('cold','active')) — i.e. an active Outreach/Foutreach cycle.
//   2. Kev, 2026-08-30: phone must either be on the fake-owner test allowlist
//      (config.automation.testNumbers, for an isolated single-number test)
//      OR AUTOMATION_LIVE=1 must be set (armed for every real owner reply).
//      Before this, only the allowlist ever applied -- AUTOMATION_TEST_NUMBERS
//      being unset meant NOTHING fired for anyone, real or test.
//   3. automation must not be globally paused (!cancela) or cancelled for
//      this one chat (!ca).
//   4. once a conversation reaches a terminal state (declined /
//      ready_for_kev / cancelled_*) the bot NEVER speaks in that chat again.
//
// Timing: every bot reaction is delayed 1-2 minutes (Kev, 2026-09-01 —
// was 3-5 minutes until this revision) and debounced — a
// second owner message arriving before the delay fires cancels the queued
// job and reschedules from the new message, so the bot always answers the
// owner's most recent, most complete text rather than a truncated one.
//
// This is additive: it never returns `consumed=true` to the webhook, so the
// existing owner-DM pipeline (reminderFromMessage, label engine, avCapture,
// rented detection) keeps running exactly as before.

const db = require('../db')
const { v2: cloudinary } = require('cloudinary')
const log = require('../logger')
const config = require('../config')
const waha = require('../waha')
const { addJob, QUEUES } = require('../queues')
const reminderFromMessage = require('./reminderFromMessage')
const { resolveAgentIdentity, agencyAnswer } = require('./agentIdentityRegistry')
const styleLearning = require('./styleLearning')
const unwatermark = require('./unwatermark')
const ownerPreferenceProfile = require('./ownerPreferenceProfile')
const { resolveSenderIdentity } = require('./outreachIdentity')

// Kev, 2026-09-01 (his "neue genauere Vorgabe", DELAY BUG prompt): 1-2
// minutes, replacing the original 3-5 minute target -- still relaxed and
// human-feeling, just tighter than before.
const DELAY_MIN_MS = 1 * 60_000
const DELAY_MAX_MS = 2 * 60_000

// Kev, 2026-08-31: an outreach/conversation this old is a DIFFERENT
// situation, not a continuation -- an owner texting back months later must
// not silently resume (or start) an automated flow. Applied both to how far
// back we'll accept an outreach_log row as "still open" (findOpenOutreach)
// and to how long an active_collecting conversation may sit idle before it
// is treated as expired (getOpenConversation) rather than resumed.
// A started owner intake is durable. Disconnects and overnight gaps must not
// discard the checklist; the four-day limit remains only on starting a new
// intake from an outreach row (findOpenOutreach below).
const SESSION_MAX_AGE_MS = null

// Kev, 2026-08-30: MUST-have basics first (price/beds/baths/locality, then
// the two date questions — "available from" and "when viewable" are
// deliberately separate fields, never merged, since they answer different
// things), THEN the optional extras. "Insurance" is gone — never asked.
// Photos kept in its old spot (right after the MUST fields, "wie bisher":
// skipped automatically once the owner's already sent them) rather than
// folded into either of Kev's two explicit lists.
const MUST_FIELDS = ['price', 'bedrooms', 'bathrooms', 'town', 'available_date', 'viewable_date']
const COMMERCIAL_MUST_FIELDS = ['town', 'commercial_use', 'permit_info']
const SALE_MUST_FIELDS = ['price', 'town', 'size_sqm']
const ROOM_MUST_FIELDS = ['price', 'town', 'available_date']
// Owner-AI judgement fix (real bug: "Warehouse available" got asked "How
// many bedrooms?"): bedrooms/bathrooms only make sense for a residential
// property. property_category defaults to unset -- meaning "not yet
// known, assume residential" (today's overwhelmingly common case, so
// nothing changes for it) -- and only actually skips these two fields
// once the owner's own words say "commercial" (extractPropertyCategory /
// the Gemini classifier's propertyCategory field). Never guessed the
// other way -- a residential listing is never treated as commercial
// without the owner having said so.
const RESIDENTIAL_ONLY_FIELDS = new Set(['bedrooms', 'bathrooms'])
function mustFieldsFor(checklist) {
  // Sales and commercial leads are captured as internal drafts immediately.
  // Their catalog is intentionally different from the residential-rent
  // interview; missing facts stay UNKNOWN for dashboard completion rather
  // than triggering monthly-rent/move-in/subletting questions.
  if (checklist?.listing_kind === 'room') return ROOM_MUST_FIELDS
  if (checklist?.property_category === 'commercial') return COMMERCIAL_MUST_FIELDS
  if (checklist?.transaction_type === 'sale') return SALE_MUST_FIELDS
  return MUST_FIELDS
}
function fieldOrderFor(checklist) {
  if (checklist?.listing_kind === 'room') return [...ROOM_MUST_FIELDS, 'photos', 'map', 'pets', 'sharing']
  if (checklist?.property_category === 'commercial') return [...COMMERCIAL_MUST_FIELDS, 'size_sqm', 'photos', 'plans', 'map']
  if (checklist?.transaction_type === 'sale') return [...SALE_MUST_FIELDS, 'condition', 'development_stage', 'photos', 'plans', 'map']
  return [...mustFieldsFor(checklist), ...OPTIONAL_FIELDS]
}
// Kev, 2026-09-01 (Gestufte Fragen-Priorität): 'photos' + 'map' are Stage 1/2
// (photos is MUST-adjacent, map is "almost always ask"); 'pets'/'sharing' are
// Stage 3 (gated on cooperation, see optionalFieldEligible below);
// 'subletting' is Stage 4 (rare, last-question-only, gated even harder).
const OPTIONAL_FIELDS = ['photos', 'map', 'pets', 'sharing', 'subletting']

function randomDelayMs() {
  return Math.floor(Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS + 1)) + DELAY_MIN_MS
}

// ── GOLDEN-SCRIPT (Kev, 2026-09-06): Kev's own four annotated real
// conversations, used as the ground-truth spec for exact bot wording on the
// three terminal short-flow outcomes below. Fall 1 (decline) and Fall 2
// (future deferral) previously both routed through the same randomized
// politeClosing() pool -- indistinguishable wording for two situations Kev
// wants read completely differently by whoever reviews the chat later.
// These three are now fixed, exact strings (no rotation), one per Fall.
const FALL1_DECLINE_TEXT =
  'No worries, thank you for your feedback, please keep me posted regarding updates, have a good evening'
const FALL2_FUTURE_FOLLOWUP_TEXT =
  'Thank you for your feedback, if you may could give me some more details, so I can already prepare some clients for it, that would be great!'
const FALL3_NEEDS_HUMAN_TEXT =
  'Thank you for your feedback, I am currently on appointments, I will be coming back later to you'

// Business/identity questions are answered before intake, from the persona of
// the account that actually sends. Recipient history never chooses a name or
// biography. Kevin's wording is explicitly approved; Cedric keeps his existing
// Quicklets answer. Gabriela has her own conservative session answer so her
// account never inherits Kevin's four-year biography by accident.
const AGENCY_QUESTION_RE = /\b(which agency|what agency|which company|what company|who do you work for|whom do you (?:work for|represent)|which agents?|are you (?:an? )?(?:agent|freelancer)|do you work (?:independently|for))\b/i
const CEDRIC_AGENCY_ANSWER = "I'm with Quicklets."
const KEVIN_AGENCY_ANSWER =
  "I work independently with 2906 Estate. I've worked in real estate for four years and have been a freelancer for the past year. " +
  "We're building a collective of around 30 agents who share property opportunities and work together to help clients find the right home."
const GABRIELA_AGENCY_ANSWER = 'I work independently with 2906 Estate.'

async function approvedAgencyAnswer(session) {
  return agencyAnswer(resolveAgentIdentity(session))
}

// ── FALL 3 (Kev, 2026-09-06, GOLDEN-SCRIPT) -- completely new. A voice
// note, an inbound call, or an explicit "call me" request are all read the
// same way: this is not something the bot can meaningfully continue with in
// text, so it acknowledges once, marks the chat unread (the same "I need
// this personally" signal Point I's frustration handler already uses) and
// stops -- never a 2-round retry like the generic 'unclear' intent below,
// because there is nothing genuinely ambiguous to retry: a voice note is
// not text the bot can re-read more carefully next time.
//
// Deliberately narrow on the text side -- an explicit request to be called,
// not a general "this message is confusing" guess (that's still the
// existing unclearCount/countUnclearSignals machinery's job, unchanged).
const CALL_REQUEST_RE = /\b(call me|please call|can you call|could you call|give me a call|ring me|call her|call him|phone me)\b/i
function looksLikeNeedsHumanContact({ text, isVoiceNote } = {}) {
  if (isVoiceNote) return true
  return CALL_REQUEST_RE.test(String(text || ''))
}

function isTestNumber(phone) {
  const list = config.automation?.testNumbers || []
  return list.includes(String(phone))
}

function isAutomationLive() {
  return config.automation?.live === true
}

async function isGloballyPaused() {
  try {
    const r = await db.query(`SELECT value FROM automation_control WHERE key = 'global_paused'`)
    return r.rows[0]?.value === true
  } catch (err) {
    log.warn('isGloballyPaused check failed, treating as paused (fail-safe)', { err: err.message })
    return true
  }
}

async function setGlobalPause(paused, updatedBy) {
  await db.query(
    `INSERT INTO automation_control (key, value, updated_at, updated_by)
     VALUES ('global_paused', $1, NOW(), $2)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW(), updated_by = $2`,
    [paused, updatedBy || null]
  )
}

// ── Scope check ──────────────────────────────────────────────────────────
// Kev, 2026-08-31: age-bounded on purpose (see SESSION_MAX_AGE_MS) -- an
// outreach_log row left 'cold'/'active' from weeks ago must not silently
// count as "open" just because nobody ever closed it out.
// Kev, 2026-09-08 (real race found while wiring up FB Direct From Owner
// Convert & TODO): this used to match ANY outreach_log row regardless of
// message_type -- including the 'fb_owner_lead' rows
// services/fbOwnerSave.js's own sendLeadIntro() now writes. Without this
// exclusion, an FB lead's very first reply ("yes"/"no"/a fee question) was
// being picked up TWICE: once by fbOwnerSave.js's own deliberate yes/no/
// commission classifier, and independently by THIS file starting a full
// checklist conversation on top of it -- two systems answering the same
// owner message, exactly the class of conflict this codebase's own history
// (see the countless dated comments in this file) already knows to avoid.
// fbOwnerSave.js hands off to this checklist engine deliberately, on its
// own schedule (only after a genuine "yes"), by inserting its own fresh,
// differently-typed outreach_log row when it is ready -- never implicitly
// via this generic match.
const EXCLUDED_MESSAGE_TYPES = ['fb_owner_lead']
async function findOpenOutreach(phone) {
  const r = await db.query(
    `SELECT id, conversation_state, account_used, sent_at FROM outreach_log
     WHERE phone = $1 AND conversation_state IN ('cold','active')
       AND sent_at > NOW() - INTERVAL '4 days'
       AND COALESCE(message_type, '') != ALL($2::text[])
     ORDER BY sent_at DESC LIMIT 1`,
    [phone, EXCLUDED_MESSAGE_TYPES]
  )
  return r.rows[0] || null
}

// Kev, 2026-08-31 (Prompt 4 — CRITICAL scope fix). Real incident: Kev ran
// !av on a property (a spontaneous check, no outreach involved), the owner
// replied "Studio yes", Kev himself typed the follow-up (viewing + move-in
// date) -- and the automation jumped in on top of Kev's own manually-run
// conversation. Root cause: findOpenOutreach() only asks "does phone X have
// an outreach_log row from within 4 days", which says nothing about
// whether the OWNER'S CURRENT MESSAGE is actually answering THAT outreach
// pitch versus answering !av / !book / !ask / something Kev typed by hand
// in the same WhatsApp chat -- WhatsApp has no separate threads, so a reply
// to a totally different command can land right next to an old outreach.
//
// The only ground truth for "is this really still the outreach thread" is
// the actual WhatsApp history: has ANYONE on our side sent this phone
// anything AFTER the outreach pitch, other than the pitch itself? If yes --
// an !av check, a !book/!ask message, or Kev typing manually -- the owner's
// reply belongs to THAT, not to the automated outreach flow, and the
// automation must stay completely silent (Point 1+2 of the new hard rule:
// outreach/foutreach in the last 4 days AND the owner's genuine first
// contact back).
//
// Kev, 2026-09-01 (real incident): this used to call waha.getChatMessages(),
// which swallows its own errors into [] -- a WAHA hiccup then read as "no
// history found" and resolved PERMISSIVE (true). During the `default`
// session's restart-loop that evening (SCAN_QR_CODE/FAILED, 19:2x-19:4x
// logs) that silently let the bot ask an owner a checklist question right
// after Kevin had already called and voice-noted them by hand in the same
// chat -- the fetch failed, came back empty, and the gate below read that as
// "nobody's said anything since the pitch" instead of "couldn't check".
// Now uses getChatMessagesStrict() so a fetch failure is fail-CLOSED (NOT
// first reply -- automation stays silent) rather than fail-open, and tells
// an admin so a genuinely missed automation opportunity isn't just silence.
async function isFirstReplyToOutreach(phone, session, outreachSentAt) {
  const chatId = `${phone}@c.us`
  let msgs
  try {
    msgs = await waha.getChatMessagesStrict(session, chatId, 30)
  } catch (err) {
    log.warn('isFirstReplyToOutreach: chat history fetch failed, failing closed (no automation)', {
      phone: String(phone).slice(-4), session, err: err.message,
    })
    notifyAdminEscalation(session, phone,
      'skipped automation -- could not verify chat history',
      `WAHA error: ${err.message}. If you haven't already replied to this owner yourself, they won't get an automated reply either -- check the chat manually.`
    ).catch(() => {})
    return false
  }
  const sentAtMs = new Date(outreachSentAt).getTime()
  // 30s grace: the pitch's own send can itself land a few seconds after
  // outreach_log.sent_at was written, and must not count against itself.
  const laterOutbound = (msgs || []).filter(m => m.fromMe && (Number(m.timestamp) * 1000) > sentAtMs + 30_000)
  return laterOutbound.length === 0
}

// Kev, 2026-08-31: also expires a conversation that has simply gone idle too
// long (owner stopped replying mid-checklist, then picks it back up much
// later) -- SESSION_EXPIRED rather than silently resuming a stale flow.
// Every caller in this file goes through here, so the expiry check only
// needs to live in one place.
// Kev, 2026-08-31 (real incident: "Olga Test", an internal contact whose
// number got a test outreach pitch back in April, was still getting asked
// checklist questions today -- 140 days after that outreach). Root cause:
// the conversation row was created by the PRE-fix code, before this file's
// 4-day age limit existed at all, so it was never subject to it. The idle
// check alone did not catch it either -- she kept (confusedly) replying, so
// last_owner_message_at kept refreshing and the row never looked "idle".
// Fix: re-validate the UNDERLYING outreach's age on every single call, not
// just at creation. This makes the age limit self-healing going forward --
// any conversation that predates a future tightening of this rule (or that
// slipped through some other way) gets closed the very next time anyone
// touches it, including the owner's own next reply, instead of silently
// grandfathering in whatever existed when the rule was added.
async function getOpenConversation(phone) {
  const r = await db.query(
    `SELECT oac.*, ol.sent_at AS outreach_sent_at
       FROM owner_auto_conversations oac
       LEFT JOIN outreach_log ol ON ol.id = oac.outreach_log_id
      WHERE oac.phone = $1 AND oac.status IN ('active_collecting', 'awaiting_auto_publish')
      ORDER BY oac.id DESC LIMIT 1`,
    [phone]
  )
  const convo = r.rows[0] || null
  if (!convo) return null

  const lastActivity = convo.last_owner_message_at || convo.created_at
  const idleTooLong = false
  const outreachTooOld = false

  if (idleTooLong || outreachTooOld) {
    await cancelPendingJob(convo.pending_job_id)
    const reason = outreachTooOld
      ? 'underlying outreach is older than the 4-day session-gate limit (retroactive re-validation)'
      : 'idle more than 4 days'
    await db.query(
      `UPDATE owner_auto_conversations SET status='session_expired', cancelled_reason=$1, updated_at=NOW() WHERE id=$2`,
      [reason, convo.id]
    )
    return null
  }
  return convo
}

// ── CRM pre-check (Point F) ─────────────────────────────────────────────
// Before ever asking a checklist question, see whether this owner already
// has exactly one property on file. Only ever pre-fills from an UNAMBIGUOUS
// match (never guesses between several listings for the same owner) --
// whatever it fills in is then simply never missing, so nextMissingField
// never asks for it.
async function findExistingProperty(phone) {
  const owner = await db.query('SELECT id FROM owner_contacts WHERE phone_normalized = $1', [phone])
  const ownerId = owner.rows[0]?.id
  if (!ownerId) return null
  const props = await db.query(
    `SELECT id, town, street, bedrooms, bathrooms, longlet_price, available_date, images
       FROM properties WHERE owner_id = $1 AND lifecycle_state != 'archived'
       ORDER BY updated_at DESC LIMIT 2`,
    [ownerId]
  )
  if (props.rows.length === 1) return props.rows[0]
  // Kev, 2026-09-10 (Schritt 2 D, dedup-before-collection-start audit): an
  // owner with 2+ existing non-archived properties used to return null here
  // -- IDENTICAL to "no existing property at all" -- so a fresh collection
  // started with no _crm_property_id set, and armAutoPublish's own
  // duplicate guard (which only checks that one field) had nothing to catch
  // it on. If the owner was describing one of their EXISTING listings again,
  // a finished checklist would sail straight through the normal auto-publish
  // timer and create a genuine duplicate property row. upload.createListing's
  // own street/text-similarity check is a backstop, not a guarantee (it was
  // tuned for FB-post-shaped text, not a checklist card). This can't safely
  // guess WHICH of the owner's properties is meant -- so it returns a distinct
  // marker instead, which the caller below turns into the same "stay manual,
  // no auto-publish timer" treatment _crm_property_id already gets, rather
  // than silently falling through as if this were a brand-new owner.
  if (props.rows.length > 1) return { _ambiguousMultiple: true, count: props.rows.length }
  return null
}

function checklistFromExistingProperty(existing) {
  // Deliberately NOT reusing _crm_property_id here -- that field is a real
  // properties.id elsewhere (writeDraftProperty runs a plain UPDATE ... WHERE
  // id = checklist._crm_property_id on it), so a sentinel string there would
  // crash that query with an invalid-integer error the moment the checklist
  // finishes. A separate flag, checked alongside _crm_property_id wherever
  // "stay manual, do not auto-publish" is decided.
  if (existing._ambiguousMultiple) {
    return { _multi_property_owner_ambiguous: true, _prefilled_from_crm: false,
             notes: [`Owner already has ${existing.count} other active listings -- check this isn't a duplicate before publishing.`] }
  }
  const checklist = { _crm_property_id: existing.id, _prefilled_from_crm: true }
  if (existing.town) checklist.town = existing.town
  if (existing.bedrooms != null) checklist.bedrooms = existing.bedrooms
  if (existing.bathrooms != null) checklist.bathrooms = existing.bathrooms
  if (existing.longlet_price != null) checklist.price = Number(existing.longlet_price)
  if (Array.isArray(existing.images) && existing.images.length > 0) checklist.photos = true
  return checklist
}

// ── Debounced scheduling ─────────────────────────────────────────────────
async function cancelPendingJob(jobId, queueName = 'auto-conversation') {
  if (!jobId) return
  try {
    const job = await QUEUES[queueName].getJob(jobId)
    if (job) await job.remove()
  } catch (err) {
    log.debug('cancelPendingJob: remove failed (likely already run)', { err: err.message, queueName })
  }
}

async function scheduleStep(conversationId, phone, session) {
  const delay = randomDelayMs()
  const job = await addJob('auto-conversation', { conversationId, phone, session }, { delay })
  await db.query(
    `UPDATE owner_auto_conversations SET pending_job_id = $1, updated_at = NOW() WHERE id = $2`,
    [String(job.id), conversationId]
  )
}

// ── Main entry — called from routes/webhook.js for every inbound owner DM.
// Never throws, never blocks the caller's pipeline; always fire-and-forget
// from the caller's side.
async function handleOwnerReply({ phone, text, session, hasMedia, mediaMimeType, payload }) {
  // Kev, 2026-08-31 (Prompt 2 T12): a media-only reply (photos, no caption)
  // must still register -- previously requiring non-empty `text` meant 10
  // photos with no caption never reached this file at all, so the bot went
  // on to ask "do you have pictures?" right after receiving them.
  if (!phone || (!text && !hasMedia)) return
  if (await isGloballyPaused()) return
  if (!isAutomationLive() && !isTestNumber(phone)) return

  let convo = await getOpenConversation(phone)

  // Kev, 2026-09-09 (timer-buffer correction): a checklist that already
  // finished and got its AV CENTRAL preview card posted is sitting in
  // 'awaiting_auto_publish' with a delayed publish job ticking down. If the
  // owner writes again in that window it is a genuine late correction ("Ich
  // hab grad gesagt 2 bedroom, sind aber 3") -- cancel the timer, reopen the
  // SAME conversation as 'active_collecting' so processStep's normal claim
  // gate (status='active_collecting') picks it up unchanged, merges the new
  // info, and re-evaluates completeness. If it comes out complete again, the
  // existing `finished` block below fires again exactly as it would the
  // first time -- fresh corrected card, fresh timer. No separate code path
  // needed for "restart with corrected info": it's the same code, run twice.
  if (convo && convo.status === 'awaiting_auto_publish') {
    await cancelPendingJob(convo.checklist?._publish_job_id, 'owner-auto-publish')
    const reopenedChecklist = { ...(convo.checklist || {}) }
    delete reopenedChecklist._publish_job_id
    delete reopenedChecklist._publish_armed_at
    await db.query(
      `UPDATE owner_auto_conversations SET status='active_collecting', checklist=$1, updated_at=NOW() WHERE id=$2`,
      [JSON.stringify(reopenedChecklist), convo.id]
    )
    convo.status = 'active_collecting'
    convo.checklist = reopenedChecklist
    log.info('autoOwnerConversation: late owner message during auto-publish buffer -- timer cancelled, checklist reopened', { phone: phone.slice(-4) })
  }

  if (!convo) {
    // HUMAN_REVIEW_REQUIRED (2026-09-21): an owner who complained about the
    // automation is not restarted by a fresh outreach cycle — a new conversation row
    // would supersede the stand-down marker (every gate reads the LATEST row) and
    // silently resume. Only a human clearing the marker resumes it.
    const standDownReason = await require('./ownerSendGate').getStandDownReason(phone)
    if (standDownReason === 'human_review_required' || standDownReason === 'permanent_owner_stop') return

    // Only ever START a conversation while an Outreach/Foutreach cycle for
    // this phone is genuinely open.
    const outreach = await findOpenOutreach(phone)
    if (!outreach) return

    // Kev, 2026-08-31 (Prompt 3 Point C, fixing a real bug in an earlier
    // version of this gate) -- ONE automated conversation per outreach
    // cycle, EVER, scoped to the specific outreach_log_id, not the phone.
    // Regardless of how that conversation ended (declined / ready_for_kev
    // / human_paused / cancelled_chat / automation_failure_paused / ...),
    // it never restarts against the SAME outreach row just because that
    // row is still within its age window -- an earlier version of this
    // check excluded human-override statuses from a phone-wide block, but
    // that let a new conversation reopen on the SAME still-open outreach
    // cycle seconds after Kevin took over, exactly the "silently resumes"
    // behaviour Point C explicitly forbids. Scoping to outreach_log_id
    // instead makes it correct AND simpler: a genuinely NEW/fresh outreach
    // cycle later (a different outreach_log_id, e.g. a fresh !foutreach)
    // is a different row and is therefore never blocked by this at all --
    // "the chat is Kevin's" only for THIS cycle, never a permanent
    // blacklist of the phone.
    const alreadyHandled = await db.query(
      `SELECT 1 FROM owner_auto_conversations WHERE outreach_log_id = $1 LIMIT 1`,
      [outreach.id]
    )
    if (alreadyHandled.rows.length) return

    // Prompt 4, Point 2 of the hard rule: the owner's message must be the
    // genuine first contact back on THIS outreach -- not an answer to !av
    // / !book / !ask / a manual message Kev already sent in this same chat.
    if (!(await isFirstReplyToOutreach(phone, session, outreach.sent_at))) return

    const existing = await findExistingProperty(phone)
    const initialChecklist = existing ? checklistFromExistingProperty(existing) : {}

    const ins = await db.query(
      `INSERT INTO owner_auto_conversations (phone, session, outreach_log_id, status, checklist)
       VALUES ($1, $2, $3, 'active_collecting', $4::jsonb) RETURNING *`,
      [phone, session, outreach.id, JSON.stringify(initialChecklist)]
    )
    convo = ins.rows[0]
  }

  // Debounce: fold this message into the pending batch, cancel any job
  // already queued, and reschedule fresh from now. A media-only message
  // (no caption) queues a "[media]" (photo/video), "[voice]" (voice note --
  // GOLDEN-SCRIPT Fall 3, 2026-09-06), or "[document]" (PDF/Excel/other
  // file) sentinel so processStep still sees that something arrived this
  // turn -- [media] feeds the photos field, [document] routes to the
  // external-source hand-off (Point E), [voice] routes to the Fall-3
  // needs-human hand-off -- never treated as a photo or a document.
  await cancelPendingJob(convo.pending_job_id)
  let checklist = convo.checklist || {}
  const isVoiceNote = !!mediaMimeType && String(mediaMimeType).startsWith('audio/')
  const isImage = !!mediaMimeType && String(mediaMimeType).startsWith('image/')
  const mediaSentinel = isVoiceNote
    ? '[voice]'
    : (mediaMimeType && !isImage ? '[document]' : '[media]')
  // Kev, 2026-09-09 (same multi-photo-batch race, applied to _pending/
  // _last_message_id): these used to only be mutated on the in-memory
  // `checklist` object and land in the wholesale combined UPDATE at the
  // bottom of this function -- exactly the race that used to silently drop
  // photos also silently dropped a `_pending` entry (or reverted
  // `_last_message_id` to an older message) whenever two owner messages
  // were handled concurrently. Same fix: an atomic DB-side jsonb_set right
  // here, reading the row's CURRENT value at write time, and excluded from
  // the JS object that goes into the later merge write.
  const pendingEntry = text || mediaSentinel
  checklist._pending = [...(checklist._pending || []), pendingEntry]
  // Kev, 2026-09-08: the message id of the owner's OWN latest turn -- used
  // once the checklist completes to react with a checkmark on the exact
  // message that finished it, not an arbitrary/older one.
  if (payload?.id) checklist._last_message_id = payload.id
  await db.query(
    `UPDATE owner_auto_conversations
        SET checklist = jsonb_set(
              ${payload?.id ? `jsonb_set(COALESCE(checklist, '{}'::jsonb), '{_last_message_id}', to_jsonb($3::text), true)` : `COALESCE(checklist, '{}'::jsonb)`},
              '{_pending}',
              COALESCE(checklist->'_pending', '[]'::jsonb) || to_jsonb($2::text), true)
      WHERE id = $1`,
    payload?.id ? [convo.id, pendingEntry, payload.id] : [convo.id, pendingEntry]
  )

  // Kev, 2026-09-08 (Owner-zu-Upload-Vollautomatisierung): the [media]
  // sentinel above only ever flagged "a photo arrived" for the question-
  // flow (checklist.photos) -- the actual image was never downloaded or
  // stored anywhere, which is fine as long as a human always re-opens
  // WhatsApp and re-uploads by hand later, but is the actual blocker for
  // ever handing a COMPLETE checklist straight to AV CENTRAL with real
  // photos attached. Persisted here, additively, into checklist._photos --
  // never replaces the existing photos:true/[media] mechanics, which stay
  // exactly as they were for the question-flow's own purposes. Cleaned
  // through the SAME Unwatermark pre-check/removal pipeline the rest of the
  // upload path uses (services/unwatermark.js) -- credits are only ever
  // spent when a watermark is actually detected. A failure here (bad
  // image, Cloudinary hiccup, Unwatermark down) must never break the
  // conversation itself, so it's a soft try/catch, not a hard dependency.
  if (isImage && payload) {
    try {
      const { getMsgImages, uploadBuffer } = require('../handlers/uploadListing')
      const images = await getMsgImages(payload)
      for (const img of images) {
        const cleaned = await unwatermark.cleanImageIfWatermarked(img.buffer, img.mimeType).catch(() => ({ buffer: img.buffer, mimeType: img.mimeType }))
        const url = await uploadBuffer(cleaned.buffer, cleaned.mimeType)
        if (url) {
          checklist._photos = [...(checklist._photos || []), url]
          // Kev, 2026-09-09 (multi-photo batch race): an owner selecting several
          // photos to send "all at once" fires one webhook per image in quick
          // succession, so two handleOwnerReply calls for the SAME conversation
          // can run concurrently, both starting from the SAME getOpenConversation
          // snapshot. Before this fix the only write was the combined UPDATE at
          // the bottom of this function, which replaced the whole checklist
          // column wholesale -- whichever call's write landed last won, silently
          // erasing every photo the other concurrent call(s) had just persisted.
          // jsonb_set here reads the row's CURRENT _photos at write time, so a
          // photo already committed by a concurrent call is never lost even if
          // this call's own in-memory `checklist` snapshot never saw it.
          await db.query(
            `UPDATE owner_auto_conversations
                SET checklist = jsonb_set(COALESCE(checklist, '{}'::jsonb), '{_photos}',
                      COALESCE(checklist->'_photos', '[]'::jsonb) || to_jsonb($2::text), true)
              WHERE id = $1`,
            [convo.id, url]
          )
        }
      }
    } catch (e) {
      log.warn('autoOwnerConversation: owner photo persistence failed', { err: e.message })
    }
  }

  // FILE-FIRST INTAKE (Kev, 2026-09-22 hotfix): a document (PDF/Excel/
  // scanned listing/etc, anything that isn't an image or a voice note) gets
  // read HERE, immediately, the same place photos get downloaded -- before
  // Point E further down (in processStep) ever sees the `[document]`
  // sentinel and decides whether to ask about it. Fields extracted here are
  // merged into the SAME in-memory `checklist` that flows into the combined
  // UPDATE at the bottom of this function, so they are already on the row
  // by the time processStep picks the next question to ask -- a field the
  // PDF already answered is never asked again, with zero changes to the
  // question-selection logic itself. `_file_extracted` / `_file_unreadable`
  // are read by Point E below to decide whether it still needs to hand off
  // for manual review or can stay quiet.
  if (!isImage && !isVoiceNote && mediaMimeType && payload) {
    try {
      const { getMsgDocument } = require('../handlers/uploadListing')
      const doc = await getMsgDocument(payload)
      if (doc && doc.buffer && doc.buffer.length && doc.buffer.length <= MAX_DOCUMENT_BYTES) {
        const fileResult = await extractFromFileAttachment(doc.buffer, doc.mimeType)
        if (fileResult.readable && fileResult.extracted) {
          checklist = mergeExtracted(checklist, fileResult.extracted, null)
          checklist._file_extracted = true
          if (String(doc.mimeType || '').toLowerCase().includes('pdf')) {
            if (fileResult.prominentContactDetails) {
              checklist._plan_blocked_contact_details = true
              checklist.plans = 'received — excluded because prominent contact details were detected'
            } else {
              const uploaded = await cloudinary.uploader.upload(
                `data:${doc.mimeType};base64,${doc.buffer.toString('base64')}`,
                { folder: '2906-property-plans', resource_type: 'auto', use_filename: true })
              if (uploaded?.secure_url) {
                checklist._plans = [...(checklist._plans || []), uploaded.secure_url]
                checklist.plans = true
              }
            }
          }
        } else {
          checklist._file_unreadable = true
        }
      } else {
        // No media URL/data on the payload, or the file is too large to
        // send inline -- same outcome as a failed read: Point E asks the
        // owner once for it instead of silently interrogating field by
        // field.
        checklist._file_unreadable = true
      }
    } catch (err) {
      log.warn('autoOwnerConversation: document extraction failed', { err: err.message })
      checklist._file_unreadable = true
    }
  }

  // _photos, _pending and _last_message_id are deliberately left OUT of this
  // payload and merged with `||` instead of a wholesale `=` replace: all
  // three are already durably persisted, field by field, in the atomic
  // jsonb_set calls above. Replacing the whole column here (the old
  // behaviour) would silently overwrite whichever of them a concurrent call
  // for the same conversation committed after this call's own `checklist`
  // snapshot was taken -- exactly the race described above, just moved one
  // write later.
  const { _photos, _pending, _last_message_id, ...checklistForMerge } = checklist
  await db.query(
    `UPDATE owner_auto_conversations
        SET checklist = COALESCE(checklist, '{}'::jsonb) || $1::jsonb,
            last_owner_message_at = NOW(), updated_at = NOW()
      WHERE id = $2`,
    [JSON.stringify(checklistForMerge), convo.id]
  )
  await scheduleStep(convo.id, phone, session)
}

// ── FALL 3, call variant (Kev, 2026-09-06, GOLDEN-SCRIPT) ────────────────
// A genuine inbound WhatsApp call, as opposed to the voice-note/call-me-text
// variants above which arrive through the normal message pipeline. Bypasses
// the debounce/pending queue entirely -- a call is an instant, singular
// fact, there is nothing to batch it with. Same scope rule as
// handleOwnerReply (open outreach or open active_collecting conversation
// only) so this never fires for a call from someone we have no active
// automated thread with.
//
// NOTE (2026-09-06): WAHA's session `events` array (waha.js) only requests
// ['message', 'message.reaction', 'session.status'] today -- 'call.received'
// is NOT actually subscribed, despite routes/webhook.js's own header
// comment claiming it's "enabled per-session". This function and its
// webhook.js wiring are ready for the day that's turned on, but changing a
// live WAHA session's event subscription risks the same class of incident
// as the 2026-08-29 restart loop / 2026-09-0x "backend restart logged out
// default" (see project memory) -- deliberately NOT done here without Kev's
// explicit go-ahead, since it touches live WhatsApp auth sessions. Until
// then, this path is reachable only if WAHA already emits the event for
// some sessions independent of that array (unconfirmed).
async function handleOwnerCallEvent({ phone, session }) {
  if (!phone) return
  if (await isGloballyPaused()) return
  if (!isAutomationLive() && !isTestNumber(phone)) return

  let convo = await getOpenConversation(phone)
  if (!convo) {
    if ((await require('./ownerSendGate').getStandDownReason(phone)) === 'human_review_required') return
    const outreach = await findOpenOutreach(phone)
    if (!outreach) return
    if (!(await isFirstReplyToOutreach(phone, session, outreach.sent_at))) return
    const alreadyHandled = await db.query(
      `SELECT 1 FROM owner_auto_conversations WHERE outreach_log_id = $1 LIMIT 1`, [outreach.id])
    if (alreadyHandled.rows.length) return
    const ins = await db.query(
      `INSERT INTO owner_auto_conversations (phone, session, outreach_log_id, status, checklist)
       VALUES ($1, $2, $3, 'active_collecting', '{}'::jsonb) RETURNING *`,
      [phone, session, outreach.id])
    convo = ins.rows[0]
  }

  await cancelPendingJob(convo.pending_job_id)
  const gate = await sendGate(convo.id, phone, session)
  if (!gate.allow) return
  await waha.sendText(session, phone, FALL3_NEEDS_HUMAN_TEXT)
  const checklist = { ...(convo.checklist || {}), _log: [...((convo.checklist || {})._log || []), { from: 'bot', text: FALL3_NEEDS_HUMAN_TEXT, at: new Date().toISOString() }] }
  await db.query(
    `UPDATE owner_auto_conversations SET status='needs_human_contact', checklist=$1, cancelled_reason='inbound call -- needs Kev personally', last_bot_message_at=NOW(), updated_at=NOW() WHERE id=$2`,
    [JSON.stringify(checklist), convo.id]
  )
  await db.query(`UPDATE outreach_log SET conversation_state='done' WHERE phone=$1 AND conversation_state IN ('cold','active')`, [phone])
  await waha.markChatUnread(session, phone)
  await notifyAdminEscalation(session, phone, 'NEEDS YOU PERSONALLY — inbound call, left unread', null)
}

// ── Human override (Point B) ─────────────────────────────────────────────
// Called from routes/webhook.js for a genuine self-typed message in an
// owner's DM thread -- Kevin or another admin account taking the chat over
// manually, WITHOUT using the explicit !ca command. Before this, any such
// message was silently dropped by the webhook's fromMe/notes-chat guards
// with zero effect on the automation: it kept auto-asking right past
// whatever Kevin had already explained by hand. The caller is the only
// place responsible for telling this apart from the bot's OWN echoed
// messages (via waha.wasSentByBackend) -- this function assumes that has
// already been done and treats every call as a real human message.
async function handleFromMeMessage(phone, text) {
  if (!phone) return
  const convo = await getOpenConversation(phone)
  if (!convo) return // no active automation in this chat -- nothing to override

  await cancelPendingJob(convo.pending_job_id)
  await db.query(
    `UPDATE owner_auto_conversations SET status='human_paused', automation_disabled=TRUE, cancelled_reason=$1, updated_at=NOW() WHERE id=$2`,
    ['Admin account wrote in this chat manually', convo.id]
  )
  log.info('autoOwnerConversation: human override -- automation paused', { phone: String(phone).slice(-4) })
  await notifyAdminEscalation(convo.session, phone,
    'automation paused (someone wrote in this chat manually)',
    `Message: "${String(text || '').slice(0, 150)}"`)
  await logLearningIfActive(phone, text, 'kevin')
}

// Kev, 2026-09-01 (Gestufte Fragen-Priorität, 40h-Lern-Monitoring): purely
// observational, NEVER sends anything, NEVER re-enables automation -- the
// permanent send-stop after human takeover is completely unaffected by
// this. Once a chat is human_paused, this keeps logging both sides for up
// to 40h so Kev/Claude can review later how he actually resolved it, to
// hand-tune the extraction/question logic. If Kevin stays active, the
// window extends (each logged row becomes the new "last activity"
// reference); once the chat has been fully silent for 40h, logging stops
// permanently -- a message arriving after that point starts no new window.
const LEARNING_WINDOW_MS = 40 * 60 * 60 * 1000

async function logLearningIfActive(phone, text, direction) {
  try {
    const convo = await db.query(
      `SELECT id, updated_at FROM owner_auto_conversations
        WHERE phone = $1 AND status = 'human_paused'
        ORDER BY id DESC LIMIT 1`,
      [phone]
    )
    const row = convo.rows[0]
    if (!row) return

    const last = await db.query(
      `SELECT GREATEST($2::timestamptz, COALESCE(MAX(created_at), $2::timestamptz)) AS last_activity
         FROM owner_takeover_learning_log WHERE conversation_id = $1`,
      [row.id, row.updated_at]
    )
    const lastActivity = new Date(last.rows[0].last_activity).getTime()
    if (Date.now() - lastActivity > LEARNING_WINDOW_MS) return // window is dead, stays dead permanently

    await db.query(
      `INSERT INTO owner_takeover_learning_log (conversation_id, phone, direction, text) VALUES ($1,$2,$3,$4)`,
      [row.id, phone, direction, String(text || '').slice(0, 4000)]
    )
  } catch (err) {
    log.warn('autoOwnerConversation: learning-log write failed', { err: err.message })
  }
}

async function notifyAdminEscalation(session, phone, reason, detail) {
  const to = config.admin.botNumber
  if (!to) return
  const msg = `⚠️ Auto-Owner-Conversation — ${reason} (+${phone}).${detail ? ` ${detail}` : ''}`
  try {
    await waha.sendText(session || 'default', to, msg)
  } catch (e) {
    log.warn('autoOwnerConversation: admin escalation send failed', { err: e.message })
  }
}

// ── Final send gate (HARD STOP spec, Kev 2026-08-31) ───────────────────────
// Sits OUTSIDE Kimi entirely -- a plain DB read, no model involved, and
// Kimi cannot overturn it. Re-reads the LATEST row from the database (never
// the in-memory `convo`/`updatedChecklist` a long-running processStep call
// captured earlier) as the LAST thing before every single outbound
// automated message. This is what closes the exact race Kev described:
// Kimi generates a reply, it sits queued for a moment, Kevin sends !ca in
// that window -- by the time this function re-reads the row, !ca's own
// UPDATE has already committed, so the gate sees it and blocks the send
// that would otherwise have gone out anyway.
function normalizeOutboundText(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function hasAlreadySentExactText(checklist, text) {
  const wanted = normalizeOutboundText(text)
  if (!wanted) return false
  return ((checklist && checklist._log) || []).some(entry =>
    entry && entry.from === 'bot' && normalizeOutboundText(entry.text) === wanted)
}

async function sendGate(conversationId, phone = null, session = null, messageText = null) {
  if (await isGloballyPaused()) return { allow: false, reason: 'globally_paused' }
  const r = await db.query(
    `SELECT status, automation_disabled, checklist FROM owner_auto_conversations WHERE id = $1`,
    [conversationId]
  )
  const row = r.rows[0]
  if (!row) return { allow: false, reason: 'not_found' }
  // Two independent checks on purpose -- status and automation_disabled are
  // set together by every cancel/override path today, but the gate does
  // not rely on that staying true forever. Either one alone is enough to
  // block.
  if (row.automation_disabled === true) return { allow: false, reason: 'automation_disabled' }
  if (row.status !== 'active_collecting') return { allow: false, reason: row.status }
  if (messageText && hasAlreadySentExactText(row.checklist, messageText)) {
    return { allow: false, reason: 'duplicate_message' }
  }
  const shared = await require('./ownerSendGate').checkOwnerSend({
    phone, session, kind: 'reply', automated: true, reviewRequired: false,
  })
  if (!shared.allow) return shared
  return { allow: true }
}

// Every outbound automated WhatsApp message in processStep goes through
// this, never a raw waha.sendText call -- so the gate above cannot be
// bypassed by a call site that forgot to check it.
async function gatedSend(session, phone, text, conversationId) {
  const saveProgress = async (status, extra = {}) => {
    if (!conversationId) return
    await db.query(
      `UPDATE owner_auto_conversations
          SET checklist = checklist || $1::jsonb, updated_at = NOW()
        WHERE id = $2`,
      [JSON.stringify({ _last_action: { action: 'owner_message', status, session, at: new Date().toISOString(), ...extra } }), conversationId]
    )
  }
  const gate = await sendGate(conversationId, phone, session, text)
  if (!gate.allow) {
    await saveProgress('blocked', { reason: gate.reason }).catch(() => {})
    log.info('autoOwnerConversation: send blocked at final gate', {
      conversationId, reason: gate.reason, phone: String(phone).slice(-4),
    })
    return { sent: false, reason: gate.reason }
  }
  const intelligenceGate = await require('./conversationIntelligence').preflightOutbound({
    phone, chatId: `${String(phone || '').replace(/\D/g, '')}@c.us`, session, draft: text,
  })
  if (!intelligenceGate.allow) {
    await saveProgress('blocked', { reason: intelligenceGate.reason }).catch(() => {})
    return { sent: false, reason: intelligenceGate.reason }
  }
  await saveProgress('sending')
  try {
    const result = await waha.sendText(session, phone, text)
    await saveProgress('sent', { messageId: result?.key?.id || result?.id || null })
    return { sent: true }
  } catch (err) {
    await saveProgress('queued_retry', { reason: String(err.message || err).slice(0, 240) }).catch(() => {})
    throw err
  }
}

// An operator upload is the authoritative end of the collection flow for
// that property.  The old flow kept its delayed question alive even after a
// complete listing (including photos) had been created in CRM, so the owner
// could receive a stale "send photos" question minutes after the upload.
// Close every open row for this owner first; an already-running worker is
// then stopped by sendGate's fresh status read immediately before WAHA.
async function completeConversationAfterOperatorUpload({ ownerId = null, phone = null, propertyId = null, ref = null } = {}) {
  let normalized = String(phone || '').replace(/\D/g, '')
  if (!normalized && ownerId) {
    const owner = await db.query('SELECT phone_normalized FROM owner_contacts WHERE id = $1', [ownerId])
    normalized = String(owner.rows[0]?.phone_normalized || '').replace(/\D/g, '')
  }
  if (!normalized) return { closed: 0, reason: 'owner_phone_unknown' }

  const open = await db.query(
    `SELECT id, pending_job_id, checklist
       FROM owner_auto_conversations
      WHERE right(regexp_replace(COALESCE(phone,''), '\\D', '', 'g'), 9) = $1
        AND status IN ('active_collecting', 'awaiting_auto_publish', 'ready_for_kev')
      ORDER BY id DESC`,
    [normalized.slice(-9)]
  )
  for (const row of open.rows) {
    await cancelPendingJob(row.pending_job_id)
    await cancelPendingJob(row.checklist?._publish_job_id, 'owner-auto-publish')
  }
  if (!open.rows.length) return { closed: 0, reason: 'no_open_collection' }

  const reason = `Operator upload completed${ref ? ` #${ref}` : ''}${propertyId ? ` (property ${propertyId})` : ''}; collection and draft delivery closed`
  const ids = open.rows.map(row => row.id)
  await db.query(
    `UPDATE owner_auto_conversations
        SET status='manually_uploaded', automation_disabled=FALSE,
            pending_job_id=NULL, processing_lock=NULL, cancelled_reason=$2,
            updated_at=NOW()
      WHERE id = ANY($1::int[])`,
    [ids, reason]
  )
  await db.query(
    `UPDATE outreach_log SET conversation_state='done'
      WHERE right(regexp_replace(COALESCE(phone,''), '\\D', '', 'g'), 9) = $1
        AND conversation_state IN ('cold','active')`,
    [normalized.slice(-9)]
  )
  log.info('autoOwnerConversation: operator upload closed owner collection', {
    phone: normalized.slice(-4), propertyId, ref, conversations: ids,
  })
  return { closed: ids.length, conversationIds: ids }
}

// ── Referral forwarding (Prompt 3, Point A) ───────────────────────────────
// Kev's explicit call: when an owner refers someone else WITH a phone
// number, message that new contact automatically, reusing the SAME
// outreach text verbatim (never re-worded), plus a recommendation note
// naming who referred them when known. The new contact gets a genuine
// fresh outreach_log row (their own OutreachSession, subject to the same
// session-gate as anyone else) linked back via referral_source_phone/name
// so the chain is traceable.
async function forwardReferral(originalPhone, referral, session) {
  const orig = await db.query(
    `SELECT o.name AS owner_name, ol.message_text
       FROM outreach_log ol JOIN owners o ON o.id = ol.owner_id
      WHERE ol.phone = $1 ORDER BY ol.sent_at DESC LIMIT 1`,
    [originalPhone]
  )
  const ownerName = orig.rows[0]?.owner_name || null
  const originalText = orig.rows[0]?.message_text || null
  if (!originalText) return { sent: false, reason: 'no original outreach text on file for this owner' }

  const referredPhone = referral.contact.replace(/\D/g, '')
  if (referredPhone.length < 7) return { sent: false, reason: 'referral number too short to be real' }

  // Kev, 2026-09-01 (Gestufte Fragen-Priorität, "Boss muss wieder
  // introducen"): a referred contact gets a real introduction FIRST -- who
  // Kevin is and why he's writing -- not the raw cold-outreach pitch with a
  // one-line footnote bolted on. The original pitch still follows (same
  // actual ask), it just isn't the FIRST thing this stranger reads.
  // 2026-09-24: the name is the SENDING account's persona, never a hard-coded
  // "Kevin" (this intro goes out via whichever session handled the referral).
  const sender = await require('./outreachIdentity').senderNames(session || 'default')
  const iAm = sender ? `Hi, I'm ${sender.first} from 2906 Real Estate in Malta` : `Hi, this is 2906 Real Estate in Malta`
  const introLine = ownerName
    ? `${iAm} — ${ownerName} mentioned you might have a property to rent out and suggested I get in touch directly.`
    : `${iAm} — someone we work with mentioned you might have a property to rent out and suggested I get in touch directly.`
  const forwardText = `${introLine}\n\n${originalText}`

  const referralGate = await require('./ownerSendGate').checkOwnerSend({
    phone: referredPhone, session: session || 'default', kind: 'followup', automated: true,
  })
  if (!referralGate.allow) return { sent: false, reason: `pre_send_gate:${referralGate.reason}` }

  const ownerIns = await db.query(
    `INSERT INTO owners (phone, name, source_account, source_group)
     VALUES ($1, $2, 'referral', 'referral')
     ON CONFLICT (phone) DO UPDATE SET last_seen_at = NOW()
     RETURNING id`,
    [referredPhone, referral.name || null]
  )

  await waha.sendText(session || 'default', referredPhone, forwardText)

  await db.query(
    `INSERT INTO outreach_log
       (owner_id, phone, account_used, message_text, message_type, conversation_state, referral_source_phone, referral_source_name)
     VALUES ($1,$2,$3,$4,'referral','cold',$5,$6)`,
    [ownerIns.rows[0].id, referredPhone, session || 'default', forwardText, originalPhone, ownerName]
  )
  return { sent: true, referredPhone }
}

// ── Greeting rotation (Malta time) ───────────────────────────────────────
function maltaNow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Malta', hour: 'numeric', hour12: false, weekday: 'short',
  }).formatToParts(new Date())
  const hour = parseInt(parts.find(p => p.type === 'hour').value, 10)
  const weekday = parts.find(p => p.type === 'weekday').value
  return { hour, isWeekend: weekday === 'Sat' || weekday === 'Sun' }
}

function politeClosing() {
  const { hour, isWeekend } = maltaNow()
  let pool
  if (isWeekend && Math.random() < 0.6) {
    pool = ['have a great weekend!', 'enjoy your weekend!']
  } else if (Math.random() < 0.15) {
    pool = ['have a great week!']
  } else if (hour < 12) {
    pool = ['have a nice day!', 'have a good one!']
  } else if (hour < 18) {
    pool = ['have a nice afternoon!', 'have a nice day!']
  } else {
    pool = ['have a nice evening!', 'have a good evening!']
  }
  const greeting = pool[Math.floor(Math.random() * pool.length)]
  return `No worries at all, thank you for letting us know! If anything comes up in the future feel free to reach out — ${greeting}`
}

// ── Checklist helpers ────────────────────────────────────────────────────
// map/pets/sharing have no reliable "still missing" value (a "no" answer is
// a real, valid answer, not an empty one) — same "_asked_X once, never
// again" gate the old map/pets_sharing_insurance fields already used.
// Everything else (including the two new date fields) is asked until an
// actual value lands in checklist[f].
const ASK_ONCE_FIELDS = new Set(['map', 'photos', 'plans', 'pets', 'sharing', 'subletting'])

// Kev, 2026-09-01 (Gestufte Fragen-Priorität): the checklist key actually
// populated by extraction for the map/address question is `address`, not
// `map` (see localExtract's 'map' branch and mergeExtracted below) -- a
// pre-existing naming split, not something to rename now (writeDraftProperty
// already reads `.address`). Anything that needs to know "was map really
// answered" must check this key, not `checklist.map`.
function mapFieldAnswered(checklist) {
  return checklist.address != null
}

// Stage 3 (pets/sharing) only fires if the owner was cooperative through
// Stage 1+2 (map actually answered). Stage 4 (subletting) only fires if
// pets AND sharing were BOTH actually answered -- "durchgehend sehr
// kooperativ". `_optional_questions_closed` (the STOP-RULE, set by
// checkOptionalStopRule below) overrides everything: once true, no Stage
// 2/3/4 field is ever eligible again for this session.
// Kev, 2026-09-10 (owner-conversation refinements #1): a 1-bedroom property
// has no second room to share, so the "professional sharing" question makes
// no sense there -- same property-type-awareness principle already applied
// to the commercial/residential MUST-field gating above (OA-1, the
// warehouse case), just applied to this optional question instead.
function sharingEligible(checklist) {
  return Number(checklist.bedrooms) !== 1
}

function optionalFieldEligible(field, checklist) {
  if (checklist._optional_questions_closed) return false
  if (field === 'sharing') return sharingEligible(checklist) && mapFieldAnswered(checklist)
  if (field === 'pets') return mapFieldAnswered(checklist)
  if (field === 'subletting') {
    // A 1-bedroom property permanently skips sharing (see sharingEligible
    // above) -- checklist.sharing will never become non-null for it, so
    // waiting on it here would wrongly skip subletting too. "Settled" means
    // either genuinely answered, or never going to be asked at all.
    const sharingSettled = checklist.sharing != null || !sharingEligible(checklist)
    if (!(checklist.pets != null && sharingSettled)) return false
    // Kev, 2026-09-16: an owner who said no to BOTH pets and sharing is very
    // unlikely to say yes to subletting either -- asking anyway after two
    // declines reads as pushy and just sours the relationship for a near-
    // certain third "no". Only a genuine 'no'+'no' skips it (a 1-bedroom
    // property's sharing stays null, never 'no', so this never misfires on
    // "sharing was simply not applicable").
    if (checklist.pets === 'no' && checklist.sharing === 'no') return false
    return true
  }
  return true
}

// Kev, 2026-09-01 (Gestufte Fragen-Priorität, STOP-RULE): the instant a
// Stage 2/3/4 question was asked and the owner's NEXT reply still left it
// unanswered -- unclear, evasive, ignored, or a completely unrelated
// answer -- the ENTIRE optional cascade closes for this session, not just
// that one field. "Für diese Owner-Session ist das Kapitel optionale
// Fragen geschlossen." Guarded by `_stage_noted_${f}` so this only ever
// fires once per field (the field stays permanently "asked but empty"
// after that, which is exactly what should happen).
function checkOptionalStopRule(checklist) {
  if (checklist._optional_questions_closed) return checklist
  for (const f of ['map', 'pets', 'sharing', 'subletting']) {
    const answered = f === 'map' ? mapFieldAnswered(checklist) : checklist[f] != null
    if (checklist[`_asked_${f}`] && !answered && !checklist[`_stage_noted_${f}`]) {
      return { ...checklist, [`_stage_noted_${f}`]: true, _optional_questions_closed: true }
    }
  }
  return checklist
}

// Kev, 2026-09-01 (Gestufte Fragen-Priorität): a language barrier or a
// generally hard-to-reach owner rarely shows up as one clean signal -- it
// shows up as SEVERAL different fields quietly failing to land. Two or
// more (any mix of a MUST field stuck after a retry, or the whole optional
// cascade closing) is treated as that broader signal, checked in
// processStep below.
function countUnclearSignals(checklist) {
  let n = 0
  for (const f of mustFieldsFor(checklist)) if (checklist[`_unresolved_${f}`]) n++
  if (checklist._optional_questions_closed) n++
  return n
}

// ── PRINCIPLE A (Kev, 2026-09-06, GOLDEN-SCRIPT): collaboration-dependent
// pace -- "friendly owner, chat can run to full completion; low-effort
// owner, ask fewer questions and write less, slowly gathering info matters
// more than forcing completeness." This is deliberately a NEW, separate
// signal from the existing per-field retry/give-up machinery above
// (_unresolved_X, checkOptionalStopRule, countUnclearSignals) -- those
// already react to a SPECIFIC missed question; this one continuously reads
// the owner's general reply style across the whole conversation so far and
// backs off the optional cascade EARLY, before any single field has even
// been asked-and-missed, rather than waiting for that to happen field by
// field. Deliberately narrow in scope (only ever tightens
// _optional_questions_closed, never touches MUST-field asking/give-up
// logic, which already has its own well-tested behaviour) -- a broader
// rewrite of the MUST-field pacing was not part of what Kev asked for here
// and risks the exact kind of regression this file's own history (see the
// countless dated comments above) shows this logic is fragile to touch.
//
// "Low collaboration" = at least 2 owner turns logged so far, and the
// owner's messages have consistently been very short (<=2 words on
// average) -- one terse reply could just be someone in a hurry; a pattern
// across several turns is the actual signal.
function computeEngagementLevel(log_) {
  const ownerTurns = (log_ || []).filter(l => l.from === 'owner')
  if (ownerTurns.length < 2) return 'unknown'
  const totalWords = ownerTurns.reduce((n, l) => n + String(l.text || '').trim().split(/\s+/).filter(Boolean).length, 0)
  const avgWords = totalWords / ownerTurns.length
  return avgWords <= 2 ? 'low' : 'high'
}

function nextMissingField(checklist) {
  for (const f of fieldOrderFor(checklist)) {
    if (checklist[`_unresolved_${f}`]) continue
    if (ASK_ONCE_FIELDS.has(f)) {
      // Kev, 2026-08-31 (Prompt 2, "Bestehende CRM-Daten VOR jeder Frage
      // prüfen"): a value can now land here WITHOUT ever having been asked
      // -- CRM pre-fill, or the owner volunteering it unprompted ("pets are
      // fine" answering a totally different question). Never ask for
      // something we already have, regardless of whether we asked for it.
      if (checklist[f] !== undefined && checklist[f] !== null) continue
      if (!optionalFieldEligible(f, checklist)) continue
      if (!checklist[`_asked_${f}`]) return f
      continue
    }
    if (checklist[f] === undefined || checklist[f] === null) return f
  }
  return null
}


const FIELD_LABEL = {
  price: 'the monthly rent', bedrooms: 'the number of bedrooms', bathrooms: 'the number of bathrooms',
  town: 'which town/area it is in',
  available_date: 'when the property will be available / the move-in date (not whether they have something at all — that part is already settled)',
  viewable_date: 'when it could actually be viewed — a separate question from when it becomes available',
  photos: 'a few photos of the place',
  map: 'the address or map location',
  plans: 'any floor plans or permit documents they can share',
  condition: 'the property condition (shell, finished or furnished)',
  development_stage: 'whether it is on-plan, under construction or already built',
  pets: 'whether they would consider tenants with pets',
  sharing: 'whether sharing with other tenants would be an option',
  subletting: 'whether they would consider subletting through a serious company, as a very last, carefully-framed question',
}

// ── Local extraction fallback (Kev, 2026-08-30) ──────────────────
// Root cause of "bot asks the same checklist question again": KIMI_API_KEY
// is currently returning 401 on every single call (verified live, not
// intermittent -- see the incident report), so buildNextMessage's Kimi path
// NEVER succeeds right now and always fell through to a fallback that
// returned extracted:{} -- the answer was simply never recorded, no matter
// what the owner typed, so the same field stayed "missing" forever.
//
// This function is the actual working extraction path until the Kimi key
// is fixed, and stays on afterward as a safety net for whatever Kimi
// misses. Deliberately generous per Kev's instruction: a short, on-topic
// reply to the question we just asked should always count, never held to
// a specific format ("2000" is a perfectly good answer to "what's the
// rent?", not just "€2,000/month").
const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
}

function wordToNumber(raw) {
  const w = String(raw || '').trim().toLowerCase()
  if (NUMBER_WORDS[w] != null) return NUMBER_WORDS[w]
  const n = parseFloat(w.replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

// Kev, 2026-09-10 (Malta context, real bug): a bare "4" or "5" answering the
// monthly-rent question means EUR 4,000 / EUR 5,000 in this market, not
// EUR 4 / EUR 5 -- no genuine Malta longlet rents for double digits or less,
// so a plain digit run under this floor is read as thousands-shorthand.
// Deliberately conservative and narrow: only fires when the owner wrote NO
// currency symbol, no thousands comma, and no decimal point -- an explicit
// "EUR4" or "4.5" is a different, deliberate shape of answer and is NEVER
// reinterpreted (explicit values always win exactly as written, per Kev's
// own instruction not to second-guess a clearly-typed figure). 100 is the
// floor because it is below any real Malta longlet price -- a room doesn't
// rent for under a hundred a month, so a literal sub-100 reading is never
// the more plausible one once the explicit-marker escape hatches above have
// already been checked.
function isBareShorthandPrice(rawText, matchedDigits) {
  const hadExplicitMarker = /[\u20ac$]/.test(String(rawText)) || /\d[.,]\d/.test(matchedDigits)
  return !hadExplicitMarker
}

// Kev, 2026-09-14 ("year became price" incident, live on #2906 Msida \u2014
// "available from 2027-03-01" produced "\u20ac2,027/month"): a bare digit run
// picked up whichever number happened to sit first in the cleaned text, with
// zero check that it was ever actually a PRICE. A reply that mentions a date
// ("available from 1st March 2027") reads "2027" first, and stripping the
// \u20ac/EUR/month markers before matching only makes it worse -- it throws away
// the one signal that would have told a currency-anchored number apart from
// a bare year. A plausible-year 4-digit number (2024-2040) is never a real
// Malta rent on its own; a genuine explicit price in that exact band still
// gets through because the currency-anchored pass below runs FIRST and wins
// outright regardless of range.
const YEAR_LIKE_RE = /^20(2[4-9]|3[0-9])$/
// A price-shaped number: plain digits, or thousands-grouped in proper groups
// of exactly 3 ("1,500" / "1.500"), optionally with cents ("1500.50"). This
// is what a date like "03.01.2027" or "1st" can never accidentally satisfy \u2014
// its groups are 2/2/4 digits, not 3s \u2014 so the marker-anchored regexes below
// can safely be greedy without also swallowing an unrelated date sitting
// next to the real price in the same sentence.
const PRICE_NUMBER = String.raw`\d{1,3}(?:[.,]\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?`
function extractPrice(text) {
  const original = String(text)

  // Pass 1: a number with an explicit currency/rent marker directly attached
  // -- unambiguous regardless of anything else in the message ("\u20ac1,500",
  // "1500 EUR", "1500/month", "1500 pm"). This is what makes spec regression
  // test B ("available 03.01.2027, \u20ac1,500/month" -> 1500, never 2027) work:
  // the marker anchor wins before the bare-digit fallback ever runs, and the
  // PRICE_NUMBER shape stops it from also swallowing the date's digits.
  const anchored = original.match(new RegExp(
    `(?:\u20ac|\\bEUR\\b)\\s*(${PRICE_NUMBER})|(${PRICE_NUMBER})\\s*(?:\u20ac|\\/?\\s*(?:per\\s*month|a\\s*month|monthly|pm)\\b|\\s*EUR\\b)`, 'i'))
  if (anchored) {
    const raw = anchored[1] || anchored[2]
    const n = parseFloat(raw.replace(/,/g, ''))
    if (Number.isFinite(n) && n > 0) return n < 100 && isBareShorthandPrice(original, raw) ? n * 1000 : n
  }

  const cleaned = original
    .replace(/[\u20ac$]/g, ' ')
    .replace(/\b(eur|euros?|per\s*month|a\s*month|monthly|pm)\b/gi, ' ')
  // Kev, 2026-09-01 (catalog test PRICE_004/005/008): "1.6k"/"2k" must read
  // as 1600/2000, not 1.6/2 -- checked BEFORE the plain digit-run match so
  // the 'k' suffix is consumed as part of the same number, not dropped.
  const km = cleaned.match(/(\d+(?:\.\d+)?)\s*k\b/i)
  if (km) {
    const n = parseFloat(km[1]) * 1000
    return Number.isFinite(n) && n > 0 ? n : null
  }
  // Kev, 2026-09-14 ("year became price" incident, live on #2906 Msida \u2014
  // "available from 1st March 2027" produced a bare shorthand price of
  // \u20ac1,000, read off the "1" in "1st"): no currency marker anywhere means
  // the message never actually stated a price, and the plain digit-run
  // fallback below was matching a day-of-month ordinal or a date's year
  // just because it happened to be the first number in the sentence. An
  // ordinal ("1st"/"2nd"/"3rd"/"4th"...) is unambiguously a day, never a
  // price, in any phrasing -- skipped outright before the fallback runs.
  const m = cleaned.match(/(\d[\d,.]*)(?!\s*(?:st|nd|rd|th)\b)/)
  if (!m) return null
  // The bare digit run is exactly year-shaped -- almost certainly a date's
  // year that survived the marker strip above, not a price. Leave the
  // field unresolved rather than publish it; it stays missing and gets
  // asked again / flagged for review, which is the correct outcome for a
  // value this uncertain with zero currency context to back it up.
  if (YEAR_LIKE_RE.test(m[1])) return null
  let n = parseFloat(m[1].replace(/,/g, ''))
  if (!Number.isFinite(n) || n <= 0) return null
  if (n < 100 && isBareShorthandPrice(original, m[1])) n *= 1000
  return n
}

// Handles "2 and 1", "2/1", "2, 1", "two bed one bath" in one go, since an
// owner asked about bedrooms will often just volunteer bathrooms too.
// Kev, 2026-08-31 -- keyword-anchored match tried FIRST, on purpose. The
// looser "number, number" pair pattern below has no bed/bath anchor at all,
// so inside a longer sentence it can latch onto a completely unrelated
// comma before ever reaching the real numbers: "...a month, 3 bed 2 bath in
// Sliema" previously misread "month, 3" as bedrooms/bathrooms=3, dropping
// bedrooms entirely, because the loose pattern ran first and returned
// immediately. Checking "N bed"/"N bath" first makes that case exact; the
// loose pair pattern is now only reached for genuinely keyword-less replies
// ("2/1", "2 and 1") where there is nothing more specific to anchor on.
// Kev, 2026-09-08 (real bug found live, conversation #3808): the single-
// preceding-word capture below used to grab whichever word sat immediately
// before "bed"/"bath" -- for "One main bathroom" that word is "main", not
// "one", so wordToNumber("main") failed and the field was never set. The
// bot then asked "how many bathrooms?" three seconds after the owner had
// already answered it in the very same message. numberBefore() now looks
// at up to 3 words before the keyword and takes the NEAREST one that is
// actually a number word, so a descriptor sitting between the count and
// "bed"/"bath" ("main", "master", "en-suite", "further") no longer hides
// the real number behind it.
function numberBefore(lower, keywordRe) {
  const m = lower.match(new RegExp(`((?:\\w+\\s+){0,3})${keywordRe.source}`))
  if (!m) return null
  const words = m[1].trim().split(/\s+/).filter(Boolean)
  for (let i = words.length - 1; i >= 0; i--) {
    const n = wordToNumber(words[i])
    if (n != null) return n
  }
  return null
}
// Kev, 2026-09-10 (system-wide "digital form" audit): a bedroom/bathroom
// count is a small integer, never a price/date/phone digit run that
// happened to land next to the word "bed"/"bath" via numberBefore's 3-word
// lookback, or via wordToNumber's bare parseFloat below. No genuine Malta
// property has more than a handful of bedrooms; 12 is a generous ceiling
// (still covers a large villa/block) that no real price or date could ever
// satisfy by coincidence. A value outside this range is dropped -- never
// coerced -- so the field stays genuinely unresolved instead of silently
// wrong.
function plausibleRoomCount(n) {
  return Number.isFinite(n) && Number.isInteger(n) && n >= 0 && n <= 12 ? n : null
}
function extractBedsBaths(text) {
  const lower = String(text).toLowerCase()
  const out = {}
  const bedN = plausibleRoomCount(numberBefore(lower, /bed(?:room)?s?/))
  if (bedN != null) out.bedrooms = bedN
  const bathN = plausibleRoomCount(numberBefore(lower, /bath(?:room)?s?/))
  if (bathN != null) out.bathrooms = bathN
  if (out.bedrooms != null || out.bathrooms != null) return out

  const pair = lower.match(/(\w+)\s*(?:and|\/|,|\+)\s*(\w+)/)
  if (pair) {
    const a = plausibleRoomCount(wordToNumber(pair[1]))
    const b = plausibleRoomCount(wordToNumber(pair[2]))
    if (a != null) out.bedrooms = a
    if (b != null) out.bathrooms = b
  }
  return out
}

// Kev, 2026-08-31 (Prompt 2, "Unsicherheit markieren") -- confidence cues,
// checked alongside the value itself so a hedge never gets silently
// dropped OR silently promoted to a hard fact. Deliberately different cue
// sets per kind: for a PRICE, "I think"/"around" both read as a rough
// figure (approximate); for a DATE, "probably"/"maybe" read as a genuine
// guess at timing (tentative) -- these are not interchangeable synonyms,
// they're answering "how sure are you" for two different kinds of things.
const APPROX_PRICE_RE = /\b(around|approx(?:imately)?|about|roughly|circa|i think|i believe)\b/i
const TENTATIVE_DATE_RE = /\b(probably|maybe|possibly|not (?:100%\s*)?sure|tentative(?:ly)?)\b/i

// Field-targeted: we know exactly which ONE question was just asked, so
// "does this short reply plausibly answer THAT question" is a much safer
// bar than trying to parse free text with no context at all.
function localExtract(askAboutField, replyText) {
  const text = String(replyText || '').trim()
  if (!text) return {}
  // Kev, 2026-09-01 (real bug found testing the staged-questions work): when
  // a field becomes "next" WITHIN the same turn as a different field just
  // resolving (e.g. photos resolves via the [media] sentinel, then map
  // becomes the next-missing field and buildNextMessage runs on that SAME
  // turn's raw text), the media/document sentinels themselves must never be
  // read as the answer to whatever field happens to be asked next.
  if (/^\[(media|document)\]$/.test(text)) return {}
  const out = {}

  if (askAboutField === 'price') {
    // Kev, 2026-09-01: strip bed/bath mentions first -- "2 bed 1 bath, 1600"
    // must never read as price=2 (extractPrice takes the first digit run in
    // whatever text it's given).
    const stripped = stripBedsBaths(text)
    const p = extractPrice(stripped)
    if (p != null) {
      out.price = p
      if (APPROX_PRICE_RE.test(text)) out._priceConfidence = 'approximate'
      // Visible flag, not a silent guess (Kev's own instruction) -- the value
      // itself is already correct (extractPrice did the x1000), this just
      // surfaces on the AV CENTRAL card that it was inferred from a bare
      // digit so Kev can glance-verify rather than trust it blind.
      const digits = stripped.replace(/[€$]/g, ' ').match(/(\d[\d,.]*)/)
      if (digits && p >= 100 && parseFloat(digits[1].replace(/,/g, '')) < 100 && isBareShorthandPrice(stripped, digits[1])) {
        out.notes = [...(out.notes || []), `Rent given as a bare "${digits[1]}" -- read as €${p.toLocaleString()}/month (Malta shorthand); please verify`]
      }
    }
    return out
  }

  if (askAboutField === 'bedrooms' || askAboutField === 'bathrooms') {
    Object.assign(out, extractBedsBaths(text))
    if (out.bedrooms == null && out.bathrooms == null) {
      const n = plausibleRoomCount(wordToNumber(text))
      if (n != null) out[askAboutField] = n
    }
    return out
  }

  if (askAboutField === 'town') {
    // Short, no digits, not a sentence -> take it as the locality name
    // as-is. Owners answer "Sliema", not "the property is in Sliema".
    // Dialect/typo/casing variants ("melieha", "MELLIEHA") are trusted
    // as-is here on purpose: this branch only runs when the town question
    // was JUST asked, so there is no other realistic reading of a short
    // reply with no digits -- exactly the context Point 3 (Prompt 2) says
    // is safe to normalize without guessing. Title-cased for storage.
    //
    // Kev, 2026-09-01 (explicit correction, catalog tests): a VAGUE reply
    // ("north", "near Sliema", "close to airport", "central area") must
    // NEVER be stored as if it were a real locality name -- it stays
    // location_text/town=UNKNOWN, and the bot moves on WITHOUT clarifying
    // (never re-asks, never "let me try again differently"). Only rejected
    // here, not elsewhere -- once genuinely vague, it's simply left alone.
    if (text.length <= 40 && !/\d/.test(text) && text.split(/\s+/).length <= 5 && !isInvalidTownValue(text.replace(/^(in|at)\s+/i, '').trim())) {
      const cleaned = text.replace(/^(in|at)\s+/i, '').trim()
      out.town = cleaned.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    } else if (looksLikeVagueLocation(text)) {
      out.location_text = text.trim()
    }
    return out
  }

  if (askAboutField === 'available_date' || askAboutField === 'viewable_date') {
    // Generous on purpose: "end of Sept", "now", "anytime", "call me next
    // week" are all real answers. Only reject a bare yes/no, which answers
    // a different question (whether they have something at all).
    //
    // Kev, 2026-09-01 (real bug found testing the staged-questions work):
    // this ran even when askAboutField was synthesized WITHIN the same turn
    // as the owner's very first, multi-fact message (classify, then
    // immediately ask about whatever MUST field is still missing using that
    // SAME raw text) -- a first message like "2 bed 1 bath in Sliema, 1600
    // a month, available now" (58 chars, not a bare yes/no) was read whole
    // as the viewable_date answer purely because it was short enough and
    // viewable_date happened to be the one field left unresolved. A reply
    // that clearly carries OTHER MUST-field content (beds/baths/price
    // cues) is never a genuine date answer on its own.
    if (looksLikeOccupancyConflict(text)) {
      out.availabilityConflict = text.trim()
      return out
    }
    const looksLikeADifferentFieldAnswer = /\b\w+\s*bed(?:room)?s?\b|\b\w+\s*bath(?:room)?s?\b|\b(eur|euros?|€|\$|per\s*month|a\s*month|monthly|pm)\b/i.test(text)
    if (text.length <= 80 && !looksLikeADifferentFieldAnswer && !/^(yes|no|yeah|yep|nope|sure)\.?$/i.test(text)) {
      const key = askAboutField === 'available_date' ? 'availableDate' : 'viewableDate'
      out[key] = text
      if (TENTATIVE_DATE_RE.test(text)) {
        out[key === 'availableDate' ? '_availableDateConfidence' : '_viewableDateConfidence'] = 'tentative'
      }
    }
    return out
  }

  if (askAboutField === 'map') {
    if (looksLikeOccupancyConflict(text)) out.availabilityConflict = text.trim()
    else if (text.length <= 150 && looksLikeRealOptionalAnswer(text)) out.address = text
    return out
  }

  if (askAboutField === 'pets' || askAboutField === 'sharing' || askAboutField === 'subletting') {
    if (text.length <= 100 && looksLikeRealOptionalAnswer(text)) out[askAboutField] = text
    return out
  }

  return out
}

// Kev, 2026-09-01 (Gestufte Fragen-Priorität, STOP-RULE support): a short
// evasive/off-topic reply ("maybe", "why?", a question back) must NOT count
// as a real answer to a Stage 2/3/4 question -- the existing extraction
// above would otherwise store almost any short reply verbatim, and the
// STOP-RULE (checkOptionalStopRule) could never detect "owner didn't
// actually answer". Deliberately narrow: only gates map/pets/sharing/
// subletting, never the MUST fields' own (already-tested) extraction.
const EVASIVE_OPTIONAL_REPLY_RE = /^(maybe|perhaps|not sure|unsure|dunno|i don'?t know|why\??|what\??|hmm+|ok(?:ay)?\??|\.{2,}|\?{1,})$/i
function looksLikeRealOptionalAnswer(text) {
  const t = String(text || '').trim()
  if (!t) return false
  if (EVASIVE_OPTIONAL_REPLY_RE.test(t)) return false
  if (/\?$/.test(t) && t.split(/\s+/).length <= 6) return false // a short question back, not an answer
  return true
}

// Kimi wins when it actually has an opinion (it understands nuance the
// regexes above cannot); the local pass fills whatever Kimi left null --
// which, with the key currently broken, is everything.
function mergeLocalOverKimi(localExtracted, kimiExtracted) {
  const out = { ...localExtracted }
  if (kimiExtracted) {
    for (const [k, v] of Object.entries(kimiExtracted)) {
      if (v != null) out[k] = v
    }
  }
  return out
}

// Kev, 2026-08-31 (Points C/G, real Mellieha regression) -- unlike
// localExtract() above, this is NOT field-targeted: it runs on the OWNER'S
// VERY FIRST message, before any question has been asked, so there is no
// "field we asked about" to anchor on yet. An owner very often volunteers
// several facts unprompted right in that first reply ("I have a 3 bedroom
// apartment in Mellieha on top of Welbees supermarket") -- with Kimi down
// this was previously extracted nowhere at all until AFTER a field got
// asked again, which is exactly how "asked something already answered"
// bugs happen. Deliberately conservative on price (only trusted alongside
// an explicit currency/rent cue) so a bare "3 bedroom" doesn't get misread
// as a price.
// Strips "N bed(room)s"/"N bath(room)s" mentions out of a segment so a
// price-hunting regex run on the remainder doesn't grab the bedroom count
// instead of the actual price ("2 bed in Gzira for 1500" -> without this,
// extractPrice's first-digit-wins scan would return 2, not 1500).
function stripBedsBaths(text) {
  return String(text)
    .replace(/\b\w+\s*bed(?:room)?s?\b/gi, ' ')
    .replace(/\b\w+\s*bath(?:room)?s?\b/gi, ' ')
}

// Kev, 2026-09-01 (catalog test): a real Malta locality named bare, with no
// "in" ("3 bed Swieqi 1600 2 bath"), is common in how owners actually write.
// A whitelist (not a generic capitalized-word guess) so this never
// misreads an unrelated capitalized word as a town.
const KNOWN_LOCALITIES = [
  'Sliema', 'Gzira', 'Gżira', 'Mellieha', 'Mellieħa', 'Mosta', 'Swieqi', 'St Julians', "St Julian's",
  'San Gwann', 'Birkirkara', 'Qormi', 'Naxxar', 'St Pauls Bay', "St Paul's Bay", 'Pieta', 'Pietà',
  'Msida', 'Hamrun', 'Ħamrun', 'Marsa', 'Zebbug', 'Żebbuġ', 'Rabat', 'Attard', 'Balzan', 'Lija',
  'Iklin', 'Fgura', 'Zabbar', 'Żabbar', 'Marsaskala', 'Marsascala', 'Zurrieq', 'Żurrieq', 'Siggiewi',
  'Qawra', 'Bugibba', 'Mgarr', 'Mtarfa', 'Dingli', 'Gudja', 'Ghaxaq', 'Kirkop', 'Luqa', 'Safi',
  'Marsaxlokk', 'Zejtun', 'Żejtun', 'Xghajra', 'Kalkara', 'Vittoriosa', 'Birgu', 'Senglea', 'Cospicua',
  'Valletta', 'Floriana', 'Sannat', 'Xaghra', 'Nadur', 'Qala', 'Xewkija', 'Fontana', 'Gharb', 'Ghajnsielem',
]
const KNOWN_LOCALITY_RE = new RegExp(`\\b(${KNOWN_LOCALITIES.map(l => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i')

// Kev, 2026-09-01 (explicit correction): "north"/"central area"/"near
// Sliema"/"close to airport"/"south of Malta" are directional/relative, not
// a real locality -- must never be stored as town, and must never trigger a
// clarifying follow-up either. Deliberately narrow (direction words, "near"/
// "close to"/"around" as a prefix) so it never rejects a genuine locality.
const VAGUE_LOCATION_RE = /^(north|south|east|west|central)\b|\b(near|close to|around)\s+\w/i
function looksLikeVagueLocation(text) {
  return VAGUE_LOCATION_RE.test(String(text || '').trim())
}

function extractTownMention(text) {
  const m = String(text).match(/\bin\s+([A-Z][a-zA-Z']+(?:\s+[A-Z][a-zA-Z']+)?)\b/)
  if (m) return m[1]
  const known = String(text).match(KNOWN_LOCALITY_RE)
  if (known) return known[1].replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
  return null
}

// Kev, 2026-08-31 (Prompt 2, "Property-Info vs. Conversation-Info
// unterscheiden") -- "I'm abroad until Thursday, call me Friday" must never
// read as a property-availability date. Real reason this matters: a bare
// weekday/relative-day mention is common in BOTH senses, and only the
// surrounding verb tells them apart ("call me Friday" vs "available
// Friday"). Checked before any date extraction below.
function looksLikeContactAvailability(text) {
  return /\b(call me|contact me|reach me|text me|whatsapp me|i'?m (?:abroad|away|travel(?:l)?ing|out (?:of|off)))\b/i.test(text)
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

// A month is an availability answer, never a Maltese locality. This is
// enforced again when model output merges so a model cannot bypass it.
function isInvalidTownValue(value) {
  const town = String(value || '').trim().toLowerCase()
  return !town || MONTH_NAMES.includes(town) || looksLikeVagueLocation(town)
}

// Explicit tenant-renewal language means neither available nor viewable.
// It must stay a review fact and must never be stored as an address/date.
const OCCUPANCY_CONFLICT_RE = /\b(?:tenant|tant)\b.{0,45}\b(?:renew|stay|remaining|remain)\b|\b(?:probably|might|may)\b.{0,30}\brenew\b|\bkeep\s+in\s+touch\b/i
function looksLikeOccupancyConflict(value) {
  return OCCUPANCY_CONFLICT_RE.test(String(value || ''))
}

function extractDateMention(text) {
  const lower = String(text).toLowerCase()
  const month = MONTH_NAMES.find(m => new RegExp(`\\b${m}\\b`).test(lower))
  if (month) return month.charAt(0).toUpperCase() + month.slice(1)
  if (/\b(now|asap|immediately|right away)\b/.test(lower)) return 'now'
  return null
}

// Kev, 2026-08-31 (Prompt 2, "Numbers an ihr semantisches Objekt binden")
// -- a rent figure volunteered without ever saying "euro"/"month" (owners
// often just say the number once mid-sentence: "2 bed in Swieqi, 1600, new
// place"). Only trusted when it's clearly NOT a bedroom/bathroom count
// already claimed above, and within a plausible Malta rent range -- guards
// against grabbing a phone number or some other unrelated figure.
function extractStandalonePrice(text, excludeValues) {
  const matches = [...String(text).matchAll(/\b(\d{2,6}(?:[.,]\d{3})*)\b/g)]
  for (const m of matches) {
    const val = parseFloat(m[1].replace(/,/g, ''))
    if (!Number.isFinite(val) || val < 150 || val > 20000) continue
    // Kev, 2026-09-14 ("year became price" incident, live on #2906 Msida):
    // this branch only runs when the message has NO currency/rent word at
    // all (localExtractAll's caller-side gate) -- so a plain "available
    // from 1st March 2027" landed here with nothing to tell "2027" apart
    // from a real bare price, and 2027 sits well inside the 150-20000
    // window. Same YEAR_LIKE_RE floor extractPrice() now uses: a bare
    // 2024-2039 number is never treated as a price with zero currency
    // context to back it up.
    if (YEAR_LIKE_RE.test(m[1])) continue
    if (excludeValues.has(val)) continue
    const after = String(text).slice(m.index + m[1].length, m.index + m[1].length + 15).toLowerCase()
    if (/^\s*(bed|bath|sqm|sq\.?\s*m|m2|m²)/.test(after)) continue
    return val
  }
  return null
}

// Kev, 2026-08-31 (Prompt 2, "unaufgefordert gegeben, immer speichern") --
// pets/sharing are ASK_ONCE fields, so catching them opportunistically here
// (not just when directly asked) means nextMissingField (fixed above to
// skip an already-valued ask-once field) never asks a question the owner
// already answered in passing.
function extractPetsMention(text) {
  const lower = String(text).toLowerCase()
  if (/\bno\s+pets?\b/.test(lower)) return 'no'
  if (/\bpets?\s*(?:are|is)?\s*(?:ok(?:ay)?|fine|welcome|allowed|no problem)\b/.test(lower)) return 'yes'
  if (/\bpet[- ]friendly\b/.test(lower)) return 'yes'
  return null
}

function extractSharingMention(text) {
  const lower = String(text).toLowerCase()
  if (/\bno\s+sharing\b|\bsingle household only\b|\bone household only\b/.test(lower)) return 'no'
  if (/\bsharing\s*(?:is)?\s*(?:ok(?:ay)?|fine|allowed|no problem)\b/.test(lower)) return 'yes'
  return null
}

// ── FALL 4 (Kev, 2026-09-06, GOLDEN-SCRIPT) -- an owner answering the
// pets/sharing question with an exclusive/selective tenant description
// ("I only want X") rather than a plain yes/no. Real example from Kev's own
// annotated transcript: "i only want brat pitts and angelina jolies from
// Europe or US" -- deliberately NOT keyword-matched against a fixed list of
// tenant types (ownerPreferenceProfile.js's EXPLICIT_PATTERNS is keyword-
// based and would miss this entirely); this only needs to recognize the
// SHAPE of an exclusive preference, the verbatim text is what actually gets
// stored (see the processStep call site).
const EXCLUSIVE_TENANT_PREF_RE = /\bonly\s+(?:want|accept|rent|take|looking\s+for)\b|\bwe\s+only\s+(?:want|accept|rent to)\b/i
function looksLikeExclusiveTenantPreference(text) {
  return EXCLUSIVE_TENANT_PREF_RE.test(String(text || ''))
}

// The casual, confirming-question form of the subletting ask once an
// exclusive tenant preference was just volunteered -- replaces the normal
// FALLBACK_QUESTIONS/Kimi-generated subletting question for this one
// owner's session (Kev's own exact wording). A statement, framed as a
// question, not an assertion -- the owner still has to actually confirm it.
const SUBLETTING_INFERENCE_TEXT = "Ah, the usual case, so I guess, subletting isnt something you would consider too?"

// Adjusts a drafted subletting question/extraction once the exclusive-
// preference flag is set (see processStep's detection call site) --
// swaps in SUBLETTING_INFERENCE_TEXT for the FIRST subletting ask only
// (checklist._asked_subletting still false at that point), and resolves a
// bare confirmation reply to subletting='no' instead of storing the literal
// confirmation word. A no-op for every other field / every owner who never
// triggered the exclusive-preference detector.
function applySublettingInferenceOverride(field, checklist, replyMessage, extracted, rawText) {
  if (field !== 'subletting' || !checklist._exclusive_tenant_pref_detected) {
    return { reply_message: replyMessage, extracted }
  }
  const nextExtracted = { ...extracted }
  if (CONFIRMATION_RE.test(String(rawText || '').trim())) nextExtracted.subletting = 'no'
  const nextMessage = checklist._asked_subletting ? replyMessage : SUBLETTING_INFERENCE_TEXT
  return { reply_message: nextMessage, extracted: nextExtracted }
}

// Owner confirming that inference ("Exact" in Kev's transcript) -- a bare
// agreement word, never a value the generic subletting extraction (any
// non-evasive text) should store verbatim, since "Exact" on its own means
// nothing to whoever reads the checklist later. Deliberately narrow: only
// consulted when _exclusive_tenant_pref_detected is set (see processStep),
// never applied to a normal subletting answer.
const CONFIRMATION_RE = /^\s*(exact(?:ly)?|yes|yep|yeah|correct|right|true|confirmed|that'?s\s+(?:right|correct|exact))[\s.!,]*$/i

function extractSublettingMention(text) {
  const lower = String(text).toLowerCase()
  if (/\bno\s+subletting\b|\bstrictly no\b.*sublet|\bnot interested\b.*sublet/.test(lower)) return 'no'
  if (/\bsubletting\s*(?:is)?\s*(?:ok(?:ay)?|fine|possible|allowed)\b/.test(lower)) return 'yes'
  return null
}

// Kev, "Final Fixes" 2026-09-12: checklist.subletting can hold a plain 'yes'/
// 'no' (from extractSublettingMention/Kimi) OR the owner's raw free-text
// answer verbatim (buildNextMessage's askAboutField capture, e.g. "Depends
// on company", "Only serious companies") -- the old mapping at upload time
// (`checklist.subletting === 'yes' ? true : ... === 'no' ? false : null`)
// collapsed every one of those nuanced answers to null, silently discarding
// a real yes. Kev's explicit rule: YES / CONSIDERED / DEPENDS / CASE-BY-CASE
// all mean the property CAN be considered -- only an actual refusal means
// false. The nuance itself is never thrown away; it survives as a note.
const SUBLETTING_REFUSAL_RE = /\bno\b|\bnever\b|\bnot\s+interested\b|\bstrictly\s+no\b|\bnot\s+considered\b|\bdo(?:es)?n'?t\s+consider\b|\bwon'?t\s+consider\b|\bnot\s+(?:an?\s+)?option\b/i
function classifySublettingAnswer(raw) {
  if (raw == null) return { considered: null, note: null }
  const text = String(raw).trim()
  if (!text) return { considered: null, note: null }
  if (SUBLETTING_REFUSAL_RE.test(text)) return { considered: false, note: null }
  if (/^yes\.?!?$/i.test(text)) return { considered: true, note: null }
  // Anything else substantive ("Depends on company", "Only serious
  // companies", "Case by case") -- considered, with the condition kept
  // verbatim for whoever reads the CRM record next.
  return { considered: true, note: text.slice(0, 300) }
}

// Owner Profile V2, Teil B (2026-09-08): "price is negotiable" is a concrete
// preference example the brief names — same opportunistic-catch shape as
// pets/sharing/subletting above (never asked outright, but saved the moment
// the owner volunteers it in passing).
function extractPriceFlexMention(text) {
  const lower = String(text).toLowerCase()
  if (/\b(price|rent)?\s*(?:is\s+)?negotiable\b|\bopen to offers\b|\bflexible on (?:the\s+)?price\b|\broom to negotiate\b/.test(lower)) return 'yes'
  if (/\bprice\s*(?:is\s+)?(?:fixed|firm|non[- ]negotiable)\b/.test(lower)) return 'no'
  return null
}

// Kev, 2026-08-31 (Prompt 2, "Freitext-Notizen nicht verlieren") -- a light
// safety net, not a general-purpose NLU pass: catches the specific kinds of
// owner-stated conditions Prompt 2 calls out by name. Anything else this
// misses is exactly what the (comprehensive) Kimi prompt below is for once
// the key is fixed; this is only the local fallback's floor.
function extractConditionNotes(text) {
  const notes = []
  const t = String(text)
  if (/\bno\s+smoking\b/i.test(t)) notes.push('No smoking')
  if (/\bprofessionals?\s+only\b/i.test(t)) notes.push('Professionals only')
  if (/\bno\s+students?\b/i.test(t)) notes.push('No students')
  // Kev, 2026-09-01 (catalog test): "2 months deposit" (value BEFORE the
  // word) is at least as common as "deposit of 2 months" -- both directions
  // checked, first match wins.
  const depositM = t.match(/\bdeposit\s+(?:of\s+)?([^.,;\n]+)/i) || t.match(/\b([\w\s]{1,20}?)\s+deposit\b/i)
  if (depositM) notes.push(`Deposit: ${depositM[1].trim()}`)
  const termM = t.match(/\b(?:minimum|min\.?)\s+(?:term|stay|lease)\s+(?:of\s+)?([^.,;\n]+)/i)
  if (termM) notes.push(`Minimum term: ${termM[1].trim()}`)
  if (/\bquiet\b.*\bblock\b|\brespectful tenants\b|\bowner lives (?:downstairs|upstairs|below|above)\b/i.test(t)) {
    notes.push(t.trim().slice(0, 200))
  }
  return notes
}

// Kev, 2026-08-31 (Points C/G, real Mellieha regression) -- unlike
// localExtract() above, this is NOT field-targeted: it runs on EVERY turn
// (first message, or opportunistically alongside a targeted reply), so
// there is no single "field we asked about" to anchor on. An owner very
// often volunteers several facts unprompted, in or out of order ("I have a
// 3 bedroom apartment in Mellieha", or "September. 2 bathrooms btw and pets
// are fine" answering a bathroom question with three facts at once) --
// with Kimi down this was previously extracted nowhere at all until AFTER
// a field got asked again, which is exactly how "asked something already
// answered" bugs happen.
function localExtractAll(text) {
  const t = String(text || '')
  const out = {}
  Object.assign(out, extractBedsBaths(t))

  const excludeValues = new Set([out.bedrooms, out.bathrooms].filter(n => n != null))
  if (/\b(eur|euros?|€|\$|per\s*month|a\s*month|monthly|pm|rent)\b/i.test(t)) {
    // Kev, 2026-09-01 (real bug found while testing the staged-questions
    // work): extractPrice takes the FIRST digit sequence in the text --
    // without stripping bed/bath mentions first, "2 bed 1 bath ... 1600 a
    // month" read the price as 2 (the bedroom count), not 1600, whenever
    // the price happened to come AFTER the bed/bath mention in the
    // sentence. detectPortfolio/splitMultipleProperties already stripped
    // beds/baths before this call; the main single-property path never did.
    const strippedT = stripBedsBaths(t)
    const price = extractPrice(strippedT)
    if (price != null) {
      out.price = price
      if (APPROX_PRICE_RE.test(t)) out._priceConfidence = 'approximate'
      const digitsT = strippedT.replace(/[€$]/g, ' ').match(/(\d[\d,.]*)/)
      if (digitsT && price >= 100 && parseFloat(digitsT[1].replace(/,/g, '')) < 100 && isBareShorthandPrice(strippedT, digitsT[1])) {
        out.notes = [...(out.notes || []), `Rent given as a bare "${digitsT[1]}" -- read as €${price.toLocaleString()}/month (Malta shorthand); please verify`]
      }
    }
  } else {
    const price = extractStandalonePrice(t, excludeValues)
    if (price != null) out.price = price
  }

  const town = extractTownMention(t)
  if (town) out.town = town

  if (!looksLikeContactAvailability(t)) {
    const date = extractDateMention(t)
    if (date) {
      out.availableDate = date
      if (TENTATIVE_DATE_RE.test(t)) out._availableDateConfidence = 'tentative'
    }
  }

  const pets = extractPetsMention(t)
  if (pets) out.pets = pets
  const sharing = extractSharingMention(t)
  if (sharing) out.sharing = sharing
  const subletting = extractSublettingMention(t)
  if (subletting) out.subletting = subletting
  const priceFlex = extractPriceFlexMention(t)
  if (priceFlex) out.priceFlex = priceFlex

  const notes = extractConditionNotes(t)
  if (notes.length) out.notes = notes

  const category = extractPropertyCategory(t)
  if (category) out.propertyCategory = category

  const transaction = extractTransactionContext(t)
  Object.assign(out, transaction)

  return out
}

// ── Owner-AI judgement fix: property-type awareness ─────────────────────
// Real bug: "Warehouse available" got asked "How many bedrooms?" -- the
// MUST-field checklist is residential-shaped and was applied unconditionally
// to every property. Checked BEFORE bed/bath words so "2 units" in a
// warehouse listing ("2 loading bays") is never mistaken for extractBedsBaths
// noise -- commercial keywords win outright when present. Deliberately a
// short, explicit keyword list (not a fuzzy classifier) -- Kev's own
// principle elsewhere in this file: never invent/guess, leave unknown
// unknown, only act on what was actually said.
const COMMERCIAL_KEYWORD_RE = /\b(warehouse|office|garage|shop|retail unit|retail space|industrial unit|industrial space|storage unit|storage space|commercial (unit|space|property)|showroom|workshop|factory)\b/i
const RESIDENTIAL_KEYWORD_RE = /\b(apartment|flat|house|villa|studio|penthouse|maisonette|duplex|bedroom|bungalow)\b/i
function extractPropertyCategory(text) {
  const t = String(text || '')
  const commercial = t.match(COMMERCIAL_KEYWORD_RE)
  const residential = RESIDENTIAL_KEYWORD_RE.test(t)
  // "apartment with garage" and "space ideal for office" are residential.
  // Garage/office only win when they describe the actual listing, rather
  // than an amenity or a possible room use inside a home.
  if (commercial && residential && /^(garage|office)$/i.test(commercial[1])) return 'residential'
  if (commercial) return 'commercial'
  if (RESIDENTIAL_KEYWORD_RE.test(t)) return 'residential'
  return null
}

function extractTransactionContext(text) {
  const t = String(text || '')
  const out = {}
  if (/\b(?:for\s+sale|sale\s+property|selling|purchase|buy)\b/i.test(t)) out.transactionType = 'sale'
  else if (/\b(?:for\s+rent|to\s+let|lease|monthly\s+rent)\b/i.test(t)) out.transactionType = 'rent'
  const use = t.match(/\b(office|retail|shop|hospitality|restaurant|bar|warehouse|industrial|storage|showroom|workshop|factory|garage)\b/i)
  if (use) out.commercialUse = use[1].toLowerCase()
  const sqm = t.match(/\b(\d{2,5}(?:\.\d+)?)\s*(?:sqm|sq\.?\s*m|m2|m²)\b/i)
  if (sqm) out.size_sqm = Number(sqm[1])
  const condition = t.match(/\b(finished|unfurnished|furnished|shell|semi-finished|newly finished|renovated|needs renovation)\b/i)
  if (condition) out.condition = condition[1].toLowerCase()
  if (/\b(on[ -]?plan|off[ -]?plan)\b/i.test(t)) out.developmentStage = 'on-plan'
  else if (/\b(under construction|being built)\b/i.test(t)) out.developmentStage = 'under construction'
  else if (/\b(pre[ -]?built|already built|completed|ready built)\b/i.test(t)) out.developmentStage = 'built'
  if (/\b(single room|double room|room to (?:rent|let)|room available|shared apartment room|flatshare room)\b/i.test(t)) out.listingKind = 'room'
  const tenure = t.match(/\b(freehold|leasehold|ground rent)\b/i)
  if (tenure) out.tenure = tenure[1].toLowerCase()
  const permit = t.match(/\b(?:permit|licen[cs]e)\b[^.!?\n]{0,100}/i)
  if (permit) out.permit_info = permit[0].trim()
  return out
}

// ── Multi-property / portfolio detection (Prompt 2, "mehrere Properties
// nicht vermischen" / "Portfolio ... erkennen") ──────────────────────────
// Checked ONLY on the first classified message (see processStep), before
// the plain intent split -- an owner describing several units at once must
// never collapse into one Frankenstein property (wrong bedrooms/price
// mixed together), and "6 apartments, all 2 bed" must never turn into 6
// chaotic individual WhatsApp interviews. Both hand off to Kevin rather
// than trying to run a structured multi-entity interview over chat (Point
// J / "gut genug" -- interviewing 6 apartments one by one over WhatsApp
// would be absurd; capturing the summary correctly and letting Kevin
// finish it is the actually-sensible behaviour).
const PORTFOLIO_STATUS_RENTED = /\b(rented|not available|taken|occupied)\b/i
const PORTFOLIO_STATUS_AVAILABLE = /\b(available|free|vacant)\b/i

function detectPortfolio(text) {
  const lower = String(text).toLowerCase()
  const countM = lower.match(/\b(\d+)\s+(?:apartments?|units?|properties|flats?)\b/)
  if (!countM) return null
  const count = parseInt(countM[1], 10)
  if (!Number.isFinite(count) || count < 2) return null
  const beds = extractBedsBaths(text)
  let price = null
  if (/\b(eur|euros?|€|\$|per\s*month|a\s*month|monthly|pm|rent|each)\b/i.test(text)) {
    price = extractPrice(stripBedsBaths(text).replace(new RegExp(`\\b${count}\\b`), ' '))
  }
  return {
    unit_count: count,
    bedrooms_each: beds.bedrooms ?? null,
    bathrooms_each: beds.bathrooms ?? null,
    town: extractTownMention(text),
    price_each: price,
    same_block: /\b(same block|new block|one block|same building)\b/i.test(text),
  }
}

// "and another" / "and a second" / "and the other" / "but the" / "and
// also" -- the natural ways an owner strings two distinct properties
// together in one message. Each segment is extracted independently so
// nothing from one property leaks into the other.
// Kev, 2026-09-01 (catalog test): "one in Sliema 1800 and one in Gzira 1500"
// -- "and one" added alongside the existing explicit connectors.
const MULTI_PROPERTY_CONNECTORS = /\s+(?:and another|and a second|and the other|but the|and also|and one)\s+/i

function splitMultipleProperties(text) {
  const parts = String(text).split(MULTI_PROPERTY_CONNECTORS)
  if (parts.length < 2) return null
  const entities = parts.map(seg => {
    const beds = extractBedsBaths(seg)
    let price = null
    if (/\b(eur|euros?|€|\$|per\s*month|a\s*month|monthly|pm|rent|for)\b/i.test(seg)) {
      price = extractPrice(stripBedsBaths(seg))
    }
    let status = null
    if (PORTFOLIO_STATUS_RENTED.test(seg)) status = 'rented'
    else if (PORTFOLIO_STATUS_AVAILABLE.test(seg)) status = 'available'
    return {
      town: extractTownMention(seg),
      bedrooms: beds.bedrooms ?? null,
      bathrooms: beds.bathrooms ?? null,
      price,
      status,
    }
  }).filter(e => e.town || e.bedrooms != null || e.price != null || e.status)
  return entities.length >= 2 ? entities : null
}

// ── Gemini calls ─────────────────────────────────────────────────────────
// Kev, 2026-09-02 ("Claude" prompt — Kimi -> Gemini): Kimi has been dead
// since February, the 401s were only ever the symptom. This is the exact
// same "brain" layer Prompt 2 (2026-08-31) built for Kimi, now speaking
// through Gemini instead — same prompts, same contract, same everything
// downstream. The ENTIRE session/guard architecture (Hard-Stop, session
// gates, field-state, send-gate — everything outside this file's three
// call sites) is untouched by this change and stays model-independent on
// purpose; only this language/understanding layer moved. Reuses the exact
// getAI()/generateContent/thinkingBudget:0 idiom services/uploadListing.js
// and services/ownerChatFieldFill.js already use elsewhere in this
// codebase for Gemini, rather than inventing a new integration.
//
// This is the "brain" layer. Prompt 1's session/guard architecture already
// decides WHETHER the bot is allowed to speak at all; everything below
// decides WHAT it understood and HOW it responds, once it's already been
// allowed to. Gemini is not a questionnaire and must not just keep the
// conversation alive — its only job is turning an owner chat into
// reliable, structured property data with minimal friction. Success is
// NOT "many bot messages"; it's useful data captured, owner effort low,
// duplicate questions at zero, and manual Kevin work low. A perfect
// interaction can be 2 messages (owner already gave everything) or 0 extra
// messages (the system already knew enough).
let _genAI = null
function getGeminiClient() {
  if (_genAI) return _genAI
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return null
  const { GoogleGenAI } = require('@google/genai')
  _genAI = new GoogleGenAI({ apiKey })
  return _genAI
}

// Same contract as the old kimi.callKimi(systemPrompt, userMessage): returns
// the parsed JSON object, or null on ANY failure (no key, network error,
// non-JSON reply, empty response) so every call site's existing "if
// (result && result.field) {...} else {fallback}" logic works completely
// unchanged. responseMimeType:'application/json' asks Gemini for the same
// guaranteed-JSON contract Kimi's response_format:{type:'json_object'} gave
// us -- stricter than the plain-prompt-then-strip-fences pattern
// services/uploadListing.js uses, deliberately: this call site's fallback
// firing on a malformed reply is a redundant question sent to a real
// owner, not just a missed field, so the extra reliability is worth it.
async function callGemini(systemPrompt, userMessage) {
  const ai = getGeminiClient()
  if (!ai) return null
  for (const model of ['gemini-2.5-flash', 'gemini-flash-latest']) {
    try {
      const r = await ai.models.generateContent({
        model,
        contents: `${systemPrompt}\n\n${userMessage}`,
        config: {
          temperature: 0, maxOutputTokens: 800,
          thinkingConfig: { thinkingBudget: 0 },
          responseMimeType: 'application/json',
        },
      })
      const text = (r.text || '').replace(/```json|```/g, '').trim()
      if (!text) continue
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object') return parsed
    } catch (err) {
      log.warn('autoOwnerConversation: Gemini call failed', { model, err: err.message })
    }
  }
  return null
}
const EXTRACTION_RULES = `EXTRACTION RULES (apply to every message you read, not just the latest one):
- Extract freely from anywhere in the sentence, in any order, however phrased. The owner never has to use your field names ("Got one in Sliema around 1800 mate" -> interested, town=Sliema, price≈1800).
- The LAST question you asked is the interpretation context for a short reply. A bare "1600" after you asked the rent means price=1600, not some unrelated number.
- Normalize typos/dialect/casing for known Malta localities when the context is unambiguous (melieha/mellieħa/MELLIEHA -> Mellieha, sweiqi -> Swieqi, san gwan -> San Gwann, st julians -> St Julian's). Never guess between multiple plausible readings.
- Normalize price formats freely (1600 / €1600 / 1600€ / 1,600 / 1.6k / "1600 monthly" / "around 1600") to a plain number, currency EUR. "around X" also sets confidence=approximate. Never re-ask just because the € sign was missing.
- Multiple distinct properties in one message ("one in Sliema for 1800 and another 2 bed in Gzira for 1500") are TWO separate property entities — never merge their fields into one Frankenstein property. Return them as a "properties" array (see schema) instead of the flat fields when this happens.
- A clearly-identified EXISTING property being reconfirmed ("yes still available") only updates availability/last_confirmed — never re-ask fields already on file.
- Negation changes meaning: "I have apartments but nothing available" = owner_has_properties=yes, current_availability=no (this is NOT the same as interest=yes). "The 2 bed is rented but the 3 bed is available" = two entities with different status each.
- Bind numbers to what they actually describe, not "the first number seen": "I have 3 apartments, all 2 bedroom" -> property_count=3, bedrooms_each=2 (never bedrooms=3). "My tenant pays 1500 now but I want 1700 for the next" -> current_tenant_rent=1500, asking_rent=1700 (asking_rent is what you should treat as "price").
- A portfolio of several units in one block ("6 apartments in the new block in Qormi, all 2 bedrooms, around 1600 each") is ONE grouped entity (unit_count≈6, town=Qormi, bedrooms_each=2, price_each≈1600, same_block=true) — not 6 separate mini-interviews.
- Separate PROPERTY info from CONVERSATION-LOGISTICS info: "I'm abroad until Thursday, call me Friday" is about when the OWNER can be reached, never property_available_from.
- Never hallucinate: "Nice apartment in Sliema" -> only town=Sliema. Do not invent bedrooms, price, or anything else not actually said. Unknown stays unknown.
- Mark uncertainty, don't discard it: "I think around 1700" -> price=1700, confidence=approximate. "Probably October" -> availableDate=October, confidence=tentative.
- A newer, explicit correction wins: "Sorry 1650 not 1600" -> price=1650 (the new value), and note the previous value was 1600.
- Owner-stated conditions, even unprompted, are valuable data — always keep them as free-text in "notes" if there's no better field: pets policy, tenant requirements, deposit, minimum term, "no smoking", "professionals only", etc.
- media_received: if the message indicates photos/video/a location pin arrived, set hasPhotos=true / note it — never ask "do you have pictures?" right after they were sent.
- "I don't know" / "not sure yet" IS an answer (mark the field as answered-but-unknown) — do not immediately repeat the same question.

LOCALITY vs EXACT ADDRESS are two different fields: once locality is known (e.g. Mellieha) OR the owner gave only a VAGUE/directional answer to it ("north", "south", "central area", "near Sliema", "close to the airport", "south of Malta", "near the sea"), NEVER ask "which town/area" again in any rephrasing — not even while your message is actually about a different field. A vague/directional reply is NOT a real town name: never put it in "town" (leave it null). But it DOES permanently close the locality question — treat it exactly like a known value for the purpose of never revisiting it, just without a usable value. The exact street/house/map-pin is a separate, optional, LATE-in-the-conversation question, never one of the first things asked.

TONE: Write like a real person texting, not a form. Do not prefix every single message with a stock acknowledgement ("Perfect, thank you!" / "Great, noted!" every time) — that pattern is itself a bot-tell; real people often skip the acknowledgement entirely. Vary phrasing, but remember that "what town is it in?", "which area is it located in?" and "where's the property?" are the SAME field (locality) semantically — phrasing variation must never be used to ask an already-answered field again.

"GOOD ENOUGH" beats perfect: do not force 100% field completion. A property with most fields filled and a happy owner beats total completeness with a frustrated one.`

const EXTRACTED_SCHEMA_TEXT = `"extracted": {
    "price": number or null,
    "priceConfidence": "approximate" | null,
    "propertyCategory": "residential" | "commercial" | null,
    "bedrooms": number or null,
    "bathrooms": number or null,
    "town": string or null,
    "availableDate": string or null,
    "availableDateConfidence": "tentative" | null,
    "viewableDate": string or null,
    "hasPhotos": true/false/null,
    "address": string or null,
    "pets": "yes" | "no" | string | null,
    "sharing": "yes" | "no" | string | null,
    "notes": string[] or null,
    "properties": [ { "town": string|null, "bedrooms": number|null, "bathrooms": number|null, "price": number|null, "status": "available"|"rented"|null } ] or null,
    "referral": { "contact": string, "name": string|null, "relationship": string|null } or null,
    "decisionMaker": string or null
  }`

const CLASSIFY_PROMPT = `You are a friendly assistant for a Malta real-estate agency (2906 Real Estate), replying inside WhatsApp to a property owner who was contacted about a potential tenant. Read the owner's message(s) below and decide their intent.

${EXTRACTION_RULES}

Return ONLY a JSON object:
{
  "intent": "declined" | "interested" | "unclear" | "future_availability" | "referral" | "external_source",
  ${EXTRACTED_SCHEMA_TEXT}
}

"declined" = owner has nothing to rent at all, ever, or is not interested / not engaging. "Nothing currently" / "nothing at the moment" / "nothing at this time" mean exactly the same thing as "nothing now" — all count as declined when no future date is given (see future_availability below for when one is).
"interested" = owner gives a GENUINE, substantive signal they have (or might have) a property — concrete details (a town, a price, a property description), OR an affirmation that clearly answers "do you have something to rent" specifically ("Yes, I have one", "Yes, apartment in Sliema available", "I have a 2 bedroom coming available next week"). Includes "nothing NOW" only if no future date was mentioned (that case is "future_availability" instead).
"unclear" = can't tell yet whether a property actually exists — this INCLUDES a bare social affirmative or pleasantry with no property content ("Yes of course", "Sure", "No problem", "Hello my friend", "Hi there") even though it sounds positive. A generic greeting or politeness is not evidence a property exists; a false "interested" here is worse than one extra clarifying question — it produces a nonsensical next question (e.g. asking about bedrooms/pets on a message that never confirmed a property at all). Real example that must classify as "unclear", not "interested": owner replies "Hello my friend" then "Yes of course" to an outreach asking about availability — neither sentence states or implies a property exists, so this is unclear, not interested.
"future_availability" = owner currently has nothing, but named a future point they expect to ("nothing now, maybe September").
"referral" = owner pointed to someone else (a relative, agent, etc.) as the actual decision-maker or contact, ideally with a way to reach them — fill "referral". A bare term of address like "my friend" with nobody else described is NOT a referral by itself.
"external_source" = owner says the details are elsewhere (Excel, PDF, a link, "check the list I sent") rather than typing them here.
"availableDate" is WHEN the property becomes free / the move-in date (e.g. "now", "from October", "1st November") — it is NEVER a yes/no restating whether they have something to rent at all; that is already the "intent" field above, so do not put "yes"/"no" in availableDate.
"viewableDate" is a SEPARATE question from availableDate — when someone could come view the place, which can differ from when it's actually free.
"propertyCategory": read what TYPE of property the owner is describing, if any is stated or implied. "residential" = apartment/house/villa/studio/flat/penthouse/maisonette/room/etc — the everyday case. "commercial" = warehouse/office/garage/shop/retail unit/industrial unit/storage/land/etc — a business/non-residential space. Leave null if nothing about the type has been said yet; do not guess residential as a silent default.
Only fill "extracted" fields the owner ACTUALLY stated or clearly implied — never guess or invent a value.`

const NEXT_MESSAGE_PROMPT = `You are a friendly, human-sounding WhatsApp assistant for 2906 Real Estate (Malta). You are mid-conversation with a property owner who said they might have something to rent out. Read the conversation so far, then write the SINGLE next WhatsApp message to send.

${EXTRACTION_RULES}

Rules for the message itself:
- Ask about ONLY ONE thing: {{ASK_ABOUT}} — unless very few items remain overall, in which case two closely-related ones may be combined naturally in one sentence; never combine three or more. This is a FIXED system decision made outside this prompt, not a suggestion for you to weigh — even when the conversation log looks sparse (e.g. this is the very first reply you're writing, with no visible earlier bot question in the log — the actual outreach pitch already went out through a different channel and simply isn't shown here) and some OTHER question would feel like the more natural opener to you, {{ASK_ABOUT}} is still the one and only thing to ask. Never substitute your own judgment about what to ask first.
- Keep it short (1-2 sentences), warm, natural — like a real person texting, not a form.
- Kev, 2026-09-01 (explicit tone correction): sachlich-freundlich, not hyped.
  Never use "great news!", "amazing!", "fantastic!", exclamation-heavy
  enthusiasm, or salesy language — this is a calm, factual, friendly text,
  not a pitch. A correct example he approved: "Thanks for updating, I
  forward and keep you posted in case." — short, factual, no overselling.
- Kev, 2026-09-02: never use a hyphen/dash bullet, a numbered list, or any
  other list formatting — one or two flowing sentences, written the way a
  person actually types on WhatsApp. A list reads like a system message,
  not a human typing.
- Do not repeat information the owner already gave.
- Do not use their name if you don't know it.
- Never invent facts about the property.
- If the owner just asked YOU a question (e.g. about your clients' budget/nationality), address that first if you can answer it safely; otherwise say you'll check and get back to them — do not just barrel ahead with your own next question.

Return ONLY a JSON object: { "reply_message": string, ${EXTRACTED_SCHEMA_TEXT} }
"availableDate" (when it's free / move-in date) and "viewableDate" (when it can be viewed) are two different things — never conflate them, and never put a yes/no in either.
Fill "extracted" with anything NEW the owner stated in their latest message(s) below — never guess.`

// ── Frustration / automation-failure signal (Point I) ────────────────────
// Real incident: owner asked "Are you reading my messages?" after the bot
// repeated a question it had already gotten a clear answer to. The instant
// a human notices the automation is failing, the automation has lost the
// right to keep going on its own -- checked on EVERY owner turn, not just
// the first one, since this can surface mid-checklist just as easily as at
// the start.
const FRUSTRATION_PROMPT = `You are checking a WhatsApp message from a property owner for signs that the automated conversation should immediately stop because the owner is frustrated, confused about what is happening, suspects a bot, says the exchange makes no sense, asks which property/client is even being discussed, or indicates the assistant is not following. Examples: "Are you reading my messages?", "I already told you", "I just answered this", "Please read above", "Why are you asking again?", "Are you a bot?", "This makes no sense", "Which apartment?", "What do you mean?", "Am I speaking Chinese?". Return ONLY {"frustrated": true|false}.
The line is accusation vs. curiosity: frustrated = the owner is complaining ABOUT the assistant/conversation itself — it's confusing THEM, repeating itself, not making sense, seems fake/broken ("you are confusing me", "this doesn't make sense", "you're not understanding me"). NOT frustrated = a neutral, non-accusatory question about the current question's relevance ("why are you asking this?", "why do you need that?", "what for?") with nothing before it suggesting a repeated or broken interaction — that is just unclear, still worth a plain answer. When in doubt: does the sentence criticise the assistant/conversation, or just query one question's purpose? Only the former is frustrated.
You are given ONLY this one message, no surrounding conversation — you cannot see whether anything was actually repeated or broken. A plain, businesslike statement (an opening message, a fact, a pointer to a document/link, a short reply) is NEVER frustrated just because it is short, curt, or terse in tone — only mark frustrated when the wording itself unmistakably complains about being misunderstood/repeated/not-read/bot-like, of the kind the examples show. Default to false whenever it is genuinely ambiguous.
"Already" is not itself a frustration signal — "I already told you [X]" (a claim that THIS conversation/assistant was told something and isn't registering it) IS frustrated, but "everything is in the file/Excel/link I already sent you" (pointing to a document sent through some other channel, e.g. email or a prior WhatsApp attachment) is just handing over information via a different medium — NOT frustrated, regardless of "already".
Kevin prefers one unnecessary stand-down over one strange automated follow-up. Treat direct confusion such as "what do you mean?", "I don't get it", "which property?", or "what is this about?" as frustrated=true. A normal factual answer or an ordinary property question without confusion remains false.`

async function detectFrustration(text) {
  const result = await callGemini(FRUSTRATION_PROMPT, text)
  if (result && typeof result.frustrated === 'boolean') return result.frustrated
  const lower = String(text || '').toLowerCase()
  const patterns = [
    /are you (even )?reading (my|this|these)/,
    /i (already|just) (told|said|answered|explained)/,
    /i said that (already|before)/,
    /already (answered|told|explained) (that|this|you)/,
    /(please )?read (above|up|back|again)/,
    /why (are you|do you|would you) ask(ing)? (again|the same|that again)/,
    /why (are you|do you|you) keep ask(ing)?/,
    /are you (a )?bot/,
    /(this is|you'?re) (not making sense|repeating (yourself|itself)|broken)/,
    /stop ask(ing)? (me )?(the )?same/,
    /you\s*(?:'re|are) confusing me/,
    /i don'?t understand what you want/,
    /what do you mean/,
    /i don'?t (understand|get) (this|you|what)/,
    /(which|what) (apartment|property|listing|place)/,
    /(are you|is this) (an? )?(ai|bot|robot|automatic|automated)/,
    /am i (speaking|talking) (chinese|to myself)/,
    /what (are you talking about|is going on|is this about)/,
    /why are you (telling|asking) me (this|that)/,
  ]
  return patterns.some(re => re.test(lower))
}

// ── External information source (Point E, reconciled 2026-09-03) ─────────
// "Check the Excel" / "it's all in the sheet I sent" etc. -- checked on
// every turn (first message or mid-checklist) since owners say this at any
// point. Kev's explicit rule: Kimi must NEVER try to read/extract the
// link/file itself, even when technically fetchable. Whether the WHOLE
// conversation hands off or just skips the one deflected field depends on
// how much is already known when it happens -- see the branch at the call
// site (Point E block) and countKnownFields() below for the reasoning. A
// URL in the text is pulled out so the escalation carries a clickable link,
// not just a quote.
function looksLikeExternalSource(text) {
  const lower = String(text || '').toLowerCase()
  // Kev, 2026-09-01 (catalog tests): added link/website/pdf/google sheet --
  // an owner pointing at ANY source outside this chat must hand off, never
  // be read by the bot itself.
  return /\b(excel|spreadsheet|the sheet|google sheet|attached (file|list|excel|sheet)|see attached|kindly check|already sent (you )?(the|all)|all (the )?(info|details|information) (is|are) in|check (the )?(list|pdf|excel|sheet)( above)?|in the (list|file|document|excel|sheet|link) i sent|(?:everything|all (?:the )?(?:details|info|information)?) is in the (?:link|pdf)|\bsee (?:the )?website\b|\bcheck (?:the )?website\b|the (link|pdf|website)\b)\b/.test(lower)
}

// Kev, 2026-09-03: real progress vs. nothing-yet, for Point E below. Counts
// actual property facts on the checklist -- every internal bookkeeping key
// this file writes is `_`-prefixed (see _classified/_log/_pending/etc.), so
// this stays correct as new fields are added later without needing its own
// hardcoded field list.
function countKnownFields(checklist) {
  return Object.keys(checklist || {}).filter(k =>
    !k.startsWith('_') && k !== 'photos' && k !== 'videos' &&
    checklist[k] != null && checklist[k] !== ''
  ).length
}

function extractUrl(text) {
  const m = String(text || '').match(/https?:\/\/\S+/i)
  return m ? m[0].replace(/[).,]+$/, '') : null
}

// ── Referral (Point G, extended 2026-08-31 — Point A) ────────────────────
// "Contact my sister +356..." -- extracted so the lead is never simply
// dropped. With a phone number present, forwardReferral() below auto-
// messages that contact directly; without one, looksLikeReferralWithoutNumber
// drives a natural "can you send me their number?" follow-up instead of
// silently doing nothing.
//
// Owner-AI judgement fix (Kev, real "Lee" incident): family terms
// (sister/brother/wife/...) are reliable -- nobody greets a business
// contact "hello my brother" in this context. "friend"/"agent"/"partner"/
// "colleague" are NOT reliable on their own -- they are common terms of
// ADDRESS ("Hello my friend") with zero introduction of anyone else at
// all. The real incident: "Hello my friend" / "Yes of course" alone
// tripped the old single regex and produced a nonsensical "could you send
// me their number?" follow-up. Split into two tiers: the ambiguous words
// only count as referral language when the SAME text also carries a
// genuine third-party signal (a pronoun referring to someone ELSE, or a
// delegation-shaped phrase) -- a bare greeting never does.
const REFERRAL_FAMILY_RE = /\bmy (sister|brother|wife|husband|son|daughter|father|mother|dad|mom)\b/i
const REFERRAL_ACTION_RE = /\b(contact|ask|call|speak (?:to|with)) (her|him|them)\b/i
const REFERRAL_AMBIGUOUS_RE = /\bmy (friend|agent|partner|colleague)\b/i
const THIRD_PARTY_SIGNAL_RE = /\b(he|she|they|him|her|them|his|hers|their|can help|will (call|contact|reach)|has (an|a)|is looking)\b/i

function hasReferralLanguage(text) {
  const t = String(text || '')
  if (REFERRAL_FAMILY_RE.test(t) || REFERRAL_ACTION_RE.test(t)) return true
  return REFERRAL_AMBIGUOUS_RE.test(t) && THIRD_PARTY_SIGNAL_RE.test(t)
}

function extractReferral(text) {
  const phoneMatch = String(text || '').match(/(\+?\d[\d\s\-().]{6,}\d)/)
  if (!phoneMatch) return null
  if (!hasReferralLanguage(text)) return null
  return { contact: phoneMatch[1].replace(/[\s().]/g, '').trim() }
}

function looksLikeReferralWithoutNumber(text) {
  const t = String(text || '')
  return hasReferralLanguage(t) && !/(\+?\d[\d\s\-().]{6,}\d)/.test(t)
}

// ── Future availability (Point G) ─────────────────────────────────────────
// "Nothing now, contact me in November" is NOT a plain decline -- it is a
// clean close of THIS outreach plus a follow-up reminder, via the existing
// reminderDetector.js/reminderFromMessage.js bridge (kept as-is, reused
// here rather than duplicated).
function looksLikeFutureAvailability(text) {
  const lower = String(text || '').toLowerCase()
  // GOLDEN-SCRIPT Fall 2 (Kev, 2026-09-06, real gap found live-testing Kev's
  // own annotated transcript): his own exact wording "Not in the moment,
  // maybe later this year" used "not IN the moment" -- the original regex
  // only recognized "not AT (the) moment", so this whole real example fell
  // through to the ordinary MUST-field flow instead of Fall 2. Added "in"
  // as an accepted preposition alongside "at".
  const negNow = /\b(nothing (now|at the moment|currently)|not (right )?now|not (?:at|in) (?:the )?moment|no vacancy (now|currently)|nothing (available|to rent) (now|at the moment|currently))\b/.test(lower)
  // Kev, 2026-09-01 (catalog test): "nothing now maybe September" -- a bare
  // month name (no "in"/"from" preposition) still counts as a future cue
  // once negNow is already true, so "maybe September" isn't missed just
  // because it skips the preposition.
  const futureCue = /\b(in (january|february|march|april|may|june|july|august|september|october|november|december)|next month|in \d+ (weeks?|months?)|from (october|november|december|january|february|march|april|may|june|july|august|september)|maybe (in|next)|later this year|contact me (in|next)|try (me )?(again )?in|(january|february|march|april|may|june|july|august|september|october|november|december))\b/.test(lower)
  // Kev, 2026-09-01 (catalog test): "contact me next month" / "try me in 2
  // weeks" stand on their own -- an explicit deferral request needs no
  // separate "nothing available now" disclaimer to read as future-
  // availability rather than a flat decline or unclear reply.
  // GOLDEN-SCRIPT Fall 2 (Kev, 2026-09-06): "come back to me in 2 weeks" is
  // Kev's own exact wording -- "come (back)? (to me)?" added alongside the
  // original contact/call/text/message/try/ask verb list, same real gap as
  // negNow above (his own transcript used phrasing the detector didn't
  // cover yet).
  const explicitDeferral = /\b(?:contact|call|text|message|try|ask|come(?: back)?) (?:to )?me (again )?(next (week|month)|in \d+ (weeks?|months?)|later)\b/.test(lower)
  // Kev, 2026-09-14 (conversation-fixes spec, item 3): "No, I have clients
  // till 1st March 2027" is the same Fall-2 shape as "nothing now, maybe
  // September" -- occupied until a future date -- but negNow only ever
  // matched "nothing/not available NOW" phrasing, never "I already HAVE
  // tenants/clients". Without this, that exact real-world reply fell
  // through to the ordinary MUST-field flow, and the very next message was
  // "would you consider tenants with pets?" straight after the owner had
  // just said the flat is taken until 2027.
  const alreadyOccupied = /\b(?:have|has|got)\s+(?:clients?|tenants?|someone|people)\b/.test(lower)
    || /\balready\s+(?:rented|taken|let|leased)\b/.test(lower)
  return (negNow && futureCue) || explicitDeferral || (alreadyOccupied && futureCue)
}

// ── FILE-FIRST OWNER INTAKE (Kev, 2026-09-22 hotfix) ──────────────────────
// "In the PDF it already says 1 bedroom, 1 bathroom, €1200/month, Long Let,
// availability -- yet the bot still asks Bedroom, Bathroom, and even the
// price again." Root cause: a document attachment was flagged `[document]`
// (see the sentinel below) and NEVER actually read -- Point E further down
// acknowledges it and hands off to Kev for "manual entry" while Stage 2/3/4
// keep asking whatever fields are still empty, which is every field when
// the PDF was the owner's whole reply. The 2026-09-03 "never read the
// link/file" decision was written for arbitrary external URLs (Excel/
// Google Sheet links a fetch could hit anything with); a WhatsApp document
// ATTACHMENT is not that -- it is already sitting on our own WAHA session,
// one authenticated media fetch away, the exact same mechanism the photo
// path below already uses. One Gemini document/vision call, same client
// and JSON contract as callGemini/classifyIntent, reusing EXTRACTION_RULES
// and the EXACT SAME EXTRACTED_SCHEMA_TEXT shape a text turn already
// produces -- so the result feeds straight into mergeExtracted() with zero
// new merge logic, and "never re-ask a field we already know" is inherited
// for free instead of reimplemented.
const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024 // Gemini inline data tops out around 20MB; stay well under it
const FILE_EXTRACTION_CALL_TIMEOUT_MS = 45_000
const FILE_EXTRACTION_PROMPT = `You are reading a document or image a property owner just sent in a WhatsApp conversation with a Malta real-estate agency (2906 Real Estate). The file may be a PDF flyer/brochure/price list, a spreadsheet screenshot, or a scanned listing for a property they want to rent out.

${EXTRACTION_RULES}

Read the WHOLE file and extract every property fact it states. Return ONLY a JSON object:
{ "readable": true|false, "prominent_contact_details": true|false, ${EXTRACTED_SCHEMA_TEXT} }

"readable" = false ONLY when the file is empty, corrupted/unopenable, or carries no property information at all (e.g. an ID card, an unrelated invoice, a blank page). If the file carries ANY usable property information, "readable" is true even when some fields are still missing from it.
There is no dedicated field for rental mode -- if the file states long let / long term, short let / holiday let, or winter let / seasonal (with or without an "until" month), put that as free text into "notes" (e.g. "Winter let, available until April").
"prominent_contact_details" is true when the document visibly promotes a phone number, email, agent contact block, website or social handle.
Never invent a value that is not actually shown in the file.`

async function extractFromFileAttachment(buffer, mimeType) {
  const ai = getGeminiClient()
  if (!ai || !buffer || !buffer.length) return { readable: false, extracted: null }
  for (const model of ['gemini-2.5-flash', 'gemini-flash-latest']) {
    try {
      const r = await Promise.race([
        ai.models.generateContent({
          model,
          contents: [{
            role: 'user',
            parts: [
              { inlineData: { mimeType: mimeType || 'application/pdf', data: buffer.toString('base64') } },
              { text: FILE_EXTRACTION_PROMPT },
            ],
          }],
          config: { temperature: 0, maxOutputTokens: 800, responseMimeType: 'application/json' },
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('gemini file-extraction timeout')), FILE_EXTRACTION_CALL_TIMEOUT_MS)),
      ])
      const text = (r.text || '').replace(/```json|```/g, '').trim()
      if (!text) continue
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object') {
        return { readable: parsed.readable !== false, prominentContactDetails: parsed.prominent_contact_details === true, extracted: parsed.extracted || null }
      }
    } catch (err) {
      log.warn('autoOwnerConversation: file extraction failed', { model, mimeType, err: err.message })
    }
  }
  return { readable: false, extracted: null }
}

async function classifyIntent(combinedText) {
  const result = await callGemini(CLASSIFY_PROMPT, combinedText)
  const localExtracted = localExtractAll(combinedText)
  if (result && result.intent) {
    return { intent: result.intent, extracted: mergeLocalOverKimi(localExtracted, result.extracted) }
  }
  // Fallback: crude keyword classifier so the flow never breaks if Gemini is
  // down -- but still extracts whatever localExtractAll can find, so a
  // first message that both states intent AND volunteers details (Point C:
  // "3 bedroom in Mellieha") captures both in this one step, Kimi or not.
  const lower = combinedText.toLowerCase()
  // Kev, 2026-08-31 -- word-boundary matched, not a plain .includes(): a
  // bare substring check on "no" matches inside "now", "known", "renovate"
  // etc. and would misclassify a perfectly normal reply as declined.
  const negWords = [/\bno\b/, /\bnothing\b/, /\bnot available\b/, /\bnein\b/, /\brented already\b/]
  // Owner-AI judgement fix (real "Lee" incident): "yes"/"sure"/"ja" alone
  // are bare social affirmatives -- they confirm the owner is THERE and
  // polite, not that a property exists. "available"/"have" are substantive
  // claims (they assert something concrete) and still count as interested
  // on their own; a bare affirmative with nothing else falls through to
  // "unclear" instead, same conservative principle as the Gemini prompt
  // below (a false "interested" is worse than one extra clarifying
  // question -- easy to re-contact later, an unsinnige checklist question
  // right after a greeting is not).
  const strongPosWords = [/\bavailable\b/, /\bhave\b/]
  const bareAffirmatives = [/\byes\b/, /\bsure\b/, /\bja\b/]
  // Kev, 2026-08-31 (Prompt 2 T8) -- an owner who describes concrete
  // property facts ("Nice apartment in Sliema") is obviously engaging even
  // without a bare "yes"/"have"; asking "do you have a property?" right
  // after they just described one would be exactly the kind of dumb
  // redundant question this whole rewrite exists to prevent.
  const hasConcreteSignal = localExtracted.town || localExtracted.price != null ||
    localExtracted.bedrooms != null || localExtracted.bathrooms != null ||
    localExtracted.propertyCategory != null
  // Kev, 2026-09-01 (real bug found via the catalog tests): hasConcreteSignal
  // is checked BEFORE negWords now -- "professionals only, no smoking
  // inside" landed on a bare \bno\b (from "no smoking") and discarded an
  // entire multi-fact message (price/beds/baths/town all extracted) as a
  // flat decline. A message carrying real property facts is never a
  // decline, no matter what unrelated "no ..." condition it also mentions.
  if (hasConcreteSignal) return { intent: 'interested', extracted: localExtracted }
  if (negWords.some(re => re.test(lower))) return { intent: 'declined', extracted: localExtracted }
  if (strongPosWords.some(re => re.test(lower))) return { intent: 'interested', extracted: localExtracted }
  // bareAffirmatives (yes/sure/ja) explicitly still land on 'unclear', same
  // as no match at all -- which asks the ONE natural clarifying question
  // ("do you have a property available?") rather than guessing a property
  // exists from politeness alone. The explicit check (vs just falling
  // through) documents that this is a deliberate classification, not a
  // gap nobody thought about.
  if (bareAffirmatives.some(re => re.test(lower))) return { intent: 'unclear', extracted: localExtracted }
  return { intent: 'unclear', extracted: localExtracted }
}

// Kev, 2026-08-30: 2-3 phrasings per field (picked at random) instead of one
// fixed string, plus a rotating short acknowledgment prefix -- so a Kimi
// outage (or just several turns of the same field) doesn't read as the bot
// robotically repeating itself verbatim.
const ACK_PREFIXES = ['Great, noted —', 'Perfect, thank you —', 'Got it, thanks —', 'Lovely, thanks —']
const FALLBACK_QUESTIONS = {
  price: ['what would the monthly rent be?', 'roughly what’s the rent per month?'],
  bedrooms: ['how many bedrooms does it have?', 'how many bedrooms are there?'],
  bathrooms: ['and how many bathrooms?', 'how many bathrooms does it have?'],
  town: ['which town or area is it in?', 'what town/area is the property in?'],
  available_date: ['and when would it be available from?', 'roughly when would it be free from?'],
  viewable_date: ['roughly when could someone come view it?', 'when would it be possible to view it?'],
  photos: ['could you send a couple of photos when you get a chance?', 'any chance you could share a few photos?'],
  map: ['would you be able to share the address or a map pin?', 'could you send the address or a map location?'],
  commercial_use: ['what kind of commercial property or permitted use is it?', 'what is the space intended or permitted for?'],
  permit_info: ['what permits or licences does the property currently have?', 'could you tell me the permit or licence status?'],
  size_sqm: ['roughly how many square metres is it?', 'what is the approximate size in sqm?'],
  condition: ['what condition is it in — shell, finished or furnished?', 'is it shell form, finished or furnished?'],
  development_stage: ['is it on-plan, under construction or already built?', 'what stage is it at — on-plan, being built or completed?'],
  plans: ['do you have any plans or PDFs you can share?', 'could you send any available floor plans or permit PDFs?'],
  // Kev, 2026-09-01 (Gestufte Fragen-Priorität): exact wording he gave for
  // Stage 3/4 -- kept verbatim, not varied, since he was deliberate about
  // the phrasing here (unlike the generic MUST-field questions above).
  pets: ['Is there any chance you may consider pets in any scenario, if the clients are very good &/or the pet is insured?'],
  sharing: ['Do you consider professional sharing in the apartment?'],
  subletting: ["One last question, sorry for the spam, but I want to make sure I ask before I don't and you somehow accept it. If I have super serious subletting companies with very interesting offers for you, would you may consider it?"],
}
function pickOne(arr) { return arr[Math.floor(Math.random() * arr.length)] }

// Kev, 2026-08-31 (Prompt 2 tone rule / T13) -- a confirmation phrase
// before EVERY single question is itself a bot-tell; real people often
// skip it entirely. Only prepend one some of the time, and only ever ONE
// question, never chained onto a second unrelated ack.
function buildFallbackQuestion(askAboutField) {
  const questionPool = FALLBACK_QUESTIONS[askAboutField]
  const question = questionPool ? pickOne(questionPool) : 'tell me a bit more?'
  if (Math.random() < 0.4) return `${pickOne(ACK_PREFIXES)} ${question}`
  return question.charAt(0).toUpperCase() + question.slice(1)
}

// Defense in depth for the NEXT_MESSAGE_PROMPT "no list formatting" rule
// (2026-09-02) — a negative instruction in a prompt is a strong steer, not a
// guarantee, and this codebase's own convention elsewhere (the category-
// group leak guard) is to back a prompt rule with a hard check on the
// actual output rather than trust the model alone. Collapses any
// hyphen/bullet/numbered-list line into flowing text before it can ever
// reach an owner looking like a system message.
function stripListFormatting(text) {
  const s = String(text || '')
  if (!/(^|\n)\s*(?:[-*•]|\d+[.)])\s+/m.test(s)) return s
  return s
    .split(/\n+/)
    .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
    .filter(Boolean)
    .join(' ')
}

async function buildNextMessage(askAboutField, conversationLog, ownerLatestText) {
  const askAbout = FIELD_LABEL[askAboutField] || askAboutField
  const prompt = NEXT_MESSAGE_PROMPT.replace('{{ASK_ABOUT}}', askAbout)
  const context = `Conversation so far:\n${conversationLog}\n\nOwner's latest message(s):\n${ownerLatestText}`
  const result = await callGemini(prompt, context)
  // Kev, 2026-08-31 (Prompt 2 T2) -- targeted extraction (what THIS
  // question was asking) stays authoritative for its own field, but the
  // broader opportunistic pass catches anything else volunteered in the
  // same reply ("September. 2 bathrooms btw and pets are fine" answers a
  // bathroom question with three facts at once). Opportunistic first,
  // targeted spread on top so it wins on the field it's actually about.
  const opportunistic = localExtractAll(ownerLatestText)
  const targeted = localExtract(askAboutField, ownerLatestText)
  const localExtracted = { ...opportunistic, ...targeted }
  if (result && result.reply_message) {
    // STYLE-1 (Kev, 2026-09-04): "NEVER an em-dash in any generated
    // message" -- same defense-in-depth shape as stripListFormatting
    // directly above (a hard check on the actual output, not just a prompt
    // rule the model could ignore). Chained after stripListFormatting on
    // purpose -- list-collapsing runs first so an em-dash the join left
    // behind still gets caught.
    return { reply_message: styleLearning.stripEmDash(stripListFormatting(result.reply_message)), extracted: mergeLocalOverKimi(localExtracted, result.extracted) }
  }
  // Deterministic fallback if Gemini is unavailable.
  const replyMessage = styleLearning.stripEmDash(buildFallbackQuestion(askAboutField))
  return { reply_message: replyMessage, extracted: localExtracted }
}

// Kev, 2026-08-31 (Prompt 2, "Korrekturen: neuerer expliziter Wert
// gewinnt") -- "Sorry 1650 not 1600" should end up as price=1650 with the
// old value kept as previous_price, not just silently overwritten. Only
// triggers when there's an actual correction cue AND the new value differs
// from what was already on file -- a normal first-time price merge is not
// a "correction" of anything.
const CORRECTION_CUE_RE = /\b(sorry|actually|i mean|correction|my mistake)\b/i

function mergeExtracted(checklist, extracted, rawText) {
  if (!extracted) return checklist
  const next = { ...checklist }
  // Kev, 2026-09-10 (Owner Auto-Upload finalize, exact regression test:
  // "2100." / "Monthly." ... later "Sharing? Yes but price will be euro
  // 2500." must NEVER become general_price=2500) -- a price mentioned while
  // THIS reply is the one resolving the sharing/subletting question is a
  // CONDITIONAL price, not a correction of the base rent. Determined the
  // same way the pets/sharing/subletting asked-field binding below already
  // works: the immediately preceding bot question is still recorded
  // (_asked_sharing/_asked_subletting) and that field has no value yet, so
  // this exact turn is what resolves it. Only ever routes an incoming price
  // away from `next.price` in that narrow window -- a price volunteered on
  // any other turn (including a genuine "actually rent is 2200" correction)
  // takes the normal general-price path below, completely unchanged.
  // "== null" alone would trust a corrupted non-yes/no value (e.g. stray
  // raw text from an unrelated field) as if it were already a real answer --
  // treating anything other than a genuine 'yes'/'no' as still-unresolved
  // is a cheap extra safety net on top of the localExtract fix above.
  const isUnresolvedYesNo = v => v == null || (v !== 'yes' && v !== 'no')
  const answeringSharingNow = next._asked_sharing && isUnresolvedYesNo(next.sharing) &&
    (extracted.sharing === 'yes' || (rawText && extractSharingMention(rawText) === 'yes'))
  const answeringSublettingNow = next._asked_subletting && isUnresolvedYesNo(next.subletting) &&
    (extracted.subletting === 'yes' || (rawText && extractSublettingMention(rawText) === 'yes'))

  if (extracted.price != null && answeringSharingNow) {
    next.sharing_price = extracted.price
  } else if (extracted.price != null && answeringSublettingNow) {
    next.subletting_price = extracted.price
  } else if (extracted.price != null) {
    // Kev, 2026-08-31 -- "isNewValue" guards both corrections AND the
    // confidence marker. Without it, a SAME turn's second buildNextMessage
    // call (picking the genuinely-next field, after this one resolved) can
    // re-derive the SAME price via the un-hedged standalone-number pass and
    // incorrectly wipe out a confidence tag the FIRST pass just set for
    // that identical value -- only a value that's actually CHANGING should
    // ever touch previous_price or clear an existing hedge.
    const isNewValue = next.price == null || next.price !== extracted.price
    if (next.price != null && isNewValue && rawText && CORRECTION_CUE_RE.test(rawText)) {
      next.previous_price = next.price
    }
    next.price = extracted.price
    if (extracted._priceConfidence || extracted.priceConfidence) {
      next._confidence_price = extracted._priceConfidence || extracted.priceConfidence
    } else if (isNewValue && next._confidence_price) {
      delete next._confidence_price // a fresh, different, non-hedged value supersedes an old hedge
    }
  }
  // Owner-AI judgement fix: property_category, once known, never flips back
  // to unset -- a later message going quiet on type doesn't erase an
  // earlier "it's a warehouse". A later EXPLICIT statement of a different
  // type still wins (an owner correcting themselves), same "newer explicit
  // value wins" principle as price/date elsewhere in this function.
  if (extracted.propertyCategory) next.property_category = extracted.propertyCategory
  if (extracted.transactionType) next.transaction_type = extracted.transactionType
  if (extracted.commercialUse) next.commercial_use = extracted.commercialUse
  if (extracted.size_sqm != null) next.size_sqm = extracted.size_sqm
  if (extracted.condition) next.condition = extracted.condition
  if (extracted.developmentStage) next.development_stage = extracted.developmentStage
  if (extracted.listingKind) next.listing_kind = extracted.listingKind
  if (extracted.tenure) next.tenure = extracted.tenure
  if (extracted.permit_info) next.permit_info = extracted.permit_info
  if (extracted.bedrooms != null) next.bedrooms = extracted.bedrooms
  if (extracted.bathrooms != null) next.bathrooms = extracted.bathrooms
  if (extracted.town && !isInvalidTownValue(extracted.town)) next.town = extracted.town
  // Kev, 2026-09-01 (explicit correction): a vague reply to the town
  // question never becomes `town` -- it's preserved as free-text context
  // only, town stays UNKNOWN, and (per nextMissingField/checkOptionalStopRule
  // needing SOME resolution to move on) the field must still count as
  // "handled" so the bot doesn't loop back to it -- see the MUST-field
  // unresolved marking in processStep, which this feeds by leaving
  // `town` unset but `_ask_count_town` already incremented there.
  if (extracted.location_text) next.location_text = extracted.location_text
  if (extracted.availabilityConflict) {
    next._availability_conflict = String(extracted.availabilityConflict).slice(0, 300)
    delete next.available_date
    delete next.viewable_date
    delete next.address
  }
  if (extracted.availableDate && !looksLikeOccupancyConflict(extracted.availableDate)) {
    const isNewDate = next.available_date == null || next.available_date !== extracted.availableDate
    next.available_date = extracted.availableDate
    if (extracted._availableDateConfidence || extracted.availableDateConfidence) {
      next._confidence_available_date = extracted._availableDateConfidence || extracted.availableDateConfidence
    } else if (isNewDate && next._confidence_available_date) {
      delete next._confidence_available_date
    }
  }
  if (extracted.viewableDate && !looksLikeOccupancyConflict(extracted.viewableDate)) next.viewable_date = extracted.viewableDate
  // Client/Owner-Flow-Korrekturen Part 4 (real bug found: the bot silently
  // stopped asking for photos even deep into the optional cascade -- e.g.
  // subletting already asked -- though none had ever actually been sent).
  // Root cause: this used to also accept extracted.hasPhotos === false from
  // Kimi's own text-only read of ANY unrelated turn -- EXTRACTION_RULES
  // (media_received) only tells the model to set true on a genuine
  // mention; nothing tells it to emit null rather than false when photos
  // simply were not mentioned at all, and a tri-state boolean field like
  // this defaults to false far more often than to null in practice. A
  // single false reading permanently marked checklist.photos "resolved"
  // (not undefined/null), so nextMissingField() never asked again for the
  // rest of the conversation. Only a genuine POSITIVE signal from the text
  // side may ever close this field now; a negative/unclear reading leaves
  // it untouched (still missing), so it keeps being asked exactly like any
  // other un-resolved field instead of being silently closed on a guess.
  // The real ground truth -- actual media received -- is the separate
  // `[media]` sentinel handling in processStep, completely unaffected by
  // this change.
  if (extracted.hasPhotos === true) next.photos = true
  if (extracted.address) next.address = extracted.address
  if (extracted.pets) next.pets = extracted.pets
  if (extracted.sharing) next.sharing = extracted.sharing
  if (extracted.subletting) next.subletting = extracted.subletting
  // Kev, 2026-09-01 (real bug found testing the staged-questions work): an
  // ASK_ONCE field (map/pets/sharing/subletting) is marked "_asked_X" the
  // MOMENT its question is sent -- so by the time the owner's actual reply
  // arrives on the NEXT turn, nextMissingField has already moved past it,
  // and buildNextMessage's targeted extraction runs against whatever field
  // comes AFTER it instead, never against the field the reply is really
  // answering. localExtractAll's opportunistic keyword pass catches pets/
  // sharing/subletting some of the time (e.g. "pets are fine"), but map has
  // no keyword pattern at all -- an owner's address would otherwise never
  // land anywhere. Caught here, once, right after asking: if a field was
  // JUST asked (still in this same rawText's reply) and still has no
  // value, try it directly against the field it was actually asked about.
  if (rawText) {
    if (next._asked_map && next.address == null && looksLikeRealOptionalAnswer(rawText) && rawText.length <= 150) {
      next.address = rawText
    }
    if (next._asked_pets && next.pets == null) {
      const p = extractPetsMention(rawText)
      if (p) next.pets = p
    }
    if (next._asked_sharing && next.sharing == null) {
      const s = extractSharingMention(rawText)
      if (s) next.sharing = s
    }
    if (next._asked_subletting && next.subletting == null) {
      const su = extractSublettingMention(rawText)
      if (su) next.subletting = su
    }
  }
  if (extracted.notes && extracted.notes.length) {
    next.notes = [...new Set([...(next.notes || []), ...extracted.notes])]
  }
  // Kev, 2026-09-01 (Gestufte Fragen-Priorität): re-checked on every merge so
  // the STOP-RULE closes the optional cascade the instant it can be detected,
  // regardless of which of processStep's several call sites triggered this.
  return checkOptionalStopRule(next)
}

// ── Draft property write-back ─────────────────────────────────────────────
function unresolvedFieldNote(checklist) {
  const unresolved = fieldOrderFor(checklist).filter(f => checklist[`_unresolved_${f}`])
  return unresolved.length ? `Unresolved after asking (needs manual follow-up): ${unresolved.join(', ')}` : null
}

// Prompt 2: confidence markers, corrections, and free-text conditions must
// never silently vanish just because they don't have their own DB column.
function extraIntelligenceNotes(checklist) {
  const notes = []
  if (checklist._confidence_price) notes.push(`Rent is approximate (owner said "around"/"I think")`)
  if (checklist.previous_price != null) notes.push(`Owner corrected the rent from ${checklist.previous_price} to ${checklist.price}`)
  if (checklist._confidence_available_date) notes.push(`Available-from date is tentative (owner said "probably"/"maybe")`)
  // Kev, 2026-09-10 (Owner Auto-Upload finalize) — conditional pricing is
  // CRM-only metadata (spec point 2/11/28), never part of the public ad
  // copy, but it must not vanish from the CRM record either.
  if (checklist.sharing_price != null) notes.push(`Sharing price: €${checklist.sharing_price}/month (general price stays €${checklist.price})`)
  if (checklist.subletting_price != null) notes.push(`Subletting price: €${checklist.subletting_price}/month`)
  if (checklist.notes && checklist.notes.length) notes.push(...checklist.notes)
  return notes
}

// ── Owner-zu-Upload-Vollautomatisierung (Kev, 2026-09-08) — the step
// between "checklist complete in the owner chat" and "posted to AV
// CENTRAL", per Kev's own live clarification: NOT an instant, unreviewed
// auto-publish -- a ✅ reaction on the owner's own finishing message (the
// visible "todo done" signal), then the real photos + a natural-language
// text block into AV CENTRAL, exactly the shape !upload's own
// extractListing() already knows how to read (property details AND owner
// contact, mixed, in any order) -- Kev or an agent replies !upload5 on it
// and the EXISTING pipeline (two-package, categorisation, website/CRM/FB)
// does the rest, completely unchanged. Images always go out with NO
// caption, images first, then the text block, per Kev's explicit
// formatting rule ("kein text zum bild attached, Bilder first, dann text
// desc"). The same DIVIDER convention categoryPublisher.js already uses
// bookends the whole thing.
const DIVIDER = '...'

// ── "UNWRAP THAT SHIT" review pipeline (Kev, 2026-09-14) ────────────────────
// Do NOT rebuild the Owner Auto-Upload system -- everything above this point
// (the checklist state machine, the canonical renderer, armAutoPublish's
// timer, !upload5/!undo) is untouched. This is the review PACKAGE this file
// already sent to AV CENTRAL, now redirected to a dedicated review group and
// given the provenance/sanity-check structure Kev asked for, so a mistake in
// an automatic extraction is caught by a human glance before it ever
// publishes -- "PROPERTY DATA WITHOUT PROVENANCE IS NOT REVIEWABLE."
//
// Group joined 2026-09-14 via WAHA groups/join on the 'default' session
// (invite: chat.whatsapp.com/Kw9gzReikd7GFvJ4dWA5pT); Kevsecond/kevthirdd/
// Cedric were already members of it when Kev created it.
const UNWRAP_REVIEW_GROUP = '120363411957250231@g.us'
const COMMERCIAL_DRAFT_GROUP = '120363367051480633@g.us'
const SALE_DRAFT_GROUP = '120363409129396268@g.us'
const ROOMS_DRAFT_GROUP = '120363428864734725@g.us'

function draftGroupFor(checklist) {
  if (checklist?.property_category === 'commercial') return COMMERCIAL_DRAFT_GROUP
  if (checklist?.transaction_type === 'sale') return SALE_DRAFT_GROUP
  if (checklist?.listing_kind === 'room') return ROOMS_DRAFT_GROUP
  return UNWRAP_REVIEW_GROUP
}

function fmtTimestampMalta(d = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Malta', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  }).format(d) + ' Malta'
}

// Spec item 1: owner + agent/WA-profile provenance, NEVER missing. Falls
// back to the phone alone when the name is unknown -- never blocks the post
// over a lookup failure (best-effort, wrapped).
async function buildReviewProvenanceBlock({ phone, conversationId, collectingSession, postingSession }) {
  let ownerName = null
  try {
    const r = await db.query(
      `SELECT name FROM owner_contacts WHERE phone_normalized = $1 LIMIT 1`,
      [String(phone).replace(/\D/g, '')])
    ownerName = (r.rows[0] && r.rows[0].name) || null
  } catch (err) {
    log.warn('autoOwnerConversation: owner name lookup failed for review provenance', { err: err.message })
  }
  const lines = [
    `👤 Owner: ${ownerName || 'Unknown name'}`,
    `📞 +${phone}`,
    // Spec item 10: keep BOTH the account that actually ran the conversation
    // and the one physically sending this post if they differ (posting picks
    // whichever account is live right now via pickUploadSession() -- the
    // collecting account may be offline). The business record stays tied to
    // the Owner + Draft either way, never to whichever WA profile happened
    // to be online at post time.
    `🤖 Collected via: ${collectingSession || 'unknown'}`,
  ]
  if (postingSession && postingSession !== collectingSession) {
    lines.push(`📤 Sent via: ${postingSession} (fallback — ${collectingSession || 'unknown'} was offline)`)
  }
  lines.push(`🧾 Draft: PD-${conversationId || '?'}`, `🕐 ${fmtTimestampMalta()}`)
  return lines.join('\n')
}

// Spec item 2: the compact internal summary, BEFORE the public ad copy, so a
// bad extraction is caught here rather than on the published listing.
function buildStructuredDraftBlock(checklist) {
  const lines = ['PROPERTY DRAFT', '']
  if (checklist.town) lines.push(`📍 ${checklist.town}`)
  if (checklist.property_category) lines.push(`🏡 ${checklist.property_category === 'commercial' ? 'Commercial' : 'Residential'}`)
  if (checklist.listing_kind === 'room') lines.push('🚪 Room')
  if (checklist.bedrooms != null) lines.push(`🛏 ${checklist.bedrooms} Bedroom${Number(checklist.bedrooms) === 1 ? '' : 's'}`)
  if (checklist.bathrooms != null) lines.push(`🛁 ${checklist.bathrooms} Bathroom${Number(checklist.bathrooms) === 1 ? '' : 's'}`)
  if (checklist.price != null) lines.push(`💰 €${Number(checklist.price).toLocaleString()}${checklist.transaction_type === 'sale' ? '' : '/month'}`)
  if (checklist.available_date) lines.push(`🟢 Available: ${checklist.available_date}`)
  if (checklist.viewable_date) lines.push(`👀 Viewable: ${checklist.viewable_date}`)
  if (checklist.address) lines.push(`📌 ${checklist.address}`)
  if (checklist.size_sqm) lines.push(`📐 ${checklist.size_sqm} sqm`)
  if (checklist.commercial_use) lines.push(`🏭 Use: ${checklist.commercial_use}`)
  if (checklist.permit_info) lines.push(`📄 Permits: ${checklist.permit_info}`)
  if (checklist.condition) lines.push(`🧱 Condition: ${checklist.condition}`)
  if (checklist.development_stage) lines.push(`🏗 Stage: ${checklist.development_stage}`)
  const yn = v => v === 'yes' ? 'Considered' : v === 'no' ? 'No' : v
  if (checklist.property_category !== 'commercial') {
    if (checklist.pets) lines.push(`🐶 Pets: ${yn(checklist.pets)}`)
    if (checklist.sharing) lines.push(`👥 Sharing: ${yn(checklist.sharing)}`)
    if (checklist.subletting) lines.push(`🏢 Subletting: ${yn(checklist.subletting)}`)
  }
  return lines.join('\n')
}

// Spec item 3+4: force a review flag instead of silently publishing an
// extraction that does not add up. Never auto-corrects anything -- only
// ever adds a warning line; the values themselves are left exactly as
// extracted so a reviewer sees precisely what the system saw.
function buildSanityWarnings(checklist) {
  const warnings = []
  const beds = Number(checklist.bedrooms)
  const baths = Number(checklist.bathrooms)
  const price = Number(checklist.price)
  const bedsOk = Number.isFinite(beds)
  const bathsOk = Number.isFinite(baths)
  const priceOk = Number.isFinite(price)

  if (bedsOk && beds >= 8) {
    warnings.push(`⚠️ UNUSUAL BEDROOM COUNT — ${beds} bedrooms`)
  }
  // Exact shape from the spec: a large bedroom count, one bathroom, and a
  // normal/small price is one mis-extracted field wearing three symptoms,
  // not a real 12-bed flat at €1,350/month.
  if (bedsOk && bathsOk && priceOk && beds >= 8 && baths <= 1 && price < 2000) {
    warnings.push(`⚠️ PROPERTY DATA LOOKS INCONSISTENT — ${beds} bed / ${baths} bath at €${price.toLocaleString()}/month`)
  }
  // Defense in depth after the extractPrice/extractStandalonePrice fix
  // (2026-09-14, "year became price" incident, live on #2906 Msida): if a
  // price still comes out exactly year-shaped through some OTHER path (CRM
  // pre-fill, the Kimi/Gemini extraction this local fallback backstops),
  // flag it here too -- this is the review-layer safety net, not a
  // replacement for the extraction-layer fix.
  if (priceOk && YEAR_LIKE_RE.test(String(Math.round(price)))) {
    warnings.push(`⚠️ PRICE MAY BE WRONG — €${price.toLocaleString()} looks like a year, not a rent`)
  }
  if (checklist.town && isInvalidTownValue(checklist.town)) {
    warnings.push(`⚠️ INVALID LOCALITY — "${String(checklist.town).slice(0, 80)}" is not a town`)
  }
  const conflictText = checklist._availability_conflict || [checklist.available_date, checklist.viewable_date, checklist.address]
    .find(looksLikeOccupancyConflict)
  if (conflictText) {
    warnings.push('⚠️ AVAILABILITY NOT CONFIRMED — the owner says the current tenant may renew; human review required')
  }
  return warnings
}

function buildChecklistCardText(checklist, phone) {
  const bits = []
  if (checklist.bedrooms != null) bits.push(`${checklist.bedrooms} bedroom${Number(checklist.bedrooms) === 1 ? '' : 's'}`)
  if (checklist.bathrooms != null) bits.push(`${checklist.bathrooms} bathroom${Number(checklist.bathrooms) === 1 ? '' : 's'}`)
  const headline = bits.length ? bits.join(', ') : 'Property'
  const town = checklist.town ? ` in ${checklist.town}` : ''
  const price = checklist.price ? `, €${Number(checklist.price).toLocaleString()}/month` : ''
  const lines = [`${headline}${town}${price}`]
  if (checklist.available_date) lines.push(`Available: ${checklist.available_date}`)
  if (checklist.viewable_date) lines.push(`Viewable: ${checklist.viewable_date}`)
  if (checklist.address) lines.push(`Location: ${checklist.address}`)
  if (checklist.pets) lines.push(`Pets: ${checklist.pets}`)
  if (checklist.sharing) lines.push(`Sharing: ${checklist.sharing}`)
  if (checklist.subletting) lines.push(`Subletting: ${checklist.subletting}`)
  lines.push('', `Owner: +${phone}`)
  return lines.join('\n')
}

async function postChecklistCompleteToAvCentral(phone, checklist, { targetGroupId = null, targetSession = null, conversationId = null } = {}) {
  const { pickUploadSession } = require('../handlers/upload')
  const { __reactAs: reactAs } = require('./availability')
  // targetGroupId/targetSession: test-only override (Level-2 proof runs
  // post into Kev's own designated safe test group instead of the real
  // review group) -- production calls never pass these, so real behaviour
  // is completely unchanged. Kev, 2026-09-14: the default target moved from
  // AV_CENTRAL_GROUP/AV_CENTRAL_DEFAULT to the new "UNWRAP THAT SHIT" group
  // -- same post, same downstream !upload5/!undo pipeline, richer review
  // package, different room.
  const groupId = targetGroupId || draftGroupFor(checklist)
  let session = targetSession || await pickUploadSession().catch(() => null)
  // A WORKING account can still be absent from a specific group. Pick the
  // preferred bridge first, then another live member, so a disabled Argus1
  // or a newly connected Argus2 cannot silently drop a completed draft.
  if (!targetSession && (!session || !(await waha.isGroupMember(session, groupId)))) {
    const working = await waha.getWorkingSessions().catch(() => [])
    for (const candidate of working.map(item => item.name)) {
      if (await waha.isGroupMember(candidate, groupId)) { session = candidate; break }
    }
  }
  if (!session || !(await waha.isGroupMember(session, groupId))) {
    log.warn('autoOwnerConversation: no connected group member available for review post', { groupId })
    if (conversationId) {
      await db.query(
        `UPDATE owner_auto_conversations
            SET checklist = checklist || $1::jsonb, updated_at = NOW()
          WHERE id = $2`,
        [JSON.stringify({ _last_action: { action: 'review_post', status: 'queued_no_group_member', groupId, at: new Date().toISOString() } }), conversationId]
      ).catch(() => {})
    }
    return false
  }

  if (checklist._last_message_id) {
    await reactAs(session, checklist._last_message_id, '✅').catch(() => {})
  }

  // Spec item 10: the account that actually COLLECTED this conversation,
  // read straight off owner_auto_conversations -- independent of `session`
  // above, which is only ever the account posting THIS message right now.
  let collectingSession = null
  if (conversationId) {
    try {
      const r = await db.query(`SELECT session FROM owner_auto_conversations WHERE id = $1`, [conversationId])
      collectingSession = (r.rows[0] && r.rows[0].session) || null
    } catch (err) {
      log.warn('autoOwnerConversation: collecting-session lookup failed', { err: err.message })
    }
  }

  const photos = (checklist._photos || []).slice(0, 15)
  // Kev, 2026-09-10 (CANONICAL 2906 LISTING RENDERER): AV CENTRAL used to
  // see buildChecklistCardText's raw extraction form ("3 bedrooms, 2
  // bathrooms in Swieqi, EUR2,100/month\nPets: yes\n..."), never the actual
  // house-style ad copy -- Kev reviewed one thing and a completely
  // different thing (fbPostFetch's free-form Gemini polish) got published
  // if the timer ran out. Now the SAME rendered text is what Kev reviews,
  // what !upload5 would extract from if typed here, and what actually
  // publishes (see runAutoPublishJob below, which reuses the cached
  // canonicalFields this call persists rather than re-deriving anything).
  // buildChecklistCardText stays as the fallback ONLY if the canonical
  // renderer can't validate the draft yet -- posting the plain facts beats
  // posting nothing.
  const canonicalRenderer = require('./canonical2906Renderer')
  const cachedCanonical = checklist._canonical_fields || null
  const rendered = await canonicalRenderer.render2906Listing(checklist, { cachedCanonical }).catch(e => {
    log.warn('autoOwnerConversation: canonical render failed, falling back to plain facts card', { err: e.message })
    return { ok: false }
  })
  const cardText = rendered.ok ? rendered.text : buildChecklistCardText(checklist, phone)
  const warnings = buildSanityWarnings(checklist)
  try {
    // Spec item 8 — review package order: images first, then the internal
    // structured draft (provenance + values), then warnings if any, then
    // the public canonical listing, then the review-status footer.
    await waha.sendText(session, groupId, `${DIVIDER}\nINFOS`)
    await waha.sendText(session, groupId, buildStructuredDraftBlock(checklist))
    await waha.sendText(session, groupId, `PICS (${photos.length})`)
    for (const url of photos) {
      try {
        const imgRes = await fetch(url)
        const buf = Buffer.from(await imgRes.arrayBuffer())
        const mime = imgRes.headers.get('content-type') || 'image/jpeg'
        await waha.sendImage(session, groupId, buf.toString('base64'), mime, '') // no caption, ever
      } catch (e) {
        log.warn('autoOwnerConversation: AV CENTRAL photo send failed', { err: e.message })
      }
    }
    const provenance = await buildReviewProvenanceBlock({ phone, conversationId, collectingSession, postingSession: session })
    await waha.sendText(session, groupId, `OWNER\n${provenance}`)
    if (warnings.length) {
      await waha.sendText(session, groupId, `⚠️ REVIEW REQUIRED\n${warnings.join('\n')}`).catch(() => {})
    }
    await waha.sendText(session, groupId, cardText)
    await waha.sendText(session, groupId, DIVIDER)
    // Spec point 8/33 — the visible human checkpoint marker. Purely
    // informational; the real timer is the BullMQ job armAutoPublish arms
    // right after this call returns (armAutoPublish now refuses to arm it
    // at all when `warnings` is non-empty — see its own comment).
    const minutesLabel = config.automation.autoPublishTimerMinutes
    const reviewLine = warnings.length
      ? `⏳ Awaiting review (flagged above — auto-publish held back)\nReply here: !upload<N> to approve & publish · !undo to discard`
      : `⏳ Property Draft ready · ${minutesLabel} min review\nReply here: !upload<N> to approve now · !undo to discard`
    const reviewMsg = await waha.sendText(session, groupId, reviewLine).catch(() => null)
    // UNWRAP SAFETY (Kev, 2026-09-23): the exact message a reply must target
    // to claim THIS draft — cmdUpload (handlers/upload.js) now requires
    // either a reply to this id or an explicit draft id typed in the
    // command, never a phone-number substring match (which could ambiguously
    // match a different pending draft, or a message that merely mentions
    // the same phone). Saved even when rendered.ok is false, so the explicit-
    // id path always works even without a canonical render.
    const reviewMessageId = reviewMsg?.key?.id || reviewMsg?.id || null
    if (conversationId) {
      const patch = { ...(rendered.ok ? { _canonical_fields: rendered.canonicalFields } : {}), ...(reviewMessageId ? { _review_message_id: reviewMessageId } : {}) }
      if (Object.keys(patch).length) {
        await db.query(
          `UPDATE owner_auto_conversations SET checklist = checklist || $1::jsonb, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(patch), conversationId]
        ).catch(e => log.warn('autoOwnerConversation: persisting canonical fields/review message id failed', { err: e.message }))
      }
    }
    if (conversationId) {
      await db.query(
        `UPDATE owner_auto_conversations SET checklist = checklist || $1::jsonb, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify({ _last_action: { action: 'review_post', status: 'sent', session, groupId, at: new Date().toISOString() } }), conversationId]
      ).catch(() => {})
    }
    log.info('autoOwnerConversation: checklist complete, posted for review', { phone: phone.slice(-4), photos: photos.length, canonical: rendered.ok, warnings: warnings.length, session, groupId })
    return true
  } catch (e) {
    if (conversationId) {
      await db.query(
        `UPDATE owner_auto_conversations SET checklist = checklist || $1::jsonb, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify({ _last_action: { action: 'review_post', status: 'queued_retry', session, groupId, reason: String(e.message || e).slice(0, 240), at: new Date().toISOString() } }), conversationId]
      ).catch(() => {})
    }
    log.warn('autoOwnerConversation: review post failed', { err: e.message, session, groupId })
    return false
  }
}

// Marker written into the created property's internal_notes so !undo can
// find it and, just as importantly, REFUSE to touch anything that wasn't
// actually produced by this flow -- !undo is scoped to auto-published
// listings only, never a general "delete any property" command.
const AUTO_PUBLISH_MARKER = 'Auto-published via owner-checklist timer'

// Kev, 2026-09-09 (timer-buffer correction to the 2026-09-08 design): posts
// the AV CENTRAL preview card exactly as before, then arms a delayed BullMQ
// job that auto-publishes through the same pipeline !upload5 would, unless
// a late owner correction (handleOwnerReply, above) or a kill switch
// (!ca / !cancela, below) cancels it first.
async function armAutoPublish(conversationId, phone, checklist, { targetGroupId = null, targetSession = null } = {}) {
  // UNWRAP SAFETY (Kev, 2026-09-23): the Unwrap/review group must NEVER
  // auto-publish, full stop — review there is explicit-!upload-only now,
  // never a ticking timer. Production's one call site (below, in
  // processStep's `finished` block) never overrides targetGroupId, so this
  // is the effective group for every real checklist completion today; a
  // future caller that genuinely wants a DIFFERENT review destination
  // (test-only, per postChecklistCompleteToAvCentral's own comment) still
  // gets the normal timer behaviour.
  const effectiveGroupId = targetGroupId || draftGroupFor(checklist)
  const manualReviewGroups = new Set([UNWRAP_REVIEW_GROUP, COMMERCIAL_DRAFT_GROUP, SALE_DRAFT_GROUP, ROOMS_DRAFT_GROUP])
  if (manualReviewGroups.has(effectiveGroupId)) {
    const posted = await postChecklistCompleteToAvCentral(phone, checklist, { targetGroupId, targetSession, conversationId }).catch(e => {
      log.warn('armAutoPublish: review-group post failed (manual group — never auto-publishes)', { err: e.message })
      return false
    })
    log.info('armAutoPublish: posted to a manual review group — staying manual, no publish timer ever armed', { phone: phone.slice(-4), effectiveGroupId })
    return { posted, armed: false }
  }
  // Point F pre-fill (existing CRM property already matched): writeDraftProperty
  // already UPDATEd that real row above in processStep. Auto-CREATING a new
  // listing here would duplicate it, so this one case deliberately keeps the
  // original ready_for_kev/manual-review behaviour -- post the preview card
  // for visibility, but never start a publish timer against it.
  // Return shape (Kev, 2026-09-10, real bug found via DB audit): callers used
  // to get nothing back at all, so a card-post failure here was invisible to
  // both the caller AND Kev -- just a server log nobody reads. `posted`
  // tells the caller whether Kev actually has something to look at in AV
  // CENTRAL right now; `armed` tells it whether a publish timer is ticking.
  // A card that posted but didn't arm (existing-CRM-match, or a MUST field
  // gate upstream) is NOT a failure -- Kev can see it and act manually. A
  // card that never posted at all IS a failure worth an alert.
  // Kev, 2026-09-10 (Schritt 2 D): an owner with 2+ existing properties gets
  // the same "stay manual, no auto-create" treatment as an unambiguous
  // existing-CRM-match -- see findExistingProperty's _ambiguousMultiple
  // comment for why this can't safely auto-pick which listing is meant.
  if (checklist._crm_property_id || checklist._multi_property_owner_ambiguous) {
    const posted = await postChecklistCompleteToAvCentral(phone, checklist, { targetGroupId, targetSession, conversationId }).catch(e => {
      log.warn('armAutoPublish: AV CENTRAL post failed (existing-CRM-match path)', { err: e.message })
      return false
    })
    log.info('armAutoPublish: existing CRM property match or ambiguous multi-property owner -- staying manual, no publish timer', { phone: phone.slice(-4) })
    return { posted, armed: false }
  }

  const posted = await postChecklistCompleteToAvCentral(phone, checklist, { targetGroupId, targetSession, conversationId })
  if (!posted) {
    log.warn('armAutoPublish: AV CENTRAL post failed -- not arming a publish timer', { phone: phone.slice(-4) })
    return { posted: false, armed: false }
  }

  // Kev, 2026-09-14 ("UNWRAP THAT SHIT" review spec, item 3: "Do not
  // auto-upload until reviewed"): a draft with a sanity-check warning
  // (unusual bedroom count, inconsistent bed/bath/price shape, a price that
  // looks like a year) is posted with the warning clearly visible, but the
  // timer never arms -- it stays a manual draft until a human explicitly
  // approves it with !upload<N>, exactly like the existing-CRM-match /
  // ambiguous-multi-property branch above already does for a different
  // reason. Same buildSanityWarnings() the review post itself already used
  // to decide whether to print "⚠️ REVIEW REQUIRED" -- one source of truth
  // for "does this need a human before it can publish."
  if (buildSanityWarnings(checklist).length) {
    log.warn('armAutoPublish: sanity-check warning on this draft -- staying manual, no publish timer', { phone: phone.slice(-4) })
    return { posted: true, armed: false }
  }

  // Kev, 2026-09-16: "ich will nicht mehr dass die Sachen autogeupped werden
  // ... bisher alle gedrafted wurden ohne bilder" -- same "stay manual, no
  // publish timer" treatment as the two cases above, for the same reason
  // (auto-publishing has never actually had photos to work with). Checked
  // here too, not just in runAutoPublishJob's own final gate, so the AV
  // CENTRAL card never even shows a ticking auto-publish countdown for a
  // draft that was always going to be blocked at send time.
  const mayPublishWithoutPhotos = checklist.transaction_type === 'sale' || checklist.property_category === 'commercial'
  if (!(checklist._photos || []).length && !mayPublishWithoutPhotos) {
    log.info('armAutoPublish: no photos collected -- staying manual, no publish timer', { phone: phone.slice(-4) })
    return { posted: true, armed: false }
  }

  const minutes = config.automation.autoPublishTimerMinutes
  const job = await addJob('owner-auto-publish', { conversationId }, { delay: minutes * 60_000 })
  await db.query(
    `UPDATE owner_auto_conversations
        SET status = 'awaiting_auto_publish',
            checklist = checklist || $1::jsonb,
            updated_at = NOW()
      WHERE id = $2`,
    [JSON.stringify({ _publish_job_id: String(job.id), _publish_armed_at: new Date().toISOString() }), conversationId]
  )
  log.info('armAutoPublish: publish timer armed', { phone: phone.slice(-4), minutes, jobId: job.id })
  return { posted: true, armed: true }
}

// The 'owner-auto-publish' BullMQ processor body (worker.js registers this).
// Everything here is re-verified from scratch rather than trusted from
// arm-time -- minutes have passed, and a race against a late correction or
// an emergency stop is exactly the scenario this whole buffer exists for.
async function runAutoPublishJob(conversationId) {
  const r = await db.query(`SELECT * FROM owner_auto_conversations WHERE id = $1`, [conversationId])
  const convo = r.rows[0]
  if (!convo) { log.warn('runAutoPublishJob: conversation not found', { conversationId }); return }

  // Stale-job guards: a late correction or a kill switch may have already
  // moved this conversation on, or armed a NEWER job with a different id
  // (Redis job removal and this status flip are not one atomic operation --
  // this closes that gap rather than trusting removal alone).
  //
  // 'ready_for_kev' added 2026-09-23 (UNWRAP SAFETY): armAutoPublish no
  // longer ever arms a timer for the Unwrap group, so a claimable draft's
  // status now stays 'ready_for_kev' forever instead of ever reaching
  // 'awaiting_auto_publish' — cmdUpload's explicit reply-id/draft-id claim
  // (handlers/upload.js) calls this function directly against that status.
  // Anything else (already 'auto_published'/'manually_uploaded', or a
  // terminal decline/expiry state) still means "already handled" and is
  // still refused here, same as before.
  if (convo.status !== 'awaiting_auto_publish' && convo.status !== 'ready_for_kev') {
    log.info('runAutoPublishJob: conversation already handled or not claimable, skipping', { conversationId, status: convo.status })
    return
  }
  const checklist = convo.checklist || {}
  const publishBlockers = buildSanityWarnings(checklist)
  if (publishBlockers.length) {
    await db.query(
      `UPDATE owner_auto_conversations
          SET status = 'ready_for_kev', cancelled_reason = $2, updated_at = NOW()
        WHERE id = $1`,
      [conversationId, `publish blocked: ${publishBlockers.join(' | ')}`.slice(0, 500)]
    )
    log.warn('runAutoPublishJob: sanity blocker present at publish time, aborting', { conversationId, blockers: publishBlockers.length })
    return
  }
  const mustUnresolved = mustFieldsFor(checklist).some(f => checklist[`_unresolved_${f}`])
  if (mustUnresolved) {
    log.warn('runAutoPublishJob: a MUST field is unresolved at publish time, aborting', { conversationId })
    return
  }
  if (checklist._crm_property_id) {
    log.info('runAutoPublishJob: existing-CRM-match checklist should never reach this job, aborting', { conversationId })
    return
  }

  const phone = convo.phone
  const upload = require('../handlers/upload')
  const { AV_CENTRAL_GROUP, AV_CENTRAL_DEFAULT, pickUploadSession } = upload
  const groupId = AV_CENTRAL_GROUP || AV_CENTRAL_DEFAULT
  const session = await pickUploadSession().catch(() => null)
  if (!session) {
    await require('../handlers/uploadListing').alertKev(`⚠️ Auto-publish for owner ${phone.slice(-4)} could not find a session — checklist stays as a manual draft, reply !upload5 in AV CENTRAL yourself.`).catch(() => {})
    return
  }

  // Kev, 2026-09-10 (CANONICAL 2906 LISTING RENDERER, superseding the
  // 2026-09-09 polishDescription approach): re-deriving the ad copy HERE via
  // a second, independent Gemini call meant the auto-publish path and
  // whatever Kev actually reviewed in AV CENTRAL a few minutes earlier
  // (postChecklistCompleteToAvCentral above) were never guaranteed to be the
  // same text -- exactly the non-idempotent behaviour spec point 31/32
  // forbids. This now reuses the SAME canonicalFields (intro/closing,
  // keyed by a fact fingerprint) persisted at post-time, so the fully
  // automated publish renders byte-for-byte what was shown for review,
  // unless a field genuinely changed since (in which case the fingerprint
  // mismatches and render2906Listing regenerates fresh -- never a stale
  // patch, per spec point 32).
  const canonicalRenderer = require('./canonical2906Renderer')
  const rendered = await canonicalRenderer.render2906Listing(checklist, {
    cachedCanonical: checklist._canonical_fields || null,
  }).catch(e => {
    log.warn('runAutoPublishJob: canonical render failed, falling back to plain facts text', { err: e.message })
    return { ok: false }
  })
  const adBody = rendered.ok ? rendered.text : null
  const factsText = buildChecklistCardText(checklist, phone)
  const rawText = adBody ? `${adBody}\n\nOwner: +${phone}` : factsText
  if (!adBody) log.warn('runAutoPublishJob: canonical render unavailable, publishing with the plain facts text instead', { conversationId })

  // Spec point 10/11/28 — pets/sharing/subletting rules and the conditional
  // (sharing/subletting) price are CRM/Match-Engine metadata, never part of
  // the public ad copy above. Carried into createListing() directly from
  // the checklist rather than re-extracted from rawText, because the
  // canonical description above deliberately omits negative facts and
  // conditional prices (they would never survive a text re-extraction).
  const sublettingAnswer = classifySublettingAnswer(checklist.subletting)
  const structuredRules = {
    pets_allowed: checklist.pets === 'yes' ? true : checklist.pets === 'no' ? false : null,
    sharing_allowed: checklist.sharing === 'yes' ? true : checklist.sharing === 'no' ? false : null,
    sharing_price: checklist.sharing_price != null ? Number(checklist.sharing_price) : null,
    // subletting_allowed kept in sync for older readers (canonical2906Renderer.js
    // etc.); subletting_considered/subletting_note are the source of truth from
    // here on -- see classifySublettingAnswer's own comment.
    subletting_allowed: sublettingAnswer.considered,
    subletting_considered: sublettingAnswer.considered,
    subletting_note: sublettingAnswer.note,
    subletting_price: checklist.subletting_price != null ? Number(checklist.subletting_price) : null,
  }
  const images = []
  for (const url of (checklist._photos || []).slice(0, 15)) {
    try {
      const imgRes = await fetch(url)
      const buffer = Buffer.from(await imgRes.arrayBuffer())
      const mimeType = imgRes.headers.get('content-type') || 'image/jpeg'
      images.push({ buffer, mimeType })
    } catch (e) {
      log.warn('runAutoPublishJob: photo fetch failed, skipping one image', { err: e.message })
    }
  }

  // Kev, 2026-09-16: "ich will nicht mehr dass die Sachen autogeupped werden
  // ... bisher alle gedrafted wurden ohne bilder, dann macht uploaden wenig
  // sinn" -- the owner conversation reliably collects a good description and
  // owner details, but never actually gets photos out of the owner over
  // chat. Auto-publishing anyway put an image-less listing live on every
  // channel. This is now a hard stop, not a "try anyway" -- the checklist
  // (description/owner info already collected) is left exactly as-is and
  // handed to Kev the same way every other "needs a human" exit from this
  // conversation already does (status='ready_for_kev', draft_property_id
  // kept), rather than being force-published or discarded.
  if (!images.length) {
    await db.query(
      `UPDATE owner_auto_conversations
          SET status = 'ready_for_kev', cancelled_reason = 'auto-publish skipped — no photos collected; add images and upload manually',
              updated_at = NOW()
        WHERE id = $1`,
      [conversationId]
    )
    await require('../handlers/uploadListing').alertKev(
      `📝 Auto-publish skipped for owner ${phone.slice(-4)} — description/owner info are ready but no photos came through the chat. Draft is waiting${convo.draft_property_id ? ` (#${convo.draft_property_id})` : ''} — add images and run !upload5 in AV CENTRAL yourself when ready.`
    ).catch(() => {})
    log.info('runAutoPublishJob: skipped — no images collected, checklist handed to Kev as ready_for_kev', { conversationId, phone: phone.slice(-4) })
    return
  }

  const agentR = await db.query(`SELECT id, username, name, display_name, alias, role, post_tag FROM agents WHERE LOWER(username)='kev' AND active=TRUE LIMIT 1`)
  const agent = agentR.rows[0]
  if (!agent) {
    await require('../handlers/uploadListing').alertKev(`⚠️ Auto-publish for owner ${phone.slice(-4)} failed — no 'kev' agent row configured. Checklist stays as a manual draft.`).catch(() => {})
    return
  }

  const minutes = config.automation.autoPublishTimerMinutes
  const variant = 'upload' + config.automation.autoPublishVariant
  let result
  try {
    result = await upload.createListing({ rawText, images, videos: [], agent, senderPhone: phone, chatId: groupId, session, variant, force: false, noAd: false, structuredRules })
  } catch (e) {
    log.error('runAutoPublishJob: createListing threw', { err: e.message, conversationId })
    await require('../handlers/uploadListing').alertKev(`❌ Auto-publish crashed for owner ${phone.slice(-4)}\n${e.message}\nChecklist stays as a manual draft in AV CENTRAL — reply !upload5 there yourself.`).catch(() => {})
    return
  }

  if (result.error || result.duplicate) {
    const reason = result.error ? result.error : `looks like a duplicate of #${result.duplicate}`
    log.warn('runAutoPublishJob: createListing did not publish', { conversationId, reason })
    await require('../handlers/uploadListing').alertKev(`⚠️ Auto-publish held back for owner ${phone.slice(-4)}: ${reason}\nStill sitting in AV CENTRAL — resolve manually with !upload5 (add "force" if the duplicate match is wrong).`).catch(() => {})
    return
  }

  await db.query(
    `UPDATE properties SET internal_notes = TRIM(BOTH ' | ' FROM COALESCE(internal_notes,'') || ' | ' || $2) WHERE id = $1`,
    [result.propId, AUTO_PUBLISH_MARKER]
  )
  // writeDraftProperty (earlier in processStep's `finished` block, unconditionally
  // for every completed checklist) already inserted a real, ref-less, published=false
  // 'pending_check' properties row -- that row is what convo.draft_property_id
  // points at. createListing above just created a SECOND, fully separate row (its
  // own real ref, this is the one that actually goes live). Left alone, the first
  // one becomes an orphaned duplicate sitting in every pending-review queue right
  // next to the real listing -- archived + cross-referenced here so it reads as
  // "superseded", not as a second loose lead for the same owner.
  if (convo.draft_property_id && convo.draft_property_id !== result.propId) {
    await db.query(
      `UPDATE properties SET available_status='archived',
              internal_notes = TRIM(BOTH ' | ' FROM COALESCE(internal_notes,'') || ' | ' || $2)
        WHERE id = $1`,
      [convo.draft_property_id, `Superseded by auto-publish #${result.ref}`]
    ).catch(e => log.warn('runAutoPublishJob: draft supersede-note failed', { err: e.message }))
  }
  await db.query(`UPDATE owner_auto_conversations SET status='auto_published', updated_at=NOW() WHERE id=$1`, [conversationId])

  await require('../handlers/uploadListing').alertKev(
    `✅ AUTO-PUBLISHED #${result.ref} (owner ${phone.slice(-4)}) — the ${minutes}-minute buffer ran out with no correction.\nWant to pull it back? Reply !undo ${result.ref}`
  ).catch(() => {})
  log.info('runAutoPublishJob: auto-published', { conversationId, ref: result.ref, propId: result.propId })
}

async function writeDraftProperty(phone, checklist) {
  // Point F: an unambiguous existing CRM listing was matched at conversation
  // start (checklistFromExistingProperty) -- update that same row instead of
  // inserting a duplicate draft.
  if (checklist._crm_property_id) {
    const notes = [`Auto-Owner-Conversation confirmed via WhatsApp ${new Date().toISOString().slice(0, 10)}`]
    if (checklist.available_date) notes.push(`Available from: ${checklist.available_date}`)
    if (checklist.pets) notes.push(`Pets: ${checklist.pets}`)
    if (checklist.sharing) notes.push(`Sharing: ${checklist.sharing}`)
    if (checklist.subletting) notes.push(`Subletting: ${checklist.subletting}`)
    notes.push(...extraIntelligenceNotes(checklist))
    const unresolvedNote = unresolvedFieldNote(checklist)
    if (unresolvedNote) notes.push(unresolvedNote)
    await db.query(
      `UPDATE properties SET internal_notes = COALESCE(internal_notes, '') || ' | ' || $1, updated_at = NOW() WHERE id = $2`,
      [notes.join(' | '), checklist._crm_property_id]
    )
    return checklist._crm_property_id
  }

  const owner = await db.query('SELECT id FROM owner_contacts WHERE phone_normalized = $1', [phone])
  const ownerId = owner.rows[0]?.id || null

  let town = checklist.town || null
  let localityId = null
  let localityStatus = town ? 'UNKNOWN' : 'UNKNOWN'
  if (town) {
    try {
      const locality = await require('./localityResolver').resolveLocality(town)
      localityStatus = locality.status
      if (locality.status === 'RESOLVED') {
        town = locality.canonical_name
        localityId = locality.locality_id
      }
    } catch (err) {
      log.warn('writeDraftProperty: canonical locality resolution failed', { town, err: err.message })
    }
  }

  // available_date stays free text here rather than the properties table's
  // real DATE column — the owner's own words ("from October", "1st Nov")
  // aren't reliably SQL-DATE-parseable, and this row is a draft
  // (published=false, pending_check) for Kev to clean up before it goes
  // live, same as the rest of this checklist always has been.
  const notes = [`Auto-collected via Outreach conversation ${new Date().toISOString().slice(0, 10)}`]
  if (checklist.available_date) notes.push(`Available from: ${checklist.available_date}`)
  if (checklist.pets) notes.push(`Pets: ${checklist.pets}`)
  if (checklist.sharing) notes.push(`Sharing: ${checklist.sharing}`)
  const transactionType = checklist.transaction_type || checklist.transactionType || 'rent'
  const propertyCategory = checklist.property_category || checklist.propertyCategory
  const commercialUse = checklist.commercial_use || checklist.commercialUse || null
  const propertyType = propertyCategory === 'commercial'
    ? (commercialUse || 'commercial')
    : (checklist.listing_kind === 'room' ? 'room' : 'apartment')
  if (transactionType === 'sale') notes.push('Transaction: SALE')
  if (propertyCategory === 'commercial') notes.push(`Commercial use: ${commercialUse || 'UNKNOWN'}`)
  if (checklist.condition) notes.push(`Condition/finish: ${checklist.condition}`)
  if (checklist.development_stage) notes.push(`Development stage: ${checklist.development_stage}`)
  if (checklist.tenure) notes.push(`Tenure: ${checklist.tenure}`)
  if (checklist.permit_info) notes.push(`Permit: ${checklist.permit_info}`)
  if (localityStatus !== 'RESOLVED' && checklist.town) notes.push(`Unresolved locality: ${checklist.town}`)
  const structuredIntake = {
    transaction_type: transactionType,
    commercial_use: commercialUse,
    size_sqm: checklist.size_sqm || null,
    condition_finish: checklist.condition || null,
    development_stage: checklist.development_stage || null,
    listing_kind: checklist.listing_kind || null,
    tenure: checklist.tenure || null,
    permit_information: checklist.permit_info || null,
    source: 'owner_whatsapp',
  }
  notes.push(...extraIntelligenceNotes(checklist))
  const unresolvedNote = unresolvedFieldNote(checklist)
  if (unresolvedNote) notes.push(unresolvedNote)

  const r = await db.query(
    `INSERT INTO properties
       (owner_id, property_type, town, street, bedrooms, bathrooms, size_sqm,
        longlet_price, sale_price, available_status, listed_by_agent_id, published,
        internal_notes, viewing_notes, is_staging, chat_extracted_fields,
        locality_id, locality_resolution_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending_check',1,false,$10,$11,TRUE,$12,$13,$14)
     RETURNING id`,
    [ownerId, propertyType, town, checklist.address || null,
     checklist.bedrooms || null, checklist.bathrooms || null,
     checklist.size_sqm || null,
     transactionType === 'rent' ? (checklist.price || null) : null,
     transactionType === 'sale' ? (checklist.price || null) : null,
     notes.join(' | '), checklist.viewable_date || null, JSON.stringify(structuredIntake),
     localityId, localityStatus]
  )
  for (const [index, url] of (checklist._plans || []).entries()) {
    await db.query(
      `INSERT INTO owner_documents (owner_contact_id, filename, url, uploaded_by, category, property_id, notes)
       VALUES ($1,$2,$3,'owner_whatsapp','plan',$4,'Contact-detail scan passed')`,
      [ownerId, `property-plan-${index + 1}.pdf`, url, r.rows[0].id])
  }
  return r.rows[0].id
}

// Kev, 2026-08-31 (Prompt 2, portfolio/multi-property handoff) -- a
// portfolio group ("6 apartments, all 2 bed") becomes ONE summary draft row
// tagged for Kevin to split, rather than 6 speculative individual rows an
// imperfect extraction could get wrong at scale.
async function writePortfolioDraft(phone, portfolio) {
  const owner = await db.query('SELECT id FROM owner_contacts WHERE phone_normalized = $1', [phone])
  const ownerId = owner.rows[0]?.id || null
  const notes = [
    `Auto-collected portfolio via Outreach conversation ${new Date().toISOString().slice(0, 10)}`,
    `Reported as ~${portfolio.unit_count} units${portfolio.same_block ? ' in the same block' : ''} -- needs manual split into individual listings`,
  ]
  const r = await db.query(
    `INSERT INTO properties
       (owner_id, property_type, town, bedrooms, bathrooms, longlet_price, available_status, listed_by_agent_id, published, internal_notes, is_staging)
     VALUES ($1,'apartment',$2,$3,$4,$5,'pending_check',1,false,$6,TRUE)
     RETURNING id`,
    [ownerId, portfolio.town || null, portfolio.bedrooms_each || null, portfolio.bathrooms_each || null,
     portfolio.price_each || null, notes.join(' | ')]
  )
  return r.rows[0].id
}

// Two (or more) genuinely DISTINCT properties mentioned together -- unlike
// a portfolio, these have different data each, so each gets its own row.
async function writeEntityDraft(phone, entity) {
  const owner = await db.query('SELECT id FROM owner_contacts WHERE phone_normalized = $1', [phone])
  const ownerId = owner.rows[0]?.id || null
  const notes = [`Auto-collected via Outreach conversation ${new Date().toISOString().slice(0, 10)} (one of several properties mentioned together)`]
  if (entity.status) notes.push(`Reported status: ${entity.status}`)
  const r = await db.query(
    `INSERT INTO properties
       (owner_id, property_type, town, bedrooms, bathrooms, longlet_price, available_status, listed_by_agent_id, published, internal_notes, is_staging)
     VALUES ($1,'apartment',$2,$3,$4,$5,$6,1,false,$7,TRUE)
     RETURNING id`,
    [ownerId, entity.town || null, entity.bedrooms || null, entity.bathrooms || null, entity.price || null,
     entity.status === 'rented' ? 'rented' : 'pending_check', notes.join(' | ')]
  )
  return r.rows[0].id
}

// ── Worker processor (registered in worker.js) ────────────────────────────
// Kev, 2026-08-31 (HARD STOP spec, Point 5) -- releases the atomic claim
// below. Best-effort: the 2-minute staleness window in the claim query
// itself is the real safety net if this is ever skipped (it never should
// be, every processStep exit path goes through the finally block).
async function releaseProcessingLock(conversationId) {
  try {
    await db.query(`UPDATE owner_auto_conversations SET processing_lock = NULL WHERE id = $1`, [conversationId])
  } catch (e) {
    log.warn('autoOwnerConversation: releaseProcessingLock failed', { conversationId, err: e.message })
  }
}

async function processStep({ conversationId, phone, session }) {
  // Kev, 2026-08-31 (HARD STOP spec, Point 5 -- "nur EIN Worker darf eine
  // ID besitzen"). Atomic claim: this UPDATE...RETURNING can only succeed
  // for ONE caller at a time. The auto-conversation queue runs at
  // concurrency 3, and cancelPendingJob()'s BullMQ job.remove() cannot stop
  // a job that is already executing -- without this claim, a debounced
  // reschedule racing an in-flight run could let two processStep calls for
  // the SAME conversation read the same pending text and both send. A lock
  // older than 2 minutes (processStep's real runtime is seconds) is treated
  // as abandoned by a crashed/stalled worker and can be reclaimed, so a
  // single missed release can never wedge a conversation shut forever.
  const claim = await db.query(
    `UPDATE owner_auto_conversations
        SET processing_lock = NOW()
      WHERE id = $1
        AND status = 'active_collecting'
        AND automation_disabled = FALSE
        AND (processing_lock IS NULL OR processing_lock < NOW() - INTERVAL '2 minutes')
      RETURNING *`,
    [conversationId]
  )
  const convo = claim.rows[0]
  if (!convo) return
  if (await isGloballyPaused()) { await releaseProcessingLock(conversationId); return }

  try {
    const checklist = convo.checklist || {}
    const pending = checklist._pending || []
    if (!pending.length) return
    const combinedText = pending.join('\n')
    delete checklist._pending

    const log_ = checklist._log || []
    log_.push({ from: 'owner', text: combinedText, at: new Date().toISOString() })

    let updatedChecklist = checklist
    let finished = false

    // Kev, 2026-08-31 (Prompt 2 T12) -- media (photos/video) arriving with no
    // caption is queued as a "[media]" sentinel by handleOwnerReply (it can't
    // require text the way everything else does). Reuses the existing
    // ASK_ONCE 'photos' field: once it has a value, nextMissingField (fixed
    // above) never asks "do you have pictures?" again, media or not.
    if (/\[media\]/.test(combinedText) && updatedChecklist.photos !== true) {
      updatedChecklist = { ...updatedChecklist, photos: true }
    }

    const persistAndReturn = async (extraFields) => {
      await db.query(
        `UPDATE owner_auto_conversations SET checklist=$1, last_bot_message_at=NOW(), updated_at=NOW() WHERE id=$2`,
        [JSON.stringify({ ...updatedChecklist, ...extraFields, _log: log_ }), conversationId]
      )
    }

    // ── BUSINESS / IDENTITY FIRST ────────────────────────────────────────
    // This is a direct answer, not another availability question. Unknown
    // personas are escalated instead of receiving an invented biography.
    if (AGENCY_QUESTION_RE.test(combinedText)) {
      const agencyAnswer = await approvedAgencyAnswer(session)
      if (!agencyAnswer) {
        await persistAndReturn({ _agency_question_needs_human: true })
        await waha.markChatUnread(session, phone).catch(() => {})
        await notifyAdminEscalation(session, phone, 'AGENCY QUESTION — no approved persona answer configured',
          `Session: ${session}. Owner asked: "${combinedText.slice(0, 200)}"`)
        return
      }
      const gC = await gatedSend(session, phone, agencyAnswer, conversationId)
      if (!gC.sent) return
      log_.push({ from: 'bot', text: agencyAnswer, at: new Date().toISOString() })
      await persistAndReturn({})
      return
    }

    // ── Point I: frustration / automation-failure signal — checked on EVERY
    // turn, first message or deep in the checklist. The instant a human
    // signals the automation is failing, it loses the right to keep going.
    if (await detectFrustration(combinedText)) {
      await require('./ownerSendGate').handleFrustratedOwner({
        phone, chatId: `${String(phone).replace(/@.*/, '')}@c.us`, session, text: combinedText,
      })
      await waha.markChatUnread(session, phone)
      return
    }

    // ── FALL 3 (Kev, 2026-09-06, GOLDEN-SCRIPT) -- voice note / inbound
    // call / explicit "call me" request. Checked right after Point I
    // (same priority: neither is something the bot can usefully continue
    // in text) and BEFORE the external-source check below -- a voice note
    // is not a document, and must never be read as one. Single-shot, no
    // 2-round retry (unlike the generic 'unclear' intent further down):
    // there is nothing to re-ask, the owner already told us in the only
    // way that matters (they called / sent audio / asked to be called).
    if (looksLikeNeedsHumanContact({ text: combinedText, isVoiceNote: /\[voice\]/.test(combinedText) })) {
      const g0 = await gatedSend(session, phone, FALL3_NEEDS_HUMAN_TEXT, conversationId)
      if (!g0.sent) return
      log_.push({ from: 'bot', text: FALL3_NEEDS_HUMAN_TEXT, at: new Date().toISOString() })
      await db.query(
        `UPDATE owner_auto_conversations SET status='needs_human_contact', checklist=$1, cancelled_reason='voice note / call / call-me request -- needs Kev personally', last_bot_message_at=NOW(), updated_at=NOW() WHERE id=$2`,
        [JSON.stringify({ ...updatedChecklist, _log: log_ }), conversationId]
      )
      await db.query(`UPDATE outreach_log SET conversation_state='done' WHERE phone=$1 AND conversation_state IN ('cold','active')`, [phone])
      await waha.markChatUnread(session, phone)
      await notifyAdminEscalation(session, phone, 'NEEDS YOU PERSONALLY — voice note/call/call-me request, left unread',
        `"${combinedText.slice(0, 200)}"`)
      return
    }

    // ── Point E (reconciled 2026-09-03): external information source, any
    // turn — "check the Excel" / a document attachment with no caption text
    // (see the [document] sentinel above) / a link. Kimi/this file NEVER
    // attempts to read the link or file itself, even when technically
    // fetchable.
    //
    // Root cause of the 13 red tests found in today's restart regression
    // sweep: the 08-31 "correction" below changed this from an unconditional
    // hand-off to "ack + never touch status + keep asking below" for EVERY
    // case, including the overwhelmingly common one where the owner's
    // deflection IS the entire reply -- nothing else has been collected yet.
    // In that case "keep asking below" means the very next thing the bot
    // sends is "so what's the rent?", directly contradicting both this
    // function's own header comment (line ~1302, never updated when 08-31
    // landed) and what the owner just said. The 08-31 correction's own
    // reasoning is still right for the case it was actually built for: an
    // owner who already gave real details and points to a document for ONE
    // remaining gap, where nuking the whole conversation would throw away
    // real progress. Reconciled: branch on how much is already known.
    //   - Nothing/near-nothing collected (countKnownFields === 0): the
    //     deflection covers EVERYTHING, not one field -- hand off cleanly,
    //     no further questions. This restores the PRE-08-31 behavior, but
    //     only for the case that actually needs it.
    //   - Real data already on the checklist: unchanged 08-31 behavior --
    //     flag it, acknowledge, do NOT touch status/draft, let Stage 2/3/4
    //     keep asking whatever is still genuinely open below.
    const isDocumentAttachment = /\[document\]/.test(combinedText)
    // FILE-FIRST INTAKE (Kev, 2026-09-22 hotfix): handleOwnerReply already
    // tried to read this exact document above, well before Point E ever
    // sees it -- `_file_extracted` / `_file_unreadable` record what
    // happened. A successfully-parsed file must NEVER hit the hand-off
    // below (its fields are already merged into `checklist`; asking again
    // or telling the owner "not auto-read" would both be wrong). A file
    // that failed to parse still hands off, but the owner-facing message
    // asks ONCE for a resend instead of silently falling through to a
    // field-by-field interrogation.
    const fileWasExtracted = isDocumentAttachment && checklist._file_extracted === true
    const fileWasUnreadable = isDocumentAttachment && checklist._file_unreadable === true
    if (!fileWasExtracted && !checklist._external_source_flagged && (looksLikeExternalSource(combinedText) || isDocumentAttachment)) {
      updatedChecklist = { ...updatedChecklist, _external_source_flagged: true }
      const ack = fileWasUnreadable
        ? "Sorry, I couldn't open that file on my end — could you resend it, or just tell me the details directly (bedrooms, bathrooms, price, availability)?"
        : "Perfect, thank you — I'll make sure our team goes through that directly. Really appreciate it!"
      const g2 = await gatedSend(session, phone, ack, conversationId)
      if (!g2.sent) return
      log_.push({ from: 'bot', text: ack, at: new Date().toISOString() })
      await waha.markChatUnread(session, phone)
      const url = extractUrl(combinedText)
      // "not auto-read" spelled out explicitly, not just implied by the
      // header comment's design principle -- Kevin (and this file's own
      // tests) must never have to assume the bot silently parsed the link.
      const detail = fileWasUnreadable
        ? 'A document/file arrived in this chat but could not be parsed by the bot (corrupted, unreadable, or unrelated to a property) -- please open WhatsApp and review it directly.'
        : isDocumentAttachment
          ? 'A document/file arrived in this chat (not auto-read by the bot) -- please open WhatsApp and review it directly, needs manual entry.'
          : (url ? `Link (not auto-read by the bot): ${url}` : `"${combinedText.slice(0, 200)}" (not auto-read by the bot)`)

      if (countKnownFields(updatedChecklist) === 0) {
        await db.query(
          `UPDATE owner_auto_conversations
             SET status='ready_for_kev', checklist=$1, cancelled_reason='owner pointed to an external source, nothing else collected yet', last_bot_message_at=NOW(), updated_at=NOW()
           WHERE id=$2`,
          [JSON.stringify({ ...updatedChecklist, _log: log_ }), conversationId]
        )
        await notifyAdminEscalation(session, phone, 'owner pointed to an external source — please review it manually (nothing else was collected, handed off)', detail)
        return
      }

      await notifyAdminEscalation(session, phone, 'owner pointed to an external source — please review it manually too (bot conversation continues)', detail)
    }

    if (!checklist._classified) {
      // Prompt 2 ("mehrere Properties nicht vermischen" / portfolio) --
      // checked FIRST, before anything else: "I have 3 apartments, all 2
      // bedroom" or "one in Sliema for 1800 and another 2 bed in Gzira for
      // 1500" must never fall into the single-property field loop below,
      // where it would either mix fields across properties or overwrite one
      // with the other. Handed straight to Kevin rather than run a
      // structured multi-entity interview over WhatsApp (Point J / "gut
      // genug") -- portfolio detection checked first since it needs an
      // explicit count ("N apartments") the connector-split doesn't have.
      const portfolio = detectPortfolio(combinedText)
      const splitEntities = !portfolio ? splitMultipleProperties(combinedText) : null
      if (portfolio || splitEntities) {
        const entities = portfolio ? [portfolio] : splitEntities
        const ack = "That's really useful, thank you — I'll make sure our team gets the full details sorted for each one."
        const g3 = await gatedSend(session, phone, ack, conversationId)
        if (!g3.sent) return
        log_.push({ from: 'bot', text: ack, at: new Date().toISOString() })
        const draftId = portfolio
          ? await writePortfolioDraft(phone, portfolio)
          : (await Promise.all(entities.map(e => writeEntityDraft(phone, e))))[0]
        await db.query(
          `UPDATE owner_auto_conversations
           SET status='ready_for_kev', checklist=$1, draft_property_id=$2, cancelled_reason=$3, last_bot_message_at=NOW(), updated_at=NOW()
           WHERE id=$4`,
          [JSON.stringify({ ...updatedChecklist, properties: entities, _log: log_ }),
           draftId || null,
           portfolio ? 'owner described a portfolio of units' : 'owner described multiple distinct properties',
           conversationId]
        )
        await db.query(`UPDATE outreach_log SET conversation_state='done' WHERE phone=$1 AND conversation_state IN ('cold','active')`, [phone])
        await waha.markChatUnread(session, phone)
        await notifyAdminEscalation(session, phone,
          portfolio ? `portfolio of ~${portfolio.unit_count} units captured` : `${entities.length} separate properties captured`,
          JSON.stringify(entities))
        return
      }

      // Point G / Prompt 3 Point A: referral and future-availability checked
      // BEFORE the plain declined/interested/unclear classification — both
      // would otherwise be misread as a flat decline (a keyword fallback
      // like "nothing" matches "nothing now, contact me in November" just as
      // easily as a real no).
      const referral = extractReferral(combinedText)
      if (referral) {
        const forwardResult = await forwardReferral(phone, referral, session)
        const ack = forwardResult.sent
          ? "Thank you so much for letting us know — I've reached out to them directly!"
          : "Thank you so much for letting us know — I'll pass their details along right away!"
        const g4 = await gatedSend(session, phone, ack, conversationId)
        if (!g4.sent) return
        log_.push({ from: 'bot', text: ack, at: new Date().toISOString() })
        const reason = forwardResult.sent
          ? `Referral forwarded to +${forwardResult.referredPhone} (same outreach text, own OutreachSession, source=+${phone})`
          : `Referral received but NOT auto-forwarded (${forwardResult.reason}): ${referral.contact}`
        await db.query(
          `UPDATE owner_auto_conversations SET status='referral_forwarded', checklist=$1, cancelled_reason=$2, last_bot_message_at=NOW(), updated_at=NOW() WHERE id=$3`,
          [JSON.stringify({ ...updatedChecklist, _log: log_ }), reason, conversationId]
        )
        await db.query(`UPDATE outreach_log SET conversation_state='done' WHERE phone=$1 AND conversation_state IN ('cold','active')`, [phone])
        await waha.markChatUnread(session, phone)
        await notifyAdminEscalation(session, phone, forwardResult.sent ? 'REFERRAL forwarded automatically' : 'REFERRAL received but NOT forwarded',
          reason)
        return
      }

      // No phone number given with the referral -- ask naturally, once, then
      // let the conversation continue normally either way (never loops).
      if (looksLikeReferralWithoutNumber(combinedText) && !checklist._asked_referral_number) {
        const msg = "Sure, could you send me their number so I can reach out?"
        const g5 = await gatedSend(session, phone, msg, conversationId)
        if (!g5.sent) return
        log_.push({ from: 'bot', text: msg, at: new Date().toISOString() })
        updatedChecklist = { ...updatedChecklist, _asked_referral_number: true }
        await persistAndReturn({})
        return
      }

      if (looksLikeFutureAvailability(combinedText)) {
        await reminderFromMessage.captureFromReply(phone, combinedText, { session }).catch(() => null)
        // GOLDEN-SCRIPT Fall 2 (Kev, 2026-09-06): hand off to the permanent
        // `!o` flow (Principle B: this outreach flow itself is SHORT and
        // closes right below -- future follow-up on this owner is `!o`'s
        // job from here on, not this file's). Only activates a fresh state
        // (never toggles an existing ENABLED one OFF -- handleToggleCommand
        // is a flip, unsafe to call blindly here).
        try {
          const ownerAssistant = require('./ownerAssistant')
          const chatId = `${phone}@c.us`
          const existingOA = await ownerAssistant.getState(session, chatId)
          if (!existingOA || !existingOA.enabled) {
            await ownerAssistant.handleToggleCommand({ session, chatId, senderPhone: phone })
            log.info('autoOwnerConversation: Fall 2 -- handed off to !o', { phone: String(phone).slice(-4) })
          }
        } catch (err) {
          log.warn('autoOwnerConversation: Fall 2 !o handoff failed (reminder was still created)', { err: err.message })
        }
        const g6 = await gatedSend(session, phone, FALL2_FUTURE_FOLLOWUP_TEXT, conversationId)
        if (!g6.sent) return
        log_.push({ from: 'bot', text: FALL2_FUTURE_FOLLOWUP_TEXT, at: new Date().toISOString() })
        await db.query(
          `UPDATE owner_auto_conversations SET status='future_followup', checklist=$1, cancelled_reason='owner indicated a future availability date', last_bot_message_at=NOW(), updated_at=NOW() WHERE id=$2`,
          [JSON.stringify({ ...updatedChecklist, _log: log_ }), conversationId]
        )
        await db.query(`UPDATE outreach_log SET conversation_state='done' WHERE phone=$1 AND conversation_state IN ('cold','active')`, [phone])
        await waha.markChatUnread(session, phone)
        return
      }

      const { intent, extracted } = await classifyIntent(combinedText)
      if (intent === 'declined') {
        const g7 = await gatedSend(session, phone, FALL1_DECLINE_TEXT, conversationId)
        if (!g7.sent) return
        log_.push({ from: 'bot', text: FALL1_DECLINE_TEXT, at: new Date().toISOString() })
        await db.query(
          `UPDATE owner_auto_conversations SET status='declined', checklist=$1, last_bot_message_at=NOW(), updated_at=NOW() WHERE id=$2`,
          [JSON.stringify({ ...updatedChecklist, _log: log_ }), conversationId]
        )
        await db.query(`UPDATE outreach_log SET conversation_state='declined' WHERE phone=$1 AND conversation_state IN ('cold','active')`, [phone])
        await waha.markChatUnread(session, phone)
        return
      }
      if (intent === 'unclear') {
        // Point J / fail-safe: one retry is a reasonable clarifying question,
        // a second one would just be the bot repeating itself verbatim while
        // still not understanding — escalate instead of looping a third time.
        const unclearCount = (updatedChecklist._unclear_count || 0) + 1
        if (unclearCount >= 2) {
          await db.query(
            `UPDATE owner_auto_conversations SET status='ready_for_kev', checklist=$1, cancelled_reason='intent stayed unclear after 2 rounds', last_bot_message_at=NOW(), updated_at=NOW() WHERE id=$2`,
            [JSON.stringify({ ...updatedChecklist, _unclear_count: unclearCount, _log: log_ }), conversationId]
          )
          // Principle B defense-in-depth (Kev, 2026-09-06, GOLDEN-SCRIPT):
          // the alreadyHandled/outreach_log_id check in handleOwnerReply
          // already makes this flow permanently non-reactivatable on its
          // own (see that function's own comment) -- this update just keeps
          // outreach_log's own conversation_state consistent with every
          // other terminal branch in this file, so a human reading THAT
          // table alone never sees a stale 'cold'/'active' row for a
          // conversation that has actually already ended.
          await db.query(`UPDATE outreach_log SET conversation_state='done' WHERE phone=$1 AND conversation_state IN ('cold','active')`, [phone])
          await waha.markChatUnread(session, phone)
          await notifyAdminEscalation(session, phone, "couldn't determine intent after 2 tries — please review manually",
            `"${combinedText.slice(0, 200)}"`)
          return
        }
        const msg = "Just to check — do you have a property available to rent out at the moment?"
        const g8 = await gatedSend(session, phone, msg, conversationId)
        if (!g8.sent) return
        log_.push({ from: 'bot', text: msg, at: new Date().toISOString() })
        // Even while intent itself stays unclear, keep whatever WAS learned
        // (Prompt 2: "was habe ich gerade gelernt" comes before "was soll ich
        // fragen" -- never discard a real extraction just because the
        // owner's overall intent wasn't obvious yet).
        updatedChecklist = mergeExtracted(updatedChecklist, extracted, combinedText)
        updatedChecklist = { ...updatedChecklist, _unclear_count: unclearCount }
        await persistAndReturn({})
        return
      }
      updatedChecklist = mergeExtracted(updatedChecklist, extracted, combinedText)
      updatedChecklist._classified = true
    } else {
      // Subsequent turn — extraction happens as part of buildNextMessage below
      // for whatever field THAT computes as askAbout. Kev, 2026-09-01 (real
      // bug found testing the staged-questions work): that is not enough on
      // its own for an ASK_ONCE field (map/pets/sharing/subletting) --
      // _asked_X is set the moment its question is SENT, so by the time the
      // owner's actual reply arrives (this turn), nextMissingField has
      // already moved past it and buildNextMessage never runs against the
      // field the reply is really answering. Also needed when askAbout ends
      // up null this turn (e.g. Stage 3/4 still gated) -- the code below
      // would otherwise never call mergeExtracted at all this turn.
      //
      // Deliberately passed `{}` here, NOT localExtractAll(combinedText) --
      // this must ONLY run mergeExtracted's own ask-once "just asked, still
      // empty" fallback (which reads rawText directly, see mergeExtracted
      // above). Running the full opportunistic pass here pre-empted the
      // MUST fields' own upcoming targeted extraction below (a price reply
      // like "I think around 1700" got crudely resolved here via
      // extractStandalonePrice with NO confidence tag, before
      // buildNextMessage('price', ...) ever got the chance to run its own,
      // confidence-aware extraction on the same text).
      updatedChecklist = mergeExtracted(updatedChecklist, {}, combinedText)
    }

    // PRINCIPLE A (Kev, 2026-09-06, GOLDEN-SCRIPT): a consistently
    // low-effort owner gets the optional cascade (photos/map/pets/sharing/
    // subletting) closed proactively -- "ask fewer, write less" -- rather
    // than waiting for the existing checkOptionalStopRule to notice a
    // specific missed question. Applied every turn (idempotent: setting an
    // already-true flag is a no-op) so it stays current with the whole
    // conversation's tone, not just a one-time snapshot.
    if (!updatedChecklist._optional_questions_closed && computeEngagementLevel(log_) === 'low') {
      updatedChecklist = { ...updatedChecklist, _optional_questions_closed: true }
    }

    // askAbout = whatever is still missing coming into this turn -- which is
    // exactly the field the LAST bot question was about (or the first real
    // gap, on the turn right after classification). buildNextMessage both
    // extracts THIS reply against that field and drafts a question about it;
    // what happens with that draft depends on whether the extraction (from
    // THIS SAME reply) just resolved it -- see Point D/H below. The defer
    // decision below is deliberately made AFTER this extraction attempt, not
    // before it: checking "already asked once" before ever trying to read
    // the reply meant to answer it would defer a field the instant its
    // answer arrives, never actually reading it.
    // Kev, 2026-09-01 (Gestufte Fragen-Priorität, language-barrier / general-
    // unclear full-stop): two or more fields quietly failing to land is read
    // as a broader signal than any one awkward question -- the bot stops
    // asking ANYTHING further in this conversation (not just the optional
    // cascade) and hands off silently. "Lieber schweigen und Kevin fragen,
    // als irgendwas Unsicheres an den Owner schreiben."
    if (countUnclearSignals(updatedChecklist) >= 2) {
      await db.query(
        `UPDATE owner_auto_conversations SET status='ready_for_kev', checklist=$1, cancelled_reason='general unclarity across multiple fields — possible language barrier', last_bot_message_at=NOW(), updated_at=NOW() WHERE id=$2`,
        [JSON.stringify({ ...updatedChecklist, _log: log_ }), conversationId]
      )
      // Principle B defense-in-depth, see the identical comment on the
      // unclearCount>=2 branch above.
      await db.query(`UPDATE outreach_log SET conversation_state='done' WHERE phone=$1 AND conversation_state IN ('cold','active')`, [phone])
      await waha.markChatUnread(session, phone)
      await notifyAdminEscalation(session, phone, 'multiple fields stayed unclear — possible language barrier, please review manually',
        `checklist so far: ${JSON.stringify(updatedChecklist)}`)
      return
    }

    // FALL 4 (Kev, 2026-09-06, GOLDEN-SCRIPT): the pets/sharing answer
    // itself volunteering an exclusive tenant preference, rather than a
    // plain yes/no. Checked once per conversation (never re-triggers).
    // Fire-and-forget the DB write -- same "never abort the inbound
    // webhook over a side write" principle as notifyAdminEscalation/
    // reminderFromMessage elsewhere in this file.
    //
    // PROTECTED-CLASS SAFEGUARD (Kev, 2026-09-07, Owner Profile V2): this is
    // VERBATIM owner free text, unfiltered by design (that is the point of
    // Fall 4 — a keyword pattern would miss "brat pitts and angelina jolies
    // from Europe or US"). Because it is unfiltered, 'preferred_tenant_type'
    // is registered in ownerPreferenceProfile.js's CONTEXT_ONLY_FIELDS —
    // every reader (getProfile/getProfileComparison) tags it contextOnly:true
    // so the owner profile page renders it as an informal "owner's own
    // words" note, never as a normal operational preference pill, and it is
    // never eligible to be wired into any matching/filtering logic. Do not
    // add a new field name here without also adding it to
    // CONTEXT_ONLY_FIELDS — an untagged free-text field is the leak.
    if (!updatedChecklist._exclusive_tenant_pref_detected
      && (updatedChecklist._asked_pets || updatedChecklist._asked_sharing)
      && looksLikeExclusiveTenantPreference(combinedText)) {
      updatedChecklist = { ...updatedChecklist, _exclusive_tenant_pref_detected: true }
      db.query(`SELECT id FROM owner_contacts WHERE phone_normalized = $1 LIMIT 1`, [String(phone).replace(/\D/g, '')])
        .then(async r => {
          if (!r.rows.length) return
          await ownerPreferenceProfile.saveExplicit(
            r.rows[0].id, 'preferred_tenant_type', combinedText.trim().slice(0, 200),
            'auto_owner_conversation_fall4', combinedText)
        })
        .catch(err => log.warn('autoOwnerConversation: Fall 4 tenant-preference capture failed', { err: err.message }))
    }

    const askAbout = nextMissingField(updatedChecklist)
    if (!askAbout) {
      finished = true
    } else {
      const logText = log_.map(l => `${l.from}: ${l.text}`).join('\n')
      const built0 = await buildNextMessage(askAbout, logText, combinedText)
      const { reply_message, extracted } = applySublettingInferenceOverride(askAbout, updatedChecklist, built0.reply_message, built0.extracted, combinedText)
      updatedChecklist = mergeExtracted(updatedChecklist, extracted, combinedText)
      const priorAskCount = updatedChecklist[`_ask_count_${askAbout}`] || 0
      updatedChecklist[`_ask_count_${askAbout}`] = priorAskCount + 1

      const isAskOnce = ASK_ONCE_FIELDS.has(askAbout)
      if (isAskOnce) updatedChecklist[`_asked_${askAbout}`] = true
      const resolvedNow = !isAskOnce && updatedChecklist[askAbout] !== undefined && updatedChecklist[askAbout] !== null

      if (!isAskOnce && !resolvedNow && priorAskCount >= 1) {
        // Point H: already asked once, and the reply meant to answer it
        // (this turn) still didn't -- defer rather than ask a third time in
        // any phrasing (real incident: "Mellieha" asked three times).
        updatedChecklist[`_unresolved_${askAbout}`] = true
      }
      // Kev, 2026-09-01 (explicit correction): a VAGUE locality reply skips
      // straight to "leave it, move on" on the very FIRST such reply --
      // unlike Point H's generic 2-strike retry, this never asks again in
      // different words even once. "location_text" is only ever set by
      // localExtract's town branch when the reply was recognized as vague.
      if (askAbout === 'town' && updatedChecklist.location_text != null && updatedChecklist.town == null) {
        updatedChecklist._unresolved_town = true
      }

      // Point D: a field just resolved by extracting THIS SAME reply (owner
      // volunteered it, or this is the answer to what we asked last turn)
      // must never also get its now-redundant question sent. ASK_ONCE
      // fields have no such concept — always send, exactly once.
      //
      // Kev, 2026-09-01: also excludes a field marked _unresolved_ THIS SAME
      // turn (the vague-locality immediate-skip above) -- without this, the
      // first-attempt branch below would still re-send the very question
      // that vague-locality handling just decided to never ask again.
      const sendThisQuestion = isAskOnce || (!resolvedNow && priorAskCount === 0 && !updatedChecklist[`_unresolved_${askAbout}`])

      if (sendThisQuestion) {
        const g9 = await gatedSend(session, phone, reply_message, conversationId)
        if (!g9.sent) return
        log_.push({ from: 'bot', text: reply_message, at: new Date().toISOString() })
        // Kev, 2026-09-01 (Gestufte Fragen-Priorität, real bug found while
        // testing): an ASK_ONCE field JUST asked for the first time this
        // turn must never immediately count as "done" -- Stage 3/4's
        // cooperation gating means pets/sharing/subletting are correctly
        // ineligible the instant map is asked-but-not-yet-answered, which
        // made nextMissingField() return null ONE TURN TOO EARLY (before
        // the owner ever got a chance to answer map) and wrongly closed the
        // whole conversation right after sending the map question.
        if (nextMissingField(updatedChecklist) === null && !(isAskOnce && priorAskCount === 0)) finished = true
      } else {
        const next = nextMissingField(updatedChecklist)
        if (!next) {
          finished = true
        } else {
          const nextIsAskOnce = ASK_ONCE_FIELDS.has(next)
          const nextNeverAskedBefore = nextIsAskOnce && !updatedChecklist[`_asked_${next}`]
          const builtRaw = await buildNextMessage(next, logText, combinedText)
          const built = applySublettingInferenceOverride(next, updatedChecklist, builtRaw.reply_message, builtRaw.extracted, combinedText)
          updatedChecklist = mergeExtracted(updatedChecklist, built.extracted, combinedText)
          updatedChecklist[`_ask_count_${next}`] = (updatedChecklist[`_ask_count_${next}`] || 0) + 1
          if (nextIsAskOnce) updatedChecklist[`_asked_${next}`] = true
          const g10 = await gatedSend(session, phone, built.reply_message, conversationId)
          if (!g10.sent) return
          log_.push({ from: 'bot', text: built.reply_message, at: new Date().toISOString() })
          if (nextMissingField(updatedChecklist) === null && !nextNeverAskedBefore) finished = true
        }
      }
    }

    if (finished) {
      const draftId = await writeDraftProperty(phone, updatedChecklist)
      const thanks = "Perfect, thank you so much for all the details! I'll pass this along and we'll be in touch. Have a great day!"
      const g11 = await gatedSend(session, phone, thanks, conversationId)
      if (!g11.sent) return
      log_.push({ from: 'bot', text: thanks, at: new Date().toISOString() })
      await db.query(
        `UPDATE owner_auto_conversations
         SET status='ready_for_kev', checklist=$1, draft_property_id=$2, last_bot_message_at=NOW(), updated_at=NOW()
         WHERE id=$3`,
        [JSON.stringify({ ...updatedChecklist, _log: log_ }), draftId, conversationId]
      )
      await db.query(`UPDATE outreach_log SET conversation_state='done' WHERE phone=$1 AND conversation_state IN ('cold','active')`, [phone])
      await waha.markChatUnread(session, phone)
      // Kev, 2026-09-08: only ever the step-between-checklist-and-AV-CENTRAL
      // when every MUST field is a real, confident value -- "kein UNCLEAR/
      // UNRESOLVED-Feld unter den Pflicht-Basics." `finished` above can go
      // true purely off the OPTIONAL cascade closing (checkOptionalStopRule)
      // while a MUST field is still sitting `_unresolved_X`; this is the
      // one additional gate that keeps a genuinely incomplete listing from
      // ever reaching AV CENTRAL -- it stays exactly the same
      // ready_for_kev/manual-review draft it already was before this
      // feature existed.
      const hasUnresolvedMustField = mustFieldsFor(updatedChecklist).some(f => updatedChecklist[`_unresolved_${f}`])
      const isNonRentalDraft = updatedChecklist.transaction_type === 'sale' || updatedChecklist.property_category === 'commercial'
      if (isNonRentalDraft) {
        const result = await armAutoPublish(conversationId, phone, updatedChecklist, {
          targetGroupId: draftGroupFor(updatedChecklist),
        }).catch(e => {
          log.warn('autoOwnerConversation: sale/commercial draft post failed', { err: e.message })
          return { posted: false, armed: false }
        })
        if (!result?.posted) await notifyAdminEscalation(session, phone,
          `${updatedChecklist.property_category === 'commercial' ? 'commercial' : 'sales'} draft could not reach its review group`,
          `Draft saved (id ${draftId}); open it in the property dashboard.`)
      } else if (!hasUnresolvedMustField) {
        const result = await armAutoPublish(conversationId, phone, updatedChecklist).catch(e => {
          log.warn('autoOwnerConversation: armAutoPublish failed', { err: e.message })
          return { posted: false, armed: false }
        })
        // Kev, 2026-09-10 (real bug found via DB audit: a checklist can finish,
        // write a DB draft, thank the owner, and land on 'ready_for_kev' with
        // ZERO WhatsApp signal to Kev -- neither an AV CENTRAL card (only
        // armAutoPublish posts that, and only on its own success path) nor an
        // admin alert (every OTHER bail-out branch in this function calls
        // notifyAdminEscalation; this was the one that didn't). Kev sees
        // "nothing happened" because, from his phone, genuinely nothing did.
        // armAutoPublish itself already logs a warning on failure -- this adds
        // the missing WhatsApp-visible half of that. A posted-but-not-armed
        // result (existing-CRM-match) is fine as-is -- Kev can already see
        // the card, no alert needed.
        if (!result || !result.posted) {
          await notifyAdminEscalation(session, phone,
            'checklist finished but the AV CENTRAL post/auto-publish failed to send',
            `Draft saved (id ${draftId}) -- resolve manually with !upload5.`)
        }
      } else {
        // Kev, 2026-09-10 (same audit): this used to be a server-log-only
        // event -- 10+ real conversations finished this way with an
        // unresolved MUST field and Kev was never told at all, on WhatsApp or
        // otherwise. The draft sat invisible in the DB. Now mirrors every
        // other manual-handoff branch in this function: a real
        // notifyAdminEscalation ping naming exactly which field(s) are
        // missing, so "!upload5 force" (or a manual correction) is something
        // Kev can actually act on instead of something he has to notice.
        log.info('autoOwnerConversation: checklist finished but a MUST field is unresolved -- staying a manual-review draft', { phone: phone.slice(-4) })
        await notifyAdminEscalation(session, phone,
          'checklist finished but needs your input before it can publish',
          `${unresolvedFieldNote(updatedChecklist) || 'a required field is unresolved'} -- draft saved (id ${draftId}), resolve manually with !upload5.`)
      }
      return
    }

    await db.query(
      `UPDATE owner_auto_conversations SET checklist=$1, last_bot_message_at=NOW(), updated_at=NOW() WHERE id=$2`,
      [JSON.stringify({ ...updatedChecklist, _log: log_ }), conversationId]
    )
  } finally {
    await releaseProcessingLock(conversationId)
  }
}

// ── Cancel commands ────────────────────────────────────────────────────────
async function cancelAllAutomations(triggeredBy) {
  await setGlobalPause(true, triggeredBy)
  // Kev, 2026-09-09: 'awaiting_auto_publish' rows carry a live, ticking
  // publish job too -- !cancela must stop those exactly as hard as it stops
  // an in-progress question flow, not just the ones still mid-checklist.
  const open = await db.query(
    `SELECT id, pending_job_id, checklist FROM owner_auto_conversations WHERE status IN ('active_collecting', 'awaiting_auto_publish')`)
  for (const row of open.rows) {
    await cancelPendingJob(row.pending_job_id)
    await cancelPendingJob(row.checklist?._publish_job_id, 'owner-auto-publish')
  }
  const upd = await db.query(
    `UPDATE owner_auto_conversations SET status='cancelled_global', cancelled_reason=$1, updated_at=NOW()
     WHERE status IN ('active_collecting', 'awaiting_auto_publish') RETURNING id`,
    [`Cancelled globally by ${triggeredBy || 'admin'}`]
  )
  return upd.rows.length
}

async function resumeAllAutomations(triggeredBy) {
  await setGlobalPause(false, triggeredBy)
}

// Kev, 2026-08-31 (HARD STOP spec) -- !ca is the emergency kill switch, so
// it sets BOTH status AND the independent automation_disabled flag
// (migration 047), on purpose redundant with each other. Neither alone is
// the whole story: status stops a NEW processStep claim from ever
// succeeding (see the atomic claim in processStep below); automation_disabled
// is the second, independent check the final send gate re-reads right
// before every single send, so even an already-running worker mid-way
// through generating a reply gets blocked at the last possible moment
// instead of finishing the send anyway.
async function cancelChatAutomation(phone) {
  const convo = await getOpenConversation(phone)
  if (!convo) return false
  await cancelPendingJob(convo.pending_job_id)
  await cancelPendingJob(convo.checklist?._publish_job_id, 'owner-auto-publish')
  await db.query(
    `UPDATE owner_auto_conversations SET status='cancelled_chat', automation_disabled=TRUE, cancelled_reason='!ca', updated_at=NOW() WHERE id=$1`,
    [convo.id]
  )
  return true
}

// ── Force-outreach (Foutreach) override classification ────────────────────
// Used by services/adminCommands.js runDirectOutreach() when `!outreach
// force` is used. force intentionally ignores our own "already contacted"
// cooldowns (Kev's call, his risk) — but a previously DECLINED or already-
// DONE (ready_for_kev) owner is never re-pitched, and a previously-contacted-
// but-unresolved (ghosted) owner gets a short nudge instead of the full pitch
// so they don't receive the same cold pitch twice.
const NUDGE_TEXT = 'Hello, any update please?'

async function classifyForceOverrides(contacts) {
  const toSend = []
  const toSkip = []
  for (const c of contacts) {
    const convo = await db.query(
      `SELECT status FROM owner_auto_conversations WHERE phone = $1 ORDER BY id DESC LIMIT 1`,
      [c.phone]
    )
    const status = convo.rows[0]?.status
    if (status === 'declined') { toSkip.push({ ...c, reason: 'already declined' }); continue }
    if (status === 'ready_for_kev') { toSkip.push({ ...c, reason: 'already provided details' }); continue }

    const outreach = await db.query(
      `SELECT conversation_state FROM outreach_log WHERE phone = $1 ORDER BY sent_at DESC LIMIT 1`,
      [c.phone]
    )
    const state = outreach.rows[0]?.conversation_state
    if (state === 'declined') { toSkip.push({ ...c, reason: 'already declined' }); continue }
    if (state === 'done') { toSkip.push({ ...c, reason: 'already provided details' }); continue }
    if (outreach.rows.length) {
      // Previously contacted, no resolution (ghosted / mid-conversation) — nudge, don't re-pitch.
      toSend.push({ ...c, overrideMessage: NUDGE_TEXT })
    } else {
      // Never contacted before — full pitch as normal.
      toSend.push({ ...c })
    }
  }
  return { toSend, toSkip }
}

module.exports = {
  extractFromFileAttachment, // test-only: file-first owner intake (Kev, 2026-09-22 hotfix)
  handleOwnerReply,
  handleFromMeMessage,
  processStep,
  isTestNumber,
  isAutomationLive,
  localExtract,
  // OG-2 (Kev, 2026-09-04): reused as-is by services/ownerAssistant.js to
  // detect a price/availability/town update in an owner's reply -- pure
  // text extraction, no side effects, safe to share across the two
  // otherwise-independent systems rather than re-deriving the same regexes.
  localExtractAll,
  extractTransactionContext,
  isGloballyPaused,
  cancelAllAutomations,
  resumeAllAutomations,
  cancelChatAutomation,
  classifyForceOverrides,
  ACK_PREFIXES, // test-only: tone-check verifies not every message carries one
  sendGate, // test-only: HARD STOP acceptance tests assert on gate reasons directly
  hasAlreadySentExactText, // test-only: exact-message dedup at the final gate
  completeConversationAfterOperatorUpload, // called by handlers/upload.js after a successful operator upload
  processingLockTTLMs: 2 * 60 * 1000, // test-only: mirrors the SQL literal above
  logLearningIfActive, // called from routes/webhook.js for every owner-inbound DM
  optionalFieldEligible, // test-only
  checkOptionalStopRule, // test-only
  countUnclearSignals, // test-only
  stripListFormatting, // test-only
  // GOLDEN-SCRIPT (Kev, 2026-09-06) -- test-only unless noted
  handleOwnerCallEvent, // called from routes/webhook.js for a real inbound-call event, when/if WAHA sends one
  FALL1_DECLINE_TEXT,
  FALL2_FUTURE_FOLLOWUP_TEXT,
  FALL3_NEEDS_HUMAN_TEXT,
  SUBLETTING_INFERENCE_TEXT,
  looksLikeNeedsHumanContact,
  looksLikeExclusiveTenantPreference,
  AGENCY_QUESTION_RE,
  approvedAgencyAnswer,
  KEVIN_AGENCY_ANSWER,
  CEDRIC_AGENCY_ANSWER,
  GABRIELA_AGENCY_ANSWER,
  computeEngagementLevel,
  mergeExtracted, // test-only: Client/Owner-Flow-Korrekturen Part 4 photo-gap proof
  postChecklistCompleteToAvCentral, // test-only / also called internally from processStep
  buildChecklistCardText, // test-only
  writeDraftProperty, // test-only
  nextMissingField, // test-only
  // Owner-zu-Upload timer-buffer (Kev, 2026-09-09 correction) -- runAutoPublishJob
  // is called by worker.js's 'owner-auto-publish' processor; armAutoPublish and
  // AUTO_PUBLISH_MARKER are test-only / reused by handlers/upload.js's !undo.
  armAutoPublish,
  runAutoPublishJob,
  AUTO_PUBLISH_MARKER,
  findExistingProperty, // test-only: Schritt 2 D dedup-before-collection-start proof
  checklistFromExistingProperty, // test-only
  extractPrice, // test-only: Schritt 2 A price-shorthand proof
  // Final Fixes (2026-09-12): shared with handlers/upload.js's own
  // matchedConvo -> structuredRules mapping so a nuanced subletting answer
  // ("Depends on company") is never re-collapsed to null by a second,
  // independent copy of this logic.
  classifySublettingAnswer,
  isInvalidTownValue, // test-only
  looksLikeOccupancyConflict, // test-only
  buildSanityWarnings, // test-only
}
