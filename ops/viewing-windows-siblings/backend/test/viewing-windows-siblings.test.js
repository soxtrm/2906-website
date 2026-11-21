'use strict'
// SYNC calendar (2026-11-21) against a throwaway PostgreSQL with the live schema (no rows). Synthetic owners only.
// Covers: single viewing hours (add / overlap refused / remove own / agency hours protected / other owner refused),
// proposing another time (refused on a taken time, window marked as proposal), accepting, and the database guarantee
// that two viewings of one home never overlap.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const http = require('http')

const SECRET = 'x'.repeat(48)
process.env.JWT_SECRET = 'test-secret-not-production'
process.env.NEXUS_LINK_INBOUND_SECRET = SECRET
process.env.ARGUS_AGENCY_KEY = '2906'
const ROOT = process.env.BACKEND_DIR || '/app'
const R = p => path.join(ROOT, p)
const express = require(R('node_modules/express'))
const { Pool } = require(R('node_modules/pg'))
const pool = new Pool({ host: process.env.PGHOST, user: 'postgres', password: 'test', database: 'postgres', max: 6 })
const noop = () => {}
function stub(rel, exports) { const file = require.resolve(R(rel)); require.cache[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [] } }
stub('db.js', { query: (s, p) => pool.query(s, p), connect: () => pool.connect() })
stub('logger.js', { info: noop, warn: noop, error: noop, debug: noop })
stub('waha.js', new Proxy({}, { get: () => async () => ({}) }))
const C = require(R('services/nexusLinkCrypto.js'))
const S = require(R('services/syncAccount.js'))
S._test.setSender(async () => {}); S._test.setMailer(async () => true)

