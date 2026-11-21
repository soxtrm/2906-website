'use strict'
// ============================================================================
// services/viewingFollowups.js — viewing request follow-up (Claude, 2026-11-21)
//
// Every booking request an agent makes (property_viewings with a time and an
// agent) gets one follow-up row as soon as it exists, owner answer or not.
// The row follows the booking: confirmed, moved, cancelled. The day after the
// slot (09:30 Malta, never before 09:00 or after 20:00) the requesting agent is
// asked once, in their own ARGUS workspace WhatsApp group, whether it took
// place; the answer is given in the CRM. A request the owner never confirmed is
// never described as a viewing that happened.
//
// Owner contact details are shown only to admins and agents with
// agents.can_view_owner_contact, only for a property that has a booking
// request, and every access is written to pii_reveal_log and the timeline.
//
// Never: messages an owner, a client or a group other than the agent's own
// workspace group; changes the booking itself.
// ============================================================================
const db = require('../db')
const log = require('../logger')
const { maltaParts, maltaToUtc, maltaDateStr, addDays } = require('../lib/maltaTime')

const ASK_H = 9, ASK_MI = 30
const QUIET_FROM = 20, QUIET_UNTIL = 9
const MAX_ASKS = 3
const LOOKBACK_DAYS = 14
const CRM = () => (process.env.PUBLIC_CRM_URL || 'https://crm.2906.estate').replace(/\/+$/, '')
const OUTCOMES = ['completed', 'didnt_happen', 'rescheduled', 'awaiting']
const NEXT_STEPS = ['interested', 'follow_up', 'offer', 'declined', 'none']

// The booking's time: starts_at, or for requests from the older /book flow
// (no starts_at) the viewing date and time read as Malta local time.
const SLOT_SQL = `COALESCE(pv.starts_at, CASE WHEN pv.viewing_date IS NULL THEN NULL ELSE
  ((pv.viewing_date + CASE WHEN pv.viewing_time ~ '^[0-2]?[0-9]:[0-5][0-9]' THEN substring(pv.viewing_time from '^[0-2]?[0-9]:[0-5][0-9]')::time ELSE time '12:00' END)
   AT TIME ZONE 'Europe/Malta') END)`

class FollowupError extends Error { constructor(code, message, status = 400) { super(message); this.code = code; this.status = status } }

// The question is due the day after the slot (Malta calendar), from 09:30.
function schedule(slotAt) {
  const p = maltaParts(new Date(slotAt))
  const next = addDays({ y: p.y, m: p.m, d: p.d }, 1)
  return {
    dueDate: `${next.y}-${String(next.m).padStart(2, '0')}-${String(next.d).padStart(2, '0')}`,
    askAfter: maltaToUtc(next.y, next.m, next.d, ASK_H, ASK_MI),
  }
}
function quiet(now = new Date()) { const h = maltaParts(now).h; return h >= QUIET_FROM || h < QUIET_UNTIL }
const stateOf = status => (status === 'confirmed' ? 'confirmed' : status === 'cancelled' ? 'cancelled' : 'requested')

async function event(q, followupId, kind, detail = {}, agentId = null) {
  await q.query(`INSERT INTO viewing_followup_events (followup_id, kind, agent_id, detail) VALUES ($1,$2,$3,$4::jsonb)`,
    [followupId, kind, agentId, JSON.stringify(detail)])
}

// ── keep one row per booking request in step with the booking ──────────────
async function ensureOne(viewingId) {
  const { rows: [v] } = await db.query(
    `SELECT pv.id, pv.property_id, ${SLOT_SQL} AS starts_at, pv.status, pv.source, COALESCE(pv.viewing_agent_id, pv.user_id) AS agent_id FROM property_viewings pv WHERE pv.id=$1`, [viewingId])
  if (!v || !v.starts_at) return null
  const s = schedule(v.starts_at)
  const st = stateOf(v.status)
  const { rows: [f] } = await db.query(
    `INSERT INTO viewing_followups (viewing_id, property_id, requesting_agent_id, slot_at, request_channel, state, feedback_state, due_date, ask_after)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (viewing_id) DO NOTHING RETURNING id`,
    [v.id, v.property_id, v.agent_id, v.starts_at, v.source || 'crm', st, st === 'cancelled' ? 'cancelled' : 'scheduled', s.dueDate, s.askAfter])
  if (f) await event(db, f.id, 'created', { state: st, slotAt: v.starts_at })
  const { rows: [row] } = await db.query(`SELECT * FROM viewing_followups WHERE viewing_id=$1`, [viewingId])
  return row
}

