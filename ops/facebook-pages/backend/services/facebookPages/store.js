'use strict'
// ============================================================================
// services/facebookPages/store.js — persistence for the agent Facebook
// integration. Plain SQL on the existing pg pool (db.js). Every read that
// returns data to an agent is scoped by agent_id here, not in the caller.
// Credentials are stored encrypted (secrets.js) in agent_facebook_credentials
// and are only ever decrypted inside this module's getters.
// ============================================================================
const db = require('../../db')
const secrets = require('./secrets')

async function tx(fn) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    throw e
  } finally { client.release() }
}

// ── credentials ──────────────────────────────────────────────────────────────
async function saveCredential(q, kind, token, expiresAt = null) {
  const { rows: [r] } = await q.query(
    `INSERT INTO agent_facebook_credentials (kind, ciphertext, key_version, expires_at) VALUES ($1,$2,$3,$4) RETURNING id`,
    [kind, secrets.encrypt(token, kind), secrets.VERSION, expiresAt])
  return r.id
}
async function readCredential(id, kind) {
  if (!id) return null
  const { rows: [r] } = await db.query(`SELECT ciphertext FROM agent_facebook_credentials WHERE id=$1 AND kind=$2`, [id, kind])
  return r ? secrets.decrypt(r.ciphertext, kind) : null
}
async function deleteCredentials(q, ids) {
  const list = (ids || []).filter(Boolean)
  if (list.length) await q.query(`DELETE FROM agent_facebook_credentials WHERE id = ANY($1::bigint[])`, [list])
}

// ── OAuth state ──────────────────────────────────────────────────────────────
async function createState(agentId, purpose, ttlMinutes = 10) {
  const state = secrets.randomToken(32)
  await db.query(
    `INSERT INTO agent_facebook_oauth_states (state_hash, agent_id, purpose, expires_at) VALUES ($1,$2,$3, NOW() + make_interval(mins => $4))`,
    [secrets.sha256(state), agentId, purpose, ttlMinutes])
  await db.query(`DELETE FROM agent_facebook_oauth_states WHERE expires_at < NOW() - INTERVAL '1 day'`)
  return state
}
// Single use, bound to the agent who started it, not expired.
async function consumeState(agentId, state) {
  const { rows: [r] } = await db.query(
    `UPDATE agent_facebook_oauth_states SET used_at = NOW()
      WHERE state_hash=$1 AND agent_id=$2 AND used_at IS NULL AND expires_at > NOW()
      RETURNING purpose`, [secrets.sha256(state || ''), agentId])
  return r ? r.purpose : null
}

// ── connections & pages ──────────────────────────────────────────────────────
async function liveConnection(agentId, q = db) {
  const { rows: [c] } = await q.query(
    `SELECT * FROM agent_facebook_connections WHERE agent_id=$1 AND state <> 'disconnected' ORDER BY id DESC LIMIT 1`, [agentId])
  return c || null
}
async function pagesFor(agentId, q = db) {
  const { rows } = await q.query(
    `SELECT * FROM agent_facebook_pages WHERE agent_id=$1 AND status <> 'disconnected' ORDER BY is_default DESC, page_name`, [agentId])
  return rows
}
// The one gate every publish/edit/delete goes through: the page row must belong
// to this agent's live connection. A Meta Page id submitted by the client is
// never trusted on its own.
async function ownedPage(agentId, pageRowId, q = db) {
  const { rows: [p] } = await q.query(
    `SELECT p.*, c.state AS connection_state
       FROM agent_facebook_pages p JOIN agent_facebook_connections c ON c.id = p.connection_id
      WHERE p.id=$1 AND p.agent_id=$2 AND c.agent_id=$2`, [pageRowId, agentId])
  return p || null
}
async function pageToken(pageRow) { return readCredential(pageRow.page_credential_id, 'page') }
async function userToken(conn) { return readCredential(conn.user_credential_id, 'user') }

async function preferences(agentId, q = db) {
  const { rows: [p] } = await q.query(`SELECT * FROM agent_facebook_preferences WHERE agent_id=$1`, [agentId])
  return p || { agent_id: agentId, language: 'en', default_template_id: null, use_emojis: true, include_contact: false, include_link: true, call_to_action: null, auto_publish_enabled: false, auto_publish_enabled_at: null, auto_daily_limit: 3 }
}

// ── audit ────────────────────────────────────────────────────────────────────
// agent_activity_log is the existing CRM audit table. details never carry tokens.
async function audit(agent, actionType, { propertyId = null, ref = null, details = {} } = {}, q = db) {
  try {
    await q.query(
      `INSERT INTO agent_activity_log (actor_agent_id, actor_role, actor_display_name, action_type, target_property_id, target_ref, details, is_kev)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,FALSE)`,
      [agent.id, agent.role || null, agent.name || agent.username || null, String(actionType).slice(0, 100), propertyId, ref ? String(ref).slice(0, 64) : null, JSON.stringify(details)])
  } catch { /* audit must never break the user action */ }
}

module.exports = {
  db, tx, saveCredential, readCredential, deleteCredentials, createState, consumeState,
  liveConnection, pagesFor, ownedPage, pageToken, userToken, preferences, audit,
}
