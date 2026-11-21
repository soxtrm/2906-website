'use strict'
// NEXUS Rooms (2026-11-21) against a throwaway PostgreSQL with the live schema (no rows). Synthetic owners only.
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

// ── NEXUS Rooms ───────────────────────────────────────────────────────────────
const PR = require(R('services/propertyRooms.js'))
const RB = require(R('services/roomsBooking.js'))
let A, B, agentA, agentB, admin
const pub = async (p, base2) => { const r = await fetch(`${base2}/api/nexus/rooms${p}`); return { status: r.status, body: await r.json() } }
let pubBase
test.before(async () => {
  for (let i = 0; i < 60; i++) { try { await pool.query('SELECT 1'); break } catch { await new Promise(r => setTimeout(r, 500)) } }
  await pool.query(require('fs').readFileSync(R('test/20261121h_property_rooms.sql'), 'utf8'))
  const app = express(); app.use(express.json({ limit: '10mb' }))
  app.use('/api/sync-account/v1', require(R('routes/syncAccountService.js')))
  app.use('/api/nexus/rooms', require(R('routes/nexusRooms.js')))
  server = http.createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`; pubBase = base
  A = await owner('Owner Rooms', '35699000501', 'rooms-a@example.test', ['2906-9901'])
  B = await owner('Owner Other', '35699000502', 'rooms-b@example.test', ['2906-9902'])
  await pool.query(`UPDATE properties SET published=true, bedrooms=3, images='["https://res.cloudinary.com/x/image/upload/v1/a.jpg","https://res.cloudinary.com/x/image/upload/v1/b.jpg"]'::jsonb WHERE ref IN ('2906-9901','2906-9902')`)
  const mk = async (u, role) => (await pool.query(`INSERT INTO agents (username, name, role, active) VALUES ($1,$1,$2,true) RETURNING id, username, role`, [u, role])).rows[0]
  agentA = await mk('rooms-agent-a', 'agent'); agentB = await mk('rooms-agent-b', 'agent'); admin = await mk('rooms-admin', 'admin')
  await pool.query(`UPDATE properties SET listed_by_agent_id=$1 WHERE ref='2906-9901'`, [agentA.id])
  PR._test.setUploader(async () => 'https://res.cloudinary.com/x/image/upload/v1/2906-properties/rooms/new.jpg')
})
test.after(async () => { server.close(); await pool.end() })

const ROOMS = [
  { label: 'Room 1', priceMonth: 650, status: 'on_market', maxOccupants: 1, features: ['double_bed', 'desk', 'bogus'], sizeSqm: 11 },
  { label: 'Room 2', priceMonth: 700, status: 'on_market', maxOccupants: 2, features: ['double_bed', 'balcony'], privateBathroom: true },
  { label: 'Room 3', priceMonth: 750, status: 'off_market', maxOccupants: 1 },
]
const SHARED = [{ label: 'Kitchen', sharedType: 'kitchen' }, { label: 'Living room', sharedType: 'living' }, { label: 'Bathroom', sharedType: 'bathroom' }, { label: 'Balcony', sharedType: 'balcony' }]

test('owner adds three rooms and four shared spaces to ONE property; positions and spans are stable', async () => {
  const r = await svc('/owner/rooms/save', { session: A.session, propertyId: A.ids[0], rooms: ROOMS, shared: SHARED })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body.rooms.map(x => [x.label, x.position, x.priceMonth, x.span[0]]), [['Room 1', 1, 650, 100], ['Room 2', 2, 700, 200], ['Room 3', 3, 750, 300]])
  assert.deepEqual(r.body.rooms[0].features, ['double_bed', 'desk'], 'unknown features are dropped')
  assert.equal(r.body.shared.length, 4); assert.ok(r.body.shared.every(s => s.status === 'off_market' && s.priceMonth === null), 'shared spaces are never priced or booked')
  const { rows } = await pool.query(`SELECT COUNT(*)::int n FROM properties WHERE ref LIKE '2906-9901%'`)
  assert.equal(rows[0].n, 1, 'no extra apartment records')
  const { rows: [m] } = await pool.query(`SELECT COUNT(*)::int n FROM property_units WHERE property_id=$1`, [A.ids[0]])
  assert.equal(m.n, 7)
})

test('editing keeps ids; leaving a room out retires it (never deleted); positions are not reused', async () => {
  const cur = (await svc('/owner/rooms', { session: A.session, propertyId: A.ids[0] })).body
  const r2 = cur.rooms.find(x => x.label === 'Room 2')
  const r = await svc('/owner/rooms/save', { session: A.session, propertyId: A.ids[0], rooms: [...cur.rooms.filter(x => x.label !== 'Room 3').map(x => ({ ...x, priceMonth: x.label === 'Room 2' ? 720 : x.priceMonth })), { label: 'Room 4', priceMonth: 600, status: 'hold' }], shared: cur.shared })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.rooms.find(x => x.label === 'Room 2').id, r2.id); assert.equal(r.body.rooms.find(x => x.label === 'Room 2').priceMonth, 720)
  assert.equal(r.body.rooms.find(x => x.label === 'Room 4').position, 4, 'position 3 belongs to the retired room forever')
  const { rows: [old] } = await pool.query(`SELECT retired_at, status FROM property_units WHERE property_id=$1 AND label='Room 3'`, [A.ids[0]])
  assert.ok(old.retired_at); assert.equal(old.status, 'off_market')
})

test('validation: on market needs a price; bad values refused; another owner changes nothing', async () => {
  const bad = await svc('/owner/rooms/save', { session: A.session, propertyId: A.ids[0], rooms: [{ label: 'Room X', status: 'on_market' }] })
  assert.equal(bad.status, 400); assert.equal(bad.body.error, 'PRICE_REQUIRED')
  const bad2 = await svc('/owner/rooms/save', { session: A.session, propertyId: A.ids[0], rooms: [{ label: 'Room X', priceMonth: 5 }] })
  assert.equal(bad2.status, 400)
  const other = await svc('/owner/rooms/save', { session: B.session, propertyId: A.ids[0], rooms: [{ label: 'Hijack', priceMonth: 500 }] })
  assert.equal(other.status, 404)
  const read = await svc('/owner/rooms', { session: B.session, propertyId: A.ids[0] })
  assert.equal(read.status, 404)
})

test('letting mode: whole apartment ↔ room by room, history kept; rooms needed first', async () => {
  const none = await svc('/owner/rooms/mode', { session: B.session, propertyId: B.ids[0], mode: 'rooms' })
  assert.equal(none.status, 400); assert.equal(none.body.error, 'ROOMS_REQUIRED')
  const r1 = await svc('/owner/rooms/mode', { session: A.session, propertyId: A.ids[0], mode: 'rooms', markets: ['long_let', 'short_let'] })
  assert.equal(r1.status, 200, JSON.stringify(r1.body)); assert.equal(r1.body.mode.mode, 'rooms')
  await svc('/owner/rooms/mode', { session: A.session, propertyId: A.ids[0], mode: 'whole' })
  const r3 = await svc('/owner/rooms/mode', { session: A.session, propertyId: A.ids[0], mode: 'rooms', markets: ['long_let'] })
  assert.equal(r3.body.mode.mode, 'rooms'); assert.deepEqual(r3.body.mode.markets, ['long_let'])
  const { rows } = await pool.query(`SELECT mode, valid_to FROM property_letting_modes WHERE property_id=$1 ORDER BY id`, [A.ids[0]])
  assert.deepEqual(rows.map(x => [x.mode, !!x.valid_to]), [['rooms', true], ['whole', true], ['rooms', false]])
})

test('photos: one of the home\'s own photos, or a checked upload; anything else refused', async () => {
  const room = (await svc('/owner/rooms', { session: A.session, propertyId: A.ids[0] })).body.rooms[0]
  const own = await svc('/owner/rooms/photo', { session: A.session, propertyId: A.ids[0], unitId: room.id, url: 'https://res.cloudinary.com/x/image/upload/v1/a.jpg' })
  assert.equal(own.status, 200, JSON.stringify(own.body)); assert.equal(own.body.photos.length, 1)
  const foreign = await svc('/owner/rooms/photo', { session: A.session, propertyId: A.ids[0], unitId: room.id, url: 'https://evil.example/x.jpg' })
  assert.equal(foreign.status, 400)
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 1)]).toString('base64')
  const up = await svc('/owner/rooms/photo', { session: A.session, propertyId: A.ids[0], unitId: room.id, dataBase64: jpeg })
  assert.equal(up.status, 200, JSON.stringify(up.body)); assert.equal(up.body.photos.length, 2)
  const txt = await svc('/owner/rooms/photo', { session: A.session, propertyId: A.ids[0], unitId: room.id, dataBase64: Buffer.alloc(3000, 65).toString('base64') })
  assert.equal(txt.status, 400)
  const rm = await svc('/owner/rooms/photo', { session: A.session, propertyId: A.ids[0], unitId: room.id, remove: 'https://res.cloudinary.com/x/image/upload/v1/a.jpg' })
  assert.equal(rm.body.photos.length, 1)
})

test('layout: blocks on a grid, no overlaps, own rooms only; public only after the owner confirms', async () => {
  const st = (await svc('/owner/rooms', { session: A.session, propertyId: A.ids[0] })).body
  const [r1, r2] = st.rooms, kitchen = st.shared.find(x => x.sharedType === 'kitchen')
  const blocks = [{ unitId: r1.id, x: 0, y: 0, w: 6, h: 5, furniture: ['double_bed', 'desk', 'rocket'] }, { unitId: r2.id, x: 6, y: 0, w: 6, h: 5 }, { unitId: kitchen.id, x: 0, y: 5, w: 12, h: 4, furniture: ['kitchen'] }]
  const overlap = await svc('/owner/rooms/layout', { session: A.session, propertyId: A.ids[0], layout: { grid: { w: 24, h: 16 }, blocks: [...blocks, { label: 'x', x: 2, y: 2, w: 3, h: 3 }] } })
  assert.equal(overlap.status, 400); assert.match(overlap.body.message, /overlap/)
  const foreign = await svc('/owner/rooms/layout', { session: A.session, propertyId: A.ids[0], layout: { blocks: [{ unitId: 99999, x: 0, y: 0, w: 2, h: 2 }] } })
  assert.equal(foreign.status, 400)
  const draft = await svc('/owner/rooms/layout', { session: A.session, propertyId: A.ids[0], layout: { grid: { w: 24, h: 16 }, blocks } })
  assert.equal(draft.status, 200, JSON.stringify(draft.body)); assert.equal(draft.body.layout.status, 'draft')
  assert.deepEqual(draft.body.layout.blocks[0].furniture, ['double_bed', 'desk'])
  let p = await pub('/2906-9901', pubBase)
  assert.equal(p.status, 200, JSON.stringify(p.body)); assert.equal(p.body.layout, null, 'a draft layout is never public')
  await svc('/owner/rooms/layout', { session: A.session, propertyId: A.ids[0], layout: { grid: { w: 24, h: 16 }, blocks }, confirm: true })
  p = await pub('/2906-9901', pubBase)
  assert.equal(p.body.layout.blocks.length, 3); assert.match(p.body.layout.note, /Approximate/)
  const again = await svc('/owner/rooms', { session: A.session, propertyId: A.ids[0] })
  assert.equal(again.body.layout.status, 'owner_confirmed'); assert.ok(again.body.layout.version >= 2)
})

test('public: published homes in room mode, rooms not off market, no owner data; whole-mode or unpublished homes hidden', async () => {
  const list = await pub('', pubBase)
  assert.equal(list.status, 200)
  const h = list.body.homes.find(x => x.ref === '2906-9901')
  assert.ok(h); assert.deepEqual(h.rooms.map(r => r.label), ['Room 1', 'Room 2', 'Room 4'], 'off-market room 3 was retired; hold rooms show as reserved')
  assert.ok(!JSON.stringify(list.body).match(/Owner Rooms|35699000501|rooms-a@/))
  assert.ok(!list.body.homes.some(x => x.ref === '2906-9902'), 'whole-mode home is not in Rooms')
  await pool.query(`UPDATE properties SET published=false WHERE ref='2906-9901'`)
  assert.equal((await pub('/2906-9901', pubBase)).status, 404)
  await pool.query(`UPDATE properties SET published=true WHERE ref='2906-9901'`)
  assert.equal((await pub('/demo/2906-9901', pubBase)).status, 404, 'demo route serves only DEMO-* staging homes')
})

test('staff: admin and the listing agent change rooms; other agents only read', async () => {
  const actor = a => ({ kind: 'staff', agent: a })
  const listed = await PR.saveUnits(actor(agentA), { propertyId: A.ids[0], rooms: (await PR.rooms(actor(agentA), { propertyId: A.ids[0] })).rooms })
  assert.ok(listed.rooms.length >= 3)
  await assert.rejects(() => PR.saveUnits(actor(agentB), { propertyId: A.ids[0], rooms: [] }), /listing agent/)
  assert.ok((await PR.rooms(actor(agentB), { propertyId: A.ids[0] })).rooms.length >= 3, 'other staff can read')
  await assert.rejects(() => PR.saveLayout(actor(agentA), { propertyId: A.ids[0], layout: { blocks: [] }, confirm: true }), /owner confirms/)
  assert.ok(await PR.setMode(actor(admin), { propertyId: A.ids[0], mode: 'rooms' }))
})

test('stays through NEXUS Booking: signed calls; owners see contacts only after confirming; occupied mirrors a started stay', async () => {
  process.env.NEXUS_ROOMS_SECRET = 's'.repeat(40); process.env.NEXUS_BOOKING_ROOMS_URL = 'http://booking.test'
  const room = (await svc('/owner/rooms', { session: A.session, propertyId: A.ids[0] })).body.rooms[1]
  const today = new Date().toISOString().slice(0, 10)
  const stay = { id: 'rs_abcdefghij', unitKey: `room:${room.id}`, unitLabel: 'Room 2', checkIn: today, checkOut: '2099-01-01', status: 'requested', kind: 'booking', guest: { name: 'Mia', email: 'mia@example.test', phone: '+35699' }, history: [] }
  const calls = []
  RB._test.setHttp(async (url, init) => {
    calls.push({ url, init })
    const ok = init.headers['X-Nexus-Rooms-Sig'] === RB.sign('s'.repeat(40), init.headers['X-Nexus-Rooms-Ts'], init.method, new URL(url).pathname, init.body || '')
    if (!ok) return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 })
    if (init.method === 'GET') return new Response(JSON.stringify({ stays: [stay] }), { status: 200 })
    return new Response(JSON.stringify({ stay: { ...stay, status: 'confirmed' } }), { status: 200 })
  })
  const list = await svc('/owner/rooms/stays', { session: A.session, propertyId: A.ids[0] })
  assert.equal(list.status, 200, JSON.stringify(list.body)); assert.equal(list.body.stays[0].guest.email, null, 'no contact before confirming')
  assert.match(calls[0].url, /property=2906-9901/)
  const dec = await svc('/owner/rooms/decide', { session: A.session, propertyId: A.ids[0], stayId: stay.id, action: 'confirm' })
  assert.equal(dec.status, 200, JSON.stringify(dec.body)); assert.equal(dec.body.stay.guest.email, 'mia@example.test')
  assert.equal(JSON.parse(calls[1].init.body).propertyRef, '2906-9901', 'the home is named by ARGUS, never by the caller')
  const { rows: [u] } = await pool.query(`SELECT status FROM property_units WHERE id=$1`, [room.id])
  assert.equal(u.status, 'occupied')
  const other = await svc('/owner/rooms/decide', { session: B.session, propertyId: A.ids[0], stayId: stay.id, action: 'confirm' })
  assert.equal(other.status, 404)
})
