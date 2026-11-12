require('dotenv').config()

const express = require('express')
const config  = require('./config')
const log     = require('./logger')
const db      = require('./db')
const { startWorkers } = require('./worker')
const { startCrons }   = require('./cron')
const webhookRoute     = require('./routes/webhook')
const activityHook     = require('./routes/activityHook')
const adminRoute       = require('./routes/admin')
const adminWebRoute    = require('./routes/adminWeb')
const propertiesRoute  = require('./routes/properties')
const clientsRoute     = require('./routes/clients')
const propertySubmitRoute = require('./routes/propertySubmit')
const referralSubmitRoute = require('./routes/referralSubmit')
const locationsRoute     = require('./routes/locations')
const contactsRoute     = require('./routes/contacts')
const adminStatsRoute  = require('./routes/adminStats')
const scheduleBoardRoute = require('./routes/scheduleBoard')
const scheduleBoardAuthRoute = require('./routes/scheduleBoardAuth')
const publicSubmissionsRoute = require('./routes/publicSubmissions')
const agentsRoute = require('./routes/agents')
const calendarRoute = require('./routes/calendar')
const path = require('path')
const agentWorkspaceRoute = require('./routes/agentWorkspace')
const swipeRoute = require('./routes/swipe')
const activityBoardRoute  = require('./routes/activityBoard')
const { sendAlert }    = require('./telegram')
const { ensureAllSessionsWorking } = require('./waha')
const { scanAllChats } = require('./services/warmScanner')
const { reconcileOnStartup } = require('./services/facebookCampaign')
const { seedConnectors }   = require('./services/platformConnectors')
const { processOpenEntriesOnRestart } = require('./services/fbOwnerSave')
const { getHealthSnapshot } = require('./services/healthStats')
const { execSync } = require('child_process')

const app = express()

app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: false }))

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
  // Security audit finding (2026-09-17): none of these existed. Conservative
  // set only — no Content-Security-Policy yet, since this backend serves a
  // real mix of JSON APIs, WAHA webhooks and static /uploads content and a
  // wrong CSP could silently break something without more direct testing
  // time than this pass has; nosniff+frame-ancestors+referrer-policy are
  // safe with zero behavioural risk to any of those paths.
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

app.use('/uploads', require('express').static('/app/uploads'))

app.get('/health', async (_req, res) => {
  // Single source of truth lives in services/healthStats.js so the cron
  // hourly tick and the public endpoint can never drift apart on what
  // "active properties" means. The semantic split is documented there:
  // active_properties = current public inventory
  // (website_properties WHERE is_published = TRUE); the legacy count
  // (owner_properties WHERE is_active = TRUE) is exposed as
  // legacy_active_properties so dashboards and briefs can compare the
  // two pipelines without summing them.
  const snap = await getHealthSnapshot(db, config.system)
  if (!snap.ok) return res.status(503).json(snap)
  res.json(snap)
})

