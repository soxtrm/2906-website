'use strict'
// ============================================================================
// 2906 Agent CRM — Phase 1 API router  (mounted at /api/crm)
// Self-contained & additive. Touches NO operational code (AutoAdvertise,
// outreach, labels, posting, AV Capture, Reminder, WhatsApp commands).
// Reads/writes: agents, properties, owner_contacts, property_activities,
// pii_reveal_log only.
// ============================================================================
const { Router } = require('express')
const jwt        = require('jsonwebtoken')
const bcrypt     = require('bcryptjs')
const multer     = require('multer')
const path       = require('path')
const fs         = require('fs')
const cloudinary = require('cloudinary').v2
const cron       = require('node-cron')
const rateLimit  = require('express-rate-limit')
const db         = require('../db')
const log        = require('../logger')

// Login rate limiter (multi-agent hardening pass, 2026-09-17) — same shape
// as routes/adminWeb.js's own loginLimiter. This router's /login had none
// at all: unmitigated credential brute-force against every real Agent
// account, found in the security audit this pass ran.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
})
// Owner Profile V2 (Kev, 2026-09-07): reused verbatim from OWNERGROUPS, not
// reimplemented — the whole point of this redesign is consolidating what
// already exists (preference extraction, the `!o` automation state machine,
// scheduled outreach) into one owner-identity-keyed view, not a second copy
// of any of it.
const ownerAssistant        = require('../services/ownerAssistant')
const ownerPreferenceProfile = require('../services/ownerPreferenceProfile')
const scheduledOutreach     = require('../services/scheduledOutreach')

// Security audit finding (2026-09-17): a hardcoded fallback secret shipped
// in source is a real risk the moment the env var is ever unset in any
// deployment — confirmed JWT_SECRET IS set in production today (verified
// live before this change), so failing loudly instead of silently falling
// back to a known string changes nothing for the running system.
if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not set — refusing to start with an insecure default')
const JWT_SECRET = process.env.JWT_SECRET
const COOKIE_DAYS = 30
const REVEAL_SECONDS = 60

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

const UPLOAD_DIR = '/app/uploads'
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase()
      cb(null, `crm-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`)
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 12 },
  fileFilter: (_, file, cb) =>
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Images only')),
})

// Owner Profile V2 (2026-09-07): guard against the Vertex AI classification
// job's own error text leaking into owner_contacts.conversation_summary —
// see the call site in GET /owners/:id for the full story. A real summary
// is prose about the owner/conversation; these are the literal signatures
// of the ClientError JSON that job dumps into the column on every 403.
const BROKEN_SUMMARY_RE = /ClientError|Classification error|PERMISSION_DENIED|"code":\s*40[13]/i
function looksLikeRealSummary(text) {
  const s = String(text || '').trim()
  return !!s && !BROKEN_SUMMARY_RE.test(s)
}

// Owner Profile V2 (2026-09-08): same class of bug as looksLikeRealSummary
// above, different field and different writer. owner_contacts.last_reply_quote
// is meant to hold something the OWNER said; found one row (a test fixture,
// +35679212035) holding services/autoOwnerConversation.js's own internal
// admin-escalation text verbatim ("⚠️ Auto-Owner-Conversation — N separate
// properties captured (+phone). [{...raw entity JSON...}]") — notifyAdminEscalation()
// only ever calls waha.sendText to config.admin.botNumber, so this can only
// have reached last_reply_quote through some other "last message in this
// chat" writer treating an outbound admin notification as if it were the
// owner's own reply. Root cause not chased further (isolated to one test
// row, not reproduced on any real owner) — guarded at the read site instead,
// same proportionate fix as the summary guard above.
const BROKEN_REPLY_QUOTE_RE = /Auto-Owner-Conversation\s*—|^\s*\[\s*\{"/
function looksLikeRealReplyQuote(text) {
  const s = String(text || '').trim()
  return !!s && !BROKEN_REPLY_QUOTE_RE.test(s)
}

// Owner Profile V2 documents (contracts/invoices/id scans/…) — any file
// type unlike `upload` above, memory storage since these go straight to
// Cloudinary and never need a local temp file. Mirrors
// routes/crmOwnergroups.js's own docUpload verbatim (same 20MB/5-file caps)
// so an owner document behaves identically whichever route wrote it.
const docUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 5 } })
async function uploadDocBuffer(buffer, mimeType, filename) {
  const res = await cloudinary.uploader.upload(`data:${mimeType};base64,${buffer.toString('base64')}`, {
    folder: '2906-owner-documents',
    resource_type: 'auto',
    filename_override: filename,
    use_filename: true,
  })
  return res.secure_url
}

const router = Router()

// ── helpers ─────────────────────────────────────────────────────────────────
const digits = (s) => String(s || '').replace(/\D/g, '')

function maskPhone(p) {
  const d = digits(p)
  if (!d) return null
  // e.g. +356 99•• ••60   (country code + 2 + last 2 visible)
  return `+${d.slice(0, 3)} ${d.slice(3, 5)}•• ••${d.slice(-2)}`
}
function maskEmail(e) {
  if (!e) return null
  const [u, dom] = String(e).split('@')
  if (!dom) return '••'
  return `${u.slice(0, 2)}••@${dom}`
}
function clientIp(req) {
  const xff = req.headers['x-forwarded-for']
  if (xff) return String(xff).split(',')[0].trim()
  return req.headers['x-real-ip'] || req.ip || req.socket?.remoteAddress || null
}

