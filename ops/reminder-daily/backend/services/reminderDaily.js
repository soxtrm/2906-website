'use strict'
// ============================================================================
// services/reminderDaily.js — Reminder Due, fully automatic (Kev, 2026-11-21).
//
// "ARGUS follows up when promised." Every morning at 09:00 Europe/Malta:
//   plan  — every pending reminder whose date has arrived (since the go-live
//           date in settings.reminder_daily_since, at most 3 days back: no
//           backlog) gets ONE dispatch record for today: planned (with a send
//           time, staggered per account) or skipped / waiting with the reason.
//   send  — every minute 09:00–19:00 the planned rows whose time has come are
//           claimed, re-checked (opt-out, DNC, pauses, human active, 4-day
//           owner-wide cooldown, sender online) and sent from the account the
//           owner talked to, with an APPROVED Safe Draft for the persona and
//           intent (owner_requested_callback / upcoming_property_followup).
//           The greeting is generated at that moment; nothing is rewritten by
//           AI. Result per reminder: sent · skipped · waiting · failed · ambiguous.
// Safety: one message per owner per day (unique index), a send that may have
// reached WhatsApp is never repeated (ambiguous → human), a worker restart
// turns in-flight rows ambiguous, WAHA down → retried for the day then waits.
// Kill switch: env REMINDER_DAILY=0. Never on Sunday (Monday catches up).
// ============================================================================
const db = require('../db')
const log = require('../logger')
const waha = require('../waha')

const TZ = 'Europe/Malta'
const GRACE_DAYS = 3
const COOLDOWN_DAYS = 4
const SEND_START_MIN = 9 * 60
const SEND_END_MIN = 18 * 60 + 30
const STAGGER_MIN = [3, 6]          // minutes between two sends of one account
const RETRY_MIN = 10
const MAX_ATTEMPTS = 12
const HEALTHY = new Set(['WORKING', 'CONNECTED'])
const enabled = () => process.env.REMINDER_DAILY !== '0'

function maltaParts(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(d).map(x => [x.type, x.value]))
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), weekday: p.weekday }
}
const addDays = (date, n) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
function maltaAt(date, minutes) {
  return require('./outreachSchedule').maltaLocalToUTC(date, `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`)
}
const digits = v => String(v || '').replace(/\D/g, '')

