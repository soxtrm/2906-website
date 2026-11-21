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

// Kev's Safe Drafts (2026-11-21) carry {{greeting}} / {{opening}} and context
// placeholders; a literal greeting is still refused everywhere.
const KNOWN_PLACEHOLDERS = ['greeting', 'opening', 'agreed_followup_time_phrase', 'followup_subject', 'property_label', 'upcoming_property_label',
  'property_list', 'missing_field_label', 'client_requirement_summary']
function validateBody(persona, body, { allowPlaceholders = true } = {}) {
  if (!outreachIdentity.PERSONA_NAMES[persona]) return 'unknown_persona'
  const text = String(body || '').trim()
  if (text.length < 40 || text.length > 1200) return 'invalid_length'
  if (GREETING_RE.test(text)) return 'greeting_not_allowed' // the greeting is added at send time
  const used = [...text.matchAll(/\{\{([a-z_]+)\}\}/g)].map(m => m[1])
  if (used.length && !allowPlaceholders) return 'placeholders_not_allowed'
  if (used.some(u => !KNOWN_PLACEHOLDERS.includes(u))) return 'unknown_placeholder'
  if (outreachIdentity.findForeignSignatures(text, persona).length) return 'foreign_persona_signature'
  return null
}

// {{greeting}} → "Good afternoon"; {{opening}} → "Good afternoon, " only when a
// fresh greeting is appropriate (no message from us in the last 24 h), else "".
// Every other placeholder must be supplied — a missing one refuses the text.
function renderPlaceholders(body, { greeting, fresh = true, vars = {} } = {}) {
  let text = String(body || '')
  const missing = []
  text = text.replace(/\{\{([a-z_]+)\}\}/g, (m, key) => {
    if (key === 'greeting') return greeting
    if (key === 'opening') return fresh ? `${greeting}, ` : ''
    const v = vars[key]
    if (v == null || String(v).trim() === '') { missing.push(key); return m }
    return String(v).trim()
  })
  if (missing.length) { const err = new Error(`missing context: ${missing.join(', ')}`); err.code = 'missing_context'; err.missing = missing; throw err }
  // "Good afternoon, Just checking in" → "Good afternoon, just checking in" (but keep "I", "I'm")
  text = text.replace(/^((?:Good (?:morning|afternoon|evening)|Hello), )([A-Z])([a-z])/, (m, lead, c, n) => `${lead}${c.toLowerCase()}${n}`)
  return text.trim()
}

function renderTemplate(body, { greeting, fresh = true, vars = {} } = {}) {
  if (/\{\{[a-z_]+\}\}/.test(body)) return renderPlaceholders(body, { greeting, fresh, vars })
  return joinGreeting(greeting, body)
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

async function list(persona = null, { intent = null, status = null } = {}) {
  return (await db.query(
    `SELECT t.id, t.persona, t.number, t.body, t.active, t.source, t.updated_by, t.updated_at,
            t.code, t.intent, t.required_context, t.review_status, t.reviewed_by, t.reviewed_at,
            (SELECT COUNT(*)::int FROM outreach_library_usage u WHERE u.template_id = t.id) AS used,
            (SELECT MAX(u.used_at) FROM outreach_library_usage u WHERE u.template_id = t.id) AS last_used_at
       FROM outreach_library_templates t
      WHERE ($1::text IS NULL OR t.persona = $1) AND ($2::text IS NULL OR t.intent = $2) AND ($3::text IS NULL OR t.review_status = $3)
      ORDER BY t.persona, t.intent, t.number`, [persona, intent, status])).rows
}

async function activeCount(persona, intent = 'new_owner_general') {
  if (!persona) return 0
  try {
    return (await db.query(
      `SELECT COUNT(*)::int AS n FROM outreach_library_templates WHERE persona = $1 AND active AND intent = $2 AND review_status = 'approved'`, [persona, intent])).rows[0].n
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

// Review (Kev, 2026-11-21): pack texts stay 'pending_review' until a person approves them.
async function setReview(ids, status, actor = 'admin') {
  if (!['approved', 'pending_review', 'rejected'].includes(status)) { const err = new Error('invalid review status'); err.code = 'invalid_status'; throw err }
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isInteger)
  if (!list.length) return []
  return (await db.query(
    `UPDATE outreach_library_templates SET review_status=$2, reviewed_by=$3, reviewed_at=NOW(), updated_at=NOW(),
            active = CASE WHEN $2 = 'rejected' THEN FALSE ELSE active END
      WHERE id = ANY($1::int[]) RETURNING id, review_status`, [list, status, actor])).rows
}

async function setActive(id, active, actor = 'admin') {
  const r = await db.query(`UPDATE outreach_library_templates SET active=$2, updated_by=$3, updated_at=NOW() WHERE id=$1 RETURNING *`, [id, active === true, actor])
  if (!r.rows.length) { const err = new Error('template not found'); err.code = 'not_found'; throw err }
  return r.rows[0]
}

// One text for one recipient. Random among the persona's active texts,
// excluding what this phone already received and the account's last sends.
async function pick(persona, { phone = null, accountId = null, intent = 'new_owner_general', filter = null, rng = Math.random } = {}) {
  let rows = (await db.query(
    `SELECT id, number, body, intent FROM outreach_library_templates
      WHERE persona=$1 AND active AND intent=$2 AND review_status='approved' ORDER BY number`, [persona, intent])).rows
  if (filter) rows = rows.filter(filter)
  if (!rows.length) { const err = new Error(`no approved ${intent} texts for ${persona}`); err.code = 'no_library_templates'; throw err }
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
async function renderForSend({ persona, phone, accountId = null, planId = null, intent = 'new_owner_general', vars = {}, fresh = true }, now = new Date(), { record = true } = {}) {
  const t = await pick(persona, { phone, accountId, intent })
  const g = greetingFor(phone, now)
  if (record) {
    await db.query(
      `INSERT INTO outreach_library_usage (template_id, account_id, phone, plan_id, greeting) VALUES ($1,$2,$3,$4,$5)`,
      [t.id, accountId, String(phone || '').replace(/\D/g, '') || null, planId, g.greeting])
  }
  return { text: renderTemplate(t.body, { greeting: g.greeting, fresh, vars }), period: g.period, templateId: t.id, number: t.number, source: 'library' }
}

// Preview for the CRM: the greeting a Malta owner gets at the plan's time.
async function preview(persona, at = new Date()) {
  const row = (await db.query(
    `SELECT number, body FROM outreach_library_templates WHERE persona=$1 AND active AND intent='new_owner_general' AND review_status='approved' ORDER BY number LIMIT 1`, [persona])).rows[0]
  if (!row) return null
  return renderTemplate(row.body, { greeting: greetingFor('356', at).greeting })
}

module.exports = { MODE_LIBRARY, zoneForPhone, greetingFor, joinGreeting, validateBody, ensureSeed, list, activeCount, save, setActive, setReview, pick, renderForSend, renderTemplate, renderPlaceholders, preview, KNOWN_PLACEHOLDERS }