// ── auth middleware ───────────────────────────────────────────────────────────
// Tokens carry an audience: 'crm' for staff, 'board' for whitelisted
// board-only agents. THIS router serves owner data (owners, reveal, property
// detail), so a 'board' token is refused here — that is the whole point of the
// split. Tokens issued before the audience existed have no `aud` and are
// treated as 'crm' so nobody is logged out mid-session; they expire on their
// own within COOKIE_DAYS.
function auth(req, res, next) {
  const h = req.headers.authorization
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' })
  let payload
  try {
    payload = jwt.verify(h.slice(7), JWT_SECRET)
  } catch {
    return res.status(401).json({ error: 'Session invalid or expired' })
  }
  if (payload.aud === 'board') {
    return res.status(403).json({ error: 'Board account — no access to CRM data.' })
  }
  req.agent = payload
  db.query(
    `UPDATE agents SET last_active_at = NOW()
      WHERE id = $1
        AND (last_active_at IS NULL OR last_active_at < NOW() - INTERVAL '5 minutes')`,
    [payload.id]).catch(err => log.warn('crm activity touch failed', { agentId: payload.id, err: err.message }))
  next()
}
function adminOnly(req, res, next) {
  if (req.agent?.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  next()
}

// Fetch a live agent row by id (role/limit may change after token issued).
async function liveAgent(id) {
  const r = await db.query(
    `SELECT id, username, email, name, role, active, board_access, daily_reveal_limit,
            can_create_owner_group FROM agents WHERE id=$1`, [id])
  return r.rows[0] || null
}
async function revealsToday(agentId) {
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM pii_reveal_log WHERE agent_id=$1 AND revealed_at::date = CURRENT_DATE`,
    [agentId])
  return r.rows[0].n
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
// POST /api/crm/login  { emailOrUsername, password }  -> { token, agent }
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { emailOrUsername, password } = req.body || {}
    if (!emailOrUsername || !password) return res.status(400).json({ error: 'Missing credentials' })
    const r = await db.query(
      `SELECT * FROM agents WHERE (LOWER(email)=LOWER($1) OR LOWER(username)=LOWER($1)) AND active=TRUE`,
      [String(emailOrUsername).trim()])
    const a = r.rows[0]
    if (!a || !a.password_hash) {
      // Security audit finding (2026-09-17): login failures were previously
      // invisible — no log, no audit row, nothing to alert on. Never logs
      // the password itself, only the attempted identifier.
      db.query(
        `INSERT INTO agent_activity_log (actor_agent_id, action_type, details) VALUES (NULL, 'LOGIN_FAILED', $1)`,
        [JSON.stringify({ attempted: String(emailOrUsername).trim(), reason: 'unknown_account' })])
        .catch(err => log.warn('login-failure audit insert failed', { err: err.message }))
      return res.status(401).json({ error: 'Invalid login' })
    }
    const ok = await bcrypt.compare(password, a.password_hash)
    if (!ok) {
      db.query(
        `INSERT INTO agent_activity_log (actor_agent_id, actor_role, actor_display_name, action_type, details) VALUES ($1,$2,$3,'LOGIN_FAILED',$4)`,
        [a.id, a.role, a.name || a.username, JSON.stringify({ reason: 'wrong_password' })])
        .catch(err => log.warn('login-failure audit insert failed', { err: err.message }))
      return res.status(401).json({ error: 'Invalid login' })
    }
    await db.query(`UPDATE agents SET last_login_at=NOW(), last_active_at=NOW() WHERE id=$1`, [a.id])
    // role 'board' = whitelisted board-only agent. Their token is stamped
    // 'board' and is refused by this router's auth(); only the schedule-board
    // router accepts it. Everyone else gets 'crm', which reaches both.
    const aud = a.role === 'board' ? 'board' : 'crm'
    const token = jwt.sign(
      { id: a.id, username: a.username, role: a.role, name: a.name || a.display_name, aud },
      JWT_SECRET, { expiresIn: `${COOKIE_DAYS}d` })
    res.json({
      token,
      agent: { id: a.id, username: a.username, email: a.email, name: a.name || a.display_name,
               role: a.role, board_access: a.board_access, daily_reveal_limit: a.daily_reveal_limit,
               can_create_owner_group: a.can_create_owner_group },
    })
  } catch (err) {
    log.error('crm/login error', err)
    res.status(500).json({ error: 'Login failed' })
  }
})

// GET /api/crm/me -> agent + today's reveal count (for sidebar counter)
router.get('/me', auth, async (req, res) => {
  try {
    const a = await liveAgent(req.agent.id)
    if (!a || !a.active) return res.status(401).json({ error: 'Account inactive' })
    const used = await revealsToday(a.id)
    res.json({ agent: a, reveals: { used, limit: a.daily_reveal_limit } })
  } catch (err) {
    log.error('crm/me error', err)
    res.status(500).json({ error: 'Failed' })
  }
})

// POST /api/crm/admin/set-password  (admin only) { agent_id|username|email, password }
router.post('/admin/set-password', auth, adminOnly, async (req, res) => {
  try {
    const { agent_id, username, email, password } = req.body || {}
    if (!password || String(password).length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' })
    const hash = await bcrypt.hash(String(password), 10)
    const r = await db.query(
      `UPDATE agents SET password_hash=$1
        WHERE id = $2 OR LOWER(username)=LOWER($3) OR LOWER(email)=LOWER($4)
        RETURNING id, username, email, role`,
      [hash, agent_id || null, username || null, email || null])
    if (!r.rows.length) return res.status(404).json({ error: 'Agent not found' })
    res.json({ ok: true, updated: r.rows })
  } catch (err) {
    log.error('crm/set-password error', err)
    res.status(500).json({ error: 'Failed' })
  }
})

// GET /api/crm/admin/ml-learning  (admin only)
// Kev, 2026-09-10: "the learning system feels like a blackbox — it collects
// data silently, but nobody sees what it actually learned." Read-only,
// human-readable window onto STYLE-1's four tables (services/styleLearning.js)
// — real counts, plain-text examples (never raw JSON), and anything sitting
// in the approval queue surfaced here instead of only in the DB.
router.get('/admin/ml-learning', auth, adminOnly, async (req, res) => {
  try {
    const [counts, pendingStyle, pendingPhrasing, recentStyle, recentPhrasing, recentOwnerLog, recentClientLog] = await Promise.all([
      db.query(`SELECT
        (SELECT COUNT(*) FROM style_examples) AS style_total,
        (SELECT COUNT(*) FROM style_examples WHERE approved = TRUE) AS style_approved,
        (SELECT COUNT(*) FROM style_examples WHERE approved IS NULL) AS style_pending,
        (SELECT COUNT(*) FROM phrasing_variants) AS phrasing_total,
        (SELECT COUNT(*) FROM phrasing_variants WHERE approved = TRUE) AS phrasing_approved,
        (SELECT COUNT(*) FROM phrasing_variants WHERE approved IS NULL) AS phrasing_pending,
        (SELECT COUNT(*) FROM owner_takeover_learning_log) AS owner_log_total,
        (SELECT COUNT(*) FROM client_takeover_learning_log) AS client_log_total
      `),
      db.query(`SELECT id, source, session, chat_id, text, created_at FROM style_examples WHERE approved IS NULL ORDER BY created_at DESC LIMIT 25`),
      db.query(`SELECT id, purpose, text, source, created_at FROM phrasing_variants WHERE approved IS NULL ORDER BY created_at DESC LIMIT 25`),
      db.query(`SELECT id, source, session, text, approved, created_at FROM style_examples ORDER BY created_at DESC LIMIT 15`),
      db.query(`SELECT id, purpose, text, approved, created_at FROM phrasing_variants ORDER BY created_at DESC LIMIT 15`),
      db.query(`SELECT id, phone, direction, text, created_at FROM owner_takeover_learning_log ORDER BY created_at DESC LIMIT 15`),
      db.query(`SELECT id, chat_id, direction, text, created_at FROM client_takeover_learning_log ORDER BY created_at DESC LIMIT 15`),
    ])
    const c = counts.rows[0]
    res.json({
      summary: [
        { system: 'Owner-Chat Style Examples', table: 'style_examples', total: Number(c.style_total), approved: Number(c.style_approved), pending: Number(c.style_pending) },
        { system: 'Phrasing Variants', table: 'phrasing_variants', total: Number(c.phrasing_total), approved: Number(c.phrasing_approved), pending: Number(c.phrasing_pending) },
        { system: 'Owner Human-Takeover Log', table: 'owner_takeover_learning_log', total: Number(c.owner_log_total) },
        { system: 'Client Human-Takeover Log', table: 'client_takeover_learning_log', total: Number(c.client_log_total) },
      ],
      pendingApprovals: [
        ...pendingStyle.rows.map(r => ({ ...r, kind: 'style_example' })),
        ...pendingPhrasing.rows.map(r => ({ ...r, kind: 'phrasing_variant' })),
      ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)),
      recent: {
        style_examples: recentStyle.rows,
        phrasing_variants: recentPhrasing.rows,
        owner_takeover_learning_log: recentOwnerLog.rows,
        client_takeover_learning_log: recentClientLog.rows,
      },
    })
  } catch (err) {
    log.error('crm/admin/ml-learning error', err)
    res.status(500).json({ error: 'Failed to load ML learning overview' })
  }
})

// Central correction ledger: one measurable source for property, owner,
// client and outreach decisions. The legacy style tables above remain intact.
router.get('/admin/learning-ledger', auth, adminOnly, async (req, res) => {
  try {
    const learningLedger = require('../services/learningLedger')
    res.json(await learningLedger.dashboard(req.query.days))
  } catch (err) {
    log.error('crm/admin/learning-ledger error', err)
    res.status(500).json({ error: 'Failed to load learning ledger' })
  }
})

// GET /api/crm/admin/agent-chats  (admin only)
// Kev, 2026-09-15: cross-agent overview of running Board-chat conversations
// — same services/bookRelay.js engine the per-agent chat window (this same
// file, /listings/:ref/relay above) and the WhatsApp !chat command
// (handlers/chat.js) already use, just not scoped to one agent_id. So Kev/
// Olga don't have to open every agent's own chat window one by one.
//
// "Full detail" here means real AGENT identity and real message text — it
// deliberately does NOT mean real OWNER identity. The owner label is
// anonymized the same way services/bookRelay.js's own getBoardSnapshot()
// already anonymizes it for the per-agent chat window (that IS this
// feature's "milchglas" precedent — services/bookRelay.js
// getOtherOwnerActivity()/anonOwnerLabel(), inspected before building this:
// existence/kind/time only, never identity, is the whole firewall point of
// this relay system). Keyed by owner_id here (not thread_id, like the
// per-agent window) so the SAME owner shows the SAME label across every
// thread — an admin overview's actual job is catching two agents both
// working the same owner, which a thread-keyed label would hide.
//
// No blurred/milchglas view for non-admins: adminOnly below refuses the
// whole route, so a non-admin gets nothing rather than a partial view —
// the safer of the two options Kev's spec left open, and the simpler one
// to get right on a first pass.
function anonOwnerLabelByOwnerId(ownerId) {
  const n = 1000 + (Number(ownerId || 0) * 47) % 8999
  return `Owner ${n}`
}
router.get('/admin/agent-chats', auth, adminOnly, async (req, res) => {
  try {
    const rows = (await db.query(
      `SELECT t.id, t.ref, t.property_id, t.agent_id, t.owner_id, t.status, t.created_at, t.updated_at,
              a.name AS agent_name, a.username AS agent_username,
              p.town, p.bedrooms, p.longlet_price, p.sale_price,
              p.public_payload->'images'->>0 AS image_url
         FROM book_relay_threads t
         LEFT JOIN agents a ON a.id = t.agent_id
         LEFT JOIN properties p ON p.id = t.property_id
        WHERE t.updated_at > NOW() - INTERVAL '14 days'
        ORDER BY t.updated_at DESC
        LIMIT 150`)).rows
    if (!rows.length) return res.json({ chats: [] })

    const bookRelay = require('../services/bookRelay')
    const ids = rows.map(r => r.id)
    const msgRows = (await db.query(
      `SELECT thread_id, direction, body, created_at
         FROM book_relay_messages
        WHERE thread_id = ANY($1::int[])
        ORDER BY thread_id, created_at`, [ids])).rows
    const byThread = {}
    for (const m of msgRows) (byThread[m.thread_id] ||= []).push(m)

    const chats = rows.map(r => {
      const privateDeviceChat = String(r.agent_username || '').toLowerCase() === 'kev'
        || String(r.agent_name || '').toLowerCase() === 'kevin'
      return ({
      threadId: r.id, ref: r.ref, status: r.status,
      agentId: r.agent_id, agentName: r.agent_name || r.agent_username || (r.agent_id ? `Agent ${r.agent_id}` : 'Unknown agent'),
      ownerLabel: anonOwnerLabelByOwnerId(r.owner_id),
      town: r.town, beds: r.bedrooms, price: r.longlet_price || r.sale_price, image: r.image_url,
      createdAt: r.created_at, updatedAt: r.updated_at,
      privateDeviceChat,
      messages: (byThread[r.id] || []).map(m => ({
        direction: m.direction,
        // owner_to_agent bodies masked exactly like the per-agent chat
        // window — an owner typing their own number into a reply must not
        // reach an admin screen any more than an agent's.
        text: privateDeviceChat ? '' : (m.direction === 'owner_to_agent' ? bookRelay.maskPhonesForDisplay(m.body) : m.body),
        redacted: privateDeviceChat,
        at: m.created_at,
      })),
    })})
    res.json({ chats })
  } catch (err) {
    log.error('crm/admin/agent-chats error', err)
    res.status(500).json({ error: 'Failed to load agent chats' })
  }
})

// ── ARGUS / NEON — Multi-Account Outreach Planner (Kev, 2026-09-11) ─────────
// Admin-only: this exposes bulk scheduled outreach across every WhatsApp
// account. All business logic lives in services/outreachPlanner.js, which
// itself only ORCHESTRATES the existing, already-hardened engines
// (listBuilder.buildPoolBatch, adminCommands.runDirectOutreach) — these
// routes are a thin, request/response wrapper, same principle as every
// other route in this file.
const outreachPlanner = require('../services/outreachPlanner')
const ownerRecheck = require('../services/ownerRecheck')

router.get('/outreach/accounts', auth, adminOnly, async (req, res) => {
  try {
    res.json({ accounts: await outreachPlanner.listAccounts() })
  } catch (err) {
    log.error('crm/outreach/accounts error', err)
    res.status(500).json({ error: 'Failed to load accounts' })
  }
})

// Register an outreach identity; connection is verified separately by WAHA.
router.post('/outreach/accounts', auth, adminOnly, async (req,res) => {
  const session=String(req.body.sessionName||'').trim(), label=String(req.body.label||'').trim();
  const phone=String(req.body.phone||'').replace(/\D/g,'');
  if(!/^[A-Za-z0-9_-]{2,40}$/.test(session)||!label||label.length>80||!/^\d{8,15}$/.test(phone)) return res.status(400).json({error:'Enter a session name, label and international phone number.'});
  if(/^argus[_-]?1$/i.test(session)) return res.status(400).json({error:'Argus 1 is the system manager.'});
  try {
    const existing=await db.query("SELECT id FROM whatsapp_accounts WHERE lower(session_name)=lower($1) OR regexp_replace(phone,'[^0-9]','','g')=$2",[session,phone]);
    if(existing.rows.length)return res.status(409).json({error:'This session or phone is already registered.'});
    const result=await db.query(`
      WITH pool_counts AS (
        SELECT COUNT(*) FILTER (WHERE pool='top')::int AS top_count,
               COUNT(*) FILTER (WHERE pool='bottom')::int AS bottom_count
          FROM whatsapp_accounts
         WHERE is_active=TRUE AND outreach_enabled=TRUE
           AND session_name !~* '^argus[_-]?1$'
      )
      INSERT INTO whatsapp_accounts
        (session_name,phone,label,is_active,outreach_enabled,is_kev_account,account_persona,pool,daily_outreach_limit)
      SELECT $1,$2,$3,true,true,true,'kev',
             CASE
               WHEN $1 ~* '^argus[_-]?[2-9][0-9]*$' THEN 'bottom'
               WHEN top_count <= bottom_count THEN 'top'
               ELSE 'bottom'
             END,10
        FROM pool_counts
      RETURNING id`,[session,phone,label]);
    res.status(201).json({ok:true,id:result.rows[0].id,connectionRequired:true});
  } catch(e) {log.error('outreach account registration failed',{error:e.message});res.status(500).json({error:'Could not register account.'});}
})

router.post('/outreach/accounts/:accountId/volume', auth, adminOnly, async (req, res) => {
  try {
    const accountId = parseInt(req.params.accountId)
    if (!accountId) return res.status(400).json({ error: 'valid accountId required' })
    const percent = Number(req.body?.percent)
    if (!Number.isFinite(percent) || percent < 10 || percent > 100) {
      return res.status(400).json({ error: 'percent must be between 10 and 100' })
    }
    const days = req.body?.days == null ? null : Number(req.body.days)
    const account = await outreachPlanner.setAccountVolume(accountId, percent, days)
    res.json({ ok: true, account })
  } catch (err) {
    log.error('crm/outreach/account-volume error', err)
    res.status(500).json({ error: 'Failed to update account volume' })
  }
})

router.post('/outreach/accounts/:accountId/restriction', auth, adminOnly, async (req, res) => {
  try {
    const accountId = Number.parseInt(req.params.accountId, 10)
    if (!accountId) return res.status(400).json({ error: 'valid accountId required' })
    const restricted = req.body?.restricted !== false
    const hours = req.body?.hours == null ? 40 : Number(req.body.hours)
    if (restricted && (!Number.isFinite(hours) || hours < 24 || hours > 168)) {
      return res.status(400).json({ error: 'hours must be between 24 and 168' })
    }
    const account = await outreachPlanner.setAccountRestriction(accountId, {
      restricted,
      hours,
      reason: String(req.body?.reason || (restricted ? 'manual_restriction' : 'manual_clear')).slice(0, 240),
      actor: req.agent?.username || 'admin',
    })
    res.json({ ok: true, account })
  } catch (err) {
    log.error('crm/outreach/account-restriction error', err)
    res.status(500).json({ error: 'Failed to update account restriction' })
  }
})

router.post('/outreach/accounts/:accountId/auto-prepare', auth, adminOnly, async (req, res) => {
  try {
    const accountId = Number.parseInt(req.params.accountId, 10)
    if (!accountId) return res.status(400).json({ error: 'valid accountId required' })
    const baseCount = req.body?.baseCount == null ? null : Number(req.body.baseCount)
    if (baseCount != null && (!Number.isFinite(baseCount) || baseCount < 1 || baseCount > 45)) {
      return res.status(400).json({ error: 'baseCount must be between 1 and 45' })
    }
    const message = req.body?.message == null ? null : String(req.body.message).slice(0, 2000)
    const validLabels = new Set(['TODAY', 'TOMORROW', 'IN_2_DAYS', 'IN_3_DAYS', 'IN_4_DAYS'])
    const labels = req.body?.labels == null ? null : req.body.labels
    if (labels != null && (!Array.isArray(labels) || labels.length === 0 || labels.some(label => !validLabels.has(String(label))))) {
      return res.status(400).json({ error: 'labels must contain valid outreach day labels' })
    }
    const result = await outreachPlanner.autoPrepareAccount(accountId, {
      baseCount,
      message,
      labels,
      actor: req.agent?.username || 'admin',
    })
    res.json(result)
  } catch (err) {
    log.error('crm/outreach/account-auto-prepare error', err)
    const status = ['account_restricted', 'system_manager_not_outreach'].includes(err.code) ? 409 : 500
    res.status(status).json({ error: err.message || 'Failed to auto-prepare account', code: err.code || null })
  }
})

router.get('/outreach/due-reminders', auth, adminOnly, async (req, res) => {
  try {
    const rows = (await db.query(
      `SELECT id, owner_name,
              right(regexp_replace(COALESCE(owner_phone,''), '\\D', '', 'g'), 4) AS phone_last4,
              left(COALESCE(original_note,''), 180) AS note,
              contact_due_date, contact_classification, auto_send_status,
              auto_send_block_reason, assigned_session, auto_send_for
         FROM reminders
        WHERE status = 'pending'
          AND contact_due_date <= CURRENT_DATE
        ORDER BY
          CASE auto_send_status WHEN 'queued' THEN 0 WHEN 'sending' THEN 1 WHEN 'blocked' THEN 2 ELSE 3 END,
          auto_send_for NULLS LAST, contact_due_date, id
        LIMIT 500`)).rows
    const perAccount = (await db.query(
      `SELECT COALESCE(assigned_session, 'Unassigned') AS session_name,
              auto_send_status, COUNT(*)::int AS count
         FROM reminders
        WHERE status = 'pending' AND contact_due_date <= CURRENT_DATE
        GROUP BY assigned_session, auto_send_status
        ORDER BY session_name, auto_send_status`)).rows
    res.json({ rows, perAccount })
  } catch (err) {
    log.error('crm/outreach/due-reminders error', err)
    res.status(500).json({ error: 'Failed to load due reminders' })
  }
})

router.get('/outreach/owner-recheck', auth, adminOnly, async (req, res) => {
  try {
    const state = req.query.state ? String(req.query.state).toUpperCase() : null
    const allowed = new Set(['DECISION_REQUIRED', 'WAITING_FOR_DATE', 'AUTO_RESOLVED', 'AUTOMATION_BLOCKED', 'APPROVED'])
    if (state && !allowed.has(state)) return res.status(400).json({ error: 'invalid state' })
    const [tasks, mode] = await Promise.all([
      ownerRecheck.listTasks({ state, limit: 500 }),
      require('../services/ownerSendGate').getAutomationMode(),
    ])
    res.json({ mode, tasks })
  } catch (err) {
    log.error('crm/outreach/owner-recheck error', err)
    res.status(500).json({ error: 'Failed to load owner rechecks' })
  }
})

router.post('/outreach/owner-recheck/run', auth, adminOnly, async (req, res) => {
  try {
    res.json({ ok: true, result: await ownerRecheck.recheckDueReminders({ limit: 500 }) })
  } catch (err) {
    log.error('crm/outreach/owner-recheck/run error', err)
    res.status(500).json({ error: 'Owner recheck failed' })
  }
})

router.post('/outreach/owner-recheck/:id/action', auth, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'valid task id required' })
    const action = String(req.body?.action || '')
    const task = await ownerRecheck.actOnTask({
      id,
      action,
      until: req.body?.until || null,
      propertyId: req.body?.propertyId == null ? null : Number(req.body.propertyId),
      message: req.body?.message || null,
      actor: req.agent?.username || 'admin',
    })
    if (!task) return res.status(404).json({ error: 'Owner recheck task not found' })
    res.json({ ok: true, task })
  } catch (err) {
    log.error('crm/outreach/owner-recheck/action error', err)
    const status = /required|not found|unknown action|no reviewed/i.test(err.message) ? 400 : 500
    res.status(status).json({ error: err.message || 'Owner recheck action failed' })
  }
})

router.get('/outreach/plans', auth, adminOnly, async (req, res) => {
  try {
    const accountId = parseInt(req.query.accountId)
    if (!accountId) return res.status(400).json({ error: 'accountId required' })
    res.json({ plans: await outreachPlanner.listRollingPlans(accountId, req.agent?.username) })
  } catch (err) {
    log.error('crm/outreach/plans error', err)
    res.status(500).json({ error: 'Failed to load plans' })
  }
})

router.get('/outreach/plans/:planId', auth, adminOnly, async (req, res) => {
  try {
    const plan = await outreachPlanner.getPlanWithEntries(parseInt(req.params.planId))
    if (!plan) return res.status(404).json({ error: 'Plan not found' })
    res.json({ plan })
  } catch (err) {
    log.error('crm/outreach/plan-detail error', err)
    res.status(500).json({ error: 'Failed to load plan' })
  }
})

router.post('/outreach/plans/:planId/message', auth, adminOnly, async (req, res) => {
  try {
    await outreachPlanner.setMessageTemplate(parseInt(req.params.planId), req.body?.text || '')
    res.json({ ok: true })
  } catch (err) {
    if (err.code === 'identity_mismatch') return res.status(400).json({ error: `Wrong signature for this account: ${err.message}` })
    log.error('crm/outreach/message error', err)
    res.status(500).json({ error: 'Failed to save message' })
  }
})

router.post('/outreach/plans/:planId/paste', auth, adminOnly, async (req, res) => {
  try {
    const result = await outreachPlanner.addEntriesFromPaste(parseInt(req.params.planId), req.body?.text || '', req.agent?.username)
    res.json(result)
  } catch (err) {
    log.error('crm/outreach/paste error', err)
    res.status(500).json({ error: 'Failed to add entries' })
  }
})

router.post('/outreach/plans/:planId/generate', auth, adminOnly, async (req, res) => {
  try {
    const requested = Number.parseInt(req.body?.count, 10)
    if (!Number.isFinite(requested) || requested < 1) {
      return res.status(400).json({ error: 'Enter how many contacts to add.' })
    }
    const count = Math.min(requested, 45)
    const result = await outreachPlanner.generateList(parseInt(req.params.planId), count, {
      topUp: req.body?.topUp === true,
      actor: req.agent?.username || 'admin',
    })
    res.json(result)
  } catch (err) {
    log.error('crm/outreach/generate error', err)
    res.status(500).json({ error: 'Failed to generate list' })
  }
})

router.post('/outreach/plans/:planId/regenerate', auth, adminOnly, async (req, res) => {
  try {
    const requested = Number.parseInt(req.body?.count, 10)
    if (!Number.isFinite(requested) || requested < 1) {
      return res.status(400).json({ error: 'Enter how many contacts to add.' })
    }
    const result = await outreachPlanner.generateList(parseInt(req.params.planId), Math.min(requested, 45), {
      topUp: false,
      actor: req.agent?.username || 'admin',
    })
    res.json(result)
  } catch (err) {
    log.error('crm/outreach/regenerate error', err)
    res.status(500).json({ error: 'Failed to regenerate list' })
  }
})

router.delete('/outreach/entries/:entryId', auth, adminOnly, async (req, res) => {
  try {
    await outreachPlanner.removeEntry(parseInt(req.params.entryId))
    res.json({ ok: true })
  } catch (err) {
    log.error('crm/outreach/entry-delete error', err)
    res.status(500).json({ error: 'Failed to remove entry' })
  }
})

router.post('/outreach/plans/:planId/clear', auth, adminOnly, async (req, res) => {
  try {
    await outreachPlanner.clearEntries(parseInt(req.params.planId))
    res.json({ ok: true })
  } catch (err) {
    log.error('crm/outreach/clear error', err)
    res.status(500).json({ error: 'Failed to clear list' })
  }
})

router.post('/outreach/plans/:planId/save', auth, adminOnly, async (req, res) => {
  try {
    res.json({ plan: await outreachPlanner.saveDraft(parseInt(req.params.planId)) })
  } catch (err) {
    log.error('crm/outreach/save error', err)
    res.status(500).json({ error: 'Failed to save plan' })
  }
})

router.post('/outreach/plans/:planId/arm', auth, adminOnly, async (req, res) => {
  try {
    const result = await outreachPlanner.armPlan(parseInt(req.params.planId), { time: req.body?.time })
    if (!result.ok) return res.status(400).json(result)
    res.json(result)
  } catch (err) {
    log.error('crm/outreach/arm error', err)
    res.status(500).json({ error: 'Failed to arm plan' })
  }
})

// Admin debug action (spec: "RUN NOW"): fires the EXACT same execution path
// the scheduler/watchdog use (runScheduledPlan), so a failure here proves
// the send pipeline itself is broken, not the scheduler discovery. No
// separate bypass sender. Only acts on a plan that is actually
// ready/blocked_session + armed (runScheduledPlan's own guard) — cannot be
// used to force-send a paused/cancelled/completed plan.
router.post('/outreach/plans/:planId/run-now', auth, adminOnly, async (req, res) => {
  try {
    const planId = parseInt(req.params.planId)
    outreachPlanner.runScheduledPlan(planId).catch(err => log.error('crm/outreach/run-now crashed', { planId, err: err.message }))
    res.json({ ok: true, note: 'Triggered via the production execution path (runScheduledPlan) — check the plan status shortly.' })
  } catch (err) {
    log.error('crm/outreach/run-now error', err)
    res.status(500).json({ error: 'Failed to trigger run' })
  }
})

router.post('/outreach/plans/:planId/pause', auth, adminOnly, async (req, res) => {
  try {
    await outreachPlanner.pausePlan(parseInt(req.params.planId))
    res.json({ ok: true })
  } catch (err) {
    log.error('crm/outreach/pause error', err)
    res.status(500).json({ error: 'Failed to pause plan' })
  }
})

router.post('/outreach/plans/:planId/cancel', auth, adminOnly, async (req, res) => {
  try {
    await outreachPlanner.cancelPlan(parseInt(req.params.planId))
    res.json({ ok: true })
  } catch (err) {
    log.error('crm/outreach/cancel error', err)
    res.status(500).json({ error: 'Failed to cancel plan' })
  }
})

router.get('/outreach/duplicates', auth, adminOnly, async (req, res) => {
  try {
    res.json({ conflicts: await outreachPlanner.checkDuplicatesGlobal() })
  } catch (err) {
    log.error('crm/outreach/duplicates error', err)
    res.status(500).json({ error: 'Failed to check duplicates' })
  }
})

router.get('/outreach/today-summary', auth, adminOnly, async (req, res) => {
  try {
    res.json(await outreachPlanner.todayContactedSummary())
  } catch (err) {
    log.error('crm/outreach/today-summary error', err)
    res.status(500).json({ error: 'Failed to load summary' })
  }
})

router.get('/outreach/templates', auth, adminOnly, async (req, res) => {
  try {
    res.json({ templates: await outreachPlanner.listMessageTemplates() })
  } catch (err) {
    log.error('crm/outreach/templates error', err)
    res.status(500).json({ error: 'Failed to load templates' })
  }
})

router.post('/outreach/templates', auth, adminOnly, async (req, res) => {
  try {
    const id = await outreachPlanner.saveMessageTemplate(req.body?.label, req.body?.text, req.agent?.username)
    res.json({ ok: true, id })
  } catch (err) {
    log.error('crm/outreach/templates-save error', err)
    res.status(500).json({ error: 'Failed to save template' })
  }
})

router.delete('/outreach/templates/:id', auth, adminOnly, async (req, res) => {
  try {
    await outreachPlanner.deleteMessageTemplate(parseInt(req.params.id))
    res.json({ ok: true })
  } catch (err) {
    log.error('crm/outreach/templates-delete error', err)
    res.status(500).json({ error: 'Failed to delete template' })
  }
})

// ── PROPERTIES ────────────────────────────────────────────────────────────────
// Visibility predicate for non-admins.
function visibilityClause(agent, params) {
  if (agent.role === 'admin') return 'TRUE'
  params.push(agent.id)
  return `(p.is_exclusive = FALSE OR p.listed_by_agent_id = $${params.length} OR p.exclusive_until < CURRENT_DATE)`
}

const PROP_SELECT = `
  SELECT p.*,
         oc.name  AS owner_name,
         oc.phone_normalized AS owner_phone,
         oc.email AS owner_email,
         oc.created_by_agent_id AS owner_creator_id,
         cre.name AS owner_creator_name, cre.username AS owner_creator_username,
         lba.name AS listed_by_name, lba.username AS listed_by_username,
         lba.alias AS listed_by_alias, lba.public_phone AS listed_by_public_phone,
         aag.name AS activity_agent_name, aag.username AS activity_agent_username,
         (SELECT COUNT(*) FROM property_activities pa WHERE pa.property_id = p.id) AS activity_count,
         (SELECT ARRAY_AGG(DISTINCT COALESCE(ag.name, ag.username))
            FROM property_activities pa JOIN agents ag ON ag.id = pa.agent_id
           WHERE pa.property_id = p.id AND pa.is_significant = TRUE) AS activity_agents
    FROM properties p
    LEFT JOIN owner_contacts oc ON oc.id = p.owner_id
    LEFT JOIN agents cre ON cre.id = oc.created_by_agent_id
    LEFT JOIN agents lba ON lba.id = p.listed_by_agent_id
    LEFT JOIN agents aag ON aag.id = p.activity_agent_id
`

// Shape a property row for the client — owner PII ALWAYS masked here.
function shapeProperty(row, { full = false, favSet = null } = {}) {
  const images = Array.isArray(row.images) ? row.images
                : (typeof row.images === 'string' ? safeJson(row.images, []) : [])
  const out = {
    id: row.id,
    ref: row.ref,
    type: row.property_type,
    published: !!row.published,
    location: { town: row.town, sub: row.sub_location, street: row.street, apt: row.apt },
    prices: { longlet: numOrNull(row.longlet_price), shortlet: !!row.shortlet, sale: numOrNull(row.sale_price) },
    // ARGUS V3 (Kev, 2026-09-16): first-class lease type + agent-verified
    // balcony/study/parking facts the match engine's scorer reads (never
    // inferred from listing text — see matchEngine.js's scorePropertyType).
    leaseType: row.lease_type || (row.shortlet ? 'short_let' : 'long_let'),
    // Rental modes (2026-09-21): effective modes (derived from lease_type/shortlet
    // until someone sets them explicitly) — a property may be several at once.
    rentalModes: require('../services/rentalModes').effectiveModes(row),
    rentalModesExplicit: Array.isArray(row.rental_modes) && row.rental_modes.length > 0,
    // Kev, 2026-09-10 (Owner-Kadenz #4, the board's "Bis" button): the longlet
    // termination date — when the CURRENT tenancy ends, as opposed to
    // availableDate (when the NEXT tenant can move in). RESTORED 2026-09-21: the
    // 09-10 23:50 overwrite of this file from a stale base silently dropped this
    // line, the 'available_until' entry in EDITABLE and its date normalisation, so
    // the deployed Bis dialog PATCHed a field the backend ignored.
    availableUntil: row.available_until || null,
    hasBalcony: row.has_balcony, balconySize: row.balcony_size, hasStudyRoom: row.has_study_room,
    parkingAvailable: row.parking_available,
    beds: row.bedrooms, baths: row.bathrooms, sizeSqm: numOrNull(row.size_sqm),
    availableStatus: row.available_status,
    availableDate: row.available_date,
    viewingStatus: row.viewing_status,
    viewingDate: row.viewing_date,
    exclusive: !!row.is_exclusive,
    exclusiveUntil: row.exclusive_until,
    completeness: row.completeness_pct || 0,
    imageCount: images.length,
    images,
    owner: {
      id: row.owner_id,
      name: row.owner_name || null,
      phoneMasked: maskPhone(row.owner_phone),
      emailMasked: maskEmail(row.owner_email),
      hasPhone: !!row.owner_phone,
      hasEmail: !!row.owner_email,
    },
    ownerCreator: row.owner_creator_name || row.owner_creator_username || null,
    // raw agent ids for the editable attribution dropdowns (Phase 5)
    listedByAgentId: row.listed_by_agent_id || null,
    ownerCreatorId: row.owner_creator_id || null,
    activityAgentId: row.activity_agent_id || null,
    activityAgent: row.activity_agent_name || row.activity_agent_username || null,
    // Public agent contact shown next to a listing. Alias overrides the real
    // name (Tomas → "Adrian"); when no agent matched the upload, fall back to
    // the uploader's phone number.
    listingAgent: {
      displayName: row.listed_by_alias || row.listed_by_name || row.listed_by_username
                   || (row.listed_by_phone ? `+${row.listed_by_phone}` : null),
      publicPhone: row.listed_by_public_phone
                   || (row.listed_by_phone ? `+${row.listed_by_phone}` : null),
    },
    listingAgents: [row.listed_by_alias || row.listed_by_name || row.listed_by_username
                    || (row.listed_by_phone ? `+${row.listed_by_phone}` : null)].filter(Boolean),
    activityAgents: row.activity_agents ? row.activity_agents.filter(Boolean) : [],
    activityCount: Number(row.activity_count) || 0,
    fav: favSet ? favSet.has(row.id) : false,
    // Owner Profile V2 (2026-09-07): additive fields, already on `p.*` via
    // PROP_SELECT — no new query, just surfacing what was already fetched.
    lastConfirmedAvailableAt: row.last_confirmed_available_at || null,
    avAutoRhythm: row.av_auto_rhythm || 'off',
    noFb: !!row.no_fb,
    // Manual category override (Phase 1, 2026-09-17) — AUTO when null,
    // MANUAL OVERRIDE when set. Never affects the fields above (bedrooms
    // etc.) — it's a publishing-routing decision only.
    categoryOverride: row.category_override || null,
    categoryOverrideByAgentId: row.category_override_by_agent_id || null,
    categoryOverrideAt: row.category_override_at || null,
    categoryOverrideReason: row.category_override_reason || null,
  }
  if (full) {
    out.description = row.description
    out.viewingNotes = row.viewing_notes
    out.internalNotes = row.internal_notes
    // 2026-09-21: practical Property Notes (agent-visible) + the listing's own
    // "do not contact until" — independent of available_status. The compliance
    // column is NOT here on purpose (admin-only, added by the detail route).
    out.propertyNotes = row.property_notes || null
    out.contactPausedUntil = row.property_contact_paused_until || null
    out.contactPauseNote = row.property_contact_pause_note || null
    out.createdAt = row.created_at
    out.updatedAt = row.updated_at
  }
  return out
}
const numOrNull = (v) => (v == null ? null : Number(v))
function safeJson(s, fb) { try { return JSON.parse(s) } catch { return fb } }

// GET /api/crm/properties  (filters via query)
router.get('/properties', auth, async (req, res) => {
  try {
    const a = await liveAgent(req.agent.id)
    if (!a) return res.status(401).json({ error: 'Account inactive' })
    const q = req.query
    const params = []
    const where = [visibilityClause(a, params)]

    if (q.town)   { params.push(`%${q.town}%`);  where.push(`p.town ILIKE $${params.length}`) }
    if (q.beds)   { params.push(parseInt(q.beds)); where.push(`p.bedrooms = $${params.length}`) }
    if (q.price_min) { params.push(parseFloat(q.price_min)); where.push(`COALESCE(p.longlet_price,p.sale_price) >= $${params.length}`) }
    if (q.price_max) { params.push(parseFloat(q.price_max)); where.push(`COALESCE(p.longlet_price,p.sale_price) <= $${params.length}`) }
    if (q.status)  { params.push(q.status);  where.push(`p.available_status = $${params.length}`) }
    if (q.viewing) { params.push(q.viewing); where.push(`p.viewing_status = $${params.length}`) }
    if (q.agent)   { params.push(parseInt(q.agent)); where.push(`p.listed_by_agent_id = $${params.length}`) }
    if (q.only_mine === '1' || q.only_mine === 'true') { params.push(a.id); where.push(`p.listed_by_agent_id = $${params.length}`) }
    if (q.exclusive === '1' || q.exclusive === 'true') where.push(`p.is_exclusive = TRUE`)
    // Rental mode tabs/filter (2026-09-21): long_let | winter_let | short_let, on the
    // EFFECTIVE modes so rows that were never explicitly classified still filter right.
    if (q.rental_mode) {
      const rm = require('../services/rentalModes')
      const mode = rm.normalizeModes([q.rental_mode])[0]
      if (mode) { params.push(mode); where.push(rm.sqlHasMode('p', params.length)) }
    }
    // Kev's "Final Fixes" (2026-09-12): Property Inventory had no way to
    // filter on subletting at all, unlike the Schedule Board's own checkbox
    // (components/crm/board-filters.tsx) -- same structured column that
    // filter now prefers (services/listingRules.js:subletPolicy).
    if (q.sublet === '1' || q.sublet === 'true') where.push(`p.subletting_considered = TRUE`)
    if (q.only_favourites === '1' || q.only_favourites === 'true') {
      params.push(a.id)
      where.push(`p.id IN (SELECT property_id FROM agent_favourites WHERE agent_id = $${params.length})`)
    }

    const sql = `${PROP_SELECT} WHERE ${where.join(' AND ')} ORDER BY p.created_at DESC LIMIT 500`
    const r = await db.query(sql, params)
    // total count visible to this agent (for header "X total")
    const tParams = []
    const tWhere = visibilityClause(a, tParams)
    const tot = await db.query(`SELECT COUNT(*)::int AS n FROM properties p WHERE ${tWhere}`, tParams)
    // current agent's favourites
    const favR = await db.query(`SELECT property_id FROM agent_favourites WHERE agent_id=$1`, [a.id])
    const favSet = new Set(favR.rows.map(x => x.property_id))
    res.json({ properties: r.rows.map(row => shapeProperty(row, { favSet })), total: tot.rows[0].n })
  } catch (err) {
    log.error('crm/properties list error', err)
    res.status(500).json({ error: 'Failed to load properties' })
  }
})

// GET /api/crm/properties/:id
router.get('/properties/:id', auth, async (req, res) => {
  try {
    const a = await liveAgent(req.agent.id)
    const params = [parseInt(req.params.id)]
    const vis = a.role === 'admin' ? 'TRUE'
      : `(p.is_exclusive = FALSE OR p.listed_by_agent_id = $2 OR p.exclusive_until < CURRENT_DATE)`
    if (a.role !== 'admin') params.push(a.id)
    const r = await db.query(`${PROP_SELECT} WHERE p.id = $1 AND ${vis}`, params)
    if (!r.rows.length) return res.status(404).json({ error: 'Not found or not visible' })
    const favR = await db.query(`SELECT 1 FROM agent_favourites WHERE agent_id=$1 AND property_id=$2`, [a.id, req.params.id])
    const favSet = favR.rows.length ? new Set([parseInt(req.params.id)]) : new Set()
    const acts = await db.query(
      `SELECT pa.id, pa.activity_type, pa.details, pa.is_significant, pa.created_at,
              ag.name AS agent_name, ag.username AS agent_username
         FROM property_activities pa LEFT JOIN agents ag ON ag.id = pa.agent_id
        WHERE pa.property_id = $1 ORDER BY pa.created_at DESC`, [req.params.id])
    const shaped = shapeProperty(r.rows[0], { full: true, favSet })
    // Owner-level context the agent needs next to the listing (2026-09-21): the
    // owner's practical notes (phone numbers masked) and the owner-wide contact
    // pause. Compliance notes: admin only.
    let ownerContext = null
    try {
      const ow = await db.query(
        `SELECT owner_notes, owner_compliance_notes, owner_contact_paused_until, owner_contact_pause_note
           FROM owner_contacts WHERE id = $1`, [r.rows[0].owner_id])
      if (ow.rows[0]) {
        ownerContext = {
          notes: ow.rows[0].owner_notes ? require('../services/contactNotes').maskPhones(ow.rows[0].owner_notes) : null,
          contactPausedUntil: ow.rows[0].owner_contact_paused_until || null,
          contactPauseNote: ow.rows[0].owner_contact_pause_note || null,
          ...(a.role === 'admin' ? { complianceNotes: ow.rows[0].owner_compliance_notes || null } : {}),
        }
      }
    } catch (e) { log.warn('crm/property detail: owner context failed', { err: e.message }) }
    if (a.role === 'admin') shaped.complianceNotes = r.rows[0].property_compliance_notes || null
    // Channel state is evidence-only and must not mutate canonical facts.
    let distribution = { channels: [], events: [] }
    try {
      distribution = await require('../services/propertyDistribution').loadPropertyDistribution(db, {
        id: parseInt(req.params.id), ref: shaped.ref, published: shaped.published,
      })
    } catch (e) {
      log.warn('crm/property detail: distribution status failed', { propertyId: req.params.id, err: e.message })
      distribution.channels = [
        { key: 'crm', label: 'CRM', status: 'connected', detail: 'Canonical property record' },
        { key: 'agent_board', label: 'Agent Board', status: 'connected', detail: 'Visible in operational inventory' },
        { key: 'website', label: '2906 Website', status: shaped.published ? 'syncing' : 'off', detail: shaped.published ? 'Publication state is refreshing' : 'Public listing disabled' },
      ]
    }
    res.json({
      property: shaped,
      ownerContext,
      distribution,
      activities: acts.rows.map(x => ({
        id: x.id, type: x.activity_type, details: x.details, significant: x.is_significant,
        when: x.created_at, who: x.agent_name || x.agent_username,
      })),
    })
  } catch (err) {
    log.error('crm/property detail error', err)
    res.status(500).json({ error: 'Failed' })
  }
})

// ── completeness (Task 7) ──────────────────────────────────────────────────────
function calcCompleteness(p, imageCount) {
  let pct = 0
  const req10 = [p.town, p.property_type, p.bedrooms, p.bathrooms,
                 (p.longlet_price || p.sale_price), p.available_status, p.available_date, p.description]
  for (const f of req10) if (f !== null && f !== undefined && f !== '') pct += 10
  if (p.street) pct += 5
  if (imageCount >= 1) pct += 5
  if (imageCount >= 3) pct += 5
  if (p.viewing_status && p.viewing_status !== 'none') pct += 5
  if (p.internal_notes) pct += 5
  return Math.min(100, pct)
}

// ── activity significance (Task 6) ──────────────────────────────────────────────
function diffActivities(oldP, newP) {
  const acts = []
  const add = (type, field, oldV, newV, sig) =>
    acts.push({ type, sig, details: { field, old: oldV, new: newV } })

  if (newP.available_status !== undefined && newP.available_status !== oldP.available_status)
    add('status_change', 'available_status', oldP.available_status, newP.available_status, true)

  if (newP.available_date !== undefined && String(newP.available_date) !== String(oldP.available_date)) {
    if (!oldP.available_date && newP.available_date) add('available_date_set', 'available_date', null, newP.available_date, true)
    else {
      const d1 = new Date(oldP.available_date), d2 = new Date(newP.available_date)
      const days = Math.abs((d2 - d1) / 86400000)
      add(days > 7 ? 'available_date_changed' : 'minor_edit', 'available_date', oldP.available_date, newP.available_date, days > 7)
    }
  }
  if (newP.longlet_price !== undefined && Number(newP.longlet_price) !== Number(oldP.longlet_price)) {
    const oldV = Number(oldP.longlet_price) || 0
    const pctChange = oldV ? Math.abs(Number(newP.longlet_price) - oldV) / oldV * 100 : 100
    add(pctChange > 10 ? 'price_change_major' : 'price_change_minor', 'longlet_price', oldP.longlet_price, newP.longlet_price, pctChange > 10)
  }
  if (newP.sale_price !== undefined && Number(newP.sale_price) !== Number(oldP.sale_price)) {
    const oldV = Number(oldP.sale_price) || 0
    const pctChange = oldV ? Math.abs(Number(newP.sale_price) - oldV) / oldV * 100 : 100
    add(pctChange > 10 ? 'price_change_major' : 'price_change_minor', 'sale_price', oldP.sale_price, newP.sale_price, pctChange > 10)
  }
  if (newP.viewing_status !== undefined && newP.viewing_status !== oldP.viewing_status) {
    if (newP.viewing_status === 'scheduled') add('viewing_scheduled', 'viewing_status', oldP.viewing_status, newP.viewing_status, true)
    else if (newP.viewing_status === 'done') add('viewing_done', 'viewing_status', oldP.viewing_status, newP.viewing_status, true)
    else add('minor_edit', 'viewing_status', oldP.viewing_status, newP.viewing_status, false)
  }
  for (const f of ['bedrooms', 'bathrooms', 'size_sqm']) {
    if (newP[f] !== undefined && String(newP[f]) !== String(oldP[f]))
      add('specs_change', f, oldP[f], newP[f], true)
  }
  if (newP.is_exclusive !== undefined && !!newP.is_exclusive !== !!oldP.is_exclusive)
    add(newP.is_exclusive ? 'exclusive_set' : 'exclusive_released', 'is_exclusive', oldP.is_exclusive, newP.is_exclusive, !!newP.is_exclusive)

  for (const f of ['viewing_notes', 'internal_notes', 'description', 'street', 'apt', 'sub_location'])
    if (newP[f] !== undefined && String(newP[f] || '') !== String(oldP[f] || ''))
      add('note_added', f, null, null, false)

  return acts
}
async function logActivities(propertyId, agentId, acts) {
  for (const x of acts) {
    await db.query(
      `INSERT INTO property_activities (property_id, agent_id, activity_type, details, is_significant)
       VALUES ($1,$2,$3,$4,$5)`,
      [propertyId, agentId, x.type, JSON.stringify(x.details || {}), !!x.sig])
  }
}

// One shared allocator is used by CRM Add+, WhatsApp uploads and unit copies.
// Timestamp-style legacy refs (2906-790860) therefore cannot pull the normal
// human-facing sequence into six digits.
const { nextRef } = require('../services/propertyRef')

// POST /api/crm/properties  (Add+ flow submit)
router.post('/properties', auth, async (req, res) => {
  const client = await db.connect()
  try {
    const a = req.agent
    const b = req.body || {}
    await client.query('BEGIN')

    // 1. resolve / create owner
    let ownerId = null
    let ownerWasNew = false
    const phoneNorm = digits(b.owner?.phone)
    if (phoneNorm) {
      const ex = await client.query(`SELECT id FROM owner_contacts WHERE phone_normalized=$1`, [phoneNorm])
      if (ex.rows.length) {
        ownerId = ex.rows[0].id
        // fill in email/name if newly provided and missing
        await client.query(
          `UPDATE owner_contacts SET
             name  = COALESCE(NULLIF($2,''), name),
             email = COALESCE(NULLIF($3,''), email)
           WHERE id=$1`, [ownerId, b.owner?.name || '', b.owner?.email || ''])
      } else {
        ownerWasNew = true
        const ins = await client.query(
          `INSERT INTO owner_contacts (phone_normalized, name, email, source, created_by_agent_id, created_by_agent_at, status)
           VALUES ($1,$2,$3,'crm_manual',$4,NOW(),'new') RETURNING id`,
          [phoneNorm, b.owner?.name || null, b.owner?.email || null, a.id])
        ownerId = ins.rows[0].id
      }
    }

    // 2. exclusive
    let exclusiveUntil = null
    if (b.is_exclusive && b.exclusive_weeks) {
      const wk = parseInt(b.exclusive_weeks)
      const d = new Date(); d.setDate(d.getDate() + wk * 7)
      exclusiveUntil = d.toISOString().slice(0, 10)
    }

    const images = Array.isArray(b.images) ? b.images : []
    // "Listed by" — defaults to the creating agent, but may be overridden
    // (the Add+ form / !uploadlisting can attribute to another active agent).
    let listedBy = a.id
    if (b.listed_by_agent_id != null && b.listed_by_agent_id !== '') {
      const want = parseInt(b.listed_by_agent_id)
      const chk = await client.query(`SELECT id FROM agents WHERE id=$1 AND active=TRUE`, [want])
      if (chk.rows.length) listedBy = want
    }
    const ref = await nextRef(client)
    const propForCalc = {
      town: b.town, property_type: b.property_type, bedrooms: int(b.bedrooms), bathrooms: int(b.bathrooms),
      longlet_price: num(b.longlet_price), sale_price: num(b.sale_price),
      available_status: b.available_status || 'available', available_date: b.available_date || null,
      description: b.description, street: b.street, viewing_status: b.viewing_status || 'none',
      internal_notes: b.internal_notes,
    }
    const completeness = calcCompleteness(propForCalc, images.length)

    // Rental modes + "Available until (Bis)" at creation (2026-09-21): the manual
    // selector. An empty selection stays NULL (modes then derive from lease_type /
    // shortlet exactly as before); a picked short_let also sets the legacy shortlet flag.
    const rmSvc = require('../services/rentalModes')
    const newModes = rmSvc.normalizeModes(b.rental_modes)
    const shortletFlag = !!b.shortlet || newModes.includes('short_let')
    const ins = await client.query(
      `INSERT INTO properties
        (ref, owner_id, property_type, town, sub_location, street, apt,
         bedrooms, bathrooms, size_sqm, longlet_price, shortlet, sale_price,
         description, images, listed_by_agent_id, available_status, available_date,
         viewing_status, viewing_notes, internal_notes, is_exclusive, exclusive_until, completeness_pct,
         available_until, rental_modes, lease_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,COALESCE($27,'long_let'))
       RETURNING id, ref`,
      [ref, ownerId, b.property_type || null, b.town || null, b.sub_location || null, b.street || null, b.apt || null,
       int(b.bedrooms), int(b.bathrooms), num(b.size_sqm), num(b.longlet_price), shortletFlag, num(b.sale_price),
       b.description || null, JSON.stringify(images), listedBy, b.available_status || 'available', b.available_date || null,
       b.viewing_status || 'none', b.viewing_notes || null, b.internal_notes || null,
       !!b.is_exclusive, exclusiveUntil, completeness,
       dateOrNull(b.available_until), newModes.length ? newModes : null, newModes.length ? rmSvc.legacyLeaseType(newModes) : null])

    const propId = ins.rows[0].id
    await client.query(
      `INSERT INTO property_activities (property_id, agent_id, activity_type, details, is_significant)
       VALUES ($1,$2,'property_created',$3,TRUE)`,
      [propId, a.id, JSON.stringify({ ref, ownerWasNew, owner_id: ownerId })])
    if (b.is_exclusive)
      await client.query(
        `INSERT INTO property_activities (property_id, agent_id, activity_type, details, is_significant)
         VALUES ($1,$2,'exclusive_set',$3,TRUE)`,
        [propId, a.id, JSON.stringify({ exclusive_until: exclusiveUntil })])

    await client.query('COMMIT')
    await require('../services/softlistOwners').handleUploadedProperty({
      propertyId: propId, ownerId, uploaderAgentId: a.id,
    }).catch(err => log.warn('softlist owner manual-upload hook failed (non-fatal)', { propId, ownerId, err: err.message }))
    res.json({ ok: true, id: propId, ref: ins.rows[0].ref, ownerWasNew })
  } catch (err) {
    await client.query('ROLLBACK')
    log.error('crm/properties create error', err)
    res.status(500).json({ error: 'Failed to create property' })
  } finally {
    client.release()
  }
})
const int = (v) => (v === '' || v == null ? null : parseInt(v))
const num = (v) => (v === '' || v == null ? null : parseFloat(v))
// Kev, 2026-08-28: the edit form sends '' for a cleared date input (same as
// every other cleared field), but nothing converted that to NULL for the
// four date/timestamp columns below — Postgres rejects '' as a date outright
// ("invalid input syntax for type date"), so ANY save that touched one of
// these while empty failed the WHOLE PATCH, not just that field.
const dateOrNull = (v) => (v === '' || v == null ? null : v)

// PATCH /api/crm/properties/:id
router.patch('/properties/:id', auth, async (req, res) => {
  try {
    const a = await liveAgent(req.agent.id)
    const id = parseInt(req.params.id)
    const cur = await db.query(`SELECT * FROM properties WHERE id=$1`, [id])
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' })
    const old = cur.rows[0]
    const b = req.body || {}

    // ── Agent (re)assignment — separate permission model from standard edits ──
    // listed_by_agent_id: ANY agent may change (mis-assignments happen, e.g. when
    //   an unrecognized !uploadlisting sender defaulted to kev). owner_creator_id
    //   and activity_agent_id are ADMIN ONLY (they drive bonus attribution).
    // Each change → property_activities 'agent_reassignment', is_significant=FALSE
    //   (reassignment never grants the re-assigner an Activity-Bonus).
    const REASSIGN_FIELDS = ['listed_by_agent_id', 'owner_creator_id', 'activity_agent_id']
    let reassignmentsLogged = 0
    if (REASSIGN_FIELDS.some(f => b[f] !== undefined)) {
      // validate any provided (non-null) agent ids exist & are active
      const wantIds = REASSIGN_FIELDS
        .map(f => b[f]).filter(v => v !== undefined && v !== null && v !== '')
        .map(v => parseInt(v))
      const agMap = {}
      if (wantIds.length) {
        const ag = await db.query(`SELECT id, name, username FROM agents WHERE id = ANY($1) AND active=TRUE`, [wantIds])
        for (const r of ag.rows) agMap[r.id] = r.name || r.username
        for (const wid of wantIds) if (!agMap[wid]) return res.status(400).json({ error: `Unknown or inactive agent id ${wid}` })
      }
      const nameOf = async (aid) => {
        if (aid == null) return null
        if (agMap[aid]) return agMap[aid]
        const r = await db.query(`SELECT name, username FROM agents WHERE id=$1`, [aid])
        return r.rows.length ? (r.rows[0].name || r.rows[0].username) : null
      }
      const logReassign = async (field, oldId, newId) => {
        await db.query(
          `INSERT INTO property_activities (property_id, agent_id, activity_type, details, is_significant)
           VALUES ($1,$2,'agent_reassignment',$3,FALSE)`,
          [id, a.id, JSON.stringify({
            field, old_agent_id: oldId, new_agent_id: newId, by_agent_id: a.id,
            from: await nameOf(oldId), to: await nameOf(newId),
          })])
        reassignmentsLogged++
      }
      const toId = (v) => (v === null || v === '' ? null : parseInt(v))

      // 1) listed_by_agent_id — any authenticated agent
      if (b.listed_by_agent_id !== undefined) {
        const newId = toId(b.listed_by_agent_id)
        if (newId !== old.listed_by_agent_id) {
          await db.query(`UPDATE properties SET listed_by_agent_id=$2, updated_at=NOW() WHERE id=$1`, [id, newId])
          await logReassign('listed_by_agent_id', old.listed_by_agent_id, newId)
        }
      }
      // 2) activity_agent_id — admin only
      if (b.activity_agent_id !== undefined) {
        if (a.role !== 'admin') return res.status(403).json({ error: 'Only admins can change the Activity agent' })
        const newId = toId(b.activity_agent_id)
        if (newId !== old.activity_agent_id) {
          await db.query(`UPDATE properties SET activity_agent_id=$2, updated_at=NOW() WHERE id=$1`, [id, newId])
          await logReassign('activity_agent_id', old.activity_agent_id, newId)
        }
      }
      // 3) owner_creator_id — admin only; stored on owner_contacts.created_by_agent_id (per-owner)
      if (b.owner_creator_id !== undefined) {
        if (a.role !== 'admin') return res.status(403).json({ error: 'Only admins can change the Owner creator' })
        if (!old.owner_id) return res.status(400).json({ error: 'Property has no linked owner to attribute' })
        const newId = toId(b.owner_creator_id)
        const ocur = await db.query(`SELECT created_by_agent_id FROM owner_contacts WHERE id=$1`, [old.owner_id])
        const oldId = ocur.rows.length ? ocur.rows[0].created_by_agent_id : null
        if (newId !== oldId) {
          await db.query(`UPDATE owner_contacts SET created_by_agent_id=$2 WHERE id=$1`, [old.owner_id, newId])
          await logReassign('owner_creator_id', oldId, newId)
        }
      }
    }

    // ── Classification changes (lease_type / winter-let etc.) — Kev, 2026-09-17
    // ("Nur Admins können es halt direkt ändern (Winterlet unso)"): an admin's
    // change still applies immediately, same as every other EDITABLE field
    // below. A non-admin's change is NOT applied — it queues in
    // property_pending_changes and shows as a dashboard notification an
    // admin must confirm, so a misclick never silently reclassifies a live
    // listing. lease_type is the one field this currently covers ("und so
    // on" is future scope, not guessed at here).
    let pendingChange = null
    let leaseTouched = false
    // RENTAL MODES (2026-09-21): several at once (long / winter / short). Same
    // permission gate as lease_type — admin applies, anyone else queues a pending
    // change an admin confirms. lease_type is kept in step (legacyLeaseType) so the
    // older single-value readers stay right; [] / null clears back to "derived".
    if (b.rental_modes !== undefined) {
      const rm = require('../services/rentalModes')
      const modes = rm.normalizeModes(b.rental_modes)
      if (Array.isArray(b.rental_modes) && b.rental_modes.length && !modes.length) {
        return res.status(400).json({ error: 'Unknown rental mode (use long_let, winter_let, short_let)' })
      }
      const before = Array.isArray(old.rental_modes) ? rm.normalizeModes(old.rental_modes) : []
      if (JSON.stringify(modes) !== JSON.stringify(before)) {
        if (a.role === 'admin') {
          await db.query(
            `UPDATE properties SET rental_modes = $1, lease_type = COALESCE($2, lease_type), updated_at = NOW() WHERE id = $3`,
            [modes.length ? modes : null, modes.length ? rm.legacyLeaseType(modes) : null, id])
          leaseTouched = true
        } else {
          const ins = await db.query(
            `INSERT INTO property_pending_changes (property_id, ref, field, old_value, new_value, proposed_by_agent_id)
               VALUES ($1,$2,'rental_modes',$3,$4,$5) RETURNING id`,
            [id, old.ref, JSON.stringify(before), JSON.stringify(modes), a.id])
          pendingChange = { id: ins.rows[0].id, field: 'rental_modes', old_value: JSON.stringify(before), new_value: JSON.stringify(modes) }
        }
      }
    }
    if (b.lease_type !== undefined && b.lease_type !== old.lease_type) {
      if (a.role === 'admin') {
        // an explicit rental_modes must not contradict the legacy value being set
        await db.query(
          `UPDATE properties SET lease_type = $1, rental_modes = CASE WHEN rental_modes IS NULL THEN NULL ELSE ARRAY[$1]::text[] END, updated_at = NOW() WHERE id = $2`,
          [b.lease_type, id])
        leaseTouched = true
      } else {
        const ins = await db.query(
          `INSERT INTO property_pending_changes (property_id, ref, field, old_value, new_value, proposed_by_agent_id)
             VALUES ($1,$2,'lease_type',$3,$4,$5) RETURNING id`,
          [id, old.ref, old.lease_type, b.lease_type, a.id])
        pendingChange = { id: ins.rows[0].id, field: 'lease_type', old_value: old.lease_type, new_value: b.lease_type }
      }
    }

    // ── Standard field edits (existing behaviour + its own permission gate) ──
    const EDITABLE = ['property_type','town','sub_location','street','apt','bedrooms','bathrooms','size_sqm',
      'longlet_price','shortlet','sale_price','description','available_status','available_date',
      'viewing_status','viewing_date','viewing_notes','internal_notes','is_exclusive','exclusive_until','published',
      // ARGUS V3 (Kev, 2026-09-16): the balcony/study fields are
      // agent-verified truth for the match engine's balcony-fallback rule —
      // NEVER inferred from listing text (see matchEngine.js's
      // scorePropertyType), so they only ever change here. lease_type is
      // handled above (admin-direct / pending-approval), not in this list.
      'has_balcony','balcony_size','has_study_room','parking_available',
      // Owner-Kadenz #4 "Bis" (restored 2026-09-21, see shapeProperty): longlet
      // termination date, independent of available_date.
      'available_until',
      // 2026-09-21: Property Notes and "do not contact until" (independent of availability)
      'property_notes','property_contact_paused_until','property_contact_pause_note',
      // ARGUS property intelligence (2026-09-23): a direct PATCH of
      // feature_tags is a HUMAN CORRECTION — see the feature_tags_locked
      // handling right after this loop, which locks the row so a later
      // description edit's auto re-extraction never silently overwrites it.
      'feature_tags']
    const sets = []
    const params = []
    const newVals = {}
    for (const f of EDITABLE) {
      if (b[f] !== undefined) {
        let v = b[f]
        if (f === 'property_notes') {
          // practical text stays in property_notes; protected-characteristic text is
          // diverted to the admin-only compliance column (services/contactNotes.js)
          const s = require('../services/contactNotes').splitNote(v)
          v = s.actionable
          if (s.compliance) {
            params.push(`[${new Date().toISOString().slice(0, 10)} agent:${a.id}] [compliance — non-actionable] ${s.compliance}`)
            sets.push(`property_compliance_notes = CASE WHEN COALESCE(property_compliance_notes,'') = '' THEN $${params.length} ELSE property_compliance_notes || E'\\n' || $${params.length} END`)
          }
        }
        if (f === 'property_contact_paused_until') {
          v = v ? require('../services/ownerSendGate').parsePauseDate(v) || (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : null) : null
          sets.push(`property_contact_paused_by = 'agent:${Number(a.id) || 0}'`, 'property_contact_paused_at = NOW()')
        }
        if (['bedrooms','bathrooms'].includes(f)) v = int(v)
        if (['size_sqm','longlet_price','sale_price'].includes(f)) v = num(v)
        if (['available_date','available_until','viewing_date','exclusive_until'].includes(f)) v = dateOrNull(v)
        if (f === 'feature_tags') {
          v = require('../services/featureTags').normalizeTags(v)
          // A direct human edit locks the row — see the description-edit
          // re-extraction block below, which reads this flag.
          sets.push(`feature_tags_locked = TRUE`)
        }
        params.push(v); sets.push(`${f} = $${params.length}`); newVals[f] = v
      }
    }

    if (!sets.length) {
      // reassignment-only, or a non-admin's classification change that just
      // queued as a pending change above (no substantive direct field edits).
      return res.json({ ok: true, completeness: old.completeness_pct || 0, activitiesLogged: 0, reassignmentsLogged, pendingChange })
    }

    if (a.role !== 'admin' && old.listed_by_agent_id !== a.id && old.is_exclusive)
      return res.status(403).json({ error: 'Not allowed to edit this property' })

    const acts = diffActivities(old, newVals)
    // recompute completeness from merged state
    const merged = { ...old, ...newVals }
    const imgCount = Array.isArray(old.images) ? old.images.length : safeJson(old.images, []).length
    const completeness = calcCompleteness(merged, imgCount)
    params.push(completeness); sets.push(`completeness_pct = $${params.length}`)
    sets.push(`updated_at = NOW()`)
    params.push(id)
    await db.query(`UPDATE properties SET ${sets.join(', ')} WHERE id=$${params.length}`, params)

    // ARGUS property intelligence (2026-09-23, item 2): a description edit
    // re-scans the FULL new text for feature tags — the same
    // services/featureTags.js the original upload extraction uses, no
    // second extractor — never the shortened public/marketing copy. Only
    // when feature_tags itself was NOT also given in this same request
    // (an explicit simultaneous correction always wins outright, handled
    // by the EDITABLE loop above). A row no human has ever directly
    // corrected (feature_tags_locked=FALSE) gets its tags replaced outright
    // — that's just keeping the auto-extraction current. A locked row
    // keeps the human's list untouched; if the fresh extraction disagrees,
    // that's flagged (property_activities + returned to the caller), never
    // silently applied over a human decision.
    let featureTagsConflict = null
    if (b.description !== undefined && b.feature_tags === undefined) {
      const featureTagsSvc = require('../services/featureTags')
      const { tags: freshTags, evidence } = featureTagsSvc.classifyFromText(newVals.description || '')
      const oldTags = Array.isArray(old.feature_tags) ? old.feature_tags : []
      const changed = JSON.stringify([...freshTags].sort()) !== JSON.stringify([...oldTags].sort())
      if (changed) {
        if (!old.feature_tags_locked) {
          await db.query(`UPDATE properties SET feature_tags = $2 WHERE id = $1`, [id, freshTags.length ? freshTags : null])
          newVals.feature_tags = freshTags
          await db.query(
            `INSERT INTO property_activities (property_id, agent_id, activity_type, details, is_significant)
             VALUES ($1,$2,'feature_tags_reextracted',$3,FALSE)`,
            [id, a.id, JSON.stringify({ from: oldTags, to: freshTags, evidence, trigger: 'description_edit' })])
        } else {
          featureTagsConflict = { current: oldTags, suggested: freshTags, evidence }
          await db.query(
            `INSERT INTO property_activities (property_id, agent_id, activity_type, details, is_significant)
             VALUES ($1,$2,'feature_tags_conflict',$3,FALSE)`,
            [id, a.id, JSON.stringify({ current: oldTags, suggested: freshTags, evidence, note: 'description changed but feature_tags is human-locked — not auto-applied' })])
        }
      }
    }

    // Description-driven rental classification uses the same deterministic
    // classifier as WhatsApp upload. Only fill an unclassified row: an
    // explicit rental_modes selection made by a human always wins. This
    // catches wording such as "Winterlet" and "from now until April" so the
    // board is already set to WINTER before an agent opens the listing.
    if (b.description !== undefined && b.rental_modes === undefined) {
      const oldModes = require('../services/rentalModes').normalizeModes(old.rental_modes)
      if (!oldModes.length) {
        const rentalModesSvc = require('../services/rentalModes')
        const cls = rentalModesSvc.classifyFromText(newVals.description || '')
        if (cls.modes.length) {
          await db.query(
            `UPDATE properties SET rental_modes=$2, lease_type=$3, updated_at=NOW() WHERE id=$1`,
            [id, cls.modes, rentalModesSvc.legacyLeaseType(cls.modes)])
          newVals.rental_modes = cls.modes
          newVals.lease_type = rentalModesSvc.legacyLeaseType(cls.modes)
          await db.query(
            `INSERT INTO property_activities (property_id, agent_id, activity_type, details, is_significant)
             VALUES ($1,$2,'rental_modes_detected',$3,FALSE)`,
            [id, a.id, JSON.stringify({ to:cls.modes, evidence:cls.evidence, trigger:'description_edit' })])
        }
      }
    }

    if (acts.length) await logActivities(id, a.id, acts)
    else await logActivities(id, a.id, [{ type: 'status_confirmed', sig: false, details: {} }])

    // Kev, 2026-08-28: the "Published (LIVE)" checkbox flipped this column
    // for as long as it has existed with ZERO effect on the actual public
    // site — routes/properties.js reads a completely separate table
    // (website_properties) that nothing ever wrote into from here. This is
    // that bridge. Best-effort: a sync failure must not fail the property
    // edit itself, so it is reported back but never thrown.
    let website = null
    if (newVals.published === true) {
      // Kev, 2026-09-01: an agent explicitly turning this back ON is the one
      // signal allowed to clear website_manually_hidden — otherwise a
      // property hidden today would silently stay eligible for the
      // auto-publish-on-images-added path (routes/crm.js's own
      // /properties/:id/images) the moment someone attaches a photo,
      // directly contradicting the manual hide they just performed.
      await db.query(`UPDATE properties SET website_manually_hidden = FALSE WHERE id = $1`, [id])
      try {
        website = await require('../services/websiteSync').syncPropertyToWebsite(id)
      } catch (err) {
        log.error('crm/property patch: website sync failed', { id, err: err.message })
        website = { ok: false, reason: 'error', detail: err.message }
      }
      // Kev, 2026-08-29 (Prompt A): the persistent property share link is
      // created HERE, at the same "just went live" moment as the website
      // sync above — the one existing choke point every publish already
      // passes through. Idempotent (services/shareLinks.js), so a second
      // publish/unpublish/republish cycle never creates a duplicate. Best-
      // effort like the sync call it sits next to: a failure here must not
      // fail the property edit itself.
      try {
        await require('../services/shareLinks').getOrCreatePropertyLink(id)
      } catch (err) {
        log.error('crm/property patch: share link create failed', { id, err: err.message })
      }
      // Kev's Prompt C, event NEW PROPERTY (a draft going live for the first
      // time is this event too — "published" flipping true either way):
      // find who this listing should be shown to right now, instead of
      // waiting for the next reconciliation pass or an agent remembering a
      // client from three weeks ago.
      require('../services/matchEngine').matchPropertyToClients(id)
        .catch(err => log.warn('crm/property patch: match-on-publish failed', { id, err: err.message }))
    } else if (newVals.published === false) {
      // Kev, 2026-09-01 ("manual hiding must override automatic
      // publication"): an agent explicitly switching this OFF is a
      // deliberate hide, distinct from a property that simply hasn't
      // qualified yet (no photos). Recorded so routes/crm.js's own
      // /properties/:id/images auto-publish path knows not to flip
      // `published` back on the next time a photo is attached.
      await db.query(`UPDATE properties SET website_manually_hidden = TRUE WHERE id = $1`, [id])
      try {
        website = await require('../services/websiteSync').unpublishFromWebsite(old.ref)
      } catch (err) {
        log.warn('crm/property patch: website unpublish failed', { id, err: err.message })
      }
    } else if (old.published === true) {
      // Kev, 2026-09-07 (source-of-truth bug: dashboard showed the new
      // available_date, but the public website kept showing the old one
      // — e.g. "October" — after a plain field edit). The sync above only
      // ever fired when THIS request explicitly flipped published:true;
      // an edit to an ALREADY-live listing (the far more common case —
      // changing the date, price, beds… days after it first went live)
      // never touched newVals.published at all, so website_properties was
      // never told anything had changed. Reached only when THIS request did
      // not touch `published` at all (both branches above already handle an
      // explicit true/false). Any edit to a field the sync actually reads
      // must re-sync a listing that is already public — same best-effort
      // contract (never fails the edit itself).
      const WEBSITE_RELEVANT = ['property_type', 'town', 'sub_location', 'bedrooms', 'bathrooms',
        'size_sqm', 'longlet_price', 'sale_price', 'available_status', 'available_date', 'available_until', 'description',
        // ARGUS property intelligence (2026-09-23): a direct human tag edit
        // (EDITABLE loop above) or the auto-re-extraction right after the
        // main UPDATE both set newVals.feature_tags — either one must
        // reach website_properties without waiting for a re-upload.
        'feature_tags']
      if (leaseTouched || WEBSITE_RELEVANT.some(f => newVals[f] !== undefined)) {
        try {
          website = await require('../services/websiteSync').syncPropertyToWebsite(id)
        } catch (err) {
          log.error('crm/property patch: website re-sync (already-published edit) failed', { id, err: err.message })
          website = { ok: false, reason: 'error', detail: err.message }
        }
      }
    }

    // Kev's Prompt C, events PRICE UPDATED / AVAILABILITY UPDATED / RENTED —
    // same choke point every property edit already passes through. Best-
    // effort, fire-and-forget: a matching hiccup must never fail the actual
    // edit the agent is waiting on.
    const matchEngine = require('../services/matchEngine')
    const statusChanged = newVals.available_status !== undefined && newVals.available_status !== old.available_status
    // Kev's 2026-09-15 hotfix (spec item 3, canonical propagation: "no
    // surface should keep an old cached... wrong bath count"): price and
    // status used to be the only two fields that ever touched
    // property_matches. A plain bedrooms/bathrooms/town correction left
    // every EXISTING match's score/reasons (computed against the OLD value)
    // sitting there forever — matchPropertyToClients() only INSERTS new
    // rows and skips a pair that already has one (its own "existing rows,
    // continue" guard), so it can never refresh a stale one on its own.
    // Every field scoreMatch()/scoreLocation() actually reads is covered
    // here now, not just the two CRM happened to already wire.
    const MATCH_RELEVANT_FIELDS = ['longlet_price', 'sale_price', 'bedrooms', 'bathrooms',
      'town', 'sub_location', 'available_status', 'available_date', 'shortlet',
      'pets_allowed', 'subletting_considered']
    const matchRelevantChanged = MATCH_RELEVANT_FIELDS.some(f =>
      newVals[f] !== undefined && newVals[f] !== old[f])
    const nowOfferable = matchEngine.isOfferable({ ...old, ...newVals })

    if (matchRelevantChanged) {
      // Always invalidate first — a stale pending match must never survive
      // an edit, offerable or not afterwards.
      matchEngine.invalidateMatchesForProperty(id, statusChanged ? `available_status:${newVals.available_status}` : 'field_edit')
        .catch(err => log.warn('crm/property patch: match invalidation failed', { id, err: err.message }))
      if (nowOfferable) {
        // Fresh matches against the corrected data — same engine as NEW PROPERTY.
        matchEngine.matchPropertyToClients(id)
          .catch(err => log.warn('crm/property patch: match-on-update failed', { id, err: err.message }))
      }
      // ARGUS Agent Notification Engine (Kev, 2026-09-16): the same
      // "something a client/agent would care about changed" signal this
      // block already computed also drives agent saved-search notifications
      // — PROPERTY_PRICE_CHANGED / PROPERTY_AVAILABLE_FROM_CHANGED /
      // PROPERTY_LEASE_TYPE_CHANGED all collapse to one PROPERTY_UPDATED
      // call here; the engine's own version-fingerprint dedup (not this
      // event name) is what decides whether it's actually worth sending.
      require('../services/notificationEngine').evaluateSavedSearchesForProperty(id, 'PROPERTY_UPDATED')
        .catch(err => log.warn('crm/property patch: saved-search notify failed', { id, err: err.message }))
    }

    // Global property sanity check (Phase 1, 2026-09-17) — a SANITY TRIGGER
    // surfaced to the editing agent, never a block: a genuinely large
    // property (6 real bedrooms) is allowed through, this just flags it for
    // a second look. Logged into property_activities (not significant —
    // doesn't affect any bonus) so it's visible in the activity history too.
    // Field provenance (Phase B, 2026-09-18) — a human CRM correction is the
    // HIGHEST trust tier in the source-priority list (explicit human CRM
    // correction > explicit Owner WhatsApp statement > trusted structured
    // source field > website marketing text > AI inference), so every
    // changed field here always gets appended to field_provenance
    // regardless of what a lower-tier source previously recorded — this is
    // the human overriding whatever came before, and the history is KEPT
    // (appended, never replaced) rather than erasing the prior entry.
    const PROVENANCE_FIELD_MAP = {
      town: 'locality', street: 'address', property_type: 'property_type',
      bedrooms: 'bedrooms', bathrooms: 'bathrooms', size_sqm: 'sqm',
      longlet_price: 'price', lease_type: 'lease_type', available_date: 'availability',
      // ARGUS property intelligence (2026-09-23): a DIRECT feature_tags PATCH
      // only — the auto-re-extraction above writes its own
      // 'feature_tags_reextracted'/'feature_tags_conflict' property_activities
      // entries instead (a system action, not a human correction, so it does
      // not belong at this "highest trust tier").
      ...(b.feature_tags !== undefined ? { feature_tags: 'feature:human_correction' } : {}),
    }
    const provenanceUpdates = Object.entries(PROVENANCE_FIELD_MAP)
      .filter(([col]) => newVals[col] !== undefined)
      .map(([col, field]) => [field, newVals[col]])
    if (provenanceUpdates.length) {
      const entry = (value) => ({
        value, source_type: 'crm_correction', source_reference: `agent:${a.id}`,
        observed_at: new Date().toISOString(), confidence: 'confirmed', explicit_or_inferred: 'explicit', updated_by: `agent:${a.id}`,
      })
      // jsonb_set with a fallback empty array per field, appending (not
      // overwriting) so earlier entries (e.g. the website-scrape provenance
      // Base Inventory promotion seeds) stay in the array as history.
      for (const [field, value] of provenanceUpdates) {
        await db.query(
          `UPDATE properties
              SET field_provenance = jsonb_set(
                    COALESCE(field_provenance, '{}'::jsonb),
                    ARRAY[$2::text],
                    COALESCE(field_provenance -> $2, '[]'::jsonb) || $3::jsonb,
                    true)
            WHERE id = $1`,
          [id, field, JSON.stringify([entry(value)])]
        ).catch(err => log.warn('crm/property patch: provenance write failed (non-fatal)', { id, field, err: err.message }))
      }
    }

    let sanityWarnings = null
    try {
      const sanity = require('../services/propertySanity').validateProperty(merged)
      if (sanity.hasSuspicious) {
        sanityWarnings = sanity.suspicious.map(f => sanity.fields[f].note)
        await db.query(
          `INSERT INTO property_activities (property_id, agent_id, activity_type, details, is_significant)
           VALUES ($1,$2,'sanity_warning',$3,FALSE)`,
          [id, a.id, JSON.stringify({ fields: sanity.suspicious, notes: sanityWarnings })])
      }
    } catch (err) {
      log.warn('crm/property patch: sanity check failed (non-fatal)', { id, err: err.message })
    }

    res.json({ ok: true, completeness, activitiesLogged: acts.length, reassignmentsLogged, website, pendingChange, sanityWarnings, featureTagsConflict })
  } catch (err) {
    log.error('crm/property patch error', err)
    res.status(500).json({ error: 'Failed to update' })
  }
})

// ── Manual category override (Phase 1, 2026-09-17) — a ROUTING decision the
// Agent/Admin makes when ARGUS can't confidently classify a listing (e.g.
// CATEGORY_REVIEW_REQUIRED). Never touches canonical bedrooms/price/type —
// see categoryClassifier.js's classifyProperty(payload, {manualOverride}).
// Object-level check, not just "authenticated": an agent may override only
// their OWN listings; admin may override any (same ownership rule DELETE
// /properties/:id above already applies).
async function assertPropertyAccess(req, res, id) {
  const a = await liveAgent(req.agent.id)
  const cur = await db.query(`SELECT listed_by_agent_id FROM properties WHERE id=$1`, [id])
  if (!cur.rows.length) { res.status(404).json({ error: 'Not found' }); return false }
  if (a.role !== 'admin' && cur.rows[0].listed_by_agent_id !== a.id) { res.status(403).json({ error: 'Not allowed' }); return false }
  return true
}
router.post('/properties/:id/category-override', auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    if (!(await assertPropertyAccess(req, res, id))) return
    const { key, reason } = req.body || {}
    const { setCategoryOverride } = require('../services/categoryPublisher')
    const result = await setCategoryOverride(id, key, req.agent.id, reason)
    res.json(result)
  } catch (err) {
    log.error('crm/property category-override set error', err)
    res.status(400).json({ error: err.message || 'Failed to set category override' })
  }
})

router.post('/properties/:id/category-override/reset', auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    if (!(await assertPropertyAccess(req, res, id))) return
    const { resetCategoryOverride } = require('../services/categoryPublisher')
    const result = await resetCategoryOverride(id, req.agent.id)
    res.json(result)
  } catch (err) {
    log.error('crm/property category-override reset error', err)
    res.status(400).json({ error: err.message || 'Failed to reset category override' })
  }
})

// ── Pending classification changes (Kev, 2026-09-17) — the dashboard
// notification admins confirm before a non-admin's lease_type change (or
// future "und so on" classification field) actually applies. ────────────────
router.get('/property-changes/pending', auth, adminOnly, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT c.*, a.name AS proposed_by_name, a.username AS proposed_by_username
         FROM property_pending_changes c
         LEFT JOIN agents a ON a.id = c.proposed_by_agent_id
        WHERE c.status = 'pending' ORDER BY c.created_at ASC`)
    res.json(rows)
  } catch (err) {
    log.error('property-changes list failed', err)
    res.status(500).json({ error: 'Failed' })
  }
})

