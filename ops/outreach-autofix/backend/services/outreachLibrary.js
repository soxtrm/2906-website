'use strict'
// ============================================================================
// services/outreachLibrary.js — first-contact message library (Kev, 2026-11-21).
//
// Replaces AI-written / period-copied persona texts for Auto outreach:
//   - outreach_library_templates holds fixed, human-reviewed texts per persona
//     (kev / gabriela / cedric), WITHOUT a greeting.
//   - Each message picks one text at random at the moment of sending, never a
//     text this phone number has already received from us, and not one the
//     account used in its last few sends (no identical bulk wording).
//   - The greeting is generated at that same moment from the recipient's local
//     time: Malta numbers use Malta time; a few European country codes use
//     their own zone; anything else gets the neutral "Hello".
//   - No AI rewriting, no invented property details.
// ============================================================================
const db = require('../db')
const { greetingHours } = require('./timeGreeting')
const outreachIdentity = require('./outreachIdentity')

const MODE_LIBRARY = 'library'
const RECENT_ACCOUNT_SENDS = 8
const GREETING_RE = /^\s*(good\s+(morning|afternoon|evening|day|night)|hi|hello|hey|dear)\b/i

// Country calling code → IANA zone, only where one zone covers the country.
const ZONES = {
  356: 'Europe/Malta', 44: 'Europe/London', 353: 'Europe/Dublin', 49: 'Europe/Berlin', 39: 'Europe/Rome', 33: 'Europe/Paris',
  34: 'Europe/Madrid', 31: 'Europe/Amsterdam', 32: 'Europe/Brussels', 41: 'Europe/Zurich', 43: 'Europe/Vienna', 46: 'Europe/Stockholm',
  47: 'Europe/Oslo', 45: 'Europe/Copenhagen', 48: 'Europe/Warsaw', 40: 'Europe/Bucharest', 359: 'Europe/Sofia', 30: 'Europe/Athens',
  36: 'Europe/Budapest', 420: 'Europe/Prague', 421: 'Europe/Bratislava', 386: 'Europe/Ljubljana', 385: 'Europe/Zagreb', 381: 'Europe/Belgrade',
  351: 'Europe/Lisbon', 358: 'Europe/Helsinki', 370: 'Europe/Vilnius', 371: 'Europe/Riga', 372: 'Europe/Tallinn', 380: 'Europe/Kyiv',
  90: 'Europe/Istanbul', 972: 'Asia/Jerusalem', 971: 'Asia/Dubai', 91: 'Asia/Kolkata', 63: 'Asia/Manila', 65: 'Asia/Singapore', 27: 'Africa/Johannesburg',
}

function zoneForPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '')
  if (!d) return null
  if (d.length === 8 && /^[279]/.test(d)) return 'Europe/Malta' // local Maltese number without +356
  for (const len of [3, 2]) { const z = ZONES[Number(d.slice(0, len))]; if (z) return z }
  return null
}

function localHour(now, zone) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', hour12: false }).format(now)) % 24
}

// "Good morning" | "Good afternoon" | "Good evening" | "Hello"
function greetingFor(phone, now = new Date(), hours = greetingHours()) {
  const zone = zoneForPhone(phone)
  if (!zone) return { greeting: 'Hello', zone: null, period: 'neutral' }
  const h = localHour(now, zone)
  if (h >= hours.morning && h < hours.afternoon) return { greeting: 'Good morning', zone, period: 'morning' }
  if (h >= hours.afternoon && h < hours.evening) return { greeting: 'Good afternoon', zone, period: 'afternoon' }
  if (h >= hours.evening && h < hours.end) return { greeting: 'Good evening', zone, period: 'evening' }
  return { greeting: 'Hello', zone, period: 'neutral' }
}

// "Good afternoon" + "I hope you're well.\n\n…" → "Good afternoon, I hope you're well.\n\n…"
function joinGreeting(greeting, body) {
  const text = String(body || '').trim()
  const first = text.replace(/^Hope\b/, 'hope')
  return `${greeting}, ${first}`
}

function validateBody(persona, body) {
  if (!outreachIdentity.PERSONA_NAMES[persona]) return 'unknown_persona'
  const text = String(body || '').trim()
  if (text.length < 40 || text.length > 1200) return 'invalid_length'
  if (GREETING_RE.test(text)) return 'greeting_not_allowed' // the greeting is added at send time
  if (outreachIdentity.findForeignSignatures(text, persona).length) return 'foreign_persona_signature'
  return null
}

async function ensureSeed() {
  const { seedRows } = require('./outreachLibrarySeed')
  let inserted = 0
  for (const r of seedRows()) {
    const res = await db.query(
      `INSERT INTO outreach_library_templates (persona, number, body, source, updated_by)
       VALUES ($1,$2,$3,$4,'seed-20261121') ON CONFLICT (persona, number) DO NOTHING RETURNING id`,
      [r.persona, r.number, r.body, r.source])
    inserted += res.rows.length
  }
  return inserted
}

