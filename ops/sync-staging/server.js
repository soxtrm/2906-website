'use strict'
// NEXUS SYNC staging service (2026-11-21): the patched SYNC + CRM routes on a throwaway database with
// synthetic owners, for signed-in end-to-end tests of nexussync's real pages. Not the full backend: no
// cron jobs, no queues, no WhatsApp, no e-mail; outgoing messages are captured in memory, never sent.
const path = require('path')
const ROOT = '/app'; const R = p => path.join(ROOT, p)
const { Pool } = require(R('node_modules/pg'))
const pool = new Pool({ host: process.env.PGHOST, user: 'postgres', password: 'test', database: 'postgres', max: 8 })
const noop = () => {}
function stub(rel, exports) { const file = require.resolve(R(rel)); require.cache[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [] } }
stub('db.js', { query: (s, p) => pool.query(s, p), connect: () => pool.connect() })
stub('logger.js', { info: noop, warn: console.warn, error: console.error, debug: noop })
const fake = new Proxy({}, { get: (t, k) => (k === 'then' ? undefined : (k === 'on' || k === 'once') ? () => fake : async () => null) })
stub('waha.js', fake); stub('redis.js', fake); stub('queues.js', fake)
const express = require(R('node_modules/express'))
const S = require(R('services/syncAccount.js'))
const L = require(R('services/nexusOwnerLink.js'))
const outbox = []
S._test.setSender(async (session, chat, text) => { outbox.push({ kind: 'whatsapp', text: String(text).slice(0, 80) }) })
S._test.setMailer(async m => { outbox.push({ kind: 'mail', subject: m && m.subject }); return true })

async function seed() {
  for (let i = 0; i < 60; i++) { try { await pool.query('SELECT 1'); break } catch { await new Promise(r => setTimeout(r, 500)) } }
  const { rows: [{ n }] } = await pool.query('SELECT COUNT(*)::int n FROM sync_accounts')
  if (n) return
  await pool.query("INSERT INTO agents (id, username, name, role, active, board_access) VALUES (1,'stage-admin','Stage Admin','admin',true,true) ON CONFLICT DO NOTHING")
  const towns = ['Sliema', 'Gzira', 'Swieqi']
  const mk = async (name, phone, email, refs) => {
    const { rows: [o] } = await pool.query('INSERT INTO owner_contacts (phone_normalized, name) VALUES ($1,$2) RETURNING id', [phone, name])
    const ids = []
    for (let i = 0; i < refs.length; i++) {
      const { rows: [p] } = await pool.query(
        "INSERT INTO properties (ref, town, property_type, longlet_price, bedrooms, bathrooms, owner_id, published, available_status) VALUES ($1,$2,'Apartment',$3,2,1,$4,true,'available') RETURNING id",
        [refs[i], towns[i % 3], 1300 + i * 250, o.id])
      ids.push(p.id)
      const { rows: [row] } = await pool.query(`SELECT ${L._internal.PROPERTY_COLUMNS} FROM properties p WHERE p.id=$1`, [p.id])
      await L._internal.ensurePropertyLink(pool, row)
    }
    await S.signup({ email, password: 'stage-pass-2026', name, userAgent: 'staging-seed' })
    const { rows: [a] } = await pool.query('SELECT * FROM sync_accounts WHERE email=$1', [email])
    if (refs.length) {
      const { rows: [l] } = await pool.query("INSERT INTO nexus_owner_links (agency_key, owner_contact_id, nexus_account_ref, link_state) VALUES ('2906',$1,$2,'verified') RETURNING id", [o.id, `sync:${a.public_id}`])
      for (const id of ids) await pool.query("INSERT INTO nexus_owner_property_claims (owner_link_id, property_id, claim_state) VALUES ($1,$2,'confirmed')", [l.id, id])
    }
    return { ids, a }
  }
  const olga = await mk('Olga Stage', '35699100001', 'olga.stage@example.test', ['ST-101', 'ST-102', 'ST-103'])
  await mk('Bruno Stage', '35699100002', 'bruno.stage@example.test', ['ST-201'])
  const dan = await mk('Dan Stage', '35699100003', 'dan.stage@example.test', [])
  await pool.query("UPDATE sync_accounts SET phone_e164='35699100003', phone_verified_at=NOW(), phone_verified_via='staging' WHERE id=$1", [dan.a.id])
  await mk('Xena Stage', '35699100004', 'xena.stage@example.test', [])
  // three pending viewing requests on Olga's first home, two days ahead
  const base = new Date(Date.now() + 2 * 86400e3); base.setUTCHours(9, 0, 0, 0)
  for (const [h, who] of [[0, 'Client A'], [2, 'Client B'], [4, 'Client C']]) {
    const at = new Date(base.getTime() + h * 3600e3)
    await pool.query("INSERT INTO property_viewings (property_id, viewing_date, status, starts_at, duration_min, requester_name, party_size, viewing_agent_name) VALUES ($1,($2::timestamptz)::date,'pending',$2,20,$3,2,'Stage Agent')", [olga.ids[0], at, who])
  }
  console.log('seeded', JSON.stringify({ olga: olga.ids }))
}

const app = express()
app.use(express.json({ limit: '6mb' }))
app.use('/api/sync-account/v1', require(R('routes/syncAccountService.js')))
app.use('/api/crm', require(R('routes/crm.js')))
app.get('/stage/outbox', (req, res) => res.json(outbox))
seed().then(() => app.listen(3901, '0.0.0.0', () => console.log('SYNC staging on 3901'))).catch(e => { console.error('seed failed', e); process.exit(1) })
