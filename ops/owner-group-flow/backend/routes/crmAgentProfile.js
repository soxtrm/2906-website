'use strict'
// ============================================================================
// routes/crmAgentProfile.js — ARGUS AGENT LAYER, "First Deliverable" (Kev,
// 2026-09-16 spec section 26): one aggregate bundle the Agent Profile
// frontend renders from, built ENTIRELY from existing/real tables --
// agents (extended, not replaced), agent_notification_channels +
// agent_saved_searches (Notification Engine, already live), agent_activity_log
// (already existed), properties (listed_by_agent_id, already existed),
// scheduled_outreach_campaigns (already existed), agent_invoices/
// agent_contracts (new generator-shell tables, this pass). No fake parallel
// data store, per the spec's own explicit rule.
// ============================================================================
const express = require('express')
const router = express.Router()
const jwt = require('jsonwebtoken')
const multer = require('multer')
const cloudinary = require('cloudinary').v2
const fs = require('fs')
const path = require('path')
const db = require('../db')
const log = require('../logger')
const waha = require('../waha')

const JWT_SECRET = process.env.JWT_SECRET

// Same Cloudinary account/config routes/crm.js's property-photo upload
// already uses — one image pipeline, not a second one for profile photos.
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})
const UPLOAD_DIR = '/app/uploads'
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })
const photoUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_, file, cb) => cb(null, `agent-photo-${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_, file, cb) => file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Images only')),
})

async function auth(req, res, next) {
  const h = req.headers.authorization
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' })
  let payload
  try { payload = jwt.verify(h.slice(7), JWT_SECRET) } catch { return res.status(401).json({ error: 'Session invalid or expired' }) }
  try {
    const r = await db.query(`SELECT id, role, active FROM agents WHERE id = $1`, [payload.id])
    const row = r.rows[0]
    if (!row || !row.active) return res.status(401).json({ error: 'Account inactive' })
    req.agent = { id: row.id, role: row.role }
  } catch (e) {
    log.error('agent-profile auth lookup failed', { err: e.message })
    return res.status(500).json({ error: 'Auth check failed' })
  }
  next()
}

// Deterministic per-Agent WAHA session name (Agent Layer, section 1/8: "use
// existing naming convention or stable form such as agent_<user_id>... avoid
// random session names"). No `default` dependency anywhere in this file.
function agentSessionName(agentId) { return `agent_${agentId}` }

async function liveWhatsappState(sessionName) {
  const whatsapp = { status: 'OFFLINE', session: sessionName || null }
  if (!sessionName) return whatsapp
  try {
    const live = await waha.getSessionStatus(sessionName)
    const s = live && live.status
    whatsapp.status = s === 'WORKING' ? 'CONNECTED'
      : s === 'SCAN_QR_CODE' ? 'QR_REQUIRED'
      : (s === 'STARTING' || s === 'CONNECTING') ? 'CONNECTING'
      : s ? 'ERROR' : 'OFFLINE'
    whatsapp.phone = live && live.me && live.me.id ? live.me.id.replace(/@.*/, '') : null
  } catch (err) {
    log.warn('agent-profile: WA status check failed', { session: sessionName, err: err.message })
  }
  return whatsapp
}

// RBAC boundary (spec section 10): a non-admin may only ever load/edit their
// OWN profile. Enforced here, server-side, not left to the frontend to hide
// a button — the spec's own explicit rule.
function assertScope(req, res, targetId) {
  if (req.agent.role === 'admin') return true
  if (req.agent.id !== targetId) { res.status(403).json({ error: 'Not your profile' }); return false }
  return true
}

const PUBLIC_IDENTITY_FIELDS = `
  id, username, name, display_name, surname, email, whatsapp_phone, public_phone, address,
  vat_number, company_number, bank_iban, bank_account_name, profile_image_url, bio,
  languages, specialties, role, active, whatsapp_session, feature_entitlements, can_create_owner_group,
  invoice_settings, contract_settings, notifications_paused, created_at, updated_at`

// Financial fields masked for anyone but the owning agent/admin (spec
// section 3: "sensitive financial details should be appropriately masked").
function maskFinancials(row, canSeeFull) {
  if (canSeeFull) return row
  const masked = { ...row }
  if (masked.bank_iban) masked.bank_iban = masked.bank_iban.replace(/^(.{4}).+(.{4})$/, '$1 **** **** **** $2')
  return masked
}

router.get('/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!assertScope(req, res, id)) return
    const agentR = await db.query(`SELECT ${PUBLIC_IDENTITY_FIELDS} FROM agents WHERE id = $1`, [id])
    const agent = agentR.rows[0]
    if (!agent) return res.status(404).json({ error: 'Agent not found' })

    // WhatsApp connection — read the REAL live WAHA state for the session
    // already recorded on this agent, never inferred/guessed (spec section 8).
    const whatsapp = await liveWhatsappState(agent.whatsapp_session)

    // Notification Engine summary — reuses the SAME tables/route the
    // dedicated notification-engine API serves, read directly here to avoid
    // an internal HTTP round-trip for one bundled page load.
    const searchesR = await db.query(
      `SELECT s.*, (SELECT count(*) FROM saved_search_notifications n
                     WHERE n.saved_search_id = s.id AND n.first_sent_at::date = CURRENT_DATE) AS matches_today
         FROM agent_saved_searches s WHERE s.agent_id = $1 ORDER BY s.created_at DESC`, [id])
    const channelR = await db.query(
      `SELECT * FROM agent_notification_channels WHERE agent_id = $1 AND active = true ORDER BY created_at DESC LIMIT 1`, [id])

    // My Property Feeds — real counts from canonical property state, no
    // duplicate/derived property table (spec section 11).
    const feedsR = await db.query(
      `SELECT
         count(*) FILTER (WHERE listed_by_agent_id = $1 AND available_status IN ('available','available_confirmed')) AS my_active_listings,
         count(*) FILTER (WHERE listed_by_agent_id = $1) AS my_total_listings
       FROM properties`, [id])

    // Personal Outreach — minimal real read from the existing outreach
    // backend (scheduled_outreach_campaigns already has created_by_agent_id).
    // Full workspace wiring is the spec's own "second delivery" (section 27).
    const outreachR = await db.query(
      `SELECT status, count(*) AS n FROM scheduled_outreach_campaigns
        WHERE created_by_agent_id = $1 GROUP BY status`, [id]).catch(() => ({ rows: [] }))

    const activityR = await db.query(
      `SELECT action_type, target_ref, details, created_at
         FROM agent_activity_log WHERE actor_agent_id = $1
        ORDER BY created_at DESC LIMIT 20`, [id])

    const invoicesR = await db.query(
      `SELECT id, invoice_number, client_or_owner_name, property_ref, deal_ref, invoice_date, status,
              line_items, vat_enabled, vat_rate
         FROM agent_invoices WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 10`, [id])
    const contractsR = await db.query(
      `SELECT id, property_ref, owner_name, tenant_name, start_date, end_date, status
         FROM agent_contracts WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 10`, [id])
    const groupsR = await require('../services/ownerGroupRequests').getAgentHistory(id)

    const canSeeFull = req.agent.role === 'admin' || req.agent.id === id
    res.json({
      agent: maskFinancials(agent, canSeeFull),
      whatsapp,
      notificationEngine: { searches: searchesR.rows, channel: channelR.rows[0] || null },
      propertyFeeds: feedsR.rows[0],
      outreach: outreachR.rows,
      activity: activityR.rows,
      invoices: invoicesR.rows,
      contracts: contractsR.rows,
      ownerGroups: groupsR,
    })
  } catch (err) {
    log.error('agent-profile load failed', { err: err.message })
    res.status(500).json({ error: err.message })
  }
})

// ── POST /:id/photo — profile picture upload (multipart) ───────────────────
router.post('/:id/photo', auth, photoUpload.single('photo'), async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!assertScope(req, res, id)) return
    if (!req.file) return res.status(400).json({ error: 'No image provided' })
    let url
    try {
      const result = await cloudinary.uploader.upload(req.file.path, {
        folder: 'crm-agents',
        transformation: [{ width: 400, height: 400, crop: 'fill', gravity: 'face', quality: 'auto', fetch_format: 'auto' }],
      })
      url = result.secure_url
    } finally {
      fs.unlink(req.file.path, () => {})
    }
    const { rows } = await db.query(
      `UPDATE agents SET profile_image_url = $1, updated_at = NOW() WHERE id = $2 RETURNING ${PUBLIC_IDENTITY_FIELDS}`,
      [url, id])
    await db.query(
      `INSERT INTO agent_activity_log (actor_agent_id, actor_role, action_type)
         VALUES ($1, $2, 'PROFILE_PHOTO_UPDATED')`,
      [req.agent.id, req.agent.role])
    res.json(rows[0])
  } catch (err) {
    log.error('agent-profile photo upload failed', { err: err.message })
    res.status(500).json({ error: err.message })
  }
})

// ── WhatsApp self-serve connect (Agent Layer, Second Delivery §1-5) ─────────
// RBAC: assertScope already refuses anyone but the owning agent or an admin
// — Agent A can never reach Agent B's QR/session state through these routes,
// since the session name itself is derived from :id, never taken from the
// request body.

router.post('/:id/whatsapp/connect', auth, async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!assertScope(req, res, id)) return
    const agentR = await db.query(`SELECT whatsapp_session FROM agents WHERE id = $1`, [id])
    if (!agentR.rows[0]) return res.status(404).json({ error: 'Agent not found' })

    // Deterministic per-Agent name — created once, reused forever, never a
    // fresh random session (spec §1: "avoid duplicate sessions").
    const session = agentR.rows[0].whatsapp_session || agentSessionName(id)
    if (agentR.rows[0].whatsapp_session !== session) {
      await db.query(`UPDATE agents SET whatsapp_session = $1, updated_at = NOW() WHERE id = $2`, [session, id])
    }

    await waha.ensureAgentSession(session)
    const whatsapp = await liveWhatsappState(session)
    if (whatsapp.status === 'QR_REQUIRED') {
      try { whatsapp.qr = await waha.getQrImage(session) } catch (err) { log.warn('agent whatsapp connect: QR fetch failed', { session, err: err.message }) }
    }
    await db.query(
      `INSERT INTO agent_activity_log (actor_agent_id, actor_role, action_type, details)
         VALUES ($1,$2,'WA_SESSION_CREATED',$3)`,
      [req.agent.id, req.agent.role, JSON.stringify({ session })])
    res.json(whatsapp)
  } catch (err) {
    log.error('agent whatsapp connect failed', { err: err.message })
    res.status(500).json({ error: err.message })
  }
})

// Polled by the frontend every few seconds while QR_REQUIRED/CONNECTING —
// refreshes the QR image too, since WAHA's QR expires and rotates.
router.get('/:id/whatsapp/status', auth, async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!assertScope(req, res, id)) return
    const agentR = await db.query(`SELECT whatsapp_session FROM agents WHERE id = $1`, [id])
    if (!agentR.rows[0]) return res.status(404).json({ error: 'Agent not found' })
    const session = agentR.rows[0].whatsapp_session
    const whatsapp = await liveWhatsappState(session)
    if (whatsapp.status === 'QR_REQUIRED' && session) {
      try { whatsapp.qr = await waha.getQrImage(session) } catch { /* keep polling, QR just not ready yet */ }
    }
    if (whatsapp.status === 'CONNECTED') {
      // Log the transition once, not on every poll tick — cheap dedup via
      // "was the most recent WA_* log for this agent already a connect".
      const last = await db.query(
        `SELECT action_type FROM agent_activity_log WHERE actor_agent_id = $1 AND action_type IN ('WA_CONNECTED','WA_DISCONNECTED')
           ORDER BY created_at DESC LIMIT 1`, [id])
      if (!last.rows[0] || last.rows[0].action_type !== 'WA_CONNECTED') {
        await db.query(
          `INSERT INTO agent_activity_log (actor_agent_id, actor_role, action_type, details)
             VALUES ($1,'agent','WA_CONNECTED',$2)`,
          [id, JSON.stringify({ session, phone: whatsapp.phone })])
      }
    }
    res.json(whatsapp)
  } catch (err) {
    log.error('agent whatsapp status failed', { err: err.message })
    res.status(500).json({ error: err.message })
  }
})

router.post('/:id/whatsapp/disconnect', auth, async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!assertScope(req, res, id)) return
    const agentR = await db.query(`SELECT whatsapp_session FROM agents WHERE id = $1`, [id])
    const session = agentR.rows[0] && agentR.rows[0].whatsapp_session
    if (!session) return res.status(400).json({ error: 'No WhatsApp session to disconnect' })
    await waha.stopSession(session)
    await db.query(
      `INSERT INTO agent_activity_log (actor_agent_id, actor_role, action_type, details)
         VALUES ($1,$2,'WA_DISCONNECTED',$3)`,
      [req.agent.id, req.agent.role, JSON.stringify({ session })])
    res.json({ ok: true })
  } catch (err) {
    log.error('agent whatsapp disconnect failed', { err: err.message })
    res.status(500).json({ error: err.message })
  }
})

// Fields a non-admin agent may edit on themselves (spec section 3: "Agent
// may edit allowed personal fields. Admin may edit everything.").
// notifications_paused (Phase E, 2026-09-17): whole-channel master pause,
// separate from per-saved-search enabled state — see
// services/notificationEngine.js:loadEnabledSearches(), the single choke
// point every notification send is gated through.
const SELF_EDITABLE_FIELDS = ['name', 'surname', 'email', 'whatsapp_phone', 'address', 'profile_image_url', 'bio', 'languages', 'specialties', 'notifications_paused']
const ADMIN_ONLY_FIELDS = ['vat_number', 'company_number', 'bank_iban', 'bank_account_name', 'role', 'active', 'feature_entitlements', 'invoice_settings', 'contract_settings', 'can_create_owner_group']

router.patch('/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!assertScope(req, res, id)) return
    const isAdmin = req.agent.role === 'admin'
    const allowed = isAdmin ? [...SELF_EDITABLE_FIELDS, ...ADMIN_ONLY_FIELDS] : SELF_EDITABLE_FIELDS
    const body = req.body || {}
    const sets = []
    const params = []
    let i = 1
    for (const f of allowed) {
      if (body[f] === undefined) continue
      sets.push(`${f} = $${i++}`)
      params.push(Array.isArray(body[f]) || (f.endsWith('_entitlements') || f.endsWith('_settings')) ? JSON.stringify(body[f]) : body[f])
    }
    if (!sets.length) return res.status(400).json({ error: 'No editable fields provided' })
    params.push(id)
    sets.push('updated_at = NOW()')
    const { rows } = await db.query(
      `UPDATE agents SET ${sets.join(', ')} WHERE id = $${i} RETURNING ${PUBLIC_IDENTITY_FIELDS}`, params)
    await db.query(
      `INSERT INTO agent_activity_log (actor_agent_id, actor_role, action_type, details)
         VALUES ($1, $2, 'PROFILE_UPDATED', $3)`,
      [req.agent.id, req.agent.role, JSON.stringify({ fields: Object.keys(body).filter(f => allowed.includes(f)) })])
    res.json(rows[0])
  } catch (err) {
    log.error('agent-profile update failed', { err: err.message })
    res.status(500).json({ error: err.message })
  }
})

// ── Invoice Creator shell (spec sections 14-15, 23: generator shell only) ──
router.get('/:id/invoices', auth, async (req, res) => {
  const id = Number(req.params.id)
  if (!assertScope(req, res, id)) return
  const { rows } = await db.query(`SELECT * FROM agent_invoices WHERE agent_id = $1 ORDER BY created_at DESC`, [id])
  res.json(rows)
})

router.post('/:id/invoices', auth, async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!assertScope(req, res, id)) return
    const b = req.body || {}
    const { rows } = await db.query(
      `INSERT INTO agent_invoices (agent_id, invoice_number, property_id, property_ref, deal_ref,
         client_or_owner_name, billing_address, billing_company_number, billing_vat_number,
         invoice_date, reference, line_items, vat_enabled, vat_rate, notes, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10, CURRENT_DATE),$11,$12,$13,$14,$15,COALESCE($16,'draft'))
       RETURNING *`,
      [id, b.invoice_number || null, b.property_id || null, b.property_ref || null, b.deal_ref || null,
       b.client_or_owner_name || null, b.billing_address || null, b.billing_company_number || null, b.billing_vat_number || null,
       b.invoice_date || null, b.reference || null, JSON.stringify(b.line_items || []), !!b.vat_enabled, b.vat_rate || 0,
       b.notes || null, b.status || null])
    await db.query(
      `INSERT INTO agent_activity_log (actor_agent_id, actor_role, action_type, target_ref, details)
         VALUES ($1,$2,'INVOICE_GENERATED',$3,$4)`,
      [req.agent.id, req.agent.role, b.property_ref || null, JSON.stringify({ invoiceId: rows[0].id })])
    res.json(rows[0])
  } catch (err) {
    log.error('agent-profile invoice create failed', { err: err.message })
    res.status(500).json({ error: err.message })
  }
})

// ── Contract Creator shell (spec section 16) ────────────────────────────────
router.get('/:id/contracts', auth, async (req, res) => {
  const id = Number(req.params.id)
  if (!assertScope(req, res, id)) return
  const { rows } = await db.query(`SELECT * FROM agent_contracts WHERE agent_id = $1 ORDER BY created_at DESC`, [id])
  res.json(rows)
})

router.post('/:id/contracts', auth, async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!assertScope(req, res, id)) return
    const b = req.body || {}
    const { rows } = await db.query(
      `INSERT INTO agent_contracts (agent_id, property_id, property_ref, owner_name, tenant_name,
         start_date, end_date, rent, deposit, occupants, pets_allowed, special_clauses, extra_fields, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,COALESCE($14,'draft'))
       RETURNING *`,
      [id, b.property_id || null, b.property_ref || null, b.owner_name || null, b.tenant_name || null,
       b.start_date || null, b.end_date || null, b.rent || null, b.deposit || null, b.occupants || null,
       typeof b.pets_allowed === 'boolean' ? b.pets_allowed : null, b.special_clauses || null,
       JSON.stringify(b.extra_fields || {}), b.status || null])
    await db.query(
      `INSERT INTO agent_activity_log (actor_agent_id, actor_role, action_type, target_ref, details)
         VALUES ($1,$2,'CONTRACT_GENERATED',$3,$4)`,
      [req.agent.id, req.agent.role, b.property_ref || null, JSON.stringify({ contractId: rows[0].id })])
    res.json(rows[0])
  } catch (err) {
    log.error('agent-profile contract create failed', { err: err.message })
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