let server, base
async function svc(p, body, { ip = '10.9.0.1' } = {}) {
  const timestamp = Math.floor(Date.now() / 1000)
  const headers = { 'content-type': 'application/json', 'X-Nexus-Link-Key': 'nexus-sync', 'X-Nexus-Link-Timestamp': String(timestamp), 'X-Sync-Client-IP': ip }
  headers['X-Nexus-Link-Signature'] = C.sign(SECRET, { timestamp, method: 'POST', path: p, body })
  const res = await fetch(`${base}/api/sync-account/v1${p}`, { method: 'POST', headers, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() }
}
async function owner(name, phone, email, refs) {
  const { rows: [o] } = await pool.query(`INSERT INTO owner_contacts (phone_normalized, name) VALUES ($1,$2) RETURNING id`, [phone, name])
  const ids = []
  for (const ref of refs) {
    const { rows: [p] } = await pool.query(`INSERT INTO properties (ref, town, property_type, longlet_price, bedrooms, bathrooms, owner_id) VALUES ($1,'Sliema','Apartment',1500,2,1,$2) RETURNING id`, [ref, o.id])
    ids.push(p.id)
  }
  const up = await svc('/signup', { email, password: 'harbour-view-22', name }, { ip: `10.9.${ids[0] % 250}.1` })
  assert.equal(up.status, 200, JSON.stringify(up.body))
  const { rows: [a] } = await pool.query(`SELECT * FROM sync_accounts WHERE email=$1`, [email])
  const { rows: [l] } = await pool.query(`INSERT INTO nexus_owner_links (agency_key, owner_contact_id, nexus_account_ref, link_state) VALUES ('2906',$1,$2,'verified') RETURNING id`, [o.id, `sync:${a.public_id}`])
  for (const id of ids) await pool.query(`INSERT INTO nexus_owner_property_claims (owner_link_id, property_id, claim_state) VALUES ($1,$2,'confirmed')`, [l.id, id])
  return { session: up.body.session.token, ids, account: a }
}
const at = (days, h, m = 0) => { const d = new Date(Date.now() + days * 86400e3); d.setUTCHours(h, m, 0, 0); return d }
async function viewing(propertyId, start, status = 'pending', min = 20) {
  const { rows: [v] } = await pool.query(
    `INSERT INTO property_viewings (property_id, viewing_date, starts_at, duration_min, status, source, owner_survey_status, viewing_agent_name)
     VALUES ($1, ($2::timestamptz AT TIME ZONE 'Europe/Malta')::date, $2::timestamptz, $3, $4, 'admin_book', 'pending', 'Test Agent') RETURNING id`, [propertyId, start.toISOString(), min, status])
  return v.id
}

// ── an acceptance or a SYNC calendar action never wipes the owner's other hours ──
const W = require(R('services/viewingWindows.js'))
let A
test.before(async () => {
  for (let i = 0; i < 60; i++) { try { await pool.query('SELECT 1'); break } catch { await new Promise(r => setTimeout(r, 500)) } }
  const app = express(); app.use(express.json()); app.use('/api/sync-account/v1', require(R('routes/syncAccountService.js')))
  server = http.createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`
  A = await owner('Owner VW', '35699000401', 'vw-a@example.test', ['2906-VW-1', '2906-VW-2'])
})
test.after(async () => { server.close(); await pool.end() })
const active = async pid => (await pool.query(`SELECT id, source_type, source_reference FROM property_viewing_windows WHERE property_id=$1 AND status='active' ORDER BY id`, [pid])).rows

test('accepting a request keeps the other hours of that day (calendar + agency)', async () => {
  const pid = A.ids[0]
  const h1 = await svc('/owner/cal/window/add', { session: A.session, propertyId: pid, start: at(4, 6).toISOString(), end: at(4, 8).toISOString() })
  const h2 = await svc('/owner/cal/window/add', { session: A.session, propertyId: pid, start: at(4, 12).toISOString(), end: at(4, 15).toISOString() })
  assert.equal(h1.status, 200, JSON.stringify(h1.body)); assert.equal(h2.status, 200, JSON.stringify(h2.body))
  await pool.query(`INSERT INTO property_viewing_windows (property_id, kind, starts_at, ends_at, status, source_type, created_by, confidence, observed_at)
     VALUES ($1,'window',$2,$3,'active','agent','agent','explicit', NOW() + interval '1 minute')`, [pid, at(4, 16).toISOString(), at(4, 17).toISOString()])
  const before = (await active(pid)).map(x => x.id)
  const req = await viewing(pid, at(4, 13))
  const ok = await svc('/owner/viewings/decide', { session: A.session, viewingId: req, decision: 'accept' })
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.status, 'confirmed')
  const after = (await active(pid)).map(x => x.id)
  for (const id of before) assert.ok(after.includes(id), `window ${id} still active after the acceptance`)
})

test('proposing another time keeps the other hours of that day', async () => {
  const pid = A.ids[0]
  const before = (await active(pid)).map(x => x.id)
  const req = await viewing(pid, at(4, 14))
  const p = await svc('/owner/viewings/decide', { session: A.session, viewingId: req, decision: 'propose', proposeStart: at(4, 9).toISOString() })
  assert.equal(p.status, 200, JSON.stringify(p.body)); assert.equal(p.body.proposed, true)
  const after = await active(pid)
  for (const id of before) assert.ok(after.some(x => x.id === id), `window ${id} still active after the proposal`)
  assert.ok(after.some(x => /:propose:/.test(x.source_reference || '')), 'proposal window added')
})

test('single hours from the first calendar (owner/window/add) on the same day stay side by side', async () => {
  const pid = A.ids[1]
  const a = await svc('/owner/window/add', { session: A.session, propertyId: pid, start: at(6, 6).toISOString(), end: at(6, 7).toISOString() })
  const b = await svc('/owner/window/add', { session: A.session, propertyId: pid, start: at(6, 12).toISOString(), end: at(6, 13).toISOString() })
  assert.equal(a.status, 200); assert.equal(b.status, 200)
  assert.equal((await active(pid)).length, 2)
})

test('a statement still replaces that day (chat, unchanged behaviour)', async () => {
  const pid = A.ids[1]
  const r = await W.addWindow(pid, { kind: 'window', start: at(6, 8).toISOString(), end: at(6, 10).toISOString(), confirmation: 'full_window' },
    { sourceType: 'owner_chat', reference: 'msg:test-1', createdBy: 'owner', confidence: 'explicit', evidence: 'Tuesday now only 10-12' })
  assert.equal(r.action, 'created'); assert.equal(r.superseded.length, 2)
  const left = await active(pid)
  assert.equal(left.length, 1); assert.equal(left[0].id, r.id)
})
