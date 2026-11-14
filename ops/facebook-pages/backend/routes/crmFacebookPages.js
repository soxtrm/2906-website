'use strict'
// ============================================================================
// routes/crmFacebookPages.js — agent Facebook Business Page publishing API.
// Mounted at /api/crm/facebook-pages BEFORE the /api/crm catch-all.
//
// Staff tokens only (board tokens refused), checked against the live agents
// row. Staged rollout: administrators, plus agents whose
// feature_entitlements.facebook_pages is true. Every action is scoped to the
// signed-in agent server-side: Pages, publications and templates of another
// agent are invisible, and a Page is identified by our own row id that must
// belong to the caller — a Meta Page id from the browser is never trusted.
// Responses never contain tokens or credential ids.
// ============================================================================
const express = require('express')
const jwt = require('jsonwebtoken')
const db = require('../db')
const log = require('../logger')
const settings = require('../services/facebookPages/settings')
const store = require('../services/facebookPages/store')
const connect = require('../services/facebookPages/connect')
const publisher = require('../services/facebookPages/publisher')
const content = require('../services/facebookPages/content')

const router = express.Router()
router.use(express.json({ limit: '256kb' }))

async function staffAuth(req, res, next) {
  const h = req.headers.authorization
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' })
  let payload
  try { payload = jwt.verify(h.slice(7), process.env.JWT_SECRET) } catch { return res.status(401).json({ error: 'Session invalid or expired' }) }
  if (payload.aud === 'board') return res.status(403).json({ error: 'Board account — no access to Facebook publishing.' })
  try {
    const { rows: [a] } = await db.query(`SELECT id, role, active, name, username, feature_entitlements FROM agents WHERE id=$1`, [payload.id])
    if (!a || !a.active) return res.status(401).json({ error: 'Account inactive' })
    if (!['admin', 'agent'].includes(a.role)) return res.status(403).json({ error: 'No access to Facebook publishing' })
    const entitled = a.role === 'admin' || (a.feature_entitlements && a.feature_entitlements.facebook_pages === true)
    if (!entitled) return res.status(403).json({ error: 'Facebook publishing is not enabled for your account yet.', kind: 'not_entitled' })
    req.agent = { id: a.id, role: a.role, name: a.name || a.username, username: a.username }
    next()
  } catch (err) {
    log.error('facebook-pages auth failed', { err: err.message })
    res.status(500).json({ error: 'Auth check failed' })
  }
}
router.use(staffAuth)

const send = fn => async (req, res) => {
  try { res.set('Cache-Control', 'no-store'); res.json(await fn(req)) }
  catch (err) {
    const status = err.status || (err.name === 'GraphError' ? (err.kind === 'auth' || err.kind === 'permission' ? 409 : 502) : 500)
    const body = { error: status === 500 ? 'Something went wrong. Please try again.' : (err.userMessage || err.message) }
    for (const k of ['kind', 'blockers', 'existing', 'canReplace']) if (err[k] !== undefined) body[k] = err[k]
    if (status >= 500) log.error('facebook-pages route failed', { path: req.path, kind: err.kind, code: err.code, detail: err.detail, err: status === 500 ? err.message : undefined })
    res.status(status).json(body)
  }
}

function shapePage(p) {
  return {
    id: Number(p.id), pageId: p.page_id, name: p.page_name, pictureUrl: p.picture_url, category: p.category,
    canPublish: p.can_publish && p.status === 'active', status: p.status, statusReason: p.status_reason,
    enabled: p.enabled, isDefault: p.is_default, autoPublish: p.auto_publish, lastSyncedAt: p.last_synced_at,
  }
}
function shapePrefs(p) {
  return {
    language: p.language, defaultTemplateId: p.default_template_id ? String(p.default_template_id) : 'classic', useEmojis: p.use_emojis,
    includeContact: p.include_contact, includeLink: p.include_link, callToAction: p.call_to_action || '',
    autoPublishEnabled: p.auto_publish_enabled, autoDailyLimit: p.auto_daily_limit,
  }
}