// ── /health/disk — disk-usage observability ─────────────────────────────────
// Lightweight endpoint that surfaces root-FS usage plus the WAHA sessions
// volume usage (mounted at /app/.sessions inside the WAHA container; this
// backend is co-located with WAHA via the compose network, so /app/.sessions
// is reachable when bind-mounted). The endpoint never crashes on a missing
// /app/ path — if the WAHA volume isn't mounted (e.g. local dev) we return
// waha_gb = null instead of a 500.
// Shape: { ok, free_gb, used_gb, total_gb, waha_gb, postgres_rows }
app.get('/health/disk', async (_req, res) => {
  const out = {
    ok: true,
    free_gb: null,
    used_gb: null,
    total_gb: null,
    waha_gb: null,
    postgres_rows: null,
  }
  try {
    // `df -P /` gives POSIX-stable output (one line per FS, no line-wrap).
    // Lines: Filesystem 1024-blocks Used Available Capacity Mounted-on
    const raw = execSync('df -P /', { encoding: 'utf8', timeout: 4000 })
    const lines = raw.trim().split('\n').slice(1)
    for (const ln of lines) {
      const parts = ln.split(/\s+/)
      if (parts.length >= 5) {
        // Convert 1024-blocks → GB.
        const totalKb  = parseInt(parts[1], 10)
        const usedKb   = parseInt(parts[2], 10)
        const availKb  = parseInt(parts[3], 10)
        if (Number.isFinite(totalKb) && totalKb > 0) {
          out.total_gb = Math.round((totalKb / 1024 / 1024) * 10) / 10
          out.used_gb  = Math.round((usedKb  / 1024 / 1024) * 10) / 10
          out.free_gb  = Math.round((availKb / 1024 / 1024) * 10) / 10
        }
        break
      }
    }
  } catch (err) {
    log.warn('GET /health/disk df failed', { err: err.message })
    out.ok = false
  }

  // WAHA volume: /app/.sessions/gows (inside the WAHA container). When the
  // backend is running on the same host with bind-mounts, /app/.sessions
  // resolves to the WAHA data dir. If the path is missing, waha_gb stays
  // null — we DO NOT crash the endpoint on a missing mount.
  try {
    const fs = require('fs')
    const path = require('path')
    const candidates = [
      '/app/.sessions/gows',
      '/app/.sessions',
      '/app/.sessions/gows.db',
    ]
    for (const p of candidates) {
      try {
        const st = fs.statSync(p)
        if (st.isDirectory() || st.isFile()) {
          // Use `du -sb` for a single-directory walk; -x stays on the FS.
          const du = execSync(`du -sb ${p} 2>/dev/null | head -1`, { encoding: 'utf8', timeout: 8000 })
          const m = du.trim().match(/^(\d+)/)
          if (m) {
            const bytes = parseInt(m[1], 10)
            if (Number.isFinite(bytes)) {
              out.waha_gb = Math.round((bytes / 1024 / 1024 / 1024) * 100) / 100
            }
          }
          break
        }
      } catch (_) { /* path not present — try next candidate */ }
    }
  } catch (_) { /* swallow — waha_gb stays null */ }

  // Postgres rows: cheap row-count across the hot tables. Helps the operator
    // detect runaway inserts (e.g. scraper gone wild). We coalesce failures to
    // null rather than 500. Tables that may not exist on older DBs are wrapped
    // in a single try so a missing table logs a warning and reports the others.
    try {
      const r = await db.query(`
        SELECT
          (SELECT COUNT(*) FROM owner_properties)        AS owner_properties,
          (SELECT COUNT(*) FROM properties)              AS properties,
          (SELECT COUNT(*) FROM properties_submitted)    AS properties_submitted,
          (SELECT COUNT(*) FROM clients)                 AS clients,
          (SELECT COUNT(*) FROM outreach_log)            AS outreach_log
      `)
      const row = r.rows[0] || {}
      out.postgres_rows = {
        owner_properties:      parseInt(row.owner_properties)      || 0,
        properties:            parseInt(row.properties)            || 0,
        properties_submitted:  parseInt(row.properties_submitted)  || 0,
        clients:               parseInt(row.clients)               || 0,
        outreach_log:          parseInt(row.outreach_log)          || 0,
      }
    } catch (err) {
      log.warn('GET /health/disk postgres probe failed', { err: err.message })
    }

  res.json(out)
})

