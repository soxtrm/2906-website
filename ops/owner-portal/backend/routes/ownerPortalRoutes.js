'use strict'
// HTTP layer for the ARGUS Owner Portal (Claude, 2026-11-16).
//
//   /api/owner-portal/*        owner or property-manager session (Bearer ses_…)
//   /api/owner-share/*         agent-facing share link + per-request link (no session)
//   /api/crm/owner-portal/*    staff: the existing CRM auth, then admin or an
//                              agent whose LIVE row has feature_entitlements.owner_portal = true
//
// Mount (production index.js, 3 lines — see README):
//   const op = require('./routes/ownerPortalRoutes')({ db, staffAuth: auth })
//   app.use('/api/owner-portal', op.owner); app.use('/api/owner-share', op.share); app.use('/api/crm/owner-portal', op.staff)
const express = require('express')
const { createOwnerPortal, PortalError } = require('../services/ownerPortal')

function limiter({ windowMs = 60000, max = 30 } = {}) {
  const hits = new Map()
  return (req, res, next) => {
    const key = `${req.ip}|${req.baseUrl}`
    const t = Date.now()
    const h = (hits.get(key) || []).filter(x => t - x < windowMs)
    h.push(t); hits.set(key, h)
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(x => t - x < windowMs)) hits.delete(k)
    if (h.length > max) return res.status(429).json({ error: 'Too many requests. Try again in a minute.', code: 'RATE_LIMITED' })
    next()
  }
}

function send(res, err) {
  if (err instanceof PortalError || (err && err.code && err.status && err.status < 500)) {
    return res.status(err.status || 400).json({ error: err.message, code: err.code, ...(err.conflict ? { conflict: err.conflict } : {}), ...(err.overridable !== undefined ? { overridable: err.overridable } : {}) })
  }
  console.error('[owner-portal]', err && err.message)
  return res.status(500).json({ error: 'Something went wrong. Nothing was changed.', code: 'INTERNAL' })
}
const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).then(out => { if (!res.headersSent) res.json(out) }).catch(err => send(res, err))
const bearer = req => { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7).trim() : '' }

