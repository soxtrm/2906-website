'use strict'
// ============================================================================
// services/facebookPages/connect.js — connect, reconnect, refresh, check and
// disconnect an agent's Facebook account and Pages.
//
// Flow: startConnect() returns the official Meta login dialog URL with a
// one-time state bound to the agent. Meta redirects to the CRM callback page,
// which posts {code, state} back here with the agent's own session. We verify
// the state, exchange the code server-side, upgrade to a long-lived user
// token, verify it with debug_token (app id + validity), read granted
// permissions and discover the Pages via /me/accounts. Page tokens are stored
// encrypted; the browser never sees any token.
// ============================================================================
const settings = require('./settings')
const graph = require('./graph')
const store = require('./store')

const { db } = store

function err(status, message, extra = {}) { return Object.assign(new Error(message), { status, ...extra }) }

function requireConfigured() {
  const miss = settings.missing()
  if (miss.length) throw err(503, 'Facebook publishing is not set up on this ARGUS server yet. An administrator needs to finish the Meta app setup.', { kind: 'not_configured' })
}

async function startConnect(agent) {
  requireConfigured()
  const existing = await store.liveConnection(agent.id)
  const state = await store.createState(agent.id, existing ? 'reconnect' : 'connect')
  return { url: graph.dialogUrl({ state, rerequest: !!(existing && existing.state === 'reconnect_required') }) }
}

const toDate = epoch => (epoch && Number(epoch) > 0 ? new Date(Number(epoch) * 1000) : null)

function pagePublishability(page, granted) {
  const tasks = Array.isArray(page.tasks) ? page.tasks : []
  const hasTask = tasks.includes('CREATE_CONTENT') || tasks.includes('MANAGE')
  const hasScope = granted.includes('pages_manage_posts')
  if (!page.access_token) return { canPublish: false, reason: 'Facebook did not give ARGUS access to this Page.' }
  if (!hasScope) return { canPublish: false, reason: 'Page posting was not allowed when you connected. Reconnect and allow ARGUS to create posts.' }
  if (!hasTask) return { canPublish: false, reason: 'Your role on this Page does not allow creating posts. Ask a Page admin to give you content access.' }
  return { canPublish: true, reason: null }
}

