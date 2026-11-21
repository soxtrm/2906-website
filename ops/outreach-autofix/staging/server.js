'use strict'
// Outreach Auto fix staging (2026-11-21): the live CRM login and outreach routes on a throwaway
// database with a synthetic admin, two synthetic accounts and 400 synthetic owners. No cron, no
// queues; every WhatsApp send is captured in /stage/outbox and never leaves this process.
const path = require('path')
const ROOT = '/app'; const R = p => path.join(ROOT, p)
const { Pool } = require(R('node_modules/pg'))
const pool = new Pool({ host: process.env.PGHOST, user: 'postgres', password: 'test', database: 'postgres', max: 8 })
const noop = () => {}
function stub(rel, exports) { const file = require.resolve(R(rel)); require.cache[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [] } }
const outbox = []
stub('db.js', { query: (s, p) => pool.query(s, p), connect: () => pool.connect(), on: noop })
stub('logger.js', { info: noop, warn: noop, error: (m, d) => console.error(m, d && (d.err || d.message || d)), debug: noop })
const fake = new Proxy({}, { get: (t, k) => (k === 'then' ? undefined : (k === 'on' || k === 'once') ? () => fake : async () => null) })
const waha = new Proxy({}, { get: (t, k) => (k === 'then' ? undefined
  : k === 'getSessionStatus' ? async () => ({ status: 'WORKING' })
  : k === 'sendText' ? async (s, chat, text) => { outbox.push({ chat: String(chat).replace(/\d(?=\d{4})/g, '•'), text: String(text) }); return { id: 'stage' } }
  : async () => null) })
stub('waha.js', waha); stub('redis.js', fake)
const jobs = new Map()
stub('queues.js', { addJob: async (q, data, opts) => { const id = opts?.jobId || `job-${jobs.size + 1}`; jobs.set(id, data); return { id } },
  QUEUES: new Proxy({}, { get: () => ({ getJob: async id => (jobs.has(id) ? { remove: async () => jobs.delete(id), getState: async () => 'delayed' } : null), add: async () => ({}) }) }) })
stub('services/listBuilder.js', {
  buildPoolBatch: async (_s, n, { cursorOverride = null } = {}) => {
    const { rows } = await pool.query(`SELECT id, phone_normalized, name FROM owner_contacts WHERE id > $1 ORDER BY id LIMIT $2`, [cursorOverride || 0, n])
    return { list: rows, cursor_advanced_to: rows.length ? rows[rows.length - 1].id : (cursorOverride || 0) }
  },
  buildListForAccount: async () => ({ list: [] }), getListStats: async () => ({}),
})
const express = require(R('node_modules/express'))

async function seed() {
  for (let i = 0; i < 60; i++) { try { await pool.query('SELECT 1'); break } catch { await new Promise(r => setTimeout(r, 500)) } }
  const bcrypt = require(R('node_modules/bcryptjs'))
  await pool.query(`INSERT INTO agents (id, username, name, email, role, active, board_access, password_hash) VALUES (1,'stage-admin','Stage Admin','stage-admin@example.test','admin',true,true,$1)`, [bcrypt.hashSync('stage-pass-2026', 10)])
  await pool.query(`INSERT INTO whatsapp_accounts (session_name, phone, label, account_persona, is_active, outreach_enabled, priority, outreach_pace_min, outreach_pace_max, outreach_auto_base_count) VALUES
    ('GabrielaStage','35699900001','Gabriela (stage)','gabriela',TRUE,TRUE,1,27,27,29), ('KevStage','35699900002','Kev (stage)','kev',TRUE,TRUE,2,30,30,32)`)
  for (let i = 0; i < 400; i++) await pool.query(`INSERT INTO owner_contacts (phone_normalized, name) VALUES ($1,$2)`, [`3567990${String(i).padStart(4, '0')}`, `Synthetic Owner ${i}`])
  console.log('library texts', await require(R('services/outreachLibrary.js')).ensureSeed())
  console.log('seeded')
}
const app = express()
app.use(express.json({ limit: '2mb' }))
app.use('/api/crm', require(R('routes/crm.js')))
app.get('/stage/outbox', (req, res) => res.json(outbox))
app.post('/stage/run/:planId', async (req, res) => {
  try { await require(R('services/outreachPlanner.js')).runScheduledPlan(Number(req.params.planId)); res.json({ ok: true, outbox: outbox.length }) } catch (e) { res.status(500).json({ error: e.message }) }
})
// The real dispatcher (outreachRunEngine → adminCommands.runDirectOutreach) for one plan's run,
// started in the background; sends land in /stage/outbox only.
app.post('/stage/execute/:planId', async (req, res) => {
  try {
    const run = (await pool.query(`SELECT run_id AS id FROM outreach_runs WHERE plan_id=$1 ORDER BY created_at DESC LIMIT 1`, [Number(req.params.planId)])).rows[0]
    if (!run) return res.status(404).json({ error: 'no run for this plan' })
    require(R('services/outreachRunEngine.js')).executeOutreachRun(run.id).catch(e => console.error('run failed', e.message))
    res.json({ ok: true, runId: run.id })
  } catch (e) { res.status(500).json({ error: e.message }) }
})
seed().then(() => app.listen(3903, '0.0.0.0', () => console.log('outreach staging on 3903'))).catch(e => { console.error('seed failed', e); process.exit(1) })