module.exports = function ownerPortalRoutes({ db, staffAuth, portal: injected, ...options }) {
  const portal = injected || createOwnerPortal({ db, ...options })
  const noStore = (req, res, next) => { res.set('Cache-Control', 'private, no-store'); res.set('X-Robots-Tag', 'noindex'); next() }

  // ── owner / property manager ──
  const owner = express.Router()
  owner.use(noStore)
  owner.post('/session/claim', limiter({ max: 10 }), express.json({ limit: '4kb' }), wrap(req => portal.claimInvitation({ token: req.body && req.body.token, userAgent: req.headers['user-agent'] })))
  owner.post('/session/logout', wrap(req => portal.logout(bearer(req))))
  owner.use(async (req, res, next) => {
    try {
      const p = await portal.authenticate(bearer(req))
      if (!p) return res.status(401).json({ error: 'Please open your owner link again.', code: 'UNAUTHENTICATED' })
      req.principal = p; next()
    } catch (err) { send(res, err) }
  })
  owner.get('/me', wrap(req => portal.me(req.principal)))
  owner.post('/me/confirm-properties', express.json(), wrap(req => portal.confirmProperties(req.principal, req.body || {})))
  owner.put('/me/preferences', express.json(), wrap(req => portal.setPreferences(req.principal, req.body || {})))
  owner.get('/audit', wrap(req => portal.auditLog(req.principal)))
  owner.post('/properties', express.json({ limit: '32kb' }), wrap(req => portal.submitProperty(req.principal, req.body || {})))
  owner.get('/properties/:id', wrap(req => portal.propertyDetail(req.principal, req.params.id)))
  owner.post('/properties/:id/proposals', express.json({ limit: '32kb' }), wrap(req => portal.proposeChange(req.principal, req.params.id, (req.body || {}).fields)))
  owner.post('/properties/:id/media', limiter({ max: 40 }), express.raw({ type: () => true, limit: '8mb' }), wrap(req => portal.addMedia(req.principal, req.params.id, {
    kind: req.headers['x-media-kind'], filename: decodeURIComponent(String(req.headers['x-filename'] || '')), contentType: String(req.headers['content-type'] || '').split(';')[0],
    bytes: req.body, visibility: req.headers['x-visibility'] || 'agency',
  })))
  owner.put('/properties/:id/media', express.json(), wrap(req => portal.arrangeMedia(req.principal, req.params.id, req.body || {})))
  owner.get('/media/:id', async (req, res) => {
    try {
      const f = await portal.mediaFile(req.principal, req.params.id)
      res.set('Content-Type', f.contentType)
      res.set('Content-Disposition', `inline; filename="${encodeURIComponent(f.filename)}"`)
      res.set('X-Content-Type-Options', 'nosniff')
      res.send(f.bytes)
    } catch (err) { send(res, err) }
  })
  owner.put('/properties/:id/rules', express.json({ limit: '64kb' }), wrap(req => portal.saveRules(req.principal, req.params.id, req.body && req.body.schedule)))
  owner.post('/properties/:id/rules/copy', express.json(), wrap(req => portal.copyRules(req.principal, req.params.id, (req.body || {}).propertyIds)))
  owner.put('/properties/:id/distribution', express.json(), wrap(req => portal.setDistribution(req.principal, req.params.id, req.body || {})))
  owner.get('/desk', wrap(req => portal.desk(req.principal, { days: req.query.days })))
  owner.post('/requests/:id/:action', express.json(), wrap(req => portal.ownerAct(req.principal, req.params.id, req.params.action, req.body || {})))
  owner.get('/share-links', wrap(req => portal.listShareLinks(req.principal)))
  owner.post('/share-links', express.json(), wrap(req => portal.createShareLink(req.principal, req.body || {})))
  owner.delete('/share-links/:id', wrap(req => portal.revokeShareLink(req.principal, req.params.id)))
  owner.get('/delegates', wrap(req => portal.listDelegates(req.principal)))
  owner.post('/delegates', express.json(), wrap(req => portal.createDelegate(req.principal, req.body || {})))
  owner.delete('/delegates/:id', wrap(req => portal.revokeDelegate(req.principal, req.params.id)))

  // ── agent-facing share link (no session, never edits the property) ──
  const share = express.Router()
  share.use(noStore)
  share.get('/request/:token', limiter({ max: 60 }), wrap(req => portal.requestStatus(req.params.token)))
  share.post('/request/:token/:action', limiter({ max: 20 }), express.json({ limit: '8kb' }), wrap(req => portal.requestAct(req.params.token, req.params.action, req.body || {})))
  share.get('/:token', limiter({ max: 60 }), wrap(req => portal.shareView(req.params.token)))
  share.post('/:token/requests', limiter({ max: 10 }), express.json({ limit: '8kb' }), wrap(req => portal.shareRequest(req.params.token, req.body || {})))

  // ── staff ──
  const staff = express.Router()
  staff.use(noStore)
  if (staffAuth) staff.use(staffAuth)
  staff.use(async (req, res, next) => {
    try {
      const id = req.agent && Number(req.agent.id)
      if (!id) return res.status(401).json({ error: 'Unauthorized' })
      const { rows: [a] } = await db.query(`SELECT id, role, active, feature_entitlements FROM agents WHERE id=$1`, [id])
      const ent = a && a.feature_entitlements && a.feature_entitlements.owner_portal === true
      if (!a || a.active === false || (a.role !== 'admin' && !ent)) return res.status(403).json({ error: 'Owner portal controls are limited to admins and entitled agents.' })
      req.staffId = a.id; next()
    } catch (err) { send(res, err) }
  })
  staff.get('/review/proposals', wrap(req => portal.listProposals({ state: req.query.state || 'pending' })))
  staff.post('/review/proposals/:id', express.json(), wrap(req => portal.reviewProposal({ id: Number(req.params.id), agentId: req.staffId, decision: (req.body || {}).decision, note: (req.body || {}).note })))
  staff.get('/:ownerId', wrap(req => portal.staffOverview(Number(req.params.ownerId))))
  staff.post('/:ownerId/invitation', express.json(), wrap(req => portal.inviteOwner({ ownerId: Number(req.params.ownerId), agentId: req.staffId, identityMethod: (req.body || {}).identityMethod, purpose: (req.body || {}).purpose })))
  staff.post('/:ownerId/invitation/revoke', wrap(req => portal.revokeInvitation({ ownerId: Number(req.params.ownerId), agentId: req.staffId })))
  staff.post('/:ownerId/sessions/revoke', wrap(req => portal.revokeSessions({ ownerId: Number(req.params.ownerId), agentId: req.staffId })))
  staff.post('/:ownerId/state', express.json(), wrap(req => portal.setAccountState({ ownerId: Number(req.params.ownerId), agentId: req.staffId, state: (req.body || {}).state })))
  staff.put('/:ownerId/pilot', express.json(), wrap(req => portal.setPilotState({ ownerId: Number(req.params.ownerId), agentId: req.staffId, state: (req.body || {}).state, note: (req.body || {}).note })))

  return { owner, share, staff, portal }
}
