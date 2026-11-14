'use strict'
// ============================================================================
// routes/facebookPagesMeta.js — the two callbacks Meta itself calls.
// Mounted at /api/facebook-pages-meta (no ARGUS login: Meta is the caller).
// Both verify Meta's signed_request (HMAC-SHA256 with the app secret) and
// refuse anything else.
//   POST /data-deletion   Meta "User Data Deletion" callback → disconnect and
//                         delete every credential held for that Facebook user;
//                         returns { url, confirmation_code } as Meta requires.
//   POST /deauthorize     the person removed the app on Facebook → same cleanup.
//   GET  /data-deletion/:code  status for the confirmation page.
// ============================================================================
const express = require('express')
const crypto = require('crypto')
const db = require('../db')
const log = require('../logger')
const settings = require('../services/facebookPages/settings')
const connect = require('../services/facebookPages/connect')

const router = express.Router()
router.use(express.urlencoded({ extended: false, limit: '16kb' }))
router.use(express.json({ limit: '16kb' }))

const b64url = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')

function parseSignedRequest(signed) {
  const { appSecret } = settings.read()
  if (!appSecret || typeof signed !== 'string' || !signed.includes('.')) return null
  const [sig, payload] = signed.split('.', 2)
  const expected = crypto.createHmac('sha256', appSecret).update(payload).digest()
  const got = b64url(sig)
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null
  let data
  try { data = JSON.parse(b64url(payload).toString('utf8')) } catch { return null }
  if (!data || String(data.algorithm || '').toUpperCase() !== 'HMAC-SHA256' || !data.user_id) return null
  return data
}

async function handle(req, res, kind) {
  const data = parseSignedRequest(req.body && req.body.signed_request)
  if (!data) return res.status(400).json({ error: 'invalid signed_request' })
  try {
    const n = await connect.forgetFacebookUser(String(data.user_id))
    const code = crypto.randomBytes(12).toString('hex')
    await db.query(
      `INSERT INTO agent_facebook_deletion_requests (confirmation_code, fb_user_id, connections, status, completed_at) VALUES ($1,$2,$3,'completed',NOW())`,
      [code, String(data.user_id), n])
    log.info('facebook-pages: meta callback processed', { kind, connections: n })
    if (kind === 'deauthorize') return res.json({ ok: true })
    const base = settings.read().deletionStatusUrl
    return res.json({ url: `${base}?code=${code}`, confirmation_code: code })
  } catch (e) {
    log.error('facebook-pages: meta callback failed', { kind, err: e.message })
    return res.status(500).json({ error: 'temporarily unavailable' })
  }
}

router.post('/data-deletion', (req, res) => handle(req, res, 'deletion'))
router.post('/deauthorize', (req, res) => handle(req, res, 'deauthorize'))
router.get('/data-deletion/:code', async (req, res) => {
  if (!/^[0-9a-f]{24}$/.test(req.params.code)) return res.status(404).json({ error: 'not found' })
  const { rows: [r] } = await db.query(`SELECT status, created_at, completed_at FROM agent_facebook_deletion_requests WHERE confirmation_code=$1`, [req.params.code])
  if (!r) return res.status(404).json({ error: 'not found' })
  res.set('Cache-Control', 'no-store').json({ status: r.status, receivedAt: r.created_at, completedAt: r.completed_at })
})

module.exports = router
module.exports.parseSignedRequest = parseSignedRequest