router.post('/property-changes/:id/approve', auth, adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const cur = await db.query(`SELECT * FROM property_pending_changes WHERE id = $1 AND status = 'pending'`, [id])
    const change = cur.rows[0]
    if (!change) return res.status(404).json({ error: 'Not found or already resolved' })
    // Only lease_type exists today (see the PATCH route above) — this stays
    // a small explicit switch rather than a dynamic `SET ${field} = ...`,
    // so a bad row can never turn into an arbitrary-column SQL write.
    if (change.field === 'lease_type') {
      await db.query(`UPDATE properties SET lease_type = $1, updated_at = NOW() WHERE id = $2`, [change.new_value, change.property_id])
    } else if (change.field === 'rental_modes') {
      const rm = require('../services/rentalModes')
      const modes = rm.normalizeModes(change.new_value)
      await db.query(
        `UPDATE properties SET rental_modes = $1, lease_type = COALESCE($2, lease_type), updated_at = NOW() WHERE id = $3`,
        [modes.length ? modes : null, modes.length ? rm.legacyLeaseType(modes) : null, change.property_id])
    } else {
      return res.status(400).json({ error: `Unknown pending-change field: ${change.field}` })
    }
    await db.query(
      `UPDATE property_pending_changes SET status = 'approved', resolved_by_agent_id = $1, resolved_at = NOW() WHERE id = $2`,
      [req.agent.id, id])
    res.json({ ok: true })
  } catch (err) {
    log.error('property-changes approve failed', err)
    res.status(500).json({ error: 'Failed' })
  }
})

