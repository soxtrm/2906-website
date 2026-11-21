'use strict'
// Viewing follow-up staging (2026-11-21): the live CRM login, schedule-board booking routes and
// viewing follow-ups on a throwaway database with synthetic agents, owner and listing. No cron,
// no queues; every WhatsApp send is captured in /stage/outbox and never leaves this process.
// Time travel for the day-after question: POST /stage/tick { at }.
const path = require('path')
const ROOT = '/app'; const R = p => path.join(ROOT, p)
const { Pool } = require(R('node_modules/pg'))
const pool = new Pool({ host: process.env.PGHOST, user: 'postgres', password: 'test', database: 'postgres', max: 8 })
const noop = () => {}
function stub(rel, exports) { const file = require.resolve(R(rel)); require.cache[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [] } }
const outbox = []
stub('db.js', { query: (s, p) => pool.query(s, p), connect: () => pool.connect(), on: noop })
stub('logger.js', { info: noop, warn: noop, error: (m, d) => console.error(m, d && d.err), debug: noop })
const fake = new Proxy({}, { get: (t, k) => (k === 'then' ? undefined : (k === 'on' || k === 'once') ? () => fake : async () => null) })
const waha = new Proxy({}, { get: (t, k) => (k === 'then' ? undefined : k === 'sendText' ? async (s, chat, text) => { outbox.push({ via: 'waha', chat: String(chat).replace(/\d(?=\d{4})/g, '•'), text: String(text).slice(0, 300) }); return { id: 'stage' } } : async () => null) })
stub('waha.js', waha); stub('redis.js', fake); stub('queues.js', fake)
const express = require(R('node_modules/express'))
const F = require(R('services/viewingFollowups.js'))
F.setTransport({ send: async (s, chat, text) => { outbox.push({ via: 'followup', chat, text }) }, pick: async () => 'StageSession' })

async function seed() {
  for (let i = 0; i < 60; i++) { try { await pool.query('SELECT 1'); break } catch { await new Promise(r => setTimeout(r, 500)) } }
  const bcrypt = require(R('node_modules/bcryptjs'))
  const pw = bcrypt.hashSync('stage-pass-2026', 10)
  await pool.query(`INSERT INTO agents (id, username, name, email, role, active, board_access, can_create_owner_group, can_view_owner_contact, password_hash) VALUES
    (1,'stage-admin','Stage Admin','stage-admin@example.test','admin',true,true,true,false,$1),
    (13,'katya.stage','Katya Stage','katya.stage@example.test','board',true,true,true,true,$1),
    (57,'nico.stage','Nico Stage','nico.stage@example.test','agent',true,true,false,false,$1)`, [pw])
  await pool.query(`INSERT INTO agent_workspace_config (agent_id, agent_name, workspace_slug, access_token, whatsapp_group_jid) VALUES (13,'Katya Stage','katya-stage','stage-token-not-real','120363000000000013@g.us')`)
  const { rows: [o] } = await pool.query(`INSERT INTO owner_contacts (phone_normalized, name, status) VALUES ('35699100777','Owen Stage-Owner','active') RETURNING id`)
  const img = '["https://res.cloudinary.com/du2jwqnbs/image/upload/v1785401218/2906-properties/szkbh5t1kbeayapysnct.jpg"]'
  const { rows: [p] } = await pool.query(
    `INSERT INTO properties (ref, town, property_type, longlet_price, bedrooms, bathrooms, owner_id, published, available_status, listed_by_agent_id, images, description, last_confirmed_available_at)
     VALUES ('9901','Sliema','apartment',1650,2,1,$1,true,'available',1,$2::jsonb,'Synthetic staging listing',NOW()) RETURNING id`, [o.id, img])
  // a future appointment created long ago, and one from the old /book flow (date + time, no starts_at)
  const far = new Date(Date.now() + 40 * 86400e3); far.setUTCHours(14, 0, 0, 0)
  await pool.query(`INSERT INTO property_viewings (property_id, viewing_date, starts_at, duration_min, status, user_id, viewing_agent_id, source, created_at)
                    VALUES ($1, ($2::timestamptz AT TIME ZONE 'Europe/Malta')::date, $2, 20, 'pending', 13, 13, 'board_slot', NOW() - interval '90 days')`, [p.id, far])
  const d9 = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Malta' }).format(new Date(Date.now() + 9 * 86400e3))
  await pool.query(`INSERT INTO property_viewings (property_id, viewing_date, viewing_time, status, user_id, viewing_agent_id, source, created_at)
                    VALUES ($1, $2::date, '16:30', 'pending', 13, 13, 'agent_book', NOW() - interval '200 days')`, [p.id, d9])
  console.log('seeded', JSON.stringify({ property: p.id, ref: '9901' }))
}

const app = express()
app.use(express.json({ limit: '2mb' }))
app.use('/api/crm/viewing-followups', require(R('routes/crmViewingFollowups.js')))
app.use('/api/crm/schedule-board', require(R('routes/crmScheduleBoard.js')))
app.use('/api/crm', require(R('routes/crm.js')))
app.get('/stage/outbox', (req, res) => res.json(outbox))
app.post('/stage/tick', async (req, res) => {
  try { res.json(await F.syncAll({ now: req.body?.at ? new Date(req.body.at) : new Date() })) } catch (e) { res.status(500).json({ error: e.message }) }
})
seed().then(() => app.listen(3902, '0.0.0.0', () => console.log('viewing staging on 3902'))).catch(e => { console.error('seed failed', e); process.exit(1) })
