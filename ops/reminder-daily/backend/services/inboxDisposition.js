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
// Kev, 2026-11-21 (Barbara / Andrew Zammit / Raymond Psaila): owners do not write from a
// word list. The decision reads MEANING: nothing available, "I'll let you know", a future
// month, a plain closing — and anything that still needs a person stays actionable.
const POS_RE = /\b(?:yes|yeah|yep|still\s+available|is\s+(?:still\s+)?available|it'?s\s+(?:still\s+)?available|available\s+(?:now|from)|vacant|free\s+(?:now|from))\b/i
const TIME_RE = new RegExp(`\\b(?:${MONTHS}|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\\s+(?:week|month|year|season|summer|winter)|in\\s+(?:a|one|two|three|four|six|\\d{1,2})\\s+(?:weeks?|months?)|end\\s+of\\s+(?:the\\s+)?(?:week|month|year)|after\\s+(?:christmas|easter|summer|the\\s+summer|new\\s+year)|later\\s+(?:this|next)|in\\s+the\\s+(?:new\\s+year|summer|spring|autumn|winter))\\b`, 'i')
const MONTH_RE = new RegExp(`\\b(${MONTHS})\\b`, 'i')
// the owner asks US to come back
const CALLBACK_VERB_RE = /\b(?:contact|message|msg|text|write|call|ring|ask|remind|try|check\s+(?:back\s+)?with|get\s+back\s+to|come\s+back\s+to|reach\s+out\s+to|whatsapp)\s+(?:me|us)\b|\bcheck\s+(?:back|again)\b|\btouch\s+base\b|\bkeep\s+in\s+touch\b/i
// the owner promises to come back to us
const WILL_UPDATE_RE = /\b(?:i'?ll|i\s+will|we'?ll|we\s+will|will)\b[^.?!]{0,40}\b(?:let\s+you\s+know|inform\s+you|contact\s+you|message\s+you|text\s+you|write\s+(?:to\s+)?you|get\s+back\s+to\s+you|keep\s+you\s+(?:posted|updated|informed)|send\s+(?:you|it|them|details|photos|pics)|be\s+in\s+touch)\b|\b(?:i|we)\s+will\s+when\b|\bwhen\s+(?:i|we)\s+(?:have|get)\s+(?:something|anything)\b|\bwill\s+do\b/i
// "nothing available" in the many ways owners write it (also "all are taken", "atm")
const NOTHING_RE = /\b(?:nothing|none|nada)\b|\bno\s+(?:propert(?:y|ies)|flats?|apartments?|units?|places?|houses?|vacanc(?:y|ies)|availability)\b|\b(?:all|everything|both)\b[^.?!]{0,30}\b(?:taken|rented|let|leased|gone|occupied|full|booked|sold)\b|\bfully\s+(?:rented|booked|let|occupied)\b|\b(?:don'?t|do\s+not|didn'?t)\s+have\s+(?:any|anything)\b|\bnot\s+(?:at\s+the\s+moment|now|right\s+now|currently|for\s+now|atm|available|any\s?more)\b|\bunfortunately\s+not\b|\b(?:i\s+|we\s+)?(?:don'?t|dont|do\s+not)\s+have\b(?=\s*(?:any|anything|nothing|at\s+the\s+moment|now|right\s+now|thanks?|thank\s+you|[.,!]|$))|\bunfortunately\s+(?:i|we)\s+(?:don'?t|dont)\b/i
const SHORT_NO_RE = /^(?:(?:hi|hello|good\s+\w+)[\s,.!]+)?(?:no|nope|sorry|sorry\s+no|no\s+sorry|unfortunately\s+not|not\s+really|nah)\b[\s,.!🙏👍🙂😊🙁😕]*(?:thanks?|thank\s+you|thx|kevin|kev|cedric|gabriela)?[\s,.!🙏👍🙂😊🙁😕]*$/i
const CLOSING_RE = /^(?:(?:ok(?:ay)?|thanks?|thank\s+you(?:\s+(?:so\s+much|very\s+much|too))?|thx|ty|tx|(?:you'?re\s+)?welcome|cheers|great|perfect|noted|sure|no\s+problem|np|bye|good\s*(?:night|day|evening)|have\s+a\s+(?:nice|good|great)\s+(?:day|evening|week(?:end)?)|same\s+to\s+you|you\s+too|kevin|kev|cedric|gabriela)[\s,.!🙏👍👌🙂😊❤️]*)+$/i
const OTHER_PROPERTY_RE = /\b(?:another|other|different|second|one\s+more)\b[^.?!]{0,40}\b(?:apartment|flat|property|place|house|penthouse|maisonette|studio|unit|villa|one)\b|\bbut\s+(?:i|we)\s+(?:do\s+)?(?:have|got)\b|\b(?:i|we)\s+(?:do\s+)?(?:have|got)\s+(?:a|an|one|two|three|\d)\s*(?:-|\s)?(?:bed|bedroom|bedroomed|apartment|apt|flat|penthouse|maisonette|studio|house|property|room|unit)\b|\bavail[ai]ble\s+for\s+(?:rent|sale)\b|\bnew\s+(?:apartment|flat|property|listing|place)\b|\bavailable\s+(?:again|now)\b/i
const QUESTION_RE = /\?|\b(?:who\s+(?:is|are)\s+(?:this|you)|who'?s\s+this|how\s+much|which\s+(?:agency|company)|can\s+you|could\s+you|do\s+you|are\s+you)\b/i
const PRICE_RE = /€\s*\d|\d+\s*(?:€|eur|euros?|k\b)|\bper\s+month\b/i
const ELSE_RE = /\b(?:nothing|anything|none)\s+else\b|\bno\s+other\b|\bnothing\s+more\b/i

function decide(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim()
  if (!raw) return { kind: 'empty' }
  const gate = require('./ownerSendGate')
  if (gate.isExplicitOptOut?.(raw) || /\b(?:stop\s+(?:contacting|messaging|texting|writing)|don'?t\s+(?:contact|message|text|write)|do\s+not\s+(?:contact|message)|remove\s+(?:me|my\s+number)|unsubscribe)\b/i.test(raw)) return { kind: 'opt_out' }
  if (QUESTION_RE.test(raw)) return { kind: 'actionable', why: 'question' }
  if (OTHER_PROPERTY_RE.test(raw) && !ELSE_RE.test(raw)) return { kind: 'other_property' }
  if (CLOSING_RE.test(raw)) return { kind: 'closing' }
  const month = (MONTH_RE.exec(raw) || [])[1] || null
  const callback = CALLBACK_VERB_RE.test(raw)
  const willUpdate = WILL_UPDATE_RE.test(raw)
  const timed = TIME_RE.test(raw)
  if (callback && timed) return { kind: 'no_with_callback', explicit: true, month }
  if (timed && /\b(?:might|may|will|should|probably|hopefully|expect|expecting|coming|planning|from|by|until|till|after)\b/i.test(raw) && !/\bsince\b/i.test(raw)) {
    // "I might have something in February" / "nothing now, maybe from March": a future month, no request to call
    return { kind: 'future_availability', month, details: PRICE_RE.test(raw) }
  }
  if (willUpdate) return { kind: 'owner_will_update', month: timed ? month : null }
  if (POS_RE.test(raw) && !NOTHING_RE.test(raw)) return { kind: 'not_negative' }
  if (NOTHING_RE.test(raw) || SHORT_NO_RE.test(raw)) {
    if (PRICE_RE.test(raw) || /\bsince\b/i.test(raw)) return { kind: 'actionable', why: 'negative_with_details' }
    // "they all love it but none give me my price … I will wait for the right client with no pets":
    // wishes about price, tenants or conditions are for a person, not a processed "no"
    if (/\b(?:price|client|tenants?|pets?|couple|family|students?|wait\s+for|looking\s+for|prefer|want|negotiable|condition|deposit|contract)\b/i.test(raw)) return { kind: 'actionable', why: 'negative_with_wishes' }
    if (raw.length > 120 && !/\b(?:nothing|none)\s+(?:is\s+)?(?:available|free|left)\b|\ball\s+(?:are\s+|is\s+)?(?:taken|rented|let|gone)\b|\bfully\s+(?:rented|booked)\b/i.test(raw)) return { kind: 'actionable', why: 'long_message' }
    return { kind: 'quiet_no' }
  }
  return { kind: 'not_negative' }
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
  // what we can actually know: whether WAHA accepted the read receipt. GOWS exposes no
  // unread counter, so the state on the phone itself is NOT observable from the server.
  const w = require('../waha')
  if (w.sendSeenChecked) return { ...(await w.sendSeenChecked(session, chatId)), phoneState: 'not_observable' }
  await w.sendSeen(session, chatId)
  return { api: 'called', phoneState: 'not_observable' }
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
function addDaysIso(n, from = new Date()) { const d = new Date(from.getTime() + n * 86400e3); return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Malta' }).format(d) }
// Follow-up for "something in <month>": the Monday about 3 weeks before that month starts
// (at least 3 days from now). The phrase keeps the owner's month — no invented day.
function followupForMonth(raw, now = new Date()) {
  if (!raw) return null
  const idx = MONTH_NAMES.findIndex(m => m.startsWith(String(raw).toLowerCase().slice(0, 3)))
  if (idx < 0) return null
  const today = new Date(`${addDaysIso(0, now)}T12:00:00Z`)
  let year = today.getUTCFullYear()
  let start = new Date(Date.UTC(year, idx, 1, 12))
  if (start <= today) start = new Date(Date.UTC(++year, idx, 1, 12))
  const due = new Date(start.getTime() - 21 * 86400e3)
  while (due.getUTCDay() !== 1) due.setUTCDate(due.getUTCDate() + 1)
  const min = new Date(today.getTime() + 3 * 86400e3)
  const pick = due < min ? min : due
  const name = MONTH_NAMES[idx][0].toUpperCase() + MONTH_NAMES[idx].slice(1)
  return { due: pick.toISOString().slice(0, 10), phrase: `in ${name}`, month: name }
}
async function pauseUntil(ownerId, until, note) {
  const cur = (await db.query(`SELECT owner_contact_paused_until::text AS until FROM owner_contacts WHERE id=$1`, [ownerId])).rows[0]
  if (cur?.until && cur.until >= until) return
  await require('./ownerSendGate').setContactPause({ scope: 'owner', id: ownerId, until, note, by: 'inbox-decision' })
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
    const seen = await markRead(session, chatId, phone)
    await audit({ ...base, action: 'marked_read', detail: { seen, question: asked.via } })
    return { action: 'marked_read', disposition: d.kind }
  }
  if (d.kind === 'closing' || d.kind === 'owner_will_update') {
    // "Welcome" / "Thanks" / "I'll let you know": nothing to answer. "I'll let you know" also
    // starts the 21-day no-stock cadence (no earlier contact unless they write or set a date).
    if (d.kind === 'owner_will_update' && owner?.id) await pauseUntil(owner.id, addDaysIso(21), 'Owner will let us know (21-day cadence)')
    const seen = await markRead(session, chatId, phone)
    await audit({ ...base, action: 'marked_read', detail: { seen, question: asked.via } })
    return { action: 'marked_read', disposition: d.kind }
  }
  if (d.kind === 'future_availability') {
    // "might have something in February": plan ONE follow-up about 3 weeks before that month,
    // never a made-up day for the availability itself (the reminder keeps the month only).
    const plan = followupForMonth(d.month)
    let reminderId = null
    if (plan) {
      const p9 = phone9(phone)
      const existing = (await db.query(
        `SELECT id FROM reminders WHERE right(regexp_replace(owner_phone,'\D','','g'),9)=$1 AND status='pending' AND created_at > $2::timestamptz - interval '2 minutes' ORDER BY id DESC LIMIT 1`, [p9, receivedAt])).rows[0]
      if (existing) {
        await db.query(`UPDATE reminders SET contact_due_date=$2, parsed_timing=$3 WHERE id=$1`, [existing.id, plan.due, plan.phrase])
        reminderId = existing.id
      } else {
        reminderId = (await db.query(
          `INSERT INTO reminders (source_session, source_phone, source_message_id, owner_phone, owner_name, original_note, parsed_timing, contact_due_date, status)
           VALUES ($1,$2,$3,$2,NULL,$4,$5,$6,'pending') RETURNING id`,
          [session, String(phone).replace(/\D/g, ''), messageId || null, String(text).slice(0, 1000), plan.phrase, plan.due])).rows[0].id
      }
      if (owner?.id) await pauseUntil(owner.id, plan.due, `Owner expects availability ${plan.phrase} — follow-up planned ${plan.due}`)
    }
    if (!plan || d.details) { await audit({ ...base, action: 'kept_visible', detail: { why: plan ? 'future_availability_with_details' : 'month_not_understood', reminderId } }); return { action: 'kept', disposition: d.kind, reminderId } }
    const seen = await markRead(session, chatId, phone)
    await audit({ ...base, action: 'marked_read', detail: { seen, reminderId, due: plan.due, month: plan.phrase, question: asked.via } })
    return { action: 'marked_read', disposition: d.kind, reminderId }
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
    const seen = await markRead(session, chatId, phone)
    await audit({ ...base, action: 'marked_read', detail: { seen, reminderId: reminder.id, due: reminder.due, question: asked.via } })
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
    const seen = await markRead(session, chatId, phone)
    await audit({ ...base, action: 'marked_read', detail: { seen, cancelledReminders: cancelled.rows.map(r => r.id) } })
    return { action: 'marked_read', disposition: d.kind, cancelledReminders: cancelled.rows.length }
  }
  await audit({ ...base, action: 'kept_visible', detail: { why: d.why || d.kind, question: asked.via } })
  return { action: 'kept', disposition: d.kind }
}

// Kev, 2026-11-21: ONE decision per owner turn. The webhook asks this before any
// reply generator runs: a plain "No" / "No, contact me in January" / "stop" that
// answers OUR question is final — no AI reply, no OG-1 reply, no second bot message.
// Anything actionable is not final and goes through the normal pipeline.
const FINAL_KINDS = ['quiet_no', 'no_with_callback', 'opt_out', 'owner_will_update', 'future_availability', 'closing']
async function finalTurn({ phone, session, text }) {
  const d = decide(text)
  if (!FINAL_KINDS.includes(d.kind)) return { final: false, kind: d.kind }
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

module.exports = { decide, handle, onInbound, finalTurn, markRead, followupForMonth, FINAL_KINDS, DELAY_MS }