router.post('/property-changes/:id/reject', auth, adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const { rows } = await db.query(
      `UPDATE property_pending_changes SET status = 'rejected', resolved_by_agent_id = $1, resolved_at = NOW()
        WHERE id = $2 AND status = 'pending' RETURNING id`,
      [req.agent.id, id])
    if (!rows.length) return res.status(404).json({ error: 'Not found or already resolved' })
    res.json({ ok: true })
  } catch (err) {
    log.error('property-changes reject failed', err)
    res.status(500).json({ error: 'Failed' })
  }
})

// DELETE /api/crm/properties/:id
// Kev, 2026-09-11 (real incident: this 500'd on "update or delete on table
// properties violates foreign key constraint swipe_links_property_id_fkey").
// A hard SQL DELETE was never actually viable against this schema: 17
// tables FK-reference properties, several (property_activities, book_relay_
// threads, property_viewings, ...) hold real audit/business history with
// NOT NULL property_id columns, so no delete could ever succeed once a
// property had any real activity on it — which is every property that's
// ever been through !upload (property_activities gets a row on creation,
// unconditionally). Reuses services/boardAction.js's own archive() —
// exactly the same soft-delete this codebase already uses everywhere else
// on the board ("Nothing is deleted... only available_status moves") —
// instead of inventing a second, competing delete semantic.
router.delete('/properties/:id', auth, async (req, res) => {
  try {
    const a = await liveAgent(req.agent.id)
    const id = parseInt(req.params.id)
    const cur = await db.query(`SELECT listed_by_agent_id FROM properties WHERE id=$1`, [id])
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' })
    if (a.role !== 'admin' && cur.rows[0].listed_by_agent_id !== a.id)
      return res.status(403).json({ error: 'Not allowed' })
    const { archive } = require('../services/boardAction')
    const plan = await archive({ propertyId: id, agentId: a.id, reason: 'Deleted from CRM', changedBy: 'agent', oldStatus: null })
    if (!plan.ok) return res.status(409).json({ error: plan.reason || 'Already archived' })

    // archive() only returns the {update, activity} SQL plan — same
    // BEGIN/UPDATE/INSERT/COMMIT shape routes/crmScheduleBoard.js's own
    // runPlan() already uses for this exact plan object, inlined here
    // rather than importing a sibling route file's local helper.
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const upd = await client.query(plan.update.sql, plan.update.params)
      if (!upd.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Already archived' }) }
      await client.query(plan.activity.sql, plan.activity.params)
      await client.query('COMMIT')
    } catch (e) {
      try { await client.query('ROLLBACK') } catch { /* connection already gone */ }
      throw e
    } finally {
      client.release()
    }
    res.json({ ok: true, archived: true })
  } catch (err) {
    log.error('crm/property delete error', err)
    res.status(500).json({ error: 'Failed' })
  }
})