async function syncAll({ now = new Date(), send = true } = {}) {
  const out = { created: 0, updated: 0, due: 0, asked: 0, failed: 0 }
  // 1. new requests: agent-made, with a time, recent or upcoming
  const { rows: fresh } = await db.query(
    `SELECT pv.id FROM property_viewings pv LEFT JOIN viewing_followups f ON f.viewing_id=pv.id
      WHERE f.id IS NULL AND ${SLOT_SQL} > $1::timestamptz - make_interval(days => $2)
        AND COALESCE(pv.viewing_agent_id, pv.user_id) IS NOT NULL ORDER BY pv.id LIMIT 300`, [now, LOOKBACK_DAYS])
  for (const r of fresh) { if (await ensureOne(r.id)) out.created++ }

  // 2. follow the booking: confirmed, moved, cancelled, reinstated
  const { rows } = await db.query(
    `SELECT f.*, pv.status AS pv_status, ${SLOT_SQL} AS pv_start, COALESCE(pv.duration_min, 20) AS pv_min
       FROM viewing_followups f JOIN property_viewings pv ON pv.id=f.viewing_id
      WHERE f.feedback_state <> 'answered' OR f.updated_at > $1::timestamptz - interval '2 days'`, [now])
  for (const f of rows) {
    const changes = []
    const ev = []
    if (f.pv_status === 'cancelled' && f.state !== 'cancelled' && f.feedback_state !== 'answered') {
      changes.push(`state='cancelled'`, `feedback_state='cancelled'`, `ask_key=NULL`); ev.push(['cancelled', {}])
    } else if (f.pv_status !== 'cancelled' && f.state === 'cancelled' && f.feedback_state === 'cancelled') {
      const s = schedule(f.pv_start)
      changes.push(`state='${stateOf(f.pv_status)}'`, `feedback_state='scheduled'`, `slot_at='${new Date(f.pv_start).toISOString()}'`, `due_date='${s.dueDate}'`, `ask_after='${s.askAfter.toISOString()}'`, `agent_slot_at=NULL`, `ask_key=NULL`)
      ev.push(['reinstated', { status: f.pv_status }])
    } else if (f.pv_start && Math.abs(new Date(f.pv_start) - new Date(f.slot_at)) > 60e3 && f.feedback_state !== 'answered') {
      const s = schedule(f.pv_start)
      changes.push(`slot_at='${new Date(f.pv_start).toISOString()}'`, `agent_slot_at=NULL`, `state='rescheduled'`, `feedback_state='scheduled'`, `due_date='${s.dueDate}'`, `ask_after='${s.askAfter.toISOString()}'`, `ask_key=NULL`)
      ev.push(['rescheduled', { from: f.slot_at, to: f.pv_start, by: 'booking' }])
    } else if (f.pv_status === 'confirmed' && f.state === 'requested') {
      changes.push(`state='confirmed'`); ev.push(['confirmed', {}])
    }
    if (changes.length) {
      await db.query(`UPDATE viewing_followups SET ${changes.join(', ')}, updated_at=NOW() WHERE id=$1`, [f.id])
      for (const [k, d] of ev) await event(db, f.id, k, d)
      out.updated++
      continue
    }
    // 3. once the slot is over the answer is due; the question goes out the day after
    const slot = new Date(f.agent_slot_at || f.slot_at)
    if (f.feedback_state === 'scheduled' && now.getTime() > slot.getTime() + (f.pv_min || 20) * 60e3) {
      await db.query(`UPDATE viewing_followups SET feedback_state='due', updated_at=NOW() WHERE id=$1 AND feedback_state='scheduled'`, [f.id])
      await event(db, f.id, 'due', {})
      out.due++
      f.feedback_state = 'due'
    }
    if (f.feedback_state === 'due' && now >= new Date(f.ask_after) && f.ask_count < MAX_ASKS && !quiet(now)) {
      const r = await ask(f, { now, send })
      if (r === 'asked') out.asked++
      if (r === 'failed') out.failed++
    }
  }
  return out
}

// ── the question to the agent ───────────────────────────────────────────────
let sender = async (session, chat, text) => require('../waha').sendText(session, chat, text)
let sessionPicker = async () => require('./availability').pickAdminSession()
function setTransport({ send, pick } = {}) { if (send) sender = send; if (pick) sessionPicker = pick }