// Upsert discovered Pages for one connection, inside a transaction.
async function syncPages(q, agent, connection, pages, granted) {
  const seen = []
  const { rows: before } = await q.query(`SELECT * FROM agent_facebook_pages WHERE agent_id=$1`, [agent.id])
  const byId = new Map(before.map(r => [r.page_id, r]))
  for (const p of pages) {
    if (!p || !p.id) continue
    seen.push(String(p.id))
    const prev = byId.get(String(p.id))
    const { canPublish, reason } = pagePublishability(p, granted)
    // Keep a Page token only where it can be used: least data held.
    const credId = canPublish ? await store.saveCredential(q, 'page', p.access_token) : null
    const picture = p.picture && p.picture.data && p.picture.data.url ? p.picture.data.url : null
    const tasks = Array.isArray(p.tasks) ? p.tasks : []
    if (prev) {
      // A Page that comes back after an explicit disconnect never silently
      // resumes automatic publishing; the agent must switch it on again.
      const resumeAuto = prev.status !== 'disconnected' && prev.auto_publish && canPublish
      await q.query(
        `UPDATE agent_facebook_pages SET connection_id=$2, page_name=$3, picture_url=$4, category=$5, tasks=$6, can_publish=$7,
                page_credential_id=$8, status=$9, status_reason=$10, auto_publish=$11,
                enabled = CASE WHEN $7 THEN enabled ELSE FALSE END, last_synced_at=NOW(), updated_at=NOW()
          WHERE id=$1`,
        [prev.id, connection.id, String(p.name || 'Facebook Page').slice(0, 200), picture, p.category || null, tasks, canPublish,
         credId, canPublish ? 'active' : 'missing_permission', reason, resumeAuto])
      if (prev.page_credential_id && prev.page_credential_id !== credId) await store.deleteCredentials(q, [prev.page_credential_id])
    } else {
      await q.query(
        `INSERT INTO agent_facebook_pages (connection_id, agent_id, page_id, page_name, picture_url, category, tasks, can_publish, page_credential_id, status, status_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [connection.id, agent.id, String(p.id), String(p.name || 'Facebook Page').slice(0, 200), picture, p.category || null, tasks, canPublish,
         credId, canPublish ? 'active' : 'missing_permission', reason])
    }
  }
  // Pages Facebook no longer lists for this account: keep the row (history), stop publishing.
  const gone = before.filter(r => !seen.includes(r.page_id) && r.status !== 'disconnected')
  for (const r of gone) {
    await q.query(
      `UPDATE agent_facebook_pages SET status='removed', status_reason=$2, can_publish=FALSE, enabled=FALSE, auto_publish=FALSE, is_default=FALSE,
              page_credential_id=NULL, last_synced_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [r.id, 'Facebook no longer lists this Page for your account.'])
    await store.deleteCredentials(q, [r.page_credential_id])
  }
  // Sensible defaults: the first publishable Page becomes the default destination.
  const { rows: [hasDefault] } = await q.query(`SELECT id FROM agent_facebook_pages WHERE agent_id=$1 AND is_default AND can_publish AND status='active'`, [agent.id])
  if (!hasDefault) {
    await q.query(`UPDATE agent_facebook_pages SET is_default=FALSE WHERE agent_id=$1 AND is_default`, [agent.id])
    await q.query(
      `UPDATE agent_facebook_pages SET is_default=TRUE, enabled=TRUE, updated_at=NOW()
        WHERE id = (SELECT id FROM agent_facebook_pages WHERE agent_id=$1 AND can_publish AND status='active' ORDER BY enabled DESC, page_name LIMIT 1)`,
      [agent.id])
  }
}

async function completeConnect(agent, { code, state, error: oauthError } = {}) {
  requireConfigured()
  const purpose = await store.consumeState(agent.id, state)
  if (!purpose) throw err(400, 'This Facebook sign-in link has expired or was already used. Please start Connect Facebook again.', { kind: 'state' })
  if (oauthError) throw err(400, 'Facebook sign-in was cancelled. Nothing was connected.', { kind: 'cancelled' })
  if (!code || typeof code !== 'string' || code.length > 2048) throw err(400, 'Facebook did not return a sign-in code. Please try again.', { kind: 'code' })

  const short = await graph.exchangeCode(code)
  let longToken = short.access_token
  let expiresIn = Number(short.expires_in) || null
  try {
    const ll = await graph.exchangeLongLived(short.access_token)
    if (ll && ll.access_token) { longToken = ll.access_token; expiresIn = Number(ll.expires_in) || null }
  } catch (e) {
    if (e.kind === 'auth') throw e
    // A short-lived token still works for this session; the agent will be asked to reconnect sooner.
  }
  const s = settings.read()
  const dbg = await graph.debugToken(longToken)
  if (!dbg.is_valid || String(dbg.app_id) !== String(s.appId)) throw err(400, 'Facebook returned a sign-in that does not belong to ARGUS. Nothing was connected.', { kind: 'token_mismatch' })
  const profile = await graph.me(longToken)
  const perms = await graph.permissions(longToken)
  const pages = await graph.accounts(longToken)
  const tokenExpires = toDate(dbg.expires_at) || (expiresIn ? new Date(Date.now() + expiresIn * 1000) : null)
  const dataExpires = toDate(dbg.data_access_expires_at)

  const result = await store.tx(async q => {
    const { rows: lives } = await q.query(`SELECT * FROM agent_facebook_connections WHERE agent_id=$1 AND state <> 'disconnected' FOR UPDATE`, [agent.id])
    let conn = lives[0] || null
    if (conn && conn.fb_user_id !== String(profile.id)) {
      // A different Facebook account replaces the old one: retire it fully.
      await retireConnection(q, conn, 'Replaced by a different Facebook account')
      conn = null
    }
    const userCred = await store.saveCredential(q, 'user', longToken, tokenExpires)
    if (conn) {
      await store.deleteCredentials(q, [conn.user_credential_id])
      const { rows: [c] } = await q.query(
        `UPDATE agent_facebook_connections SET fb_user_name=$2, state='active', state_reason=NULL, granted_scopes=$3, declined_scopes=$4,
                user_credential_id=$5, token_expires_at=$6, data_access_expires_at=$7, graph_version=$8, last_checked_at=NOW(), updated_at=NOW()
          WHERE id=$1 RETURNING *`,
        [conn.id, profile.name || null, perms.granted, perms.declined, userCred, tokenExpires, dataExpires, s.graphVersion])
      conn = c
    } else {
      const { rows: [c] } = await q.query(
        `INSERT INTO agent_facebook_connections (agent_id, fb_user_id, fb_user_name, granted_scopes, declined_scopes, user_credential_id,
                token_expires_at, data_access_expires_at, graph_version, last_checked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) RETURNING *`,
        [agent.id, String(profile.id), profile.name || null, perms.granted, perms.declined, userCred, tokenExpires, dataExpires, s.graphVersion])
      conn = c
    }
    await syncPages(q, agent, conn, pages, perms.granted)
    // Publications parked because the connection had expired can be retried by the agent now.
    await store.audit(agent, purpose === 'reconnect' ? 'facebook_reconnect' : 'facebook_connect', {
      details: { pages: pages.length, granted: perms.granted, declined: perms.declined, graph_version: s.graphVersion },
    }, q)
    return conn
  })
  return { connectionId: result.id }
}

// Mark a connection gone and stop everything that depends on it (caller's transaction).
async function retireConnection(q, conn, reason) {
  const { rows: pages } = await q.query(`SELECT id, page_credential_id FROM agent_facebook_pages WHERE connection_id=$1`, [conn.id])
  await q.query(
    `UPDATE agent_facebook_pages SET status='disconnected', status_reason=$2, enabled=FALSE, auto_publish=FALSE, is_default=FALSE,
            can_publish=FALSE, page_credential_id=NULL, updated_at=NOW() WHERE connection_id=$1`, [conn.id, reason])
  await store.deleteCredentials(q, pages.map(p => p.page_credential_id))
  await q.query(
    `UPDATE agent_facebook_connections SET state='disconnected', state_reason=$2, user_credential_id=NULL, disconnected_at=NOW(), updated_at=NOW() WHERE id=$1`,
    [conn.id, reason])
  await store.deleteCredentials(q, [conn.user_credential_id])
  // Future jobs stop immediately. Work whose outcome is unknown is kept for review.
  await q.query(
    `UPDATE agent_facebook_publications SET state='cancelled', last_error_kind='disconnected',
            last_error_message='Facebook was disconnected before this post was published.', next_attempt_at=NULL, updated_at=NOW()
      WHERE page_row_id = ANY($1::bigint[]) AND state IN ('draft','queued','reconnect_required')`, [pages.map(p => p.id)])
  await q.query(
    `UPDATE agent_facebook_publications SET state='needs_review', last_error_kind='disconnected',
            last_error_message='Facebook was disconnected while this post was being published. Check your Page to see whether it appeared.', next_attempt_at=NULL, updated_at=NOW()
      WHERE page_row_id = ANY($1::bigint[]) AND state IN ('publishing','reconciling')`, [pages.map(p => p.id)])
}

async function refreshPages(agent) {
  requireConfigured()
  const conn = await store.liveConnection(agent.id)
  if (!conn) throw err(409, 'Facebook is not connected.')
  const token = await store.userToken(conn)
  if (!token) throw err(409, 'Please reconnect Facebook.', { kind: 'auth' })
  try {
    const perms = await graph.permissions(token)
    const pages = await graph.accounts(token)
    await store.tx(async q => {
      await q.query(`UPDATE agent_facebook_connections SET granted_scopes=$2, declined_scopes=$3, last_checked_at=NOW(), updated_at=NOW() WHERE id=$1`, [conn.id, perms.granted, perms.declined])
      await syncPages(q, agent, conn, pages, perms.granted)
    })
    await store.audit(agent, 'facebook_pages_refresh', { details: { pages: pages.length } })
  } catch (e) {
    if (e.kind === 'auth') await markReconnectRequired(conn.id, e.userMessage)
    throw e
  }
}

// Validity check without changing anything except the stored status.
async function checkConnection(agent) {
  requireConfigured()
  const conn = await store.liveConnection(agent.id)
  if (!conn) return { state: 'not_connected' }
  const token = await store.userToken(conn)
  if (!token) { await markReconnectRequired(conn.id, 'Stored credentials are missing.'); return { state: 'reconnect_required' } }
  try {
    const dbg = await graph.debugToken(token)
    if (!dbg.is_valid) { await markReconnectRequired(conn.id, 'Facebook reports the connection is no longer valid.'); return { state: 'reconnect_required' } }
    const perms = await graph.permissions(token)
    await db.query(
      `UPDATE agent_facebook_connections SET granted_scopes=$2, declined_scopes=$3, token_expires_at=COALESCE($4, token_expires_at),
              data_access_expires_at=COALESCE($5, data_access_expires_at), last_checked_at=NOW(), updated_at=NOW(),
              state = CASE WHEN $6 THEN 'active' ELSE 'reconnect_required' END,
              state_reason = CASE WHEN $6 THEN NULL ELSE 'Page posting permission was removed.' END
        WHERE id=$1`,
      [conn.id, perms.granted, perms.declined, toDate(dbg.expires_at), toDate(dbg.data_access_expires_at), perms.granted.includes('pages_manage_posts')])
    return { state: perms.granted.includes('pages_manage_posts') ? 'active' : 'reconnect_required' }
  } catch (e) {
    if (e.kind === 'auth') { await markReconnectRequired(conn.id, e.userMessage); return { state: 'reconnect_required' } }
    throw e
  }
}

async function markReconnectRequired(connectionId, reason) {
  await db.query(
    `UPDATE agent_facebook_connections SET state='reconnect_required', state_reason=$2, updated_at=NOW() WHERE id=$1 AND state='active'`,
    [connectionId, String(reason || 'Reconnect required').slice(0, 300)])
}

async function disconnect(agent, { revoke = true } = {}) {
  const conn = await store.liveConnection(agent.id)
  if (!conn) return { disconnected: false }
  // Best effort: remove ARGUS from the person's Facebook settings too, unless the
  // same Facebook account is still connected to another ARGUS agent.
  let revoked = false
  if (revoke && settings.isConfigured()) {
    try {
      const { rows: [other] } = await db.query(
        `SELECT 1 FROM agent_facebook_connections WHERE fb_user_id=$1 AND agent_id<>$2 AND state<>'disconnected' LIMIT 1`, [conn.fb_user_id, agent.id])
      const token = other ? null : await store.userToken(conn)
      if (token) { await graph.request('DELETE', 'me/permissions', { token, idempotent: true }); revoked = true }
    } catch { /* already revoked or expired: disconnecting locally is what matters */ }
  }
  await store.tx(async q => {
    await retireConnection(q, conn, 'Disconnected by the agent')
    await q.query(`UPDATE agent_facebook_preferences SET auto_publish_enabled=FALSE, updated_at=NOW() WHERE agent_id=$1`, [agent.id])
    await store.audit(agent, 'facebook_disconnect', { details: { revoked_at_meta: revoked } }, q)
  })
  return { disconnected: true, revokedAtMeta: revoked }
}

async function updatePage(agent, pageRowId, { enabled, isDefault, autoPublish } = {}) {
  return store.tx(async q => {
    const page = await store.ownedPage(agent.id, pageRowId, q)
    if (!page || page.status === 'disconnected') throw err(404, 'Page not found.')
    if ((enabled === true || isDefault === true || autoPublish === true) && !(page.can_publish && page.status === 'active')) {
      throw err(409, page.status_reason || 'This Page cannot be used for publishing.')
    }
    if (isDefault === true) await q.query(`UPDATE agent_facebook_pages SET is_default=FALSE WHERE agent_id=$1 AND is_default AND id<>$2`, [agent.id, page.id])
    const next = {
      enabled: enabled === undefined ? page.enabled : !!enabled,
      is_default: isDefault === undefined ? page.is_default : !!isDefault,
      auto_publish: autoPublish === undefined ? page.auto_publish : !!autoPublish,
    }
    if (next.is_default) next.enabled = true
    if (!next.enabled) { next.is_default = false; next.auto_publish = false }
    await q.query(`UPDATE agent_facebook_pages SET enabled=$2, is_default=$3, auto_publish=$4, updated_at=NOW() WHERE id=$1`,
      [page.id, next.enabled, next.is_default, next.auto_publish])
    if (autoPublish === false) {
      await q.query(
        `UPDATE agent_facebook_publications SET state='cancelled', last_error_kind='auto_off', last_error_message='Automatic publishing was switched off for this Page.', next_attempt_at=NULL, updated_at=NOW()
          WHERE page_row_id=$1 AND trigger='auto_verified' AND state='queued'`, [page.id])
    }
    await store.audit(agent, 'facebook_page_settings', { details: { page_row_id: page.id, ...next } }, q)
    return next
  })
}

// Meta data-deletion callback: forget everything held for one Facebook user.
async function forgetFacebookUser(fbUserId) {
  const { rows: conns } = await db.query(`SELECT * FROM agent_facebook_connections WHERE fb_user_id=$1 AND state<>'disconnected'`, [String(fbUserId)])
  for (const c of conns) {
    await store.tx(async q => {
      await retireConnection(q, c, 'Removed at the person\'s request on Facebook')
      await q.query(`UPDATE agent_facebook_preferences SET auto_publish_enabled=FALSE, updated_at=NOW() WHERE agent_id=$1`, [c.agent_id])
    })
  }
  await db.query(`UPDATE agent_facebook_connections SET fb_user_name=NULL WHERE fb_user_id=$1`, [String(fbUserId)])
  return conns.length
}

module.exports = {
  startConnect, completeConnect, refreshPages, checkConnection, disconnect, updatePage, markReconnectRequired,
  forgetFacebookUser, pagePublishability, requireConfigured,
}
