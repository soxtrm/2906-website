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

let A, B
test.before(async () => {
  for (let i = 0; i < 60; i++) { try { await pool.query('SELECT 1'); break } catch { await new Promise(r => setTimeout(r, 500)) } }
  const app = express(); app.use(express.json()); app.use('/api/sync-account/v1', require(R('routes/syncAccountService.js')))
  server = http.createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`
  A = await owner('Owner A', '35699000201', 'cal-a@example.test', ['K-1', 'K-2'])
  B = await owner('Owner B', '35699000202', 'cal-b@example.test', ['K-9'])
})
test.after(async () => { server.close(); await pool.end() })

test('owner adds viewing hours with one tap; overlapping hours are refused', async () => {
  const s = at(3, 8), e = at(3, 10)
  const r = await svc('/owner/window/add', { session: A.session, propertyId: A.ids[0], start: s.toISOString(), end: e.toISOString() })
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.ok(r.body.window.id); assert.equal(r.body.window.own, true)
  const { rows: [w] } = await pool.query(`SELECT source_type, status FROM property_viewing_windows WHERE id=$1`, [r.body.window.id])
  assert.deepEqual([w.source_type, w.status], ['owner_sync', 'active'])
  const dup = await svc('/owner/window/add', { session: A.session, propertyId: A.ids[0], start: at(3, 9).toISOString(), end: at(3, 11).toISOString() })
  assert.equal(dup.status, 409); assert.equal(dup.body.error, 'WINDOW_OVERLAP')
  const bad = await svc('/owner/window/add', { session: A.session, propertyId: A.ids[0], start: at(4, 9).toISOString(), end: at(4, 9, 5).toISOString() })
  assert.ok(bad.status >= 400 && bad.status < 500); assert.equal(bad.body.error, 'RANGE_INVALID')
})

test('another owner cannot add or remove hours on this home', async () => {
  const r = await svc('/owner/window/add', { session: B.session, propertyId: A.ids[0], start: at(5, 8).toISOString(), end: at(5, 9).toISOString() })
  assert.ok(r.status >= 400 && r.status < 500, JSON.stringify(r.body))
  const { rows: [w] } = await pool.query(`SELECT id FROM property_viewing_windows WHERE property_id=$1 AND status='active' LIMIT 1`, [A.ids[0]])
  const rm = await svc('/owner/window/remove', { session: B.session, propertyId: A.ids[0], windowId: w.id })
  assert.ok(rm.status >= 400 && rm.status < 500)
  const { rows: [still] } = await pool.query(`SELECT status FROM property_viewing_windows WHERE id=$1`, [w.id])
  assert.equal(still.status, 'active')
})

test('owner removes own hours; hours set by the agency stay protected', async () => {
  const add = await svc('/owner/window/add', { session: A.session, propertyId: A.ids[1], start: at(6, 8).toISOString(), end: at(6, 9).toISOString() })
  const rm = await svc('/owner/window/remove', { session: A.session, propertyId: A.ids[1], windowId: add.body.window.id })
  assert.equal(rm.status, 200, JSON.stringify(rm.body))
  const { rows: [gone] } = await pool.query(`SELECT status FROM property_viewing_windows WHERE id=$1`, [add.body.window.id])
  assert.equal(gone.status, 'cancelled')
  const { rows: [ag] } = await pool.query(
    `INSERT INTO property_viewing_windows (property_id, kind, starts_at, ends_at, status, source_type, created_by, confidence)
     VALUES ($1,'window',$2,$3,'active','agent','agent','explicit') RETURNING id`, [A.ids[1], at(7, 8).toISOString(), at(7, 9).toISOString()])
  const no = await svc('/owner/window/remove', { session: A.session, propertyId: A.ids[1], windowId: ag.id })
  assert.equal(no.status, 403); assert.equal(no.body.error, 'WINDOW_NOT_OWN')
})

test('proposing another time: refused on a taken time, otherwise saved as a proposal window', async () => {
  const taken = at(8, 10)
  await viewing(A.ids[0], taken, 'confirmed')
  const req = await viewing(A.ids[0], at(8, 12))
  const clash = await svc('/owner/viewings/decide', { session: A.session, viewingId: req, decision: 'propose', proposeStart: at(8, 10, 10).toISOString() })
  assert.equal(clash.status, 409, JSON.stringify(clash.body)); assert.equal(clash.body.error, 'SLOT_TAKEN')
  const { rows: [still] } = await pool.query(`SELECT status FROM property_viewings WHERE id=$1`, [req])
  assert.equal(still.status, 'pending', 'a refused proposal changes nothing')
  const ok = await svc('/owner/viewings/decide', { session: A.session, viewingId: req, decision: 'propose', proposeStart: at(9, 15).toISOString() })
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.proposed, true)
  const { rows: [w] } = await pool.query(`SELECT source_reference FROM property_viewing_windows WHERE property_id=$1 AND source_reference LIKE $2`, [A.ids[0], `%:propose:${req}`])
  assert.ok(w, 'proposal window is linked to the request')
})

test('accepting a request confirms it; two viewings of one home can never overlap', async () => {
  const s = at(10, 9)
  const id = await viewing(A.ids[1], s)
  const r = await svc('/owner/viewings/decide', { session: A.session, viewingId: id, decision: 'accept' })
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.status, 'confirmed')
  const { rows: [v] } = await pool.query(`SELECT status, owner_survey_status FROM property_viewings WHERE id=$1`, [id])
  assert.deepEqual([v.status, v.owner_survey_status], ['confirmed', 'confirmed'])
  await assert.rejects(() => viewing(A.ids[1], new Date(s.getTime() + 10 * 60e3)), /no_overlap|exclusion|conflict/i)
})

test('the viewings list shows only the owner\'s own homes', async () => {
  const mine = await svc('/owner/viewings', { session: A.session })
  assert.equal(mine.status, 200)
  assert.ok(mine.body.viewings.length >= 3 && mine.body.viewings.every(v => A.ids.includes(v.propertyId)))
  const theirs = await svc('/owner/viewings', { session: B.session })
  assert.equal(theirs.body.viewings.length, 0)
})
