'use strict'
// ============================================================================
// services/agentPermissions.js — who may run which routine property action.
//
// Kev, 2026-10-22 (P1): routine inventory work was gated as if it were
// administration. Evidence: Olga's uploads #2906-9507 / #2906-9515 failed
// category distribution ("bedrooms are unknown"); the uploader was told
// "Retry: !recategorize" — an admin-only command — and Kev had to fix both by
// hand. Separately, the lifecycle gate (!available/!archive/…) used
// uploadListing.resolveAgent, an EXACT match on agents.whatsapp_phones, so a
// board agent whose number is only registered as notify_whatsapp (or arrives
// in another format) was ignored with no reply at all.
//
// Matrix (one place, see PERMISSION_MATRIX):
//   admin  (ADMIN_NUMBERS or agents.role='admin')  every action, every property
//   agent  (agents.role='agent', core team)       routine actions, every property
//   board  (agents.role='board', external)        routine actions on properties
//                                                  they listed or are assigned to
//   anyone else                                    nothing (no reply: external
//                                                  chats can never change inventory)
// Special distribution (commercial / luxury category, price changes) stays
// admin-only; it is escalated, the upload itself is not blocked.
// ============================================================================

const db = require('../db')

const PERMISSION_MATRIX = Object.freeze({
  mark_available:   { roles: ['admin', 'agent', 'board'], scoped: true },
  mark_rented:      { roles: ['admin', 'agent', 'board'], scoped: true },
  lifecycle:        { roles: ['admin', 'agent', 'board'], scoped: true },   // !priority/!archive/!markrecentlyrented/!return
  set_bedroom_category: { roles: ['admin', 'agent', 'board'], scoped: true }, // !recategorize REF 1|2|3|4
  set_special_category: { roles: ['admin'], scoped: false },               // !recategorize REF C|LUX
  change_price:     { roles: ['admin'], scoped: false },                   // !price (unchanged)
})

function tail8(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-8)
}

// Same matching rule as services/ownerAsk.resolveAgentByPhone (notify_whatsapp
// OR any whatsapp_phones entry, last 8 digits) — plus the role.
async function findAgentByPhone(phone, conn = db) {
  const t = tail8(phone)
  if (t.length < 8) return null
  const r = await conn.query(
    `SELECT id, username, name, display_name, role
       FROM agents
      WHERE active = TRUE
        AND (RIGHT(REGEXP_REPLACE(COALESCE(notify_whatsapp,''), '[^0-9]', '', 'g'), 8) = $1
             OR EXISTS (SELECT 1 FROM unnest(whatsapp_phones) p
                         WHERE RIGHT(REGEXP_REPLACE(p, '[^0-9]', '', 'g'), 8) = $1))
      ORDER BY id LIMIT 1`, [t])
  return r.rows[0] || null
}

// phones: every number we could attribute to the sender (senderForAuth, the
// LID-resolved real phone). isAdmin: the existing ADMIN_NUMBERS check.
async function resolveOperator(phones, { isAdmin = () => false, conn = db } = {}) {
  const list = (Array.isArray(phones) ? phones : [phones]).filter(Boolean)
  if (list.some(p => isAdmin(p))) return { kind: 'admin', agent: null }
  for (const p of list) {
    const agent = await findAgentByPhone(p, conn)
    if (!agent) continue
    const role = String(agent.role || '').toLowerCase()
    return { kind: role === 'admin' ? 'admin' : role === 'board' ? 'board' : 'agent', agent }
  }
  return { kind: null, agent: null }
}

async function propertyScope(propertyId, conn = db) {
  const r = await conn.query(`SELECT id, ref, listed_by_agent_id, activity_agent_id FROM properties WHERE id = $1`, [propertyId])
  return r.rows[0] || null
}

function authorize(operator, action, property) {
  const rule = PERMISSION_MATRIX[action]
  if (!rule) return { allow: false, reason: 'unknown_action' }
  if (!operator || !operator.kind) return { allow: false, reason: 'not_an_operator', silent: true }
  if (!rule.roles.includes(operator.kind)) {
    return { allow: false, reason: 'needs_admin', message: 'needs an admin — I have asked Kev to do this step.' }
  }
  if (rule.scoped && operator.kind === 'board') {
    const id = operator.agent && operator.agent.id
    if (!property || (property.listed_by_agent_id !== id && property.activity_agent_id !== id)) {
      return { allow: false, reason: 'outside_scope', message: 'you can only change properties you listed or are assigned to.' }
    }
  }
  return { allow: true, reason: null }
}

module.exports = { PERMISSION_MATRIX, findAgentByPhone, resolveOperator, propertyScope, authorize }
