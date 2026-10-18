'use strict'
// ============================================================================
// handlers/priority.js — WhatsApp side of Phase 3.
//
// Four commands, one file, because they are the same shape: resolve a ref,
// build SQL with services/boardAction.js, run it, report what changed.
//
//   !priority <ref> <urgent|high|normal|low> [number]   → AXIS B
//   !archive <ref> [reason]                             → AXIS A
//   !markrecentlyrented <ref> [reason]                  → AXIS A
//   !return <ref> [reason]                              → AXIS A (recovery)
//   !available <ref> [reason]                           → alias for !return
//                                                          (handlers/upload.js dispatch;
//                                                          ARGUS spec's own command name)
//
// No confirm step: unlike !av these send nothing to an owner and every one of
// them is reversible with !return, so a Y/N round-trip would be friction for
// no safety gain.
// ============================================================================

const db = require('../db')
const waha = require('../waha')
const { resolveProperty } = require('../services/availability')
const boardAction = require('../services/boardAction')
const boardFeedback = require('../services/boardFeedback')

const VALID_CLASSES = ['urgent', 'high', 'normal', 'low']

async function reply(session, chatId, text) {
  try { return await waha.sendText(session, chatId, text) }
  catch (e) { /* best-effort */ }
}

// Runs a built { update, activity }. Returns { ok, row } — the caller phrases
// the message, because "already archived" reads differently per command.
//
// One transaction, same as routes/crmScheduleBoard.js:runPlan. The audit row is
// not best-effort: a status change nobody can trace back to a person is exactly
// what status_change_reason exists to prevent, so if the log insert fails the
// status change goes with it. (db.js exports the pg Pool itself, so the checkout
// is db.connect(), not db.pool.connect().)
async function runBuilt(built) {
  if (!built.ok) return { ok: false, reason: built.reason }
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const u = await client.query(built.update.sql, built.update.params)
    if (!u.rows.length) { await client.query('ROLLBACK'); return { ok: false, reason: 'noop' } }
    await client.query(built.activity.sql, built.activity.params)
    await client.query('COMMIT')
    return { ok: true, row: u.rows[0] }
  } catch (e) {
    try { await client.query('ROLLBACK') } catch { /* connection already gone */ }
    return { ok: false, reason: e.message }
  } finally {
    client.release()
  }
}

// The WhatsApp half of the same feedback loop the board has: a listing taken off
// the market from a chat still has to be corrected in the groups it was posted
// in, and the agents who asked about it still have to hear. See
// services/boardFeedback.js — the groups never get the reason.
async function announce({ prop, kind, reason, actor }) {
  try {
    const told = await boardFeedback.announceStatusChange({
      propertyId: prop.id, ref: prop.ref, kind, reason: reason || null, actor,
    })
    if (!told || told.skipped) return ''
    const g = told.groups
    const n = told.requesters ? told.requesters.notified : 0
    const bits = []
    if (g && g.total) bits.push(`${g.replied}/${g.total} group${g.total === 1 ? '' : 's'} updated`)
    if (n)            bits.push(`${n} agent${n === 1 ? '' : 's'} told`)
    return bits.length ? `\n📣 ${bits.join(', ')}.` : ''
  } catch (e) {
    return ''
  }
}

// The ref is the first token; everything after it is command-specific.
// Accepts '2906-077', '077' and '77' — same tolerance resolveProperty has.
function splitArg(arg) {
  const parts = String(arg || '').trim().split(/\s+/).filter(Boolean)
  return { ref: parts[0] || '', rest: parts.slice(1) }
}

// Shared front half of all four commands: parse, resolve, or reply with the
// error and return null.
async function resolveOrComplain({ session, chatId, arg, usage }) {
  const { ref, rest } = splitArg(arg)
  if (!ref) { await reply(session, chatId, usage); return null }

  const prop = await resolveProperty(ref)
  if (!prop) { await reply(session, chatId, `❌ Property ${ref} not found.`); return null }
  return { prop, rest }
}

// ── !priority ───────────────────────────────────────────────────────────────
const PRIORITY_USAGE =
  'Usage: !priority <ref> <urgent|high|normal|low> [0-1000]\n' +
  'Example: !priority 2906-077 high  or  !priority 077 urgent 50'

async function cmdPriority({ session, chatId, senderPhone, agentId = null, arg }) {
  const r = await resolveOrComplain({ session, chatId, arg, usage: PRIORITY_USAGE })
  if (!r) return true
  const { prop, rest } = r

  const cls = String(rest[0] || '').toLowerCase()
  if (!VALID_CLASSES.includes(cls)) {
    await reply(session, chatId,
      `❌ Unknown priority class "${rest[0] || ''}".\n${PRIORITY_USAGE}`)
    return true
  }
  const num = rest[1] !== undefined ? rest[1] : null

  const who = agentId || (await agentIdForPhone(senderPhone))
  const built = await boardAction.setPriority({
    propertyId: prop.id,
    agentId: who,
    priorityClass: cls,
    priority: num,
    changedBy: who ? 'agent' : 'system',
  })
  const out = await runBuilt(built)
  if (!out.ok) {
    await reply(session, chatId,
      out.reason === 'noop'
        ? `ℹ️ #${prop.ref} — priority unchanged.`
        : `❌ ${out.reason}`)
    return true
  }
  await reply(session, chatId,
    `✅ #${out.row.ref} priority → *${out.row.priority_class}*` +
    (out.row.priority ? ` (rank ${out.row.priority})` : ''))
  return true
}

