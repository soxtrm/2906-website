'use strict'
// SYNC calendar 2.0 (2026-11-21) against a throwaway PostgreSQL with the live schema (no rows). Synthetic owners only.
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

// ── calendar 2.0 ──────────────────────────────────────────────────────────────
const MT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const wall = d => { const p = Object.fromEntries(MT.formatToParts(d).map(x => [x.type, x.value])); return `${p.hour}:${p.minute}` }
let A, B
test.before(async () => {
  for (let i = 0; i < 60; i++) { try { await pool.query('SELECT 1'); break } catch { await new Promise(r => setTimeout(r, 500)) } }
  await pool.query(require('fs').readFileSync(R('test/20261121g_sync_calendar_2.sql'), 'utf8'))
  const app = express(); app.use(express.json()); app.use('/api/sync-account/v1', require(R('routes/syncAccountService.js')))
  server = http.createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`
  A = await owner('Owner A2', '35699000301', 'cal2-a@example.test', ['2906-C2-1', '2906-C2-2'])
  B = await owner('Owner B2', '35699000302', 'cal2-b@example.test', ['2906-C2-9'])
})
test.after(async () => { server.close(); await pool.end() })

test('a range is one window; a second range the same day does not replace it; agency hours stay', async () => {
  const { rows: [ag] } = await pool.query(`INSERT INTO property_viewing_windows (property_id, kind, starts_at, ends_at, status, source_type, created_by, confidence)
     VALUES ($1,'window',$2,$3,'active','agent','agent','explicit') RETURNING id`, [A.ids[0], at(5, 6).toISOString(), at(5, 7).toISOString()])
  const r = await svc('/owner/cal/window/add', { session: A.session, propertyId: A.ids[0], start: at(5, 12).toISOString(), end: at(5, 15).toISOString() })
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.created.length, 1)
  const r2 = await svc('/owner/cal/window/add', { session: A.session, propertyId: A.ids[0], start: at(5, 8).toISOString(), end: at(5, 10).toISOString() })
  assert.equal(r2.status, 200, JSON.stringify(r2.body))
  const { rows } = await pool.query(`SELECT id FROM property_viewing_windows WHERE property_id=$1 AND status='active'`, [A.ids[0]])
  assert.equal(rows.length, 3, 'agency hours + two owner ranges, nothing superseded')
  assert.ok(rows.some(x => x.id === ag.id))
  const dup = await svc('/owner/cal/window/add', { session: A.session, propertyId: A.ids[0], start: at(5, 14).toISOString(), end: at(5, 16).toISOString() })
  assert.equal(dup.status, 409); assert.equal(dup.body.error, 'WINDOW_OVERLAP')
})

test('weekly hours keep the same Malta wall time every week and skip weeks that are taken', async () => {
  const s = at(2, 13), e = at(2, 15)
  await svc('/owner/cal/window/add', { session: A.session, propertyId: A.ids[1], start: at(16, 13).toISOString(), end: at(16, 14).toISOString() })
  const r = await svc('/owner/cal/window/add', { session: A.session, propertyId: A.ids[1], start: s.toISOString(), end: e.toISOString(), repeatWeeks: 3 })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.created.length, 3); assert.equal(r.body.skipped.length, 1)
  for (const w of r.body.created) { assert.equal(wall(new Date(w.start)), wall(s)); assert.equal(wall(new Date(w.end)), wall(e)) }
})

test('moving and resizing own hours: bookings outside are flagged, never moved; agency hours cannot be changed', async () => {
  const add = await svc('/owner/cal/window/add', { session: A.session, propertyId: A.ids[0], start: at(20, 8).toISOString(), end: at(20, 12).toISOString() })
  assert.equal(add.status, 200, JSON.stringify(add.body))
  const w = add.body.created[0]
  const v = await viewing(A.ids[0], at(20, 11), 'confirmed')
  await pool.query(`UPDATE property_viewings SET window_id=$2 WHERE id=$1`, [v, w.id])
  const up = await svc('/owner/cal/window/update', { session: A.session, propertyId: A.ids[0], windowId: w.id, start: at(20, 8).toISOString(), end: at(20, 10).toISOString() })
  assert.equal(up.status, 200, JSON.stringify(up.body)); assert.equal(up.body.flagged, 1)
  const { rows: [vv] } = await pool.query(`SELECT starts_at, status, attention_reason FROM property_viewings WHERE id=$1`, [v])
  assert.equal(vv.status, 'confirmed'); assert.equal(new Date(vv.starts_at).getTime(), at(20, 11).getTime()); assert.ok(vv.attention_reason)
  const { rows: [ag] } = await pool.query(`SELECT id FROM property_viewing_windows WHERE property_id=$1 AND source_type='agent' LIMIT 1`, [A.ids[0]])
  const no = await svc('/owner/cal/window/update', { session: A.session, propertyId: A.ids[0], windowId: ag.id, start: at(5, 6).toISOString(), end: at(5, 7, 30).toISOString() })
  assert.equal(no.status, 403); assert.equal(no.body.error, 'WINDOW_NOT_OWN')
  const other = await svc('/owner/cal/window/update', { session: B.session, propertyId: A.ids[0], windowId: w.id, start: at(21, 8).toISOString(), end: at(21, 9).toISOString() })
  assert.ok(other.status >= 400 && other.status < 500)
})

test('own appointment (neighbour) is confirmed at once and blocks the slot; overlaps are refused', async () => {
  const s = at(22, 9)
  const r = await svc('/owner/cal/appointment', { session: A.session, propertyId: A.ids[1], start: s.toISOString(), minutes: 20, label: 'Neighbour (Maria)' })
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.viewing.status, 'confirmed'); assert.equal(r.body.viewing.kind, 'manual')
  const { rows: [v] } = await pool.query(`SELECT source, confirmation_method, requester_name, status FROM property_viewings WHERE id=$1`, [r.body.viewing.id])
  assert.deepEqual([v.source, v.confirmation_method, v.requester_name, v.status], ['owner_sync', 'owner_manual', 'Neighbour (Maria)', 'confirmed'])
  const clash = await svc('/owner/cal/appointment', { session: A.session, propertyId: A.ids[1], start: at(22, 9, 10).toISOString(), kind: 'reserved' })
  assert.equal(clash.status, 409); assert.equal(clash.body.error, 'SLOT_TAKEN')
  await assert.rejects(() => viewing(A.ids[1], at(22, 9, 5)), /no_overlap|exclusion|conflict/i)
  const res = await svc('/owner/cal/appointment', { session: A.session, propertyId: A.ids[1], start: at(22, 10).toISOString(), kind: 'reserved' })
  assert.equal(res.status, 200); assert.equal(res.body.viewing.kind, 'reserved'); assert.equal(res.body.viewing.label, 'Reserved')
  const st = await svc('/owner/cal', { session: A.session })
  assert.equal(st.status, 200)
  const mine = st.body.viewings.filter(x => x.kind !== 'agency')
  assert.ok(mine.some(x => x.label === 'Neighbour (Maria)') && mine.some(x => x.kind === 'reserved'))
  assert.ok(st.body.viewings.filter(x => x.kind === 'agency').every(x => x.label === null), 'agency clients are never named')
})

test('only own appointments can be removed; another owner sees and changes nothing', async () => {
  const st = await svc('/owner/cal', { session: A.session })
  const own = st.body.viewings.find(x => x.kind === 'manual' && x.status === 'confirmed'), agency = st.body.viewings.find(x => x.kind === 'agency')
  assert.ok(own && agency)
  const no = await svc('/owner/cal/appointment/cancel', { session: A.session, viewingId: agency.id })
  assert.equal(no.status, 404)
  const other = await svc('/owner/cal/appointment/cancel', { session: B.session, viewingId: own.id })
  assert.equal(other.status, 404)
  const ok = await svc('/owner/cal/appointment/cancel', { session: A.session, viewingId: own.id })
  assert.equal(ok.status, 200)
  const { rows: [v] } = await pool.query(`SELECT status FROM property_viewings WHERE id=$1`, [own.id])
  assert.equal(v.status, 'cancelled')
  const theirs = await svc('/owner/cal', { session: B.session })
  assert.equal(theirs.body.viewings.length, 0)
  const b = await svc('/owner/cal/appointment', { session: B.session, propertyId: A.ids[1], start: at(23, 9).toISOString() })
  assert.ok(b.status >= 400 && b.status < 500)
})

test('slot length per home is stored on the account and survives a new session', async () => {
  const bad = await svc('/owner/cal/slot', { session: A.session, propertyId: A.ids[0], minutes: 45 })
  assert.equal(bad.status, 400)
  const ok = await svc('/owner/cal/slot', { session: A.session, propertyId: A.ids[0], minutes: 15 })
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.slotMinutes, 15)
  const login = await svc('/login', { email: 'cal2-a@example.test', password: 'harbour-view-22' }, { ip: '10.9.77.1' })
  assert.equal(login.status, 200, JSON.stringify(login.body))
  const st = await svc('/owner/cal', { session: login.body.session.token })
  assert.equal(st.body.homes.find(h => h.id === A.ids[0]).slotMinutes, 15)
  assert.equal(st.body.homes.find(h => h.id === A.ids[1]).slotMinutes, 30)
  const other = await svc('/owner/cal/slot', { session: B.session, propertyId: A.ids[0], minutes: 60 })
  assert.equal(other.status, 404)
})