// /health/sheets — read-only configuration probe for Google Sheets wiring.
// NEVER calls Google APIs. Just reports whether the env vars and the
// service-account JSON are in place. Useful for the runbook in
// SHEETS-SETUP.md to confirm the operator completed the setup.
app.get('/health/sheets', async (_req, res) => {
  try {
    const fs = require('fs')
    const credPath = config.sheets.credentialsPath
    const sid = config.sheets.spreadsheetId
    const credsExist = fs.existsSync(credPath)
    let credsValid = false
    let credsProject = null
    let credsClientEmail = null
    if (credsExist) {
      try {
        const c = JSON.parse(fs.readFileSync(credPath, 'utf8'))
        credsValid = !!(c.type === 'service_account' && c.private_key && c.client_email)
        credsProject = c.project_id || null
        credsClientEmail = c.client_email || null
      } catch (e) { credsValid = false }
    }
    const configured = !!(sid && credsValid)
    res.json({
      configured,
      spreadsheet_id_set: !!sid,
      credentials_path: credPath,
      credentials_present: credsExist,
      credentials_valid: credsValid,
      credentials_project: credsProject,
      credentials_client_email: credsClientEmail,
      next_step: configured
        ? 'Sheets sync is live. Tab names: Outreach, Replies, Clients, Blacklist, Notes.'
        : (credsExist && !credsValid)
          ? `Service-account JSON at ${credPath} is invalid. Re-download from Google Cloud Console.`
          : (sid && !credsValid)
            ? `Spreadsheet ID is set but credentials file is missing or invalid. Place the service-account JSON at ${credPath} (mode 600).`
            : (!sid && credsValid)
              ? 'Credentials file is valid. Set GOOGLE_SPREADSHEET_ID in /opt/2906-system/.env and restart the backend.'
              : `Not configured. See SHEETS-SETUP.md for the one-time setup. Set GOOGLE_SPREADSHEET_ID and place the service-account JSON at ${credPath}.`
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.use('/webhook', activityHook, webhookRoute)
app.use('/api/admin', adminWebRoute)
app.use('/api/properties', propertiesRoute)
app.use('/api/clients', clientsRoute)

app.get('/api/content', async (_req, res) => {
  try {
    const r = await db.query('SELECT key, value FROM site_content ORDER BY key')
    const obj = {}
    for (const row of r.rows) obj[row.key] = row.value
    res.json(obj)
  } catch { res.json({}) }
})

app.use('/api', adminRoute)
app.use('/api/property-submit', propertySubmitRoute)
app.use('/api/referrals/submit', referralSubmitRoute)
app.use('/api/locations', locationsRoute)
app.use('/api/contacts', contactsRoute)
app.use('/api/public', publicSubmissionsRoute)
app.use('/api/agents', agentsRoute)
app.use('/api/calendar', calendarRoute)
// Swipe Boards public half (deck + like + optional contact) — no auth, rate
// limited inside the router itself. Agent-authenticated half (create link,
// see results) lives under /api/crm/schedule-board, mounted below.
app.use('/api/swipe', swipeRoute)
app.use('/api/admin/stats', adminStatsRoute)
// Auth endpoints (invite/redeem/me/invites/revoke) take precedence over the
// board router's GET '/' because Express matches by exact (method, path).
// Both routers share the same parent path; the auth router declares only
// /invite, /redeem, /me, /invites, /revoke — no collision with the board's
// /, /:id/action, /:id/schedule.
// Long-lived cookie session — read sb_session from cookie header and attach
// req.sbUser (used by both routers' requireBoardSession gate).
const { readSession: readSbSession } = require('./services/scheduleBoardSession')
app.use('/api/admin/schedule-board', readSbSession)
app.use('/api/admin/schedule-board', scheduleBoardAuthRoute)
app.use('/api/admin/schedule-board', scheduleBoardRoute)
app.use('/api/admin/properties-overview', require('./routes/propertiesOverview'))
// Schedule Board API for the CRM frontend. Mounted BEFORE /api/crm so the
// board's own paths are matched here; routes/crm.js has no /schedule-board
// routes, so the order is defensive rather than load-bearing.
app.use("/api/crm/schedule-board", require("./routes/crmScheduleBoard"))
// Kev, 2026-08-28: both routers were fully built (routes/boardAccess.js's own
// header says "Mounted at /api/crm/board-access", routes/boardLogin.js's says
// "Mounted at /api/crm/board") but neither app.use() ever happened — the
// whole "add a board agent → they get a magic link → they sign in" flow was
// silently a 404 the entire time. That is the actual reason the Add-an-agent
// page did nothing on click: the frontend's POST had nowhere to land.
app.use("/api/crm/board-access", require("./routes/boardAccess"))
app.use("/api/crm/board", require("./routes/boardLogin"))
// CLIENTGROUPS 3/7 -- CRM dashboard for the WA CLIENT ASSISTANT. Same
// defensive before-the-catch-all ordering as schedule-board above.
app.use("/api/crm/clientgroups", require("./routes/crmClientgroups"))
app.use("/api/crm/ownergroups", require("./routes/crmOwnergroups"))
// Unified ARGUS read layer: property, owner, client, village/map and stored
// traffic coverage behind one permission-aware filter contract.
app.use("/api/crm/workspace", require("./routes/crmWorkspace"))
// ARGUS Agent Notification Engine (Kev, 2026-09-16) -- must mount before the
// /api/crm catch-all below, same defensive ordering every other crm/* route
// here already follows.
app.use("/api/crm/notification-engine", require("./routes/crmNotificationEngine"))
// ARGUS Agent Layer (Kev, 2026-09-16) -- same defensive before-the-catch-all ordering.
app.use("/api/crm/agent-profile", require("./routes/crmAgentProfile"))
app.use("/api/crm/scheduled-messages", require("./routes/crmScheduledMessages"))
app.use("/api/crm/base-inventory", require("./routes/crmBaseInventory"))
// ARGUS Integrations → Property Sources (Claude, 2026-11-09): authorised provider
// collections, change detection and review. Admin only; before the catch-all.
app.use("/api/crm/property-sources", require("./routes/crmPropertySources"))
// Automation event log + worker health (2026-11-12). Admin only, read-only.
app.use("/api/crm/automation", require("./routes/crmAutomation"))
app.use("/api/owner-upload", require("./routes/ownerUpload"))
app.use("/api/nexus", require("./routes/nexusBridge"))
app.use("/api/crm/nexus", require("./routes/nexusBridge"))
app.use("/api/crm", require("./routes/crm"))

// Agent Workspace prototype (gated by AGENT_WORKSPACE_ENABLED env flag).
// Mounts the API route and a friendly HTML-serving alias at /workspace/*.
app.use('/agent-workspace', agentWorkspaceRoute)
app.use('/workspace', (req, res, next) => {
  res.sendFile(require('path').join(__dirname, 'public', 'agent-workspace', 'index.html'))
})

// Activity Board (gated by AGENT_ACTIVITY_LOG_ENABLED env flag, admin-only).
app.use('/activity-board', activityBoardRoute)

app.use((_req, res) => res.status(404).json({ error: 'not found' }))
app.use((err, _req, res, _next) => { log.error('Unhandled request error', err); res.status(500).json({ error: 'internal server error' }) })

async function waitForDb(retries = 12, delayMs = 5000) {
  for (let i = 0; i < retries; i++) {
    try { await db.query('SELECT 1'); return } catch { log.warn(`DB not ready, retrying in ${delayMs / 1000}s (${i + 1}/${retries})`); await new Promise(r => setTimeout(r, delayMs)) }
  }
  throw new Error('Database unavailable after retries')
}

async function start() {
  log.info('2906 Backend starting', { env: config.nodeEnv, port: config.port })
  await waitForDb()
  log.info('Database connected')
  const server = app.listen(config.port, () => { log.info(`HTTP server listening on :${config.port}`) })
  const { closeAll } = startWorkers()
  startCrons()
  // Kev, 2026-09-10: FB Direct-From-Owner entries get first priority on any
  // restart — awaited (not fire-and-forget) so it genuinely runs BEFORE the
  // FB posting queue reconciliation / warm scan below, per Kev's explicit
  // ordering requirement. scheduleContact() inside still only ever enqueues
  // a delayed job respecting the normal contact window — nothing sends
  // instantly, so this adds negligible boot time.
  await processOpenEntriesOnRestart().catch(err => log.warn('FB-TODO restart priority failed', { err: err.message }))
  seedConnectors().catch(err => log.warn('Connector seeding failed', err.message))
  reconcileOnStartup().catch(err => log.warn('FB reconciliation failed', err.message))
  ensureAllSessionsWorking().catch(err => log.warn('WAHA startup check failed', { err: err.message }))
  scanAllChats().catch(err => log.warn('Startup warm scan failed', { err: err.message }))
  await sendAlert('2906 System gestartet ✅', 'success')
  async function shutdown(signal) { log.info(`${signal} received, shutting down`); server.close(async () => { await closeAll(); await db.end(); log.info('Shutdown complete'); process.exit(0) }) }
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.on('uncaughtException', (err) => { log.error('Uncaught exception', err); sendAlert(`Kritischer Fehler: ${err.message}`, 'error').catch(() => {}) })
  process.on('unhandledRejection', (reason) => { log.error('Unhandled rejection', reason instanceof Error ? reason : String(reason)) })
}

start().catch((err) => { console.error('Fatal startup error:', err); process.exit(1) })