// ── Reading the owner's request (pure) ───────────────────────────────────────
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const MON_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
const AUTO_REPLY_RE = /thanks? for (?:reaching out|contacting|your message)|you(?:'|’)ve got \w+|office hours|automated (?:reply|message)|auto-?reply|we will get back to you|currently (?:out of (?:the )?office|unavailable)/i
// Only the owner asking US to come back counts as a callback ("contact me in January");
// "I'll let you know" / "I'll keep you posted" / "will call you" is the owner's own promise.
const CALLBACK_RE = /\b(?:contact|message|msg|text|write|call|ring|remind|ask|try|check (?:back )?with|get back to|come back to|reach out to|follow up with|whatsapp)\s+(?:me|us)\b|\bkeep in touch\b|\btouch base\b|\b(?:check|ask) (?:back|again) (?:in|on|at|after|next)\b/i
const UPCOMING_RE = /\b(?:availab\w*|free|vacant|ready|leav(?:e|es|ing)|move[- ]?in|coming|finish\w*|renovat\w*|furnish\w*|tenants?|occupied|viewings?|have (?:a|an|something|one)|will have)\b/i
const TYPES = ['penthouse', 'maisonette', 'apartment', 'flat', 'studio', 'townhouse', 'house of character', 'house', 'villa', 'duplex', 'bungalow', 'office', 'garage', 'shop']

const title = s => s.replace(/\b([a-z])/g, c => c.toUpperCase())
function monthName(raw) { const i = MONTHS.findIndex(m => m.startsWith(String(raw).toLowerCase().slice(0, 3))); return i >= 0 ? title(MONTHS[i]) : null }

// The owner's own timing words, made to read inside "you asked me to follow up ___".
function normalizePhrase(raw) {
  const s = String(raw || '').trim().replace(/\s+/g, ' ').replace(/[.!,;]+$/, '')
  if (!s || s.length > 40) return null
  const t = s.toLowerCase()
  let m
  if ((m = new RegExp(`^(?:the )?(end|beginning|start|middle|mid)(?: of)? ${MON_RE}$`).exec(t))) return `${m[1] === 'mid' || m[1] === 'middle' ? 'in the middle' : m[1] === 'end' ? 'at the end' : 'at the beginning'} of ${monthName(m[2])}`
  if ((m = new RegExp(`^(?:in |by |around |after |from |early |late |mid )?${MON_RE}$`).exec(t))) { const pre = (t.match(/^(in|by|around|after|from|early|late|mid) /) || [])[1]; return `${pre && !['early', 'late', 'mid'].includes(pre) ? pre : 'in'} ${pre && ['early', 'late'].includes(pre) ? pre + ' ' : ''}${monthName(m[1])}` }
  if ((m = new RegExp(`^(?:on |by |from |the |after |around )*(\\d{1,2})(?:st|nd|rd|th)?(?: of)? ${MON_RE}$`).exec(t))) return `on ${Number(m[1])} ${monthName(m[2])}`
  if ((m = new RegExp(`^(?:on |by |from )?${MON_RE} (\\d{1,2})(?:st|nd|rd|th)?$`).exec(t))) return `on ${Number(m[2])} ${monthName(m[1])}`
  if ((m = /^(?:in |on |by )?(?:the )?(next|this) (week|month|year)$/.exec(t))) return `${m[1]} ${m[2]}`
  if ((m = /^(?:at |by |around )?(?:the )?end of (?:the )?(week|month|year)$/.exec(t))) return `at the end of the ${m[1]}`
  if ((m = /^in (\d{1,2}|a|one|two|three|four|six) (weeks?|months?)$/.exec(t))) return `in ${m[1]} ${m[2]}`
  if ((m = new RegExp(`^(?:on |by |next |this )?(${WEEKDAYS.join('|')})$`).exec(t))) return `on ${title(m[1])}`
  if ((m = /^(?:after |around |before )?(christmas|easter|the summer|summer|the new year|new year)$/.exec(t))) return `${t.startsWith('after') ? 'after' : t.startsWith('before') ? 'before' : 'around'} ${title(m[1].replace(/^the /, ''))}`
  return null
}

// Malti letters and apostrophes are ignored when matching ("Gzira" finds "Gżira").
const fold = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[żŻ]/g, 'z').replace(/[ħĦ]/g, 'h').replace(/[ġĠ]/g, 'g').replace(/[ċĊ]/g, 'c').replace(/['’`]/g, '').toLowerCase()
const BUILTIN_TOWNS = ['Gżira', 'Sliema', "St Julian's", 'Msida', 'Swieqi', 'Valletta', 'Birkirkara', 'Mosta', 'Naxxar', "St Paul's Bay", 'Qawra', 'Buġibba', 'Mellieħa',
  'Marsaskala', "Ta' Xbiex", 'Pietà', 'Ħamrun', 'Floriana', 'San Ġwann', 'Pembroke', 'Attard', 'Balzan', 'Lija', 'Iklin', 'Mġarr', 'Rabat', 'Mdina', 'Żebbuġ', 'Siġġiewi',
  'Qormi', 'Paola', 'Fgura', 'Żabbar', 'Tarxien', 'Birżebbuġa', 'Marsaxlokk', 'Żejtun', 'Kalkara', 'Birgu', 'Senglea', 'Cospicua', 'Gozo', 'Victoria', 'Xlendi', 'Marsalforn',
  'Għargħur', 'Madliena', 'Kappara', 'Santa Venera', 'Luqa', 'Gudja', 'Kirkop', 'Mqabba', 'Qrendi', 'Żurrieq', 'Xemxija', 'Paceville', 'Santa Luċija', 'Xagħra', 'Nadur', 'Għajnsielem']
let townCache = null
async function towns() {
  if (townCache) return townCache
  let fromDb = []
  try { fromDb = (await db.query(`SELECT DISTINCT name FROM villages WHERE name IS NOT NULL AND length(name) BETWEEN 3 AND 30`)).rows.map(x => x.name) } catch { /* soft */ }
  const seen = new Set(); townCache = []
  for (const t of [...BUILTIN_TOWNS, ...fromDb]) { const k = fold(t); if (!seen.has(k)) { seen.add(k); townCache.push(t) } }
  townCache.sort((a, b) => b.length - a.length)
  return townCache
}
// "3 bedroom apartment in Gzira" → "the 3-Bedroom Apartment in Gzira". Only what the note says.
function propertyLabel(note, townList = []) {
  const t = String(note || '')
  const beds = /\b(\d)\s*-?\s*(?:bed(?:room)?s?|br|bedroomed)\b/i.exec(t)
  const type = TYPES.find(x => new RegExp(`\\b${x}s?\\b`, 'i').test(t))
  const folded = ` ${fold(t).replace(/[^a-z0-9]+/g, ' ')} `
  const town = townList.find(x => folded.includes(` ${fold(x).replace(/[^a-z0-9]+/g, ' ').trim()} `))
  if (!beds && !type && !town) return null
  const parts = [beds ? `${beds[1]}-Bedroom` : null, type ? title(type) : (beds ? 'Property' : 'property')].filter(Boolean)
  return `the ${parts.join(' ')}${town ? ` in ${town}` : ''}`
}

function classify(reminder, townList = []) {
  const note = String(reminder.original_note || '').trim()
  if (!note) return { skip: 'no_recorded_request' }
  if (AUTO_REPLY_RE.test(note)) return { skip: 'automatic_reply_not_an_owner_request' }
  const phrase = normalizePhrase(reminder.parsed_timing)
  const label = propertyLabel(note, townList)
  if (CALLBACK_RE.test(note)) {
    return { intent: 'owner_requested_callback', vars: { agreed_followup_time_phrase: phrase, followup_subject: label || 'any upcoming availability' } }
  }
  if (UPCOMING_RE.test(note)) {
    return { intent: 'upcoming_property_followup', vars: { upcoming_property_label: label || 'your property' } }
  }
  return { skip: 'not_a_follow_up_request' }
}

// ── DB helpers ───────────────────────────────────────────────────────────────
async function since() {
  const r = await db.query(`SELECT value FROM settings WHERE key='reminder_daily_since'`).catch(() => ({ rows: [] }))
  return /^\d{4}-\d{2}-\d{2}$/.test(r.rows[0]?.value || '') ? r.rows[0].value : null
}

async function senderFor(reminder) {
  const src = String(reminder.source_session || '').trim()
  if (!src) return null
  return (await db.query(
    `SELECT id, session_name, account_persona, is_active, outreach_enabled, operational_status, restriction_until, restriction_reason, COALESCE(access_tier,'operator') AS tier
       FROM whatsapp_accounts WHERE lower(session_name) = lower($1) ORDER BY (session_name = $1) DESC LIMIT 1`, [src])).rows[0] || null
}

async function recentContact(phone, { days = COOLDOWN_DAYS, excludeDispatchId = null } = {}) {
  const p = digits(phone).slice(-9)
  const r = await db.query(
    `SELECT 'outreach' AS via, MAX(sent_at) AS at FROM outreach_log WHERE right(regexp_replace(phone,'\\D','','g'),9) = $1 AND sent_at > NOW() - ($2 || ' days')::interval
     UNION ALL
     SELECT 'reminder', MAX(sent_at) FROM reminder_dispatches WHERE right(owner_phone,9) = $1 AND state IN ('sent','ambiguous') AND sent_at > NOW() - ($2 || ' days')::interval AND id IS DISTINCT FROM $3::bigint`,
    [p, String(days), excludeDispatchId])
  return r.rows.filter(x => x.at).sort((a, b) => new Date(b.at) - new Date(a.at))[0] || null
}

async function record(reminderId, runDate, phone, fields) {
  const cols = Object.keys(fields)
  const vals = cols.map(k => (k === 'context' ? JSON.stringify(fields[k] || {}) : fields[k]))
  const res = await db.query(
    `INSERT INTO reminder_dispatches (reminder_id, run_date, owner_phone, ${cols.join(', ')})
     VALUES ($1, $2, $3, ${cols.map((_, i) => `$${i + 4}`).join(', ')})
     ON CONFLICT (reminder_id, run_date) DO NOTHING RETURNING *`, [reminderId, runDate, digits(phone), ...vals])
  return res.rows[0] || null
}

// ── 09:00: plan the day ──────────────────────────────────────────────────────
async function planDay(now = new Date(), { dryRun = false, onlyReminderIds = null } = {}) {
  const day = maltaParts(now)
  if (!enabled()) return { skipped: 'disabled' }
  if (day.weekday === 'Sun') return { skipped: 'sunday', date: day.date }
  if (await require('./ownerSendGate').getAutomationMode() === 'REVIEW_ONLY') return { skipped: 'review_only_mode', date: day.date }
  const from = await since()
  if (!from) return { skipped: 'no_go_live_date', date: day.date }
  const earliest = [from, addDays(day.date, -GRACE_DAYS)].sort().pop()
  const rows = (await db.query(
    `SELECT r.* FROM reminders r
      WHERE r.status = 'pending' AND r.contact_due_date BETWEEN $1::date AND $2::date
        AND ($3::int[] IS NULL OR r.id = ANY($3::int[]))
        AND NOT EXISTS (SELECT 1 FROM reminder_dispatches d WHERE d.reminder_id = r.id AND (d.run_date = $2::date OR d.state IN ('sent','ambiguous','skipped')))
      ORDER BY r.contact_due_date, r.id`, [onlyReminderIds ? '2020-01-01' : earliest, day.date, onlyReminderIds])).rows
  const townList = await towns()
  const planned = [], skipped = [], waiting = []
  const slots = new Map()        // session → next free minute
  const owners = new Set()
  for (const r of rows) {
    const phone = digits(r.owner_phone)
    // month-only requests stay approximate: the owner gave a month, never a day we invent
    const approx = !!r.parsed_timing && !/\d/.test(String(r.parsed_timing))
    const ctx = { due: String(r.contact_due_date).slice(0, 10), note: String(r.original_note || '').slice(0, 300), parsedTiming: r.parsed_timing || null, approx }
    const out = (state, reason, extra = {}) => ({ reminderId: r.id, phone, state, reason, ...extra })
    let res
    const taken = phone && (owners.has(phone.slice(-9)) || (await db.query(
      `SELECT 1 FROM reminder_dispatches WHERE run_date=$1 AND right(owner_phone,9)=$2 AND reminder_id<>$3 AND state IN ('planned','sending','sent','ambiguous','waiting') LIMIT 1`,
      [day.date, phone.slice(-9), r.id])).rows.length)
    if (!phone) res = out('skipped', 'no_owner_phone')
    else if (taken) res = out('skipped', 'another_reminder_for_this_owner_today')
    else if (r.auto_send_status === 'blocked') res = out('skipped', `blocked:${r.auto_send_block_reason || 'unknown'}`)
    else if (r.auto_send_status === 'paused_manual') res = out('skipped', 'paused_by_hand')
    if (!res) {
      const c = classify(r, townList)
      if (c.skip) res = out('skipped', c.skip)
      else {
        const who = await require('./reminderOutreach').classifyReminderContact(r)
        const sender = await senderFor(r)
        if (who.kind !== 'owner' || who.reason) res = out('skipped', who.reason || 'not_an_owner')
        else if (!sender || sender.tier === 'agent') res = out('skipped', `no_verified_sender:${r.source_session || 'unknown'}`)
        else if (!sender.is_active) res = out('skipped', `sender_account_inactive:${sender.session_name}`)
        else {
          const persona = String(sender.account_persona || '').toLowerCase()
          const needsPhrase = c.intent === 'owner_requested_callback' && !c.vars.agreed_followup_time_phrase
          const canary = !!onlyReminderIds && /ARGUS CANARY/.test(String(r.original_note || ''))
          const n = (await db.query(
            `SELECT COUNT(*)::int AS n FROM outreach_library_templates WHERE persona=$1 AND intent=$2 AND active AND review_status='approved'
               AND ($3::boolean IS FALSE OR body NOT LIKE '%{{agreed_followup_time_phrase}}%')
               AND (COALESCE(code,'') NOT LIKE 'ARGUS-CANARY-%' OR $4::boolean)`, [persona, c.intent, needsPhrase, canary])).rows[0].n
          const base = { intent: c.intent, session_name: sender.session_name, persona, context: { ...ctx, vars: c.vars, ...(canary ? { canary: true } : {}) } }
          if (!n) res = out('waiting', `no_approved_template:${c.intent}:${persona}`, base)
          else {
            const minute = Math.max(slots.get(sender.session_name) || SEND_START_MIN, day.date === maltaParts(now).date ? maltaParts(now).minutes + 1 : SEND_START_MIN)
            slots.set(sender.session_name, minute + STAGGER_MIN[0] + Math.floor(Math.random() * (STAGGER_MIN[1] - STAGGER_MIN[0] + 1)))
            if (minute > SEND_END_MIN) res = out('waiting', 'no_send_slot_left_today', base)
            else res = out('planned', null, { ...base, planned_at: maltaAt(day.date, minute) })
          }
        }
      }
    }
    if (phone && ['planned', 'waiting'].includes(res.state)) owners.add(phone.slice(-9))
    if (!dryRun) {
      const row = await record(r.id, day.date, phone || '0', {
        state: res.state, reason: res.reason || null, intent: res.intent || null, session_name: res.session_name || null,
        persona: res.persona || null, context: res.context || ctx, planned_at: res.planned_at || null,
      }).catch(err => { if (err.code === '23505') return null; throw err })
      if (!row && res.state === 'planned') { res.state = 'skipped'; res.reason = 'another_reminder_for_this_owner_today' }
      if (row && res.state === 'planned') await db.query(`UPDATE reminders SET auto_send_status='daily_auto', assigned_session=$2, auto_send_for=$3 WHERE id=$1`, [r.id, res.session_name, res.planned_at])
    }
    ;({ planned, skipped, waiting })[res.state].push(res)
  }
  log.info('reminderDaily: day planned', { date: day.date, planned: planned.length, skipped: skipped.length, waiting: waiting.length, dryRun })
  return { date: day.date, planned, skipped, waiting }
}

// Rows that were 'waiting' (sender offline / template not approved yet) are re-checked during the day.
async function replanWaiting(now = new Date()) {
  const day = maltaParts(now)
  const rows = (await db.query(`SELECT id, reminder_id FROM reminder_dispatches WHERE run_date=$1 AND state='waiting'`, [day.date])).rows
  if (!rows.length) return 0
  await db.query(`DELETE FROM reminder_dispatches WHERE id = ANY($1::bigint[])`, [rows.map(r => r.id)])
  const r = await planDay(now)
  return (r.planned || []).length
}

// ── every minute: send what is due ───────────────────────────────────────────
function transportOutcomeUnknown(err) {
  const m = String(err?.message || err || '')
  return /timeout|ETIMEDOUT|ECONNRESET|socket hang up|aborted|503|502|504/i.test(m)
}

async function recoverInterrupted(now = new Date()) {
  const r = await db.query(
    `UPDATE reminder_dispatches SET state='ambiguous', reason='worker_restarted_during_send', updated_at=NOW()
      WHERE state='sending' AND sending_at < $1::timestamptz - interval '3 minutes' RETURNING id`, [now])
  return r.rows.length
}

async function sendOne(d, now) {
  const reminder = (await db.query(`SELECT * FROM reminders WHERE id=$1`, [d.reminder_id])).rows[0]
  const finish = async (state, reason, extra = {}) => {
    await db.query(
      `UPDATE reminder_dispatches SET state=$2, reason=$3, rendered_text=COALESCE($4, rendered_text), template_id=COALESCE($5, template_id),
              sent_at=CASE WHEN $2 IN ('sent','ambiguous') THEN NOW() ELSE sent_at END, updated_at=NOW() WHERE id=$1`,
      [d.id, state, reason || null, extra.text || null, extra.templateId || null])
    return { id: d.id, reminderId: d.reminder_id, state, reason }
  }
  if (!reminder || reminder.status !== 'pending') return finish('skipped', `reminder_${reminder ? reminder.status : 'deleted'}`)
  // authoritative gates at the moment of sending
  const who = await require('./reminderOutreach').classifyReminderContact(reminder)
  if (who.kind !== 'owner' || who.reason) return finish('skipped', who.reason || 'not_an_owner')
  const gate = await require('./ownerSendGate').checkOwnerSend({ phone: reminder.owner_phone, kind: 'reminder', automated: true })
  // Kev, 2026-11-21: a date the OWNER asked for wins over a no-stock pause (21-day cadence);
  // DNC, stop, human-active and every other gate still apply.
  const pauseOnly = !gate.allow && /^(?:owner|property)_contact_paused/.test(String(gate.reason || ''))
  if (!gate.allow && !(pauseOnly && d.intent === 'owner_requested_callback')) return finish('skipped', `owner_gate:${gate.reason}`)
  // Kev, 2026-11-21: a date the owner asked for is kept — the generic 4-day cooldown does not
  // cancel it. Only a message to this owner earlier TODAY moves it to the next day (no double contact).
  if (d.intent === 'owner_requested_callback') {
    const today = await recentContact(reminder.owner_phone, { days: 1, excludeDispatchId: d.id })
    if (today && maltaParts(new Date(today.at)).date === maltaParts(now).date) return finish('waiting', `owner_already_contacted_today:${today.via}`)
  } else {
    const recent = await recentContact(reminder.owner_phone, { excludeDispatchId: d.id })
    if (recent) return finish('skipped', `owner_contacted_within_${COOLDOWN_DAYS}_days:${recent.via}`)
  }
  let status = 'UNKNOWN'
  try { status = String((await waha.getSessionStatus(d.session_name))?.status || 'UNKNOWN').toUpperCase() } catch (_) {}
  if (!HEALTHY.has(status)) {
    const attempts = d.attempts + 1
    if (attempts >= MAX_ATTEMPTS || maltaParts(now).minutes + RETRY_MIN > SEND_END_MIN) return finish('waiting', `sender_offline:${status}`)
    await db.query(`UPDATE reminder_dispatches SET state='planned', attempts=$2, reason=$3, planned_at=NOW() + ($4 || ' minutes')::interval, updated_at=NOW() WHERE id=$1`,
      [d.id, attempts, `sender_offline:${status}:retrying`, String(RETRY_MIN)])
    return { id: d.id, reminderId: d.reminder_id, state: 'planned', reason: `sender_offline:${status}:retrying` }
  }
  // render: an approved Safe Draft, greeting for this moment, owner's own context
  const lib = require('./outreachLibrary')
  const vars = d.context?.vars || {}
  const fresh = !(await recentContact(reminder.owner_phone, { days: 1, excludeDispatchId: d.id }))
  let rendered
  try {
    const needsPhrase = d.intent === 'owner_requested_callback' && !vars.agreed_followup_time_phrase
    const t = await lib.pick(d.persona, { phone: reminder.owner_phone, intent: d.intent, allowCanary: d.context?.canary === true, filter: needsPhrase ? x => !x.body.includes('{{agreed_followup_time_phrase}}') : null })
    const g = lib.greetingFor(reminder.owner_phone, now)
    rendered = { text: lib.renderTemplate(t.body, { greeting: g.greeting, fresh, vars }), templateId: t.id }
  } catch (err) { return finish('waiting', err.code === 'no_library_templates' ? `no_approved_template:${d.intent}:${d.persona}` : `render_failed:${err.code || err.message}`) }
  const foreign = require('./outreachIdentity').findForeignSignatures(rendered.text, d.persona)
  if (foreign.length) return finish('skipped', 'foreign_persona_signature')
  // claim → wire
  const claimed = (await db.query(`UPDATE reminder_dispatches SET state='sending', sending_at=NOW(), attempts=attempts+1, rendered_text=$2, template_id=$3, updated_at=NOW()
                                    WHERE id=$1 AND state='planned' RETURNING id`, [d.id, rendered.text, rendered.templateId])).rows[0]
  if (!claimed) return { id: d.id, state: 'claimed_elsewhere' }
  try {
    await waha.sendText(d.session_name, reminder.owner_phone, rendered.text)
  } catch (err) {
    if (transportOutcomeUnknown(err)) return finish('ambiguous', `transport_unknown:${String(err.message || err).slice(0, 120)}`)
    if (d.attempts + 1 >= MAX_ATTEMPTS) return finish('failed', String(err.message || err).slice(0, 200))
    await db.query(`UPDATE reminder_dispatches SET state='planned', reason=$2, planned_at=NOW() + ($3 || ' minutes')::interval, updated_at=NOW() WHERE id=$1`,
      [d.id, `send_error_retrying:${String(err.message || err).slice(0, 120)}`, String(RETRY_MIN)])
    return { id: d.id, reminderId: d.reminder_id, state: 'planned', reason: 'send_error_retrying' }
  }
  await finish('sent', null, rendered)
  // the owner's other due reminders are covered by this one message
  await db.query(
    `UPDATE reminders SET status='contacted', contacted_at=NOW(), contacted_by=$2, auto_send_status='sent',
            notes=CASE WHEN id=$1 THEN notes ELSE trim(both ' ' from COALESCE(notes,'') || ' covered by reminder ' || $1::text) END
      WHERE status='pending' AND (id=$1 OR (right(regexp_replace(owner_phone,'\\D','','g'),9) = right($3,9) AND contact_due_date <= $4::date))`,
    [d.reminder_id, d.session_name, digits(reminder.owner_phone), maltaParts(now).date])
  return { id: d.id, reminderId: d.reminder_id, state: 'sent', session: d.session_name }
}

async function tick(now = new Date(), { limit = 3 } = {}) {
  if (!enabled()) return { skipped: 'disabled' }
  const m = maltaParts(now)
  if (m.minutes < SEND_START_MIN || m.minutes > SEND_END_MIN + 30) return { skipped: 'outside_window' }
  await recoverInterrupted(now)
  if (m.minutes % 15 === 0) await replanWaiting(now).catch(err => log.warn('reminderDaily: replan failed', { err: err.message }))
  const due = (await db.query(
    `SELECT * FROM reminder_dispatches WHERE state='planned' AND run_date=$1 AND planned_at <= $2 ORDER BY planned_at, id LIMIT $3`, [m.date, now, limit])).rows
  const results = []
  for (const d of due) {
    try { results.push(await sendOne(d, now)) }
    catch (err) { log.warn('reminderDaily: send step failed', { id: d.id, err: err.message }); results.push({ id: d.id, state: 'error', reason: err.message }) }
  }
  return { date: m.date, results }
}

// ── read model for the CRM ───────────────────────────────────────────────────
async function report(date = maltaParts().date) {
  const rows = (await db.query(
    `SELECT d.id, d.reminder_id, d.run_date::text AS run_date, d.state, d.reason, d.intent, d.session_name, d.persona, d.planned_at, d.sent_at,
            d.rendered_text, d.template_id, d.attempts, d.context, r.owner_name, right(r.owner_phone, 4) AS phone_last4,
            r.contact_due_date::text AS due, r.original_note, t.code AS template_code
       FROM reminder_dispatches d JOIN reminders r ON r.id = d.reminder_id LEFT JOIN outreach_library_templates t ON t.id = d.template_id
      WHERE d.run_date = $1::date ORDER BY d.state = 'sent' DESC, d.planned_at NULLS LAST, d.id`, [date])).rows
  const summary = rows.reduce((s, r) => { s[r.state] = (s[r.state] || 0) + 1; return s }, {})
  const upcoming = (await db.query(
    `SELECT contact_due_date::text AS due, COUNT(*)::int AS n FROM reminders
      WHERE status='pending' AND contact_due_date > $1::date AND contact_due_date <= $1::date + 14 GROUP BY 1 ORDER BY 1`, [date])).rows
  return { date, since: await since(), enabled: enabled(), summary, rows, upcoming }
}

// What the next 09:00 run would do, without writing anything (CRM "next run" preview).
async function preview(date) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : null
  let at = day ? maltaAt(day, SEND_START_MIN) : new Date()
  if (!day) { const p = maltaParts(); let d = p.minutes < SEND_START_MIN ? p.date : addDays(p.date, 1); if (maltaParts(maltaAt(d, SEND_START_MIN)).weekday === 'Sun') d = addDays(d, 1); at = maltaAt(d, SEND_START_MIN) }
  const r = await planDay(at, { dryRun: true })
  const ids = [...(r.planned || []), ...(r.waiting || []), ...(r.skipped || [])].map(x => x.reminderId)
  const rows = ids.length ? (await db.query(`SELECT id, owner_name, right(owner_phone,4) AS phone_last4, contact_due_date::text AS due, parsed_timing, left(original_note, 160) AS note, source_session FROM reminders WHERE id = ANY($1::int[])`, [ids])).rows : []
  const by = new Map(rows.map(x => [x.id, x]))
  const out = list => (list || []).map(x => ({ ...by.get(x.reminderId), state: x.state, reason: x.reason || null, intent: x.intent || null, session: x.session_name || null, plannedAt: x.planned_at || null, approx: !!(by.get(x.reminderId)?.parsed_timing && !/\d/.test(by.get(x.reminderId).parsed_timing)) }))
  return { date: r.date || null, skippedRun: typeof r.skipped === 'string' ? r.skipped : null, planned: out(r.planned), waiting: out(r.waiting), skipped: out(Array.isArray(r.skipped) ? r.skipped : []) }
}

module.exports = { preview, planDay, tick, replanWaiting, recoverInterrupted, report, classify, normalizePhrase, propertyLabel, maltaParts, maltaAt, sendOne, AUTO_REPLY_RE }