function questionText({ agentName, ref, town, slotAt, confirmed, now, link }) {
  const first = String(agentName || '').trim().split(/\s+/)[0] || 'there'
  const slot = new Date(slotAt)
  const yesterday = maltaDateStr(slot) === maltaDateStr(new Date(now.getTime() - 86400e3))
  const day = yesterday ? 'yesterday' : `on ${slot.toLocaleDateString('en-GB', { timeZone: 'Europe/Malta', weekday: 'short', day: 'numeric', month: 'short' })}`
  const time = slot.toLocaleTimeString('en-GB', { timeZone: 'Europe/Malta', hour: '2-digit', minute: '2-digit' })
  const where = `#${ref}${town ? ` ${town}` : ''}`
  const lead = confirmed
    ? `Hi ${first}, you had a viewing planned for ${where} ${day} at ${time}. Did it take place?`
    : `Hi ${first}, a viewing for ${where} was requested for ${day} at ${time}; the owner had not confirmed it. Did it take place?`
  return `${lead}\nCompleted · Didn't happen · Rescheduled · Awaiting confirmation\nAnswer in ARGUS: ${link}`
}

async function ask(f, { now = new Date(), send = true } = {}) {
  const key = `${f.viewing_id}:${new Date(f.agent_slot_at || f.slot_at).toISOString()}:${f.ask_count + 1}`
  // claim the question first: two workers can never both send it
  const { rows: [claimed] } = await db.query(
    `UPDATE viewing_followups SET feedback_state='asked', asked_at=NOW(), ask_count=ask_count+1, ask_key=$2, updated_at=NOW()
      WHERE id=$1 AND feedback_state='due' RETURNING *`, [f.id, key]).catch(err => {
    if (err.code === '23505') return { rows: [] } // same question already asked
    throw err
  })
  if (!claimed) return 'skipped'
  const { rows: [ctx] } = await db.query(
    `SELECT p.ref, p.town, a.name AS agent_name, c.whatsapp_group_jid
       FROM properties p LEFT JOIN agents a ON a.id=$2 LEFT JOIN agent_workspace_config c ON c.agent_id=$2 WHERE p.id=$1`, [f.property_id, f.requesting_agent_id])
  const text = questionText({ agentName: ctx?.agent_name, ref: ctx?.ref, town: ctx?.town, slotAt: f.agent_slot_at || f.slot_at,
    confirmed: f.state === 'confirmed' || (f.state === 'rescheduled' && f.pv_status === 'confirmed'), now, link: `${CRM()}/bookings?feedback=${f.id}` })
  const enabled = process.env.VIEWING_FOLLOWUP_WHATSAPP !== '0'
  if (!send || !enabled || !ctx?.whatsapp_group_jid) {
    await event(db, f.id, 'asked', { channel: 'crm', reason: !ctx?.whatsapp_group_jid ? 'no workspace group' : 'whatsapp off' })
    return 'asked'
  }
  try {
    const session = await sessionPicker()
    if (!session) throw new Error('no live session')
    await sender(session, ctx.whatsapp_group_jid, text)
    await event(db, f.id, 'asked', { channel: 'whatsapp_workspace_group', askKey: key })
    return 'asked'
  } catch (err) {
    // provider failure: put it back, try again in an hour (within the ask limit)
    await db.query(`UPDATE viewing_followups SET feedback_state='due', ask_key=NULL, ask_after=NOW() + interval '1 hour', updated_at=NOW() WHERE id=$1`, [f.id])
    await event(db, f.id, 'ask_failed', { error: String(err.message || err).slice(0, 160) })
    log.warn('[viewingFollowups] question not sent', { id: f.id, err: err.message })
    return 'failed'
  }
}

// ── who may see what ────────────────────────────────────────────────────────
async function agentRow(id) {
  const { rows: [a] } = await db.query(`SELECT id, name, role, active, can_view_owner_contact, can_create_owner_group FROM agents WHERE id=$1`, [id])
  return a || null
}
const seesAll = a => a && (a.role === 'admin' || a.can_view_owner_contact === true)
const mayContact = a => a && a.active && (a.role === 'admin' || a.can_view_owner_contact === true)