// POST /api/crm/properties/:id/images  (multipart)  OR  POST with {images:[urls]} to attach pre-uploaded
router.post('/properties/:id/images', auth, upload.array('images', 12), async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const urls = []
    for (const file of (req.files || [])) {
      try {
        const result = await cloudinary.uploader.upload(file.path, {
          folder: 'crm-properties',
          transformation: [{ width: 1600, crop: 'limit', quality: 'auto', fetch_format: 'auto' }],
        })
        const thumb = result.secure_url.replace('/upload/', '/upload/w_400,h_300,c_fill,q_auto/')
        urls.push({ url: result.secure_url, thumbnail: thumb })
      } finally { fs.unlink(file.path, () => {}) }
    }
    const cur = await db.query(
      `SELECT images, public_payload, description, published, website_manually_hidden, ref
         FROM properties WHERE id=$1`, [id])
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' })
    const row = cur.rows[0]
    const existing = Array.isArray(row.images) ? row.images : safeJson(row.images, [])
    const merged = existing.concat(urls)

    // Kev, 2026-09-01 ("wenn Bilder später kommen, website_listed -> true,
    // außer manuell versteckt"): public_payload.images is what
    // services/websiteSync.js's isPublishReady()/syncPropertyToWebsite()
    // actually read — properties.images (just updated above) is NOT the
    // same field, so it has to be mirrored here or a property that got its
    // first photos through this route would never look publish-ready no
    // matter how many photos it has.
    const publicPayload = { ...(row.public_payload || {}), images: merged.map(i => i.url).filter(Boolean) }
    const willBeReady = require('../services/websiteSync').isPublishReady({
      public_payload: publicPayload, description: row.description,
    })
    const shouldAutoPublish = willBeReady && row.published !== true && row.website_manually_hidden !== true

    const sets = ['images=$2', 'public_payload=$3', 'updated_at=NOW()']
    const params = [id, JSON.stringify(merged), JSON.stringify(publicPayload)]
    if (shouldAutoPublish) { params.push(true); sets.push(`published=$${params.length}`) }
    await db.query(`UPDATE properties SET ${sets.join(', ')} WHERE id=$1`, params)

    if (shouldAutoPublish) {
      try {
        await require('../services/websiteSync').syncPropertyToWebsite(id)
        await require('../services/shareLinks').getOrCreatePropertyLink(id).catch(() => {})
        log.info('crm/property images: auto-published (now has photos + description)', { id, ref: row.ref })
      } catch (err) {
        log.error('crm/property images: auto-publish sync failed', { id, err: err.message })
      }
    }

    res.json({ ok: true, images: merged, published: shouldAutoPublish ? true : row.published })
  } catch (err) {
    log.error('crm/property images error', err)
    res.status(500).json({ error: 'Upload failed: ' + err.message })
  }
})

