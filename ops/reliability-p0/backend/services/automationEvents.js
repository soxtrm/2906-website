'use strict'
// ============================================================================
// services/automationEvents.js — the one event log for automation (2026-11-12)
//
// Every executed, skipped, failed or retried automatic action writes one row
// into agent_activity_log, the table the Activity Board already reads. Until
// now only logins and profile edits landed there, and the general logger was
// behind a flag that is off in production, so automatic work was invisible.
// Rows are written directly (no flag): an audit trail must not be optional.
//
// action_type is "auto:<rule>:<action>"; details carries rule, result, owner
// reference (id only, never a phone number), account, message id, reason and
// the next due time. heartbeat() records the last run of each recurring worker.
// Neither function ever throws into the caller.
// ============================================================================
const db = require('../db')

async function record({ rule, action, result = 'success', agentId = null, propertyId = null, ref = null, ownerId = null,
                        account = null, messageId = null, trigger = null, reason = null, nextAt = null, details = {} } = {}) {
  try {
    const d = { rule, result, owner_ref: ownerId ? `owner#${ownerId}` : null, account, message_id: messageId, trigger, reason,
                next_at: nextAt ? new Date(nextAt).toISOString() : null, ...details }
    for (const k of Object.keys(d)) if (d[k] === null || d[k] === undefined) delete d[k]
    const r = await db.query(
      `INSERT INTO agent_activity_log (actor_agent_id, actor_role, actor_display_name, action_type, target_property_id, target_ref, details, is_kev)
       VALUES ($1, 'system', 'ARGUS automation', $2, $3, $4, $5::jsonb, FALSE) RETURNING id`,
      [agentId ? Number(agentId) : null, `auto:${rule}:${action}`.slice(0, 100), propertyId ? Number(propertyId) : null, ref ? String(ref).slice(0, 64) : null, JSON.stringify(d)])
    return r.rows[0]?.id || null
  } catch (err) {
    console.error('[automationEvents] write failed:', err.message)
    return null
  }
}

async function heartbeat(name, { ok = true, detail = null, schedule = null, nextExpectedAt = null } = {}) {
  try {
    await db.query(
      `INSERT INTO worker_heartbeats (name, schedule, last_run_at, last_ok_at, last_status, last_detail, runs, failures, next_expected_at, updated_at)
       VALUES ($1, $2, NOW(), CASE WHEN $3 THEN NOW() END, CASE WHEN $3 THEN 'ok' ELSE 'failed' END, $4::jsonb, 1, CASE WHEN $3 THEN 0 ELSE 1 END, $5, NOW())
       ON CONFLICT (name) DO UPDATE SET schedule = COALESCE(EXCLUDED.schedule, worker_heartbeats.schedule), last_run_at = NOW(),
         last_ok_at = CASE WHEN $3 THEN NOW() ELSE worker_heartbeats.last_ok_at END, last_status = EXCLUDED.last_status,
         last_detail = EXCLUDED.last_detail, runs = worker_heartbeats.runs + 1,
         failures = worker_heartbeats.failures + CASE WHEN $3 THEN 0 ELSE 1 END, next_expected_at = EXCLUDED.next_expected_at, updated_at = NOW()`,
      [name, schedule, !!ok, detail ? JSON.stringify(detail) : null, nextExpectedAt ? new Date(nextExpectedAt) : null])
  } catch (err) { console.error('[automationEvents] heartbeat failed:', err.message) }
}

const compact = out => (out && typeof out === 'object'
  ? JSON.parse(JSON.stringify(out, (k, v) => (Array.isArray(v) && v.length > 20 ? v.length : v)))
  : (out === undefined ? null : { value: out }))

// Wraps a recurring job: heartbeat on every run, a failure is recorded with its message.
function beat(name, schedule, fn, { intervalMs = null } = {}) {
  return async (...args) => {
    const next = intervalMs ? Date.now() + intervalMs : null
    try {
      const out = await fn(...args)
      await heartbeat(name, { ok: true, schedule, nextExpectedAt: next, detail: compact(out) })
      return out
    } catch (err) {
      await heartbeat(name, { ok: false, schedule, nextExpectedAt: next, detail: { error: String(err.message || err).slice(0, 300) } })
      throw err
    }
  }
}

async function listEvents({ limit = 200, rule = null, propertyRef = null, result = null, before = null } = {}) {
  const where = [`l.action_type LIKE 'auto:%'`], p = []
  if (rule) { p.push(`auto:${rule}:%`); where.push(`l.action_type LIKE $${p.length}`) }
  if (propertyRef) { p.push(propertyRef); where.push(`l.target_ref = $${p.length}`) }
  if (result) { p.push(result); where.push(`l.details->>'result' = $${p.length}`) }
  if (before) { p.push(Number(before)); where.push(`l.id < $${p.length}`) }
  p.push(Math.min(Number(limit) || 200, 500))
  return (await db.query(
    `SELECT l.id, l.created_at, l.action_type, l.target_property_id, l.target_ref, l.actor_agent_id, a.name AS agent_name, l.details
       FROM agent_activity_log l LEFT JOIN agents a ON a.id = l.actor_agent_id
      WHERE ${where.join(' AND ')} ORDER BY l.id DESC LIMIT $${p.length}`, p)).rows
}

async function listHeartbeats() {
  return (await db.query(
    `SELECT name, schedule, last_run_at, last_ok_at, last_status, last_detail, runs, failures, next_expected_at,
            (next_expected_at IS NOT NULL AND next_expected_at < NOW() - INTERVAL '10 minutes') AS overdue
       FROM worker_heartbeats ORDER BY name`)).rows
}

module.exports = { record, heartbeat, beat, listEvents, listHeartbeats }