async function list(persona = null) {
  return (await db.query(
    `SELECT t.id, t.persona, t.number, t.body, t.active, t.source, t.updated_by, t.updated_at,
            (SELECT COUNT(*)::int FROM outreach_library_usage u WHERE u.template_id = t.id) AS used,
            (SELECT MAX(u.used_at) FROM outreach_library_usage u WHERE u.template_id = t.id) AS last_used_at
       FROM outreach_library_templates t
      WHERE ($1::text IS NULL OR t.persona = $1) ORDER BY t.persona, t.number`, [persona])).rows
}

async function activeCount(persona) {
  if (!persona) return 0
  try {
    return (await db.query(`SELECT COUNT(*)::int AS n FROM outreach_library_templates WHERE persona = $1 AND active`, [persona])).rows[0].n
  } catch (err) {
    if (err.code === '42P01') return 0 // table not there yet
    throw err
  }
}

async function save({ id = null, persona, body, active = true }, actor = 'admin') {
  const p = String(persona || '').toLowerCase()
  const problem = validateBody(p, body)
  if (problem) { const err = new Error(problem); err.code = problem; throw err }
  if (id) {
    const r = await db.query(
      `UPDATE outreach_library_templates SET body=$2, active=$3, updated_by=$4, updated_at=NOW(), source=CASE WHEN body IS DISTINCT FROM $2 THEN 'edited' ELSE source END
        WHERE id=$1 AND persona=$5 RETURNING *`, [id, String(body).trim(), active !== false, actor, p])
    if (!r.rows.length) { const err = new Error('template not found'); err.code = 'not_found'; throw err }
    return r.rows[0]
  }
  const r = await db.query(
    `INSERT INTO outreach_library_templates (persona, number, body, active, source, updated_by)
     VALUES ($1, (SELECT COALESCE(MAX(number),0)+1 FROM outreach_library_templates WHERE persona=$1), $2, $3, 'added', $4) RETURNING *`,
    [p, String(body).trim(), active !== false, actor])
  return r.rows[0]
}

async function setActive(id, active, actor = 'admin') {
  const r = await db.query(`UPDATE outreach_library_templates SET active=$2, updated_by=$3, updated_at=NOW() WHERE id=$1 RETURNING *`, [id, active === true, actor])
  if (!r.rows.length) { const err = new Error('template not found'); err.code = 'not_found'; throw err }
  return r.rows[0]
}

// One text for one recipient. Random among the persona's active texts,
// excluding what this phone already received and the account's last sends.
async function pick(persona, { phone = null, accountId = null, rng = Math.random } = {}) {
  const rows = (await db.query(`SELECT id, number, body FROM outreach_library_templates WHERE persona=$1 AND active ORDER BY number`, [persona])).rows
  if (!rows.length) { const err = new Error(`no active library texts for ${persona}`); err.code = 'no_library_templates'; throw err }
  const p = String(phone || '').replace(/\D/g, '')
  const seenByPhone = p ? new Set((await db.query(`SELECT DISTINCT template_id FROM outreach_library_usage WHERE phone=$1`, [p])).rows.map(r => r.template_id)) : new Set()
  const recent = accountId ? new Set((await db.query(
    `SELECT template_id FROM outreach_library_usage WHERE account_id=$1 ORDER BY used_at DESC, id DESC LIMIT $2`, [accountId, RECENT_ACCOUNT_SENDS])).rows.map(r => r.template_id)) : new Set()
  let pool = rows.filter(r => !seenByPhone.has(r.id) && !recent.has(r.id))
  if (!pool.length) pool = rows.filter(r => !seenByPhone.has(r.id))
  if (!pool.length) pool = rows
  return pool[Math.floor(rng() * pool.length)]
}

// The send-time render (called by outreachTemplates.renderAtSendTime).
async function renderForSend({ persona, phone, accountId = null, planId = null }, now = new Date(), { record = true } = {}) {
  const t = await pick(persona, { phone, accountId })
  const g = greetingFor(phone, now)
  if (record) {
    await db.query(
      `INSERT INTO outreach_library_usage (template_id, account_id, phone, plan_id, greeting) VALUES ($1,$2,$3,$4,$5)`,
      [t.id, accountId, String(phone || '').replace(/\D/g, '') || null, planId, g.greeting])
  }
  return { text: joinGreeting(g.greeting, t.body), period: g.period, templateId: t.id, number: t.number, source: 'library' }
}

// Preview for the CRM: the greeting a Malta owner gets at the plan's time.
async function preview(persona, at = new Date()) {
  const row = (await db.query(`SELECT number, body FROM outreach_library_templates WHERE persona=$1 AND active ORDER BY number LIMIT 1`, [persona])).rows[0]
  if (!row) return null
  return joinGreeting(greetingFor('356', at).greeting, row.body)
}

module.exports = { MODE_LIBRARY, zoneForPhone, greetingFor, joinGreeting, validateBody, ensureSeed, list, activeCount, save, setActive, pick, renderForSend, preview }