// POST /api/crm/properties/:id/notify-clients
// Kev, 2026-09-06: the CLIENTGROUPS dashboard's "Find Matches Now" +
// per-match Gallery/Send Link buttons are a per-CLIENTGROUP pull model --
// matchPropertyToClients() above already computes matches on save/publish,
// but nothing ever pushed a fresh property straight out to every matching
// client from the PROPERTY side. This is that missing push: reuses
// matchEngine.computePropertyMatches() (the same pure compute the CRM
// board's own MATCH button calls, Property -> Clients direction) and
// clientAssistant.deliverMatchesToClient() (the SAME send primitive the
// dashboard buttons and the automatic proactive loop use, so dedup/daily-
// caps/history stay shared by construction -- no parallel send path).
// Only reaches clients who already have an established WhatsApp thread
// (an existing, enabled client_assistant_state) -- there is nowhere to
// send to otherwise. Already-sent-this-property clients are skipped
// (property_matches.sent_to_client), same rule eligibleMatchesForClient
// applies on the automatic side.
router.post('/properties/:id/notify-clients', auth, async (req, res) => {
  const id = parseInt(req.params.id)
  // ?dryRun=1 -- compute the same eligibility decisions with no send and no
  // DB write, so the dashboard button can show "this will message N clients"
  // before an agent commits to it. Same idiom as services/availability.js's
  // own dryRun flag.
  const dryRun = req.query.dryRun === '1' || req.body?.dryRun === true
  try {
    const matchEngine = require('../services/matchEngine')
    const clientAssistant = require('../services/clientAssistant')
    const { property, matches } = await matchEngine.computePropertyMatches(id, { limit: 200 })
    if (!property) return res.status(404).json({ error: 'Not found or not offerable' })
    if (!matches.length) return res.json({ ok: true, dryRun, matched: 0, sent: 0, skipped: 0, results: [] })

    const clientIds = matches.map(m => m.client.id)
    const already = await db.query(
      `SELECT client_id FROM property_matches
        WHERE property_id = $1 AND client_id = ANY($2) AND sent_to_client = TRUE`,
      [id, clientIds])
    const alreadySent = new Set(already.rows.map(r => r.client_id))

    const results = []
    for (const m of matches) {
      if (alreadySent.has(m.client.id)) {
        results.push({ clientId: m.client.id, ok: false, reason: 'already_sent' })
        continue
      }
      const states = await clientAssistant.getStatesByClientId(m.client.id)
      const state = states.find(s => s.enabled)
      if (!state) {
        results.push({ clientId: m.client.id, ok: false, reason: 'no_active_thread' })
        continue
      }
      if (dryRun) {
        results.push({ clientId: m.client.id, stateId: state.id, ok: true, wouldSend: true, score: m.score })
        continue
      }
      const outcome = await clientAssistant.deliverMatchesToClient(
        state, [{ property, score: m.score, reasons: m.reasons }],
        { trigger: 'manual', tone: 'update', composedBy: req.agent?.username || null })
      results.push({ clientId: m.client.id, stateId: state.id, ...outcome })
    }

    const sent = results.filter(r => r.ok).length
    log.info('crm/property notify-clients', { id, ref: property.ref, dryRun, matched: matches.length, sent })
    res.json({ ok: true, dryRun, matched: matches.length, sent, skipped: results.length - sent, results })
  } catch (err) {
    log.error('crm/property notify-clients error', { id, err: err.message })
    res.status(500).json({ error: 'Failed to notify clients' })
  }
})

// Standalone uploader (used by Add+ before the property exists)
router.post('/upload', auth, upload.array('images', 12), async (req, res) => {
  try {
    const urls = []
    for (const file of (req.files || [])) {
      try {
        const result = await cloudinary.uploader.upload(file.path, {
          folder: 'crm-properties',
          transformation: [{ width: 1600, crop: 'limit', quality: 'auto', fetch_format: 'auto' }],
        })
        const thumb = result.secure_url.replace('/upload/', '/upload/w_400,h_300,c_fill,q_auto/')
        urls.push({ url: result.secure_url, thumbnail: thumb })
      } finally { fs.unlink(file.path, () => {}) }
    }
    res.json({ ok: true, images: urls })
  } catch (err) {
    log.error('crm/upload error', err)
    res.status(500).json({ error: 'Upload failed: ' + err.message })
  }
})

// ── OWNERS ──────────────────────────────────────────────────────────────────────
// GET /api/crm/owners?search=
router.get('/owners', auth, async (req, res) => {
  try {
    const s = (req.query.search || '').trim()
    const params = []
    let where = ''
    if (s) {
      params.push(`%${s}%`, `%${digits(s) || '___nomatch___'}%`)
      where = `WHERE oc.name ILIKE $1 OR oc.phone_normalized ILIKE $2`
    }
    const r = await db.query(`
      SELECT oc.id, oc.name, oc.phone_normalized, oc.email, oc.created_at,
             cre.name AS created_by_name, cre.username AS created_by_username,
             (SELECT COUNT(*) FROM properties p WHERE p.owner_id = oc.id AND NOT p.is_staging) AS prop_count
        FROM owner_contacts oc
        LEFT JOIN agents cre ON cre.id = oc.created_by_agent_id
        ${where}
        ORDER BY (SELECT COUNT(*) FROM properties p WHERE p.owner_id = oc.id AND NOT p.is_staging) DESC, oc.created_at DESC
        LIMIT 200`, params)
    res.json({
      owners: r.rows.map(o => ({
        id: o.id, name: o.name,
        phoneMasked: maskPhone(o.phone_normalized), emailMasked: maskEmail(o.email),
        hasPhone: !!o.phone_normalized, hasEmail: !!o.email,
        props: Number(o.prop_count) || 0,
        by: o.created_by_name || o.created_by_username || null,
        since: o.created_at,
      })),
    })
  } catch (err) {
    log.error('crm/owners list error', err)
    res.status(500).json({ error: 'Failed' })
  }
})