// ── !archive ────────────────────────────────────────────────────────────────
async function cmdArchive({ session, chatId, senderPhone, agentId = null, arg }) {
  const r = await resolveOrComplain({
    session, chatId, arg,
    usage: 'Usage: !archive <ref> [reason]\nExample: !archive 2906-077 owner went silent',
  })
  if (!r) return true
  const { prop, rest } = r

  const who = agentId || (await agentIdForPhone(senderPhone))
  const reason = rest.length ? rest.join(' ') : null
  const built = await boardAction.archive({
    propertyId: prop.id,
    agentId: who,
    reason: reason || undefined,   // let the builder's own default text stand
    oldStatus: prop.available_status || null,
    // An admin whose number is not in agents.whatsapp_phones still has to be
    // able to run this: 'system' is the honest attribution, and it is what lets
    // the builder accept a NULL agent_id.
    changedBy: who ? 'agent' : 'system',
  })
  const out = await runBuilt(built)
  if (!out.ok) {
    await reply(session, chatId, out.reason === 'noop'
      ? `ℹ️ #${prop.ref} is already archived.`
      : `❌ ${out.reason}`)
    return true
  }
  const said = await announce({ prop, kind: 'archived', reason, actor: senderPhone })
  await reply(session, chatId,
    `📦 #${out.row.ref} archived — removed from the board and unpublished.${said}`)
  return true
}

// ── !markrecentlyrented ─────────────────────────────────────────────────────
async function cmdMarkRecentlyRented({ session, chatId, senderPhone, agentId = null, arg }) {
  const r = await resolveOrComplain({
    session, chatId, arg,
    usage: 'Usage: !markrecentlyrented <ref> [reason]',
  })
  if (!r) return true
  const { prop, rest } = r

  const who = agentId || (await agentIdForPhone(senderPhone))
  const reason = rest.length ? rest.join(' ') : null
  const built = await boardAction.markRecentlyRented({
    propertyId: prop.id,
    agentId: who,
    reason,
    oldStatus: prop.available_status || null,
    changedBy: who ? 'agent' : 'system',
  })
  const out = await runBuilt(built)
  if (!out.ok) {
    await reply(session, chatId, out.reason === 'noop'
      ? `ℹ️ #${prop.ref} is archived, or was already marked rented in the last 48h.`
      : `❌ ${out.reason}`)
    return true
  }
  const said = await announce({ prop, kind: 'rented', reason, actor: senderPhone })
  await reply(session, chatId,
    `🔴 #${out.row.ref} marked rented — stays visible under "recently rented" for 48h.${said}`)
  return true
}

// ── !return ─────────────────────────────────────────────────────────────────
async function cmdReturnToMarket({ session, chatId, senderPhone, agentId = null, arg }) {
  const r = await resolveOrComplain({
    session, chatId, arg,
    usage: 'Usage: !return <ref> [reason]\nPuts a rented/archived listing back on the market.',
  })
  if (!r) return true
  const { prop, rest } = r

  const who = agentId || (await agentIdForPhone(senderPhone))
  const reason = rest.length ? rest.join(' ') : null
  const built = await boardAction.returnToMarket({
    propertyId: prop.id,
    agentId: who,
    reason,
    oldStatus: prop.available_status || null,
    changedBy: who ? 'agent' : 'system',
  })
  const out = await runBuilt(built)
  if (!out.ok) {
    await reply(session, chatId, out.reason === 'noop'
      ? `ℹ️ #${prop.ref} is already available.`
      : `❌ ${out.reason}`)
    return true
  }
  const said = await announce({ prop, kind: 'back_on_market', reason, actor: senderPhone })
  await reply(session, chatId,
    `🟢 #${out.row.ref} back on the market — republished, availability not yet confirmed.${said}`)
  return true
}

// property_activities.agent_id is a FK to agents(id), so an unknown sender has
// to log as NULL rather than break the insert.
async function agentIdForPhone(senderPhone) {
  const p = String(senderPhone || '').replace(/\D/g, '')
  if (!p) return null
  const candidates = [p]
  if (p.length === 8 && /^[79]/.test(p)) candidates.push('356' + p)
  try {
    const r = await db.query(
      `SELECT id FROM agents WHERE whatsapp_phones && $1::text[] AND active = TRUE LIMIT 1`,
      [candidates])
    return r.rows[0] ? r.rows[0].id : null
  } catch (e) { return null }
}

module.exports = {
  cmdPriority,
  cmdArchive,
  cmdMarkRecentlyRented,
  cmdReturnToMarket,
  agentIdForPhone,
  VALID_CLASSES,
}
