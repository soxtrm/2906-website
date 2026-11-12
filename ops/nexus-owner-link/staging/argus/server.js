'use strict'
// ARGUS STAGING — owner-link surface only (Claude, 2026-11-13).
//
// This is NOT the production backend. It mounts exactly the two owner-link
// routers and the link scheduler on top of two unmodified production files
// (db.js, services/boardAction.js). There is no worker, no cron.js, no WAHA
// client, no queue, no outreach, no notification and no payment code in this
// image, so it cannot message anyone. It refuses to start against anything
// that is not explicitly declared a staging database.
const express = require('express')

if (process.env.ARGUS_STAGING !== '1') { console.error('ARGUS_STAGING=1 is required'); process.exit(1) }
if (!/staging/i.test(process.env.STAGING_DB_NAME || '')) { console.error('STAGING_DB_NAME must be a staging database'); process.exit(1) }
for (const k of ['JWT_SECRET', 'STAGING_DB_HOST', 'STAGING_DB_PASSWORD']) if (!process.env[k]) { console.error(`${k} is required`); process.exit(1) }

const db = require('./db')
const log = require('./logger')

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '1mb' }))
app.get('/healthz', async (_req, res) => {
  try { await db.query('SELECT 1'); res.json({ ok: true, staging: true, commit: process.env.ARGUS_COMMIT || null, contract: require('./services/nexusOwnerLink').CONTRACT_VERSION }) }
  catch (err) { res.status(503).json({ ok: false, staging: true }) }
})
app.use('/api/crm/owner-nexus', require('./routes/crmOwnerNexus'))
app.use('/api/nexus-link/v1', require('./routes/nexusLinkService'))
app.use((_req, res) => res.status(404).json({ error: 'not found (ARGUS staging serves the owner-link surface only)' }))
app.use((err, _req, res, _next) => { log.error('unhandled', { err: err.message }); res.status(err.status === 400 || err.type === 'entity.parse.failed' ? 400 : 500).json({ error: 'request failed' }) })

const port = Number(process.env.PORT || 3001)
app.listen(port, '0.0.0.0', () => {
  log.info('ARGUS staging listening', { port, commit: process.env.ARGUS_COMMIT || null })
  log.info('scheduler', require('./services/nexusLinkScheduler').start())
})