// GET /api/crm/owners/check?phone=  (Add+ step 1)
router.get('/owners/check', auth, async (req, res) => {
  try {
    const phoneNorm = digits(req.query.phone)
    if (!phoneNorm) return res.status(400).json({ error: 'phone required' })
    const r = await db.query(`
      SELECT oc.id, oc.name, oc.created_at, cre.name AS created_by_name, cre.username AS created_by_username
        FROM owner_contacts oc LEFT JOIN agents cre ON cre.id = oc.created_by_agent_id
       WHERE oc.phone_normalized = $1`, [phoneNorm])
    if (!r.rows.length) return res.json({ exists: false })
    const o = r.rows[0]
    res.json({ exists: true, owner: { id: o.id, name: o.name, createdBy: o.created_by_name || o.created_by_username, since: o.created_at } })
  } catch (err) {
    log.error('crm/owners check error', err)
    res.status(500).json({ error: 'Failed' })
  }
})

// A property is only a real, workable listing once it has a ref, a
// locality, a price and a type — bedrooms too, outside 'commercial'. Same
// gate as routes/crmScheduleBoard.js's REAL_LISTING_WHERE (2026-09-07 ghost-
// listing fix) — an owner-conversation draft (services/autoOwnerConversation.js
// writeEntityDraft/writeSummaryDraft, status 'pending_check') must never
// render as if it were a normal listing on the owner's own profile either.
// Rows failing this are counted separately (`incompleteCount`) so the
// profile can say "3 more pending completion" instead of just hiding them.
const REAL_PROPERTY_WHERE = `
  (p.ref IS NOT NULL AND btrim(p.ref) <> '')
  AND (p.town IS NOT NULL AND btrim(p.town) <> '')
  AND COALESCE(p.longlet_price, p.sale_price) IS NOT NULL
  AND (p.property_type IS NOT NULL AND btrim(p.property_type) <> '')
  AND (LOWER(p.property_type) = 'commercial' OR p.bedrooms IS NOT NULL)
`

// GET /api/crm/owners/:id — Owner Profile V2 (Kev, 2026-09-07). Everything
// a "same identity, whichever WA account talks to them" owner profile needs
// in ONE call: core contact + every known phone variant, the properties
// that are actually real listings (ghost-filtered, see REAL_PROPERTY_WHERE),
// the preference "Karteikarte" (OGX-1, protected-class-tagged), every
// document, the `!o` automation state + scheduled campaigns (if any — an
// owner who has never been `!o`'d simply gets automation:null, not an
// error), which WA account(s) actually talk to them and how warm that
// relationship reads, and a merged activity timeline. Reuses
// services/ownerAssistant.js, services/ownerPreferenceProfile.js and
// services/scheduledOutreach.js verbatim — this route does not reimplement
// any of routes/crmOwnergroups.js's logic, only reshapes it around
// owner_contacts.id instead of owner_assistant_state.id so it works for
// every owner, not only ones with an active automation row.
router.get('/owners/:id', auth, async (req, res) => {
  try {
    const a = await liveAgent(req.agent.id)
    const id = parseInt(req.params.id)
    const o = await db.query(`
      SELECT oc.*, cre.name AS created_by_name, cre.username AS created_by_username
        FROM owner_contacts oc LEFT JOIN agents cre ON cre.id = oc.created_by_agent_id
       WHERE oc.id=$1`, [id])
    if (!o.rows.length) return res.status(404).json({ error: 'Not found' })
    const row = o.rows[0]
    // protected-characteristic notes are admin-only (services/contactNotes.js)
    if (a.role !== 'admin') delete row.owner_compliance_notes
    const params = [id]
    const vis = a.role === 'admin' ? 'TRUE'
      : (params.push(a.id), `(p.is_exclusive=FALSE OR p.listed_by_agent_id=$2 OR p.exclusive_until < CURRENT_DATE)`)

    const [props, incompleteCount, phoneVariants, accountLabels, preferenceComparison, documents, states, events, campaigns] = await Promise.all([
      db.query(`${PROP_SELECT} WHERE p.owner_id = $1 AND ${vis} AND ${REAL_PROPERTY_WHERE} ORDER BY p.created_at DESC`, params),
      db.query(`SELECT COUNT(*)::int AS n FROM properties p WHERE p.owner_id = $1 AND NOT (${REAL_PROPERTY_WHERE})`, [id]),
      db.query(`SELECT phone_normalized, is_primary FROM owner_phone_variants WHERE contact_id = $1 ORDER BY is_primary DESC, created_at ASC`, [id]),
      db.query(`SELECT account_session, label, total_msgs_in, total_msgs_out, last_reply_at, last_we_sent_at,
                       consecutive_no_reply_count, last_outreach_at
                  FROM owner_account_labels WHERE contact_id = $1 ORDER BY last_reply_at DESC NULLS LAST, updated_at DESC`, [id]),
      ownerPreferenceProfile.getProfileComparison(id),
      db.query(`SELECT d.id, d.filename, d.url, d.uploaded_by, d.created_at, d.category, d.notes,
                       d.property_id, p.ref AS property_ref
                  FROM owner_documents d LEFT JOIN properties p ON p.id = d.property_id
                 WHERE d.owner_contact_id = $1 ORDER BY d.created_at DESC`, [id]),
      db.query(`SELECT id, chat_id, session, enabled, status, checkin_min_days, checkin_max_days,
                       last_action, last_action_at, pause_until, updated_at
                  FROM owner_assistant_state WHERE owner_contact_id = $1 ORDER BY updated_at DESC`, [id]),
      db.query(`SELECT oae.kind, oae.decision, oae.reason, oae.detail, oae.created_at
                  FROM owner_assistant_events oae
                  JOIN owner_assistant_state oas ON oas.id = oae.state_id
                 WHERE oas.owner_contact_id = $1 ORDER BY oae.created_at DESC LIMIT 30`, [id]),
      scheduledOutreach.listForOwner(id),
    ])

    // Merge automation events with the properties' own activity log into one
    // timeline (History tab) — same "one place, not six tabs" principle the
    // whole redesign is about. Capped and sorted client-agnostic (server
    // does the merge+sort so the frontend never has to reconcile two feeds).
    const propActivities = props.rows.length
      ? await db.query(
          `SELECT pa.created_at, pa.activity_type, pa.details, pa.is_significant,
                  p.id AS property_id, p.ref AS property_ref, COALESCE(ag.name, ag.username) AS agent_name
             FROM property_activities pa
             JOIN properties p ON p.id = pa.property_id
             LEFT JOIN agents ag ON ag.id = pa.agent_id
            WHERE pa.property_id = ANY($1::int[])
            ORDER BY pa.created_at DESC LIMIT 40`,
          [props.rows.map(p => p.id)])
      : { rows: [] }
    const history = [
      ...events.rows.map(e => ({ at: e.created_at, kind: 'automation', label: e.kind, detail: e.reason || e.detail || null })),
      ...propActivities.rows.map(pa => ({
        at: pa.created_at, kind: 'property', label: pa.activity_type, detail: pa.details || null,
        propertyId: pa.property_id, propertyRef: pa.property_ref, agent: pa.agent_name, significant: !!pa.is_significant,
      })),
    ].sort((x, y) => new Date(y.at) - new Date(x.at)).slice(0, 50)

    // Relationship warmth — the account with the most recent reply speaks
    // for the relationship; an owner with 3 dead accounts and 1 warm one
    // reads as warm, not as an average.
    const warmestAccount = accountLabels.rows[0] || null

    // Next automation contact — the soonest pause_until across every armed
    // state row this owner has (they can have more than one WA account
    // running `!o` independently).
    const nextAutomationAt = states.rows
      .map(s => s.pause_until)
      .filter(Boolean)
      .sort((x, y) => new Date(x) - new Date(y))[0] || null

    // "Next check" per property — the soonest still-open availability_checks
    // row (services/availability.js / the !av / board Fall-A pipeline, see
    // today's 2026-09-07 !av-tracking fix). One extra query, only for this
    // owner's own properties, not a new tracking concept.
    const pendingChecks = props.rows.length
      ? await db.query(
          `SELECT DISTINCT ON (property_id) property_id, sent_at, status
             FROM availability_checks WHERE property_id = ANY($1::int[]) AND status = 'awaiting'
            ORDER BY property_id, sent_at DESC`,
          [props.rows.map(p => p.id)])
      : { rows: [] }
    const pendingByProperty = new Map(pendingChecks.rows.map(c => [c.property_id, c.sent_at]))
    const shapedProperties = props.rows.map(p => ({ ...shapeProperty(p), pendingCheckSentAt: pendingByProperty.get(p.id) || null }))

    res.json({
      owner: {
        id: row.id, name: row.name,
        phoneMasked: maskPhone(row.phone_normalized), emailMasked: maskEmail(row.email),
        hasPhone: !!row.phone_normalized, hasEmail: !!row.email,
        createdBy: row.created_by_name || row.created_by_username || null,
        since: row.created_at, status: row.status,
        location: row.location || null, propertyType: row.property_type || null,
        avatarUrl: row.avatar_url || null, coverUrl: row.cover_url || null,
        lastContactAt: row.last_contact_at, lastReplyAt: row.last_reply_at,
        replyCount: row.reply_count || 0, outreachCount: row.outreach_count || 0,
        nextReachAt: row.next_reach_at, doNotContact: !!row.do_not_contact,
        doNotContactReason: row.do_not_contact_reason || null,
        // Owner Profile V2 (2026-09-07): a Vertex AI 403 (bad service-account
        // permissions on the classification job — separate, pre-existing
        // backend bug, not touched here) has been writing its OWN raw error
        // text into conversation_summary for every owner it ever ran on
        // (1302 of 1302 non-empty rows, checked live). This UI is the first
        // place that ever rendered the column, so it is the first place the
        // corruption became visible — never hand it to a client display as
        // if it were a real summary. Flagged for Kev separately; this only
        // stops the symptom from reaching the page.
        conversationSummary: looksLikeRealSummary(row.conversation_summary) ? row.conversation_summary : null,
        lastReplyQuote: looksLikeRealReplyQuote(row.last_reply_quote) ? row.last_reply_quote : null,
        phoneVariants: phoneVariants.rows.map(v => ({ phoneMasked: maskPhone(v.phone_normalized), primary: !!v.is_primary })),
        warmth: warmestAccount ? warmestAccount.label : null,
        ...(a.role === 'admin' ? { complianceNotes: row.owner_compliance_notes || null } : {}),
      },
      properties: shapedProperties,
      incompleteCount: incompleteCount.rows[0].n,
      accountLabels: accountLabels.rows,
      preferences: preferenceComparison,
      documents: documents.rows,
      automation: {
        states: states.rows,
        nextAutomationAt,
        campaigns,
      },
      history,
    })
  } catch (err) {
    log.error('crm/owner detail error', err)
    res.status(500).json({ error: 'Failed' })
  }
})

// PATCH /api/crm/owners/:id — the header's "Edit contact" action. Deliberately
// narrow: name/location/property_type are free-text context fields already on
// owner_contacts; phone/email are NOT editable here — those are identity, and
// changing them is a merge/dedupe operation (owner_phone_variants), not a
// plain field edit. do_not_contact has its own reason field, same shape the
// backend's own automation code already writes.
// Move an owner-wide operational signal onto one concrete property/block.
// The owner profile uses this for the second-click scope action. Context-only
// protected-characteristic statements are never accepted by this endpoint.
router.post('/owners/:id/preferences/:preferenceId/scope', auth, async (req, res) => {
  try {
    const ownerId = parseInt(req.params.id)
    const preferenceId = parseInt(req.params.preferenceId)
    const propertyId = parseInt(req.body && req.body.propertyId)
    if (!ownerId || !preferenceId || !propertyId) return res.status(400).json({ error: 'owner, preference and property required' })
    const own = await db.query('SELECT 1 FROM properties WHERE id=$1 AND owner_id=$2', [propertyId, ownerId])
    if (!own.rows.length) return res.status(400).json({ error: 'Property does not belong to this owner' })
    const pref = await db.query('SELECT field FROM owner_tenant_preferences WHERE id=$1 AND owner_contact_id=$2', [preferenceId, ownerId])
    if (!pref.rows.length) return res.status(404).json({ error: 'Preference not found' })
    if (ownerPreferenceProfile.isContextOnlyField(pref.rows[0].field)) return res.status(400).json({ error: 'Context-only notes cannot become property rules' })
    const moved = await ownerPreferenceProfile.movePreferenceToProperty(ownerId, preferenceId, propertyId)
    await db.query(
      `INSERT INTO property_activities (property_id, agent_id, activity_type, details, is_significant)
       VALUES ($1,$2,'owner_preference_scoped',$3,TRUE)`,
      [propertyId, req.agent.id, JSON.stringify({ preferenceId, field: moved.field, value: moved.value, explicit: !!moved.is_explicit })])
    res.json({ ok: true, preference: moved })
  } catch (err) {
    log.error('crm/owner preference scope error', err)
    res.status(500).json({ error: 'Could not change preference scope' })
  }
})

router.patch('/owners/:id', auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id)
    const b = req.body || {}
    const EDITABLE = ['name', 'location', 'property_type']
    const sets = []
    const params = []
    for (const f of EDITABLE) {
      if (b[f] !== undefined) { params.push(String(b[f] || '').trim() || null); sets.push(`${f} = $${params.length}`) }
    }
    if (b.do_not_contact !== undefined) {
      params.push(!!b.do_not_contact); sets.push(`do_not_contact = $${params.length}`)
      params.push(b.do_not_contact ? (b.do_not_contact_reason ? String(b.do_not_contact_reason).slice(0, 200) : null) : null)
      sets.push(`do_not_contact_reason = $${params.length}`)
      sets.push(`do_not_contact_at = ${b.do_not_contact ? 'NOW()' : 'NULL'}`)
    }
    // Manual override for Flow C (Future Availability) — same column
    // services/ownerAssistant.js:maybeScheduleFutureContact sets
    // automatically when the owner names a date in chat; an agent can also
    // set/clear it directly from the Flows tab. null clears it back to "no
    // planned future contact".
    if (b.next_reach_at !== undefined) {
      params.push(b.next_reach_at || null); sets.push(`next_reach_at = $${params.length}`)
    }
    // 2026-09-21: "Do not contact until [date]" on the OWNER (every listing of theirs)
    // — a contact permission, not an availability state. Any date-ish input is
    // accepted ('2026-11-15', '15 Nov', '1/12/2026'); empty clears it.
    if (b.owner_contact_paused_until !== undefined) {
      const sg = require('../services/ownerSendGate')
      const until = b.owner_contact_paused_until
        ? (sg.parsePauseDate(b.owner_contact_paused_until) || (/^\d{4}-\d{2}-\d{2}$/.test(String(b.owner_contact_paused_until)) ? String(b.owner_contact_paused_until) : null))
        : null
      if (b.owner_contact_paused_until && !until) return res.status(400).json({ error: 'Could not read that date' })
      params.push(until); sets.push(`owner_contact_paused_until = $${params.length}`)
      params.push(until ? (b.owner_contact_pause_note ? String(b.owner_contact_pause_note).slice(0, 500) : null) : null)
      sets.push(`owner_contact_pause_note = $${params.length}`)
      sets.push(`owner_contact_paused_by = 'agent:${Number(req.agent.id) || 0}'`, 'owner_contact_paused_at = NOW()')
    }
    // Owner Notes: practical text → owner_notes; protected-characteristic text is
    // routed to the admin-only compliance column and never reaches matching.
    if (b.owner_notes !== undefined) {
      const s = require('../services/contactNotes').splitNote(b.owner_notes)
      params.push(s.actionable); sets.push(`owner_notes = $${params.length}`)
      if (s.compliance) {
        params.push(`[${new Date().toISOString().slice(0, 10)} agent:${Number(req.agent.id) || 0}] [compliance — non-actionable] ${s.compliance}`)
        sets.push(`owner_compliance_notes = CASE WHEN COALESCE(owner_compliance_notes,'') = '' THEN $${params.length} ELSE owner_compliance_notes || E'\\n' || $${params.length} END`)
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' })
    sets.push('updated_at = NOW()')
    params.push(id)
    const r = await db.query(`UPDATE owner_contacts SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`, params)
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (err) {
    log.error('crm/owner patch error', err)
    res.status(500).json({ error: 'Update failed' })
  }
})

