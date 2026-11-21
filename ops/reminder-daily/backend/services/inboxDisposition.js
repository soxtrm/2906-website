'use strict'
// ============================================================================
// services/inboxDisposition.js — keep irrelevant "No" replies out of Kev's
// WhatsApp inbox without hiding anything that needs a person (2026-11-21).
//
// Runs ~45 s after an owner DM (so the availability pipeline, the reminder
// detector and the opt-out recorder have finished) and ONLY when ARGUS asked
// this owner something in the last 14 days — a "No" is read through the
// question that preceded it, never on its own.
//   quiet_no            "No, nothing available" / "sorry, all rented"   → read
//   no_with_callback    "No, contact me in January" → read only once the
//                       callback reminder exists (created if missing)
//   opt_out             "Stop contacting me" → read only once the stop is
//                       recorded; pending reminders and planned sends cancelled
//   other_property /    "No, but I have another apartment", questions,
//   actionable          anything with data in it → stays UNREAD
// A newer message from the owner in the meantime cancels the read (the newest
// message decides). Every decision is written to owner_inbox_dispositions;
// nothing is deleted, the chat history stays as it is.
// ============================================================================
const db = require('../db')
const log = require('../logger')

const DELAY_MS = 45_000
const QUESTION_LOOKBACK_DAYS = 14
const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?'
const NEG_RE = /\b(?:no|nope|nothing|none|not\s+(?:now|yet|at\s+the\s+moment|available|anymore|right\s+now)|sorry|unfortunately|rented|taken|gone|don'?t\s+have|do\s+not\s+have|haven'?t\s+got|no\s+longer)\b/i
const POS_RE = /\b(?:yes|yeah|yep|still\s+available|is\s+available|it'?s\s+available|available\s+(?:now|from)|vacant|free\s+(?:now|from))\b/i
const TIME_RE = new RegExp(`\\b(?:${MONTHS}|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\\s+(?:week|month|year|season|summer|winter)|in\\s+(?:a|one|two|three|four|six|\\d{1,2})\\s+(?:weeks?|months?)|end\\s+of\\s+(?:the\\s+)?(?:week|month|year)|after\\s+(?:christmas|easter|summer|the\\s+summer|new\\s+year)|later\\s+(?:this|next)|in\\s+the\\s+(?:new\\s+year|summer|spring|autumn|winter))\\b`, 'i')
const CALLBACK_VERB_RE = /\b(?:contact|message|msg|text|write|call|ring|ask|check|get\s+back|come\s+back|reach\s+out|try\s+(?:again|me)|let\s+you\s+know|keep\s+you\s+(?:posted|informed|updated)|touch\s+base)\b/i
const OTHER_PROPERTY_RE = /\b(?:another|other|different|second|new|one\s+more)\b[^.?!]{0,40}\b(?:apartment|flat|property|place|house|penthouse|maisonette|studio|unit|villa|one)\b|\bbut\s+(?:i|we)\s+(?:do\s+)?(?:have|got|will\s+have)\b|\b(?:i|we)\s+(?:do\s+)?have\s+(?:a|an|one|two|\d)\b/i
const QUESTION_RE = /\?|\b(?:who\s+(?:is|are)\s+(?:this|you)|who'?s\s+this|how\s+much|what\s+(?:is|are)|which\s+(?:agency|company)|can\s+you|could\s+you|do\s+you)\b/i
const DATA_RE = /\d|€|eur\b/i
const FILLER_RE = /^(?:(?:hi|hello|hey|dear|good\s+(?:morning|afternoon|evening)|kevin|kev|cedric|gabriela|sorry|no|nope|nothing|none|not|else|more|other|thanks|thank\s+you|thx|tx|ok|okay|unfortunately|at|the|this|moment|now|right|currently|for|anything|available|all|rented|rent|out|already|taken|gone|i|we|don'?t|do|have|it'?s|it|is|was|has|been|any|more|anymore|at\s+the\s+moment|yet|still|sir|madam|mate|bro|regards|kind|best|bye|cheers|good\s+luck|apologies|[.,!🙏👍🙂😊🙁😕👌❤️]+)\s*)+$/i

function decide(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim()
  if (!raw) return { kind: 'empty' }
  const gate = require('./ownerSendGate')
  if (gate.isExplicitOptOut?.(raw) || /\b(?:stop\s+(?:contacting|messaging|texting|writing)|don'?t\s+(?:contact|message|text|write)|do\s+not\s+(?:contact|message)|remove\s+(?:me|my\s+number)|unsubscribe)\b/i.test(raw)) return { kind: 'opt_out' }
  if (OTHER_PROPERTY_RE.test(raw)) return { kind: 'other_property' }
  if (QUESTION_RE.test(raw)) return { kind: 'actionable', why: 'question' }
  if (!NEG_RE.test(raw) || POS_RE.test(raw)) return { kind: 'not_negative' }
  if (TIME_RE.test(raw)) {
    const explicit = CALLBACK_VERB_RE.test(raw)
    // "rented since 1 March for 1200" carries facts for a person, not a callback
    if (!explicit && (DATA_RE.test(raw) || /since/i.test(raw))) return { kind: 'actionable', why: 'negative_with_details' }
    return { kind: 'no_with_callback', explicit }
  }
  if (raw.length <= 160 && !DATA_RE.test(raw) && FILLER_RE.test(raw)) return { kind: 'quiet_no' }
  return { kind: 'actionable', why: 'negative_with_details' }
}

const phone9 = v => String(v || '').replace(/\D/g, '').slice(-9)
const LAST_KEY = (session, phone) => `inbox:last:${String(session || '').toLowerCase()}:${phone9(phone)}`

async function askedRecently(phone, ownerId) {
  const p = phone9(phone)
  if (!p) return null
  const r = await db.query(
    `SELECT 'outreach' AS via, MAX(sent_at) AS at FROM outreach_log WHERE right(regexp_replace(phone,'\\D','','g'),9)=$1 AND sent_at > NOW() - ($3 || ' days')::interval
     UNION ALL SELECT 'reminder', MAX(sent_at) FROM reminder_dispatches WHERE right(owner_phone,9)=$1 AND state='sent' AND sent_at > NOW() - ($3 || ' days')::interval
     UNION ALL SELECT 'availability_check', MAX(created_at) FROM availability_checks WHERE ($2::int IS NOT NULL AND owner_id=$2) AND created_at > NOW() - ($3 || ' days')::interval
     UNION ALL SELECT 'weekly_recheck', MAX(sent_at) FROM owner_recheck_threads WHERE ($2::int IS NOT NULL AND owner_id=$2) AND sent_at > NOW() - ($3 || ' days')::interval`,
    [p, ownerId || null, String(QUESTION_LOOKBACK_DAYS)]).catch(err => { log.debug('[inbox] question lookup failed', { err: err.message }); return { rows: [] } })
  return r.rows.filter(x => x.at).sort((a, b) => new Date(b.at) - new Date(a.at))[0] || null
}

async function audit(row) {
  await db.query(
    `INSERT INTO owner_inbox_dispositions (session, chat_id, phone, owner_id, message_id, text, disposition, action, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [row.session || null, row.chatId || null, phone9(row.phone) || null, row.ownerId || null, row.messageId || null, String(row.text || '').slice(0, 1000),
     row.disposition, row.action, JSON.stringify(row.detail || {})]).catch(err => log.warn('[inbox] audit write failed', { err: err.message }))
}

async function markRead(session, chatId, phone) {
  const redis = require('../redis')
  // waha.markChatUnread consults this key, so a later "make it look fresh" stays read
  const key = s => `recheck7d:quiet:${String(session || '').toLowerCase()}:${String(s || '').replace(/\D/g, '').slice(-9)}`
  for (const k of [key(chatId), key(phone)]) await redis.set(k, '1', 'EX', 6 * 3600).catch(() => {})
  await require('../waha').sendSeen(session, chatId)
}

async function ownerFor(phone) {
  return (await db.query(`SELECT id FROM owner_contacts WHERE right(regexp_replace(COALESCE(phone_normalized,''),'\\D','','g'),9)=$1 ORDER BY id DESC LIMIT 1`, [phone9(phone)])).rows[0] || null
}

async function handle({ session, chatId, phone, text, messageId, receivedAt = new Date() }) {
  const d = decide(text)
  if (['empty', 'not_negative'].includes(d.kind)) return { action: 'none', disposition: d.kind }
  const owner = await ownerFor(phone)
  const asked = await askedRecently(phone, owner?.id)
  const base = { session, chatId, phone, ownerId: owner?.id || null, messageId, text, disposition: d.kind }
  if (!asked) { await audit({ ...base, action: 'kept_no_preceding_question' }); return { action: 'kept', disposition: d.kind, why: 'no_preceding_question' } }
  // the newest owner message decides: a later message cancels this read
  try {
    const latest = await require('../redis').get(LAST_KEY(session, phone))
    if (latest && messageId && latest !== messageId) { await audit({ ...base, action: 'kept_newer_message' }); return { action: 'kept', why: 'newer_message' } }
  } catch { /* soft */ }

  if (d.kind === 'quiet_no') {
    // Kev, 2026-11-21: only once the answer is saved. A property question that is still
    // 'awaiting' with no recorded reply means the availability pipeline did not store it.
    if (owner?.id) {
      const open = (await db.query(
        `SELECT id FROM availability_checks WHERE owner_id=$1 AND status='awaiting' AND created_at > NOW() - interval '14 days'
            AND (reply_at IS NULL OR reply_at < $2::timestamptz - interval '2 minutes') LIMIT 1`, [owner.id, receivedAt]).catch(() => ({ rows: [] }))).rows[0]
      if (open) { await audit({ ...base, action: 'kept_answer_not_saved', detail: { checkId: open.id } }); return { action: 'kept', why: 'answer_not_saved' } }
    }
    await markRead(session, chatId, phone)
    await audit({ ...base, action: 'marked_read', detail: { question: asked.via } })
    return { action: 'marked_read', disposition: d.kind }
  }
  if (d.kind === 'no_with_callback') {
    let reminder = (await db.query(
      `SELECT id, contact_due_date::text AS due FROM reminders WHERE right(regexp_replace(owner_phone,'\\D','','g'),9)=$1 AND status='pending'
         AND created_at > $2::timestamptz - interval '2 minutes' ORDER BY id DESC LIMIT 1`, [phone9(phone), receivedAt])).rows[0]
    if (!reminder) {
      const id = await require('./reminderFromMessage').captureFromReply(String(phone).replace(/\D/g, ''), text, { session, messageId }).catch(() => null)
      if (id) reminder = (await db.query(`SELECT id, contact_due_date::text AS due FROM reminders WHERE id=$1`, [id])).rows[0]
    }
    if (!reminder) { await audit({ ...base, action: 'kept_callback_not_recorded' }); return { action: 'kept', why: 'callback_not_recorded' } }
    // The owner named a date: no weekly recheck / availability cadence before it (the
    // pause lifts ON that date, when the callback itself goes out). A later pause stays.
    if (owner?.id && reminder.due) {
      const cur = (await db.query(`SELECT owner_contact_paused_until::text AS until FROM owner_contacts WHERE id=$1`, [owner.id])).rows[0]
      if (!cur?.until || cur.until < reminder.due) {
        await require('./ownerSendGate').setContactPause({ scope: 'owner', id: owner.id, until: reminder.due, note: `Owner asked to be contacted on ${reminder.due} (reminder ${reminder.id})`, by: 'inbox-callback' })
      }
    }
    await markRead(session, chatId, phone)
    await audit({ ...base, action: 'marked_read', detail: { reminderId: reminder.id, due: reminder.due, question: asked.via } })
    return { action: 'marked_read', disposition: d.kind, reminderId: reminder.id }
  }
  if (d.kind === 'opt_out') {
    const p = phone9(phone)
    const stopped = (await db.query(
      `SELECT 1 FROM owner_automation_blocks WHERE right(phone_normalized,9)=$1 AND active
       UNION ALL SELECT 1 FROM owner_contacts WHERE right(regexp_replace(COALESCE(phone_normalized,''),'\\D','','g'),9)=$1 AND (do_not_contact IS TRUE OR status='do_not_contact') LIMIT 1`, [p])).rows.length
    if (!stopped) { await audit({ ...base, action: 'kept_opt_out_not_recorded' }); return { action: 'kept', why: 'opt_out_not_recorded' } }
    const cancelled = await db.query(
      `UPDATE reminders SET status='cancelled', auto_send_status='blocked', auto_send_block_reason='Explicit owner opt-out'
        WHERE status='pending' AND right(regexp_replace(owner_phone,'\\D','','g'),9)=$1 RETURNING id`, [p])
    await db.query(`UPDATE reminder_dispatches SET state='skipped', reason='owner_opt_out', updated_at=NOW() WHERE right(owner_phone,9)=$1 AND state IN ('planned','waiting')`, [p])
    await markRead(session, chatId, phone)
    await audit({ ...base, action: 'marked_read', detail: { cancelledReminders: cancelled.rows.map(r => r.id) } })
    return { action: 'marked_read', disposition: d.kind, cancelledReminders: cancelled.rows.length }
  }
  await audit({ ...base, action: 'kept_visible', detail: { why: d.why || d.kind, question: asked.via } })
  return { action: 'kept', disposition: d.kind }
}

// Kev, 2026-11-21: ONE decision per owner turn. The webhook asks this before any
// reply generator runs: a plain "No" / "No, contact me in January" / "stop" that
// answers OUR question is final — no AI reply, no OG-1 reply, no second bot message.
// Anything actionable is not final and goes through the normal pipeline.
async function finalTurn({ phone, session, text }) {
  const d = decide(text)
  if (!['quiet_no', 'no_with_callback', 'opt_out'].includes(d.kind)) return { final: false, kind: d.kind }
  const owner = await ownerFor(phone)
  const asked = await askedRecently(phone, owner?.id)
  if (!asked) return { final: false, kind: d.kind, why: 'no_preceding_question' }
  log.info('[inbox] final owner turn — reply generators suppressed', { kind: d.kind, question: asked.via, session })
  return { final: true, kind: d.kind, question: asked.via }
}

// Called for every inbound owner DM; returns at once, decides 45 s later.
function onInbound({ session, chatId, senderPhone, text, messageId }) {
  const phone = senderPhone || chatId
  const receivedAt = new Date()
  require('../redis').set(LAST_KEY(session, phone), String(messageId || receivedAt.getTime()), 'EX', 3600).catch(() => {})
  const d = decide(text)
  if (['empty', 'not_negative'].includes(d.kind)) return
  setTimeout(() => {
    handle({ session, chatId, phone, text, messageId: messageId || String(receivedAt.getTime()), receivedAt })
      .catch(err => log.warn('[inbox] disposition failed — chat left as it is', { err: err.message }))
  }, DELAY_MS).unref?.()
}

module.exports = { decide, handle, onInbound, finalTurn, markRead, DELAY_MS }
