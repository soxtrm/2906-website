'use strict'
// ============================================================================
// services/outreachTemplates.js — persona template library, per-account
// rotation and send-time rendering (Kev, 2026-10-29).
//
// - Library: outreach_persona_templates (persona × period × slot), editable
//   through the CRM API. A template that introduces/signs as another persona
//   is refused at save time (same rule as the outbound identity gate).
// - Rotation: a plan gets ONE slot when it is prepared. The slot is the
//   least-recently-used one for that account, never the slot the account used
//   last time (when more than one exists). Choice is recorded in
//   outreach_template_usage (unique per plan), so it is auditable, survives
//   restarts and a second preparation of the same plan returns the same slot.
// - Rendering: the text is chosen at the instant of each send from the period
//   of THAT instant (morning/afternoon/evening), using the plan's slot. A
//   message prepared in the evening and sent the next morning therefore uses
//   the morning variant of the same slot. Free-text plans get their greeting
//   and closing corrected instead (outreachSchedule.normalizeGreeting).
// ============================================================================
const db = require('../db')
const { seedRows, PERIODS } = require('./outreachTemplateSeed')
const { greetingPeriod, normalizeGreeting, maltaDateStr } = require('./outreachSchedule')
const outreachIdentity = require('./outreachIdentity')

const MODE_FREE = 'free_text'
const MODE_ROTATION = 'persona_rotation'

async function ensureSeed() {
  for (const r of seedRows()) {
    await db.query(
      `INSERT INTO outreach_persona_templates(persona, period, slot, body, updated_by)
       VALUES ($1,$2,$3,$4,'seed-20261029') ON CONFLICT (persona, period, slot) DO NOTHING`,
      [r.persona, r.period, r.slot, r.body])
  }
}

async function listLibrary(persona = null) {
  const r = await db.query(
    `SELECT id, persona, period, slot, body, active, updated_by, updated_at
       FROM outreach_persona_templates
      WHERE ($1::text IS NULL OR persona = $1)
      ORDER BY persona, CASE period WHEN 'morning' THEN 1 WHEN 'afternoon' THEN 2 ELSE 3 END, slot`,
    [persona])
  return r.rows
}

function validateTemplate({ persona, period, slot, body }) {
  if (!persona || !outreachIdentity.PERSONA_NAMES[persona]) return 'unknown_persona'
  if (!PERIODS.includes(period)) return 'invalid_period'
  if (!Number.isInteger(Number(slot)) || slot < 1 || slot > 12) return 'invalid_slot'
  const text = String(body || '').trim()
  if (text.length < 20 || text.length > 1200) return 'invalid_length'
  if (outreachIdentity.findForeignSignatures(text, persona).length) return 'foreign_persona_signature'
  return null
}

async function upsertTemplate({ persona, period, slot, body, active = true }, actor = 'admin') {
  const input = { persona: String(persona || '').toLowerCase(), period: String(period || '').toLowerCase(), slot: Number(slot), body: String(body || '').trim() }
  const problem = validateTemplate(input)
  if (problem) {
    const err = new Error(problem)
    err.code = problem
    throw err
  }
  const r = await db.query(
    `INSERT INTO outreach_persona_templates(persona, period, slot, body, active, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (persona, period, slot) DO UPDATE
       SET body = EXCLUDED.body, active = EXCLUDED.active, updated_by = EXCLUDED.updated_by, updated_at = NOW()
     RETURNING *`,
    [input.persona, input.period, input.slot, input.body, active !== false, actor])
  return r.rows[0]
}

async function activeSlots(persona) {
  const r = await db.query(
    `SELECT DISTINCT slot FROM outreach_persona_templates WHERE persona = $1 AND active = TRUE ORDER BY slot`, [persona])
  return r.rows.map(row => row.slot)
}

// Least-recently-used slot for this account, never repeating the last one.
async function pickSlot(accountId, persona, { planId = null, now = new Date() } = {}) {
  if (planId) {
    const existing = (await db.query(`SELECT slot FROM outreach_template_usage WHERE plan_id = $1`, [planId])).rows[0]
    if (existing) return existing.slot
  }
  const slots = await activeSlots(persona)
  if (!slots.length) {
    const err = new Error(`no active templates for persona ${persona}`)
    err.code = 'no_persona_templates'
    throw err
  }
  const history = (await db.query(
    `SELECT slot, MAX(id) AS last_id FROM outreach_template_usage
      WHERE account_id = $1 AND persona = $2 GROUP BY slot`, [accountId, persona])).rows
  const lastUse = new Map(history.map(h => [h.slot, Number(h.last_id)]))
  const mostRecent = history.reduce((best, h) => (!best || Number(h.last_id) > Number(best.last_id) ? h : best), null)
  const candidates = slots.length > 1 && mostRecent ? slots.filter(s => s !== mostRecent.slot) : slots
  candidates.sort((a, b) => (lastUse.get(a) || 0) - (lastUse.get(b) || 0) || a - b)
  const slot = candidates[0]
  if (planId) {
    await db.query(
      `INSERT INTO outreach_template_usage(account_id, persona, slot, plan_id, used_on)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (plan_id) DO NOTHING`,
      [accountId, persona, slot, planId, maltaDateStr(now)])
    const stored = (await db.query(`SELECT slot FROM outreach_template_usage WHERE plan_id = $1`, [planId])).rows[0]
    return stored ? stored.slot : slot
  }
  return slot
}

// Text for ONE message at the instant it is sent.
async function renderAtSendTime({ mode, persona, slot, freeText }, now = new Date()) {
  if (mode !== MODE_ROTATION) {
    const fixed = normalizeGreeting(freeText, now)
    return { text: fixed.text, period: fixed.period, source: fixed.changed ? 'free_text_greeting_fixed' : 'free_text' }
  }
  const period = greetingPeriod(now)
  if (!period) {
    const err = new Error('no greeting period at this hour')
    err.code = 'outside_greeting_hours'
    throw err
  }
  const rows = (await db.query(
    `SELECT slot, body FROM outreach_persona_templates
      WHERE persona = $1 AND period = $2 AND active = TRUE ORDER BY (slot = $3) DESC, slot LIMIT 1`,
    [persona, period, slot])).rows
  if (!rows.length) {
    const err = new Error(`no active ${period} template for ${persona}`)
    err.code = 'no_persona_templates'
    throw err
  }
  return { text: rows[0].body, period, slot: rows[0].slot, source: rows[0].slot === slot ? 'persona_rotation' : 'persona_rotation_fallback_slot' }
}

// Preview (no usage recorded) for the CRM day cards.
async function previewForPlan(plan, persona, at) {
  if (plan.message_mode !== MODE_ROTATION) return normalizeGreeting(plan.message_template || '', at).text
  try { return (await renderAtSendTime({ mode: MODE_ROTATION, persona, slot: plan.template_slot }, at)).text }
  catch (_) { return '' }
}

module.exports = {
  MODE_FREE, MODE_ROTATION, ensureSeed, listLibrary, validateTemplate, upsertTemplate,
  activeSlots, pickSlot, renderAtSendTime, previewForPlan,
}