// POST /api/crm/owners/:id/photo (multipart: file, kind='avatar'|'cover') —
// header profile photo / optional cover. Reuses the same Cloudinary upload
// helper as the document vault above (uploadDocBuffer works for any file
// type via resource_type:'auto', so it uploads an image just as well —
// no second Cloudinary helper for the same one config block).
router.post('/owners/:id/photo', auth, docUpload.single('file'), async (req, res) => {
  try {
    const ownerId = parseInt(req.params.id)
    const kind = req.body?.kind === 'cover' ? 'cover' : 'avatar'
    const exists = await db.query(`SELECT id FROM owner_contacts WHERE id = $1`, [ownerId])
    if (!exists.rows.length) return res.status(404).json({ error: 'Owner not found' })
    if (!req.file) return res.status(400).json({ error: 'No file' })
    if (!req.file.mimetype.startsWith('image/')) return res.status(400).json({ error: 'Images only' })
    const url = await uploadDocBuffer(req.file.buffer, req.file.mimetype, req.file.originalname)
    const col = kind === 'cover' ? 'cover_url' : 'avatar_url'
    await db.query(`UPDATE owner_contacts SET ${col} = $2, updated_at = NOW() WHERE id = $1`, [ownerId, url])
    res.json({ ok: true, kind, url })
  } catch (err) {
    log.error('crm/owner photo upload error', err)
    res.status(500).json({ error: 'Upload failed' })
  }
})

// POST /api/crm/owners/:id/automation/start — Flows tab "Start automation"
// for an owner who has NEVER had `!o` triggered from WhatsApp (no
// owner_assistant_state row exists yet at all, so none of
// routes/crmOwnergroups.js's state-id-keyed actions have anything to act
// on). Resolves a real (session, chatId) for this owner from
// owner_account_labels (whichever account most recently talked to them,
// same "who actually owns this relationship" read the CRM board's own
// account picking already relies on) and calls
// services/ownerAssistant.js:handleToggleCommand — the EXACT WhatsApp `!o`
// entry point, not a second creation path — so a state row made from the
// CRM behaves identically to one made by typing `!o` in the chat.
router.post('/owners/:id/automation/start', auth, async (req, res) => {
  try {
    const ownerId = parseInt(req.params.id)
    const owner = await db.query(`SELECT phone_normalized FROM owner_contacts WHERE id = $1`, [ownerId])
    if (!owner.rows.length) return res.status(404).json({ error: 'Owner not found' })
    const phone = owner.rows[0].phone_normalized
    if (!phone) return res.status(400).json({ error: 'Owner has no phone on file' })

    let session = req.body?.session
    if (!session) {
      const best = await db.query(
        `SELECT account_session FROM owner_account_labels WHERE contact_id = $1
          ORDER BY last_reply_at DESC NULLS LAST, updated_at DESC LIMIT 1`, [ownerId])
      session = best.rows[0]?.account_session || 'default'
    }
    const chatId = `${phone}@c.us`

    const ownerAssistant = require('../services/ownerAssistant')
    const existing = await ownerAssistant.getState(session, chatId)
    if (existing && existing.enabled) return res.json({ ok: true, alreadyEnabled: true, stateId: existing.id })
    const result = await ownerAssistant.handleToggleCommand({ session, chatId, senderPhone: null })
    if (result.toggledTo === 'REFUSED') return res.status(409).json({ ok: false, error: 'Owner is marked do-not-contact', reason: result.reason })
    res.json({ ok: true, stateId: result.stateId, session, chatId })
  } catch (err) {
    log.error('crm/owner automation start error', err)
    res.status(500).json({ error: 'Failed to start automation' })
  }
})

// ── OWNER DOCUMENT VAULT (Owner Profile V2, Kev, 2026-09-07) ────────────────
// Additive alongside routes/crmOwnergroups.js's own /:id/documents (which
// stays keyed on owner_assistant_state.id for the Ownergroups dashboard —
// left untouched). These are keyed directly on owner_contacts.id so every
// owner has a working document vault, not only ones with an active `!o`
// automation row. Same table (owner_documents), same Cloudinary folder, same
// upload contract — one storage layer, two entry points into it.
const DOCUMENT_CATEGORIES = ['invoice', 'contract', 'owner_document', 'property_document', 'agreement', 'other']

// POST /api/crm/owners/:id/documents  (multipart: files[], category?, property_id?, notes?)
router.post('/owners/:id/documents', auth, docUpload.array('files', 5), async (req, res) => {
  try {
    const ownerId = parseInt(req.params.id)
    const exists = await db.query(`SELECT id FROM owner_contacts WHERE id = $1`, [ownerId])
    if (!exists.rows.length) return res.status(404).json({ error: 'Owner not found' })
    const category = DOCUMENT_CATEGORIES.includes(req.body?.category) ? req.body.category : 'other'
    const propertyId = req.body?.property_id ? parseInt(req.body.property_id) : null
    const notes = req.body?.notes ? String(req.body.notes).slice(0, 500) : null
    const uploadedBy = req.agent?.username || req.agent?.name || 'agent'

    const files = req.files || []
    if (!files.length) return res.status(400).json({ error: 'No files' })
    const inserted = []
    for (const f of files) {
      const url = await uploadDocBuffer(f.buffer, f.mimetype, f.originalname)
      const r = await db.query(
        `INSERT INTO owner_documents (owner_contact_id, filename, url, uploaded_by, category, property_id, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, filename, url, uploaded_by, created_at, category, property_id, notes`,
        [ownerId, f.originalname, url, uploadedBy, category, propertyId, notes])
      inserted.push(r.rows[0])
    }
    res.json({ ok: true, documents: inserted })
  } catch (err) {
    log.error('crm/owner documents upload error', err)
    res.status(500).json({ error: 'Upload failed' })
  }
})

// PATCH /api/crm/owners/:id/documents/:docId  { category?, property_id?, notes? }
router.patch('/owners/:id/documents/:docId', auth, async (req, res) => {
  try {
    const ownerId = parseInt(req.params.id)
    const docId = parseInt(req.params.docId)
    const b = req.body || {}
    const sets = []
    const params = []
    if (b.category !== undefined) {
      if (!DOCUMENT_CATEGORIES.includes(b.category)) return res.status(400).json({ error: 'Invalid category' })
      params.push(b.category); sets.push(`category = $${params.length}`)
    }
    if (b.property_id !== undefined) { params.push(b.property_id || null); sets.push(`property_id = $${params.length}`) }
    if (b.notes !== undefined) { params.push(String(b.notes).slice(0, 500) || null); sets.push(`notes = $${params.length}`) }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' })
    params.push(docId, ownerId)
    const r = await db.query(
      `UPDATE owner_documents SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND owner_contact_id = $${params.length}
       RETURNING id, filename, url, uploaded_by, created_at, category, property_id, notes`, params)
    if (!r.rows.length) return res.status(404).json({ error: 'Document not found' })
    res.json({ ok: true, document: r.rows[0] })
  } catch (err) {
    log.error('crm/owner documents update error', err)
    res.status(500).json({ error: 'Update failed' })
  }
})

// DELETE /api/crm/owners/:id/documents/:docId
router.delete('/owners/:id/documents/:docId', auth, async (req, res) => {
  try {
    await db.query(`DELETE FROM owner_documents WHERE id = $1 AND owner_contact_id = $2`,
      [parseInt(req.params.docId), parseInt(req.params.id)])
    res.json({ ok: true })
  } catch (err) {
    log.error('crm/owner documents delete error', err)
    res.status(500).json({ error: 'Delete failed' })
  }
})

// GET /api/crm/owners/:id/upload-link — the OGX-3 self-upload link. SAME
// token shape routes/crmOwnergroups.js's own /:id/upload-link signs
// ({ ownerContactId, aud: 'owner-upload' }) so /owner-upload/[token]
// validates a token from either route identically — this is the direct
// owner_contacts.id path into the same mechanism, not a second one. Works
// for every owner (no automation row required), unlike the ownergroups
// version which needs a state row to resolve owner_contact_id from.
router.get('/owners/:id/upload-link', auth, async (req, res) => {
  try {
    const ownerId = parseInt(req.params.id)
    const exists = await db.query(`SELECT id FROM owner_contacts WHERE id = $1`, [ownerId])
    if (!exists.rows.length) return res.status(404).json({ error: 'Owner not found' })
    // Security audit finding (2026-09-17): this token never expired — a
    // forwarded/leaked upload link stayed valid forever. 90 days is
    // generous for a real document-upload workflow but not indefinite.
    const token = jwt.sign({ ownerContactId: ownerId, aud: 'owner-upload' }, JWT_SECRET, { expiresIn: '90d' })
    res.json({ token, path: `/owner-upload/${token}` })
  } catch (err) {
    log.error('crm/owner upload-link error', err)
    res.status(500).json({ error: 'Failed' })
  }
})

// ── REVEAL (Task 5) ──────────────────────────────────────────────────────────────
// POST /api/crm/reveal  { entity_type, entity_id, property_id? }
router.post('/reveal', auth, async (req, res) => {
  try {
    const a = await liveAgent(req.agent.id)
    if (!a) return res.status(401).json({ error: 'Account inactive' })
    const { entity_type, entity_id, property_id } = req.body || {}
    const allowed = ['owner_phone', 'owner_email', 'owner_alt_phone']
    if (!allowed.includes(entity_type) || !entity_id)
      return res.status(400).json({ error: 'Invalid reveal request' })

    const used = await revealsToday(a.id)
    if (used >= a.daily_reveal_limit)
      return res.status(403).json({ error: 'Daily reveal limit reached. Contact admin.', used, limit: a.daily_reveal_limit })

    const oc = await db.query(`SELECT phone_normalized, email, emails FROM owner_contacts WHERE id=$1`, [entity_id])
    if (!oc.rows.length) return res.status(404).json({ error: 'Owner not found' })
    let value = null
    if (entity_type === 'owner_phone') value = oc.rows[0].phone_normalized ? `+${oc.rows[0].phone_normalized}` : null
    else if (entity_type === 'owner_email') value = oc.rows[0].email || (Array.isArray(oc.rows[0].emails) ? oc.rows[0].emails[0] : null)
    else if (entity_type === 'owner_alt_phone') value = Array.isArray(oc.rows[0].emails) ? null : null
    if (!value) return res.status(404).json({ error: 'No value to reveal' })

    await db.query(
      `INSERT INTO pii_reveal_log (agent_id, entity_type, entity_id, property_id, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [a.id, entity_type, entity_id, property_id || null, clientIp(req), (req.headers['user-agent'] || '').slice(0, 400)])

    res.json({ value, expires_in: REVEAL_SECONDS, used: used + 1, limit: a.daily_reveal_limit })
  } catch (err) {
    log.error('crm/reveal error', err)
    res.status(500).json({ error: 'Reveal failed' })
  }
})

// ── FAVOURITES (per-agent) ───────────────────────────────────────────────────────
// GET /api/crm/favourites -> list of property_ids favourited by current agent
router.get('/favourites', auth, async (req, res) => {
  try {
    const r = await db.query(`SELECT property_id FROM agent_favourites WHERE agent_id=$1`, [req.agent.id])
    res.json({ favourites: r.rows.map(x => x.property_id) })
  } catch (err) { log.error('crm/favourites list error', err); res.status(500).json({ error: 'Failed' }) }
})
// POST /api/crm/favourites { property_id }
router.post('/favourites', auth, async (req, res) => {
  try {
    const pid = parseInt(req.body?.property_id)
    if (!pid) return res.status(400).json({ error: 'property_id required' })
    await db.query(
      `INSERT INTO agent_favourites (agent_id, property_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [req.agent.id, pid])
    res.json({ ok: true, fav: true })
  } catch (err) { log.error('crm/favourites add error', err); res.status(500).json({ error: 'Failed' }) }
})
// DELETE /api/crm/favourites/:property_id
router.delete('/favourites/:property_id', auth, async (req, res) => {
  try {
    await db.query(`DELETE FROM agent_favourites WHERE agent_id=$1 AND property_id=$2`,
      [req.agent.id, parseInt(req.params.property_id)])
    res.json({ ok: true, fav: false })
  } catch (err) { log.error('crm/favourites del error', err); res.status(500).json({ error: 'Failed' }) }
})

// ── DASHBOARD STATS ────────────────────────────────────────────────────────────
router.get('/stats', auth, async (req, res) => {
  try {
    const a = await liveAgent(req.agent.id)
    const vp = []
    const vis = visibilityClause(a, vp)
    // Kev, 2026-09-23 (Unwrap staging cleanup): NOT p.is_staging on all three —
    // an owner-conversation draft (services/autoOwnerConversation.js
    // writeDraftProperty/writeEntityDraft/writePortfolioDraft) is not yet a
    // real listing and must not inflate the dashboard totals, this agent's
    // own count, or falsely flag an owner as "hot" (>=2 properties) on the
    // strength of one real listing plus one still-staging draft.
    const total = await db.query(`SELECT COUNT(*)::int n FROM properties p WHERE ${vis} AND NOT p.is_staging`, vp)
    const mine = await db.query(`SELECT COUNT(*)::int n FROM properties WHERE listed_by_agent_id=$1 AND NOT is_staging`, [a.id])
    const hotOwners = await db.query(
      `SELECT COUNT(*)::int n FROM (SELECT owner_id FROM properties WHERE NOT is_staging GROUP BY owner_id HAVING COUNT(*) >= 2) t`)
    const recent = await db.query(`
      SELECT pa.activity_type, pa.created_at, pa.is_significant, p.ref, p.town,
             ag.name AS agent_name, ag.username AS agent_username
        FROM property_activities pa
        JOIN properties p ON p.id = pa.property_id
        LEFT JOIN agents ag ON ag.id = pa.agent_id
       ORDER BY pa.created_at DESC LIMIT 15`)
    res.json({
      totalListings: total.rows[0].n,
      myListings: mine.rows[0].n,
      hotOwners: hotOwners.rows[0].n,
      recent: recent.rows.map(x => ({
        type: x.activity_type, when: x.created_at, significant: x.is_significant,
        ref: x.ref, town: x.town, who: x.agent_name || x.agent_username,
      })),
    })
  } catch (err) {
    log.error('crm/stats error', err)
    res.status(500).json({ error: 'Failed' })
  }
})

// GET /api/crm/agents  (for filter dropdown; names only, no PII)
router.get('/agents', auth, async (_req, res) => {
  try {
    const r = await db.query(`SELECT id, name, username, role FROM agents WHERE active=TRUE ORDER BY id`)
    res.json({ agents: r.rows })
  } catch (err) { res.status(500).json({ error: 'Failed' }) }
})

// GET /api/crm/locations  (normalized list from the locations table)
function slugify(name) {
  return String(name || '').toLowerCase().trim()
    .replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}
router.get('/locations', auth, async (_req, res) => {
  try {
    const r = await db.query(
      `SELECT id, name, slug, region, COALESCE(is_region_any,FALSE) AS is_region_any
         FROM locations WHERE active=TRUE
        ORDER BY COALESCE(sort_order,0), name`)
    res.json({ locations: r.rows.map(x => x.name), items: r.rows })
  } catch (err) {
    log.error('crm/locations error', err)
    res.json({ locations: [], items: [] })
  }
})
// POST /api/crm/locations { name }  (admin only) — add a new canonical location
router.post('/locations', auth, adminOnly, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim()
    if (!name) return res.status(400).json({ error: 'name required' })
    const slug = slugify(name)
    if (!slug) return res.status(400).json({ error: 'invalid name' })
    const r = await db.query(
      `INSERT INTO locations (name, slug) VALUES ($1,$2)
       ON CONFLICT (slug) DO UPDATE SET active=TRUE RETURNING id, name, slug`, [name, slug])
    res.json({ ok: true, location: r.rows[0] })
  } catch (err) {
    log.error('crm/locations add error', err)
    res.status(500).json({ error: 'Failed' })
  }
})

// ── nightly exclusive auto-release (Task 8) ──────────────────────────────────────
// Self-contained; only flips is_exclusive on expired CRM properties. Touches nothing else.
try {
  cron.schedule('15 3 * * *', async () => {
    try {
      const r = await db.query(
        `UPDATE properties SET is_exclusive=FALSE, updated_at=NOW()
          WHERE is_exclusive=TRUE AND exclusive_until IS NOT NULL AND exclusive_until < CURRENT_DATE
          RETURNING id`)
      if (r.rows.length) log.info('crm: exclusive auto-release', { released: r.rows.length })
    } catch (e) { log.warn('crm exclusive auto-release failed', { err: e.message }) }
  })
} catch (e) { log.warn('crm cron schedule failed', { err: e.message }) }

module.exports = router