function view(r) {
  return {
    id: r.id, viewingId: r.viewing_id, propertyId: r.property_id, ref: r.ref, town: r.town,
    agent: { id: r.requesting_agent_id, name: r.agent_name || null },
    slotAt: r.agent_slot_at || r.slot_at, bookingSlotAt: r.slot_at, state: r.state, feedback: r.feedback_state,
    dueDate: r.due_date instanceof Date ? maltaDateStr(r.due_date) : String(r.due_date).slice(0, 10),
    askedAt: r.asked_at, outcome: r.outcome, nextStep: r.next_step, note: r.answer_note, answeredAt: r.answered_at,
    bookingStatus: r.pv_status || null, channel: r.request_channel,
  }
}

async function list(me, { open = true } = {}) {
  const a = await agentRow(me.id)
  const all = seesAll(a)
  const { rows } = await db.query(
    `SELECT f.*, p.ref, p.town, ag.name AS agent_name, pv.status AS pv_status
       FROM viewing_followups f JOIN properties p ON p.id=f.property_id LEFT JOIN agents ag ON ag.id=f.requesting_agent_id
       JOIN property_viewings pv ON pv.id=f.viewing_id
      WHERE ($1::boolean OR f.requesting_agent_id=$2)
        AND (NOT $3::boolean OR f.feedback_state IN ('scheduled','due','asked') OR f.updated_at > NOW() - interval '7 days')
      ORDER BY CASE f.feedback_state WHEN 'asked' THEN 0 WHEN 'due' THEN 1 WHEN 'scheduled' THEN 2 ELSE 3 END, COALESCE(f.agent_slot_at, f.slot_at) LIMIT 300`,
    [all, me.id, open])
  return { scope: all ? 'all' : 'mine', canViewOwnerContact: mayContact(a), followups: rows.map(view) }
}

async function summary(me) {
  const { rows: [r] } = await db.query(
    `SELECT COUNT(*) FILTER (WHERE feedback_state IN ('due','asked'))::int AS feedback_due,
            COUNT(*) FILTER (WHERE feedback_state='scheduled')::int AS upcoming
       FROM viewing_followups WHERE requesting_agent_id=$1`, [me.id])
  return { feedbackDue: r.feedback_due, upcoming: r.upcoming }
}

async function detail(me, id) {
  const a = await agentRow(me.id)
  const { rows: [r] } = await db.query(
    `SELECT f.*, p.ref, p.town, ag.name AS agent_name, pv.status AS pv_status FROM viewing_followups f JOIN properties p ON p.id=f.property_id
       LEFT JOIN agents ag ON ag.id=f.requesting_agent_id JOIN property_viewings pv ON pv.id=f.viewing_id WHERE f.id=$1`, [Number(id) || 0])
  if (!r || (!seesAll(a) && r.requesting_agent_id !== me.id)) throw new FollowupError('NOT_FOUND', 'Follow-up not found.', 404)
  const { rows: ev } = await db.query(
    `SELECT e.kind, e.detail, e.at, ag.name AS agent_name FROM viewing_followup_events e LEFT JOIN agents ag ON ag.id=e.agent_id WHERE e.followup_id=$1 ORDER BY e.at, e.id`, [r.id])
  return { followup: view(r), timeline: ev.map(e => ({ kind: e.kind, at: e.at, by: e.agent_name || null, detail: e.detail })) }
}