async function status(agent) {
  const s = settings.read()
  const conn = await store.liveConnection(agent.id)
  const pages = conn ? await store.pagesFor(agent.id) : []
  const prefs = await store.preferences(agent.id)
  const { rows: [me] } = await db.query(`SELECT display_name, name, alias, public_phone, color_hex FROM agents WHERE id=$1`, [agent.id])
  const { rows: templates } = await db.query(`SELECT id, name, language, body, updated_at FROM agent_facebook_templates WHERE agent_id=$1 ORDER BY name`, [agent.id])
  const missingScopes = conn ? settings.REQUIRED_SCOPES.filter(x => !(conn.granted_scopes || []).includes(x)) : []
  return {
    configured: settings.isConfigured(),
    setupMissing: settings.missing(),               // env names only, never values
    appId: s.appId || null,                         // public identifier, used for the Share Dialog
    graphVersion: s.graphVersion,
    autoPublishAvailable: s.autoPublishScan,
    connection: conn ? {
      state: conn.state, reason: conn.state_reason, facebookName: conn.fb_user_name, connectedAt: conn.connected_at,
      lastCheckedAt: conn.last_checked_at, tokenExpiresAt: conn.token_expires_at, missingPermissions: missingScopes,
    } : { state: 'not_connected' },
    pages: pages.map(shapePage),
    preferences: shapePrefs(prefs),
    templates: [...content.BUILT_IN.map(t => ({ ...t, builtIn: true })), ...templates.map(t => ({ id: String(t.id), name: t.name, language: t.language, body: t.body, builtIn: false }))],
    agent: { displayName: (me && (me.display_name || me.alias || me.name)) || agent.name, publicPhone: me ? me.public_phone : null, colorHex: me && /^#[0-9a-f]{6}$/i.test(me.color_hex || '') ? me.color_hex : null },
  }
}

router.get('/status', send(req => status(req.agent)))
router.post('/connect', send(req => connect.startConnect(req.agent)))
router.post('/connect/complete', send(async req => {
  await connect.completeConnect(req.agent, { code: req.body && req.body.code, state: req.body && req.body.state, error: req.body && req.body.error })
  return status(req.agent)
}))
router.post('/refresh', send(async req => { await connect.refreshPages(req.agent); return status(req.agent) }))
router.post('/check', send(async req => { await connect.checkConnection(req.agent); return status(req.agent) }))
router.post('/disconnect', send(async req => { const r = await connect.disconnect(req.agent); return { ...r, status: await status(req.agent) } }))
router.patch('/pages/:id', send(async req => {
  const b = req.body || {}
  await connect.updatePage(req.agent, Number(req.params.id), { enabled: b.enabled, isDefault: b.isDefault, autoPublish: b.autoPublish })
  return status(req.agent)
}))

router.patch('/preferences', send(async req => {
  const b = req.body || {}
  const cur = await store.preferences(req.agent.id)
  const language = content.LANGS.includes(b.language) ? b.language : cur.language
  let tpl = cur.default_template_id
  if (b.defaultTemplateId !== undefined) {
    if (/^\d+$/.test(String(b.defaultTemplateId))) {
      const { rows: [t] } = await db.query(`SELECT id FROM agent_facebook_templates WHERE id=$1 AND agent_id=$2`, [Number(b.defaultTemplateId), req.agent.id])
      if (!t) throw Object.assign(new Error('Template not found.'), { status: 404 })
      tpl = t.id
    } else tpl = null
  }
  const auto = b.autoPublishEnabled === undefined ? cur.auto_publish_enabled : b.autoPublishEnabled === true
  if (auto && !cur.auto_publish_enabled) {
    const conn = await store.liveConnection(req.agent.id)
    if (!conn || conn.state !== 'active') throw Object.assign(new Error('Connect Facebook before switching on automatic publishing.'), { status: 409 })
  }
  const limit = b.autoDailyLimit === undefined ? cur.auto_daily_limit : Math.min(10, Math.max(1, Number(b.autoDailyLimit) || 3))
  const cta = b.callToAction === undefined ? cur.call_to_action : (String(b.callToAction || '').trim().slice(0, 200) || null)
  await db.query(
    `INSERT INTO agent_facebook_preferences (agent_id, language, default_template_id, use_emojis, include_contact, include_link, call_to_action,
            auto_publish_enabled, auto_publish_enabled_at, auto_daily_limit, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $8 THEN NOW() END, $9, NOW())
     ON CONFLICT (agent_id) DO UPDATE SET language=$2, default_template_id=$3, use_emojis=$4, include_contact=$5, include_link=$6, call_to_action=$7,
            auto_publish_enabled=$8,
            auto_publish_enabled_at = CASE WHEN $8 AND NOT agent_facebook_preferences.auto_publish_enabled THEN NOW()
                                           WHEN $8 THEN agent_facebook_preferences.auto_publish_enabled_at ELSE NULL END,
            auto_daily_limit=$9, updated_at=NOW()`,
    [req.agent.id, language, tpl, b.useEmojis === undefined ? cur.use_emojis : !!b.useEmojis, b.includeContact === undefined ? cur.include_contact : !!b.includeContact,
     b.includeLink === undefined ? cur.include_link : !!b.includeLink, cta, auto, limit])
  if (!auto && cur.auto_publish_enabled) {
    await db.query(
      `UPDATE agent_facebook_publications SET state='cancelled', last_error_kind='auto_off', last_error_message='Automatic publishing was switched off.', next_attempt_at=NULL, updated_at=NOW()
        WHERE agent_id=$1 AND trigger='auto_verified' AND state='queued'`, [req.agent.id])
  }
  if (auto !== cur.auto_publish_enabled) await store.audit(req.agent, auto ? 'facebook_auto_publish_on' : 'facebook_auto_publish_off')
  return status(req.agent)
}))

router.post('/templates', send(async req => {
  const b = req.body || {}
  const name = String(b.name || '').trim().slice(0, 80)
  const body = String(b.body || '').replace(/\r/g, '').trim()
  if (!name || !body) throw Object.assign(new Error('Give the template a name and some text.'), { status: 400 })
  if (body.length > 4000) throw Object.assign(new Error('Templates can be at most 4000 characters.'), { status: 400 })
  const language = content.LANGS.includes(b.language) ? b.language : 'en'
  const { rows: [{ n }] } = await db.query(`SELECT COUNT(*)::int n FROM agent_facebook_templates WHERE agent_id=$1`, [req.agent.id])
  if (n >= 20) throw Object.assign(new Error('You can save up to 20 templates.'), { status: 409 })
  await db.query(`INSERT INTO agent_facebook_templates (agent_id, name, language, body) VALUES ($1,$2,$3,$4)`, [req.agent.id, name, language, body])
  return status(req.agent)
}))
router.delete('/templates/:id', send(async req => {
  await db.query(`UPDATE agent_facebook_preferences SET default_template_id=NULL WHERE agent_id=$1 AND default_template_id=$2`, [req.agent.id, Number(req.params.id)])
  await db.query(`DELETE FROM agent_facebook_templates WHERE id=$1 AND agent_id=$2`, [Number(req.params.id), req.agent.id])
  return status(req.agent)
}))

router.get('/properties/:id/draft', send(req => publisher.draft(req.agent, req.params.id, {
  language: req.query.language, templateId: req.query.templateId, cta: req.query.cta,
  emojis: req.query.emojis === undefined ? undefined : req.query.emojis === '1',
  includeContact: req.query.contact === undefined ? undefined : req.query.contact === '1',
  includeLink: req.query.link === undefined ? undefined : req.query.link === '1',
})))

router.get('/publications', send(async req => ({ publications: await publisher.list(req.agent, { propertyId: req.query.propertyId, limit: req.query.limit, before: req.query.before }) })))
router.post('/publications', send(req => publisher.create(req.agent, req.body || {})))
router.get('/publications/:id', send(async req => ({ publication: await publisher.get(req.agent, req.params.id) })))
router.post('/publications/:id/check', send(async req => ({ publication: await publisher.check(req.agent, req.params.id) })))
router.post('/publications/:id/retry', send(async req => ({ publication: await publisher.retry(req.agent, req.params.id, { confirm: !!(req.body && req.body.confirm) }) })))
router.patch('/publications/:id', send(async req => ({ publication: await publisher.updateText(req.agent, req.params.id, req.body && req.body.message) })))
router.delete('/publications/:id', send(async req => ({ publication: await publisher.remove(req.agent, req.params.id, { confirm: !!(req.body && req.body.confirm) || req.query.confirm === '1' }) })))

module.exports = router
module.exports.status = status