async function answer(me, id, { outcome, nextStep, note, newStartsAt }) {
  const a = await agentRow(me.id)
  const { rows: [f] } = await db.query(`SELECT * FROM viewing_followups WHERE id=$1`, [Number(id) || 0])
  if (!f || (a?.role !== 'admin' && f.requesting_agent_id !== me.id)) throw new FollowupError('NOT_FOUND', 'Follow-up not found.', 404)
  if (!OUTCOMES.includes(outcome)) throw new FollowupError('OUTCOME_INVALID', 'Choose Completed, Didn’t happen, Rescheduled or Awaiting confirmation.')
  if (nextStep !== undefined && nextStep !== null && !NEXT_STEPS.includes(nextStep)) throw new FollowupError('NEXT_STEP_INVALID', 'Unknown next step.')
  if (f.feedback_state === 'cancelled') throw new FollowupError('CANCELLED', 'This booking request was cancelled; there is nothing to report.', 409)
  const text = note ? String(note).trim().slice(0, 500) : null
  if (outcome === 'rescheduled') {
    const at = new Date(newStartsAt)
    if (!Number.isFinite(at.getTime()) || at.getTime() < Date.now() - 3600e3 || at.getTime() > Date.now() + 120 * 86400e3) throw new FollowupError('TIME_INVALID', 'Give the new date and time.')
    const s = schedule(at)
    await db.query(
      `UPDATE viewing_followups SET outcome='rescheduled', state='rescheduled', feedback_state='scheduled', agent_slot_at=$2, due_date=$3, ask_after=$4, ask_key=NULL,
              answer_note=$5, answered_by=$6, answered_at=NOW(), updated_at=NOW() WHERE id=$1`, [f.id, at, s.dueDate, s.askAfter, text, me.id])
    await event(db, f.id, 'answered', { outcome, newStartsAt: at.toISOString(), note: text }, me.id)
  } else if (outcome === 'awaiting') {
    const next = new Date(Date.now() + 86400e3)
    const p = maltaParts(next)
    await db.query(
      `UPDATE viewing_followups SET outcome='awaiting', feedback_state=CASE WHEN ask_count >= $3 THEN 'due' ELSE 'due' END, ask_after=$2, ask_key=NULL,
              answer_note=$4, answered_by=$5, answered_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [f.id, maltaToUtc(p.y, p.m, p.d, ASK_H, ASK_MI), MAX_ASKS, text, me.id])
    await event(db, f.id, 'answered', { outcome, note: text }, me.id)
  } else {
    await db.query(
      `UPDATE viewing_followups SET outcome=$2, state=$3, feedback_state='answered', next_step=$4, answer_note=$5, answered_by=$6, answered_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [f.id, outcome, outcome === 'completed' ? 'completed' : 'no_show', nextStep || null, text, me.id])
    await event(db, f.id, 'answered', { outcome, nextStep: nextStep || null, note: text }, me.id)
  }
  return detail(me, f.id)
}

// ── owner contact from a booking request ────────────────────────────────────
async function ownerInfo(me, viewingId, { ip, userAgent } = {}) {
  const a = await agentRow(me.id)
  if (!mayContact(a)) throw new FollowupError('FORBIDDEN', 'Owner contact details are not enabled for this profile.', 403)
  const f = await ensureOne(Number(viewingId) || 0)
  if (!f) throw new FollowupError('NOT_FOUND', 'Booking request not found.', 404)
  const { rows: [o] } = await db.query(
    `SELECT p.id AS property_id, p.ref, p.town, oc.id AS owner_id, oc.name, oc.phone_normalized, oc.do_not_contact, oc.status
       FROM properties p LEFT JOIN owner_contacts oc ON oc.id=p.owner_id WHERE p.id=$1`, [f.property_id])
  if (!o || !o.owner_id) throw new FollowupError('NO_OWNER', 'There is no owner on file for this property.', 404)
  await db.query(`INSERT INTO pii_reveal_log (agent_id, entity_type, entity_id, property_id, revealed_at, ip_address, user_agent) VALUES ($1,'owner_contact_viewing',$2,$3,NOW(),$4,$5)`,
    [me.id, o.owner_id, o.property_id, String(ip || '').slice(0, 64) || null, String(userAgent || '').slice(0, 300) || null])
  await event(db, f.id, 'owner_info_viewed', { ownerId: o.owner_id }, me.id)
  const dnc = o.do_not_contact === true || o.status === 'do_not_contact'
  return {
    ref: o.ref, town: o.town, followupId: f.id, bookingState: f.state,
    owner: { name: o.name || null, phone: o.phone_normalized ? `+${o.phone_normalized}` : null, doNotContact: dnc },
    note: dnc ? 'This owner asked not to be contacted by ARGUS. Contact only for this booking, by hand.' : 'Opening these details is logged. Contact the owner by hand; the booking stays a request until the owner confirms it.',
  }
}

// ── loop ────────────────────────────────────────────────────────────────────
let timer = null
function start() {
  if (timer || process.env.NODE_ENV === 'test' || process.env.VIEWING_FOLLOWUPS === '0') return
  const run = () => syncAll().then(r => { if (r.created || r.updated || r.due || r.asked || r.failed) log.info('[viewingFollowups] pass', r) })
    .catch(err => log.warn('[viewingFollowups] pass failed', { err: err.message }))
  setTimeout(run, 20e3)
  timer = setInterval(run, 2 * 60e3)
}

module.exports = { FollowupError, schedule, quiet, questionText, ensureOne, syncAll, ask, list, summary, detail, answer, ownerInfo, start, setTransport, OUTCOMES, NEXT_STEPS }
