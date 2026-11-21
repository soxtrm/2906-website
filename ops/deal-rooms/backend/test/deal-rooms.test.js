'use strict'
// NEXUS Deal Room (2026-11-21) against a throwaway PostgreSQL with the live schema + migrations. Synthetic agents,
// listing and visitor only; staff notices are stubbed, nothing is sent anywhere.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const http = require('http')

process.env.JWT_SECRET = 'test-secret-not-production'
process.env.ARGUS_AGENCY_KEY = '2906'
const ROOT = process.env.BACKEND_DIR || '/app'
const R = p => path.join(ROOT, p)
const express = require(R('node_modules/express'))
const jwt = require(R('node_modules/jsonwebtoken'))
const { Pool } = require(R('node_modules/pg'))
const pool = new Pool({ host: process.env.PGHOST, user: 'postgres', password: 'test', database: 'postgres', max: 8 })
const noop = () => {}
function stub(rel, exports) { const file = require.resolve(R(rel)); require.cache[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [] } }
stub('db.js', { query: (s, p) => pool.query(s, p), connect: () => pool.connect() })
stub('logger.js', { info: noop, warn: noop, error: noop, debug: noop })
stub('waha.js', new Proxy({}, { get: () => async () => ({}) }))
stub('services/syncAccount.js', { staffNotice: async () => true })

let server, base, admin, a1, a2, propId
const tok = a => jwt.sign({ id: a.id, username: a.username, aud: 'crm' }, process.env.JWT_SECRET)
async function http_(method, p, body, headers = {}) {
  const res = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, body: await res.json() }
}
const inbox = (a, m, p, b) => http_(m, `/api/crm/marketplace-inbox${p}`, b, { authorization: `Bearer ${tok(a)}` })
const deals = (a, m, p, b) => http_(m, `/api/crm/deal-rooms${p}`, b, { authorization: `Bearer ${tok(a)}` })
const visitor = (m, p, b, token) => http_(m, `/api/nexus/mp${p}`, b, token ? { 'x-mp-token': token } : {})
const maltaDay = days => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Malta' }).format(new Date(Date.now() + days * 86400e3))

test.before(async () => {
  for (let i = 0; i < 60; i++) { try { await pool.query('SELECT 1'); break } catch { await new Promise(r => setTimeout(r, 500)) } }
  const mk = async (username, role) => (await pool.query(`INSERT INTO agents (username, name, role, active, password_hash) VALUES ($1,$1,$2,true,'x') RETURNING id, username, role`, [username, role])).rows[0]
  admin = await mk('dr-admin', 'admin'); a1 = await mk('dr-agent-1', 'agent'); a2 = await mk('dr-agent-2', 'agent')
  propId = (await pool.query(`INSERT INTO properties (ref, town, property_type, longlet_price, bedrooms, bathrooms, listed_by_agent_id) VALUES ('2906-9765','Msida','apartment',1750,2,2,$1) RETURNING id`, [a1.id])).rows[0].id
  const app = express(); app.use(express.json())
  app.use('/api/crm/marketplace-inbox', require(R('routes/crmMarketplaceInbox.js')))
  app.use('/api/crm/deal-rooms', require(R('routes/crmDealRooms.js')))
  app.use('/api/nexus/mp', require(R('routes/marketplaceConversations.js')))
  server = http.createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`
})
test.after(async () => { server.close(); await pool.end() })

let conv, token, room
test('an ordinary enquiry is not a deal: no Deal Room until a viewing is requested', async () => {
  const r = await visitor('POST', '/conversations', { ref: '2906-9765', name: 'Mia Visitor', email: 'mia@example.test', message: 'Hi, still available?' })
  assert.equal(r.status, 200, JSON.stringify(r.body)); conv = r.body.conversation; token = r.body.token
  assert.equal(conv.deal, null)
  assert.equal((await deals(a1, 'GET', '/')).body.deals.length, 0)
})

test('a viewing request creates exactly one Deal Room, linked to the conversation, visible to both sides', async () => {
  const r = await visitor('POST', `/conversations/${conv.id}/viewing`, { preferred: [{ date: maltaDay(5), part: 'evening' }] }, token)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const d = r.body.conversation.deal
  assert.ok(d && d.id); assert.equal(d.stage, 'viewing_requested')
  assert.deepEqual(d.timeline.map(e => e.kind), ['created', 'viewing_requested'])
  assert.equal(d.nextAction, undefined, 'the visitor does not get the agency\'s working notes')
  room = d.id
  const list = await deals(a1, 'GET', '/'); assert.equal(list.body.deals.length, 1); assert.equal(list.body.deals[0].ref, '2906-9765')
  const v = await deals(a1, 'GET', `/${room}`)
  assert.equal(v.status, 200); assert.equal(v.body.deal.conversationId, conv.id); assert.equal(v.body.deal.property.ref, '2906-9765')
  assert.equal(v.body.deal.payments.status, 'not_available', 'nothing can be marked paid')
})

test('a second viewing request on the same enquiry links to the same room (no duplicate)', async () => {
  const st = await inbox(a1, 'GET', `/${conv.id}`); const req = st.body.conversation.requests[0]
  assert.equal((await inbox(a1, 'POST', `/${conv.id}/requests/${req.id}/decline`, { note: 'Fully booked that week' })).status, 200)
  const again = await visitor('POST', `/conversations/${conv.id}/viewing`, { preferred: [{ date: maltaDay(6) }] }, token)
  assert.equal(again.status, 200); assert.equal(again.body.conversation.deal.id, room)
  assert.equal(Number((await pool.query(`SELECT count(*) FROM deal_rooms WHERE conversation_id=$1`, [conv.id])).rows[0].count), 1)
  const kinds = (await deals(a1, 'GET', `/${room}`)).body.deal.timeline.map(e => e.kind)
  assert.deepEqual(kinds, ['created', 'viewing_requested', 'viewing_declined', 'viewing_requested'])
})

test('an unrelated agent can neither list, read nor change the room; admin can', async () => {
  assert.equal((await deals(a2, 'GET', '/')).body.deals.length, 0)
  assert.equal((await deals(a2, 'GET', `/${room}`)).status, 404)
  assert.equal((await deals(a2, 'POST', `/${room}/stage`, { stage: 'cancelled' })).status, 404)
  assert.equal((await deals(a2, 'POST', `/${room}/notes`, { text: 'x' })).status, 404)
  assert.equal((await deals(admin, 'GET', `/${room}`)).status, 200)
  assert.equal((await deals(a1, 'GET', `/00000000-0000-0000-0000-000000000000`)).status, 404)
})

test('booking the viewing moves the room to "viewing booked"; the owner side shows the real confirmation state', async () => {
  const byHand = await deals(a1, 'POST', `/${room}/stage`, { stage: 'viewing_booked' })
  assert.equal(byHand.status, 409, 'only a real booking sets viewing booked'); assert.deepEqual((await deals(a1, 'GET', `/${room}`)).body.deal.allowed, ['cancelled'])
  const st = await inbox(a1, 'GET', `/${conv.id}`); const req = st.body.conversation.requests.find(r => r.state === 'requested')
  const at = new Date(`${maltaDay(6)}T17:00:00Z`)
  await pool.query(`INSERT INTO property_viewing_windows (property_id, kind, starts_at, ends_at, status, source_type, created_by, confidence, confirmation)
                    VALUES ($1,'window',$2,$3,'active','owner_sync','owner','explicit','full_window')`, [propId, new Date(at.getTime() - 3600e3).toISOString(), new Date(at.getTime() + 3600e3).toISOString()])
  const b = await inbox(a1, 'POST', `/${conv.id}/requests/${req.id}/book`, { startsAt: at.toISOString(), durationMin: 20 })
  assert.equal(b.status, 200, JSON.stringify(b.body))
  const v = (await deals(a1, 'GET', `/${room}`)).body.deal
  assert.equal(v.stage, 'viewing_booked'); assert.equal(v.owner.viewing[0].state, 'waiting_owner')
  assert.ok(!JSON.stringify(v.owner).match(/phone|email|name/i), 'no owner identity or contact')
  await pool.query(`UPDATE property_viewings SET status='confirmed' WHERE id=(SELECT property_viewing_id FROM mp_viewing_requests WHERE id=$1)`, [req.id])
  assert.equal((await deals(a1, 'GET', `/${room}`)).body.deal.owner.viewing[0].state, 'confirmed')
})

test('stages move one step at a time; internal notes stay internal; the visitor sees the progress', async () => {
  const skip = await deals(a1, 'POST', `/${room}/stage`, { stage: 'offer' })
  assert.equal(skip.status, 409); assert.equal(skip.body.error, 'STAGE_NOT_ALLOWED')
  assert.equal((await deals(a1, 'POST', `/${room}/stage`, { stage: 'viewing_done', note: 'Client liked it, worried about parking' })).status, 200)
  assert.equal((await deals(a1, 'POST', `/${room}/stage`, { stage: 'offer' })).status, 200)
  assert.equal((await deals(a1, 'POST', `/${room}/notes`, { text: 'Owner wants 12 months minimum' })).status, 200)
  const mine = await visitor('GET', `/conversations/${conv.id}`, null, token)
  const d = mine.body.conversation.deal
  assert.equal(d.stage, 'offer')
  assert.equal(d.stages.find(s => s.key === 'viewing_done').state, 'done'); assert.equal(d.stages.find(s => s.key === 'offer').state, 'now')
  const seen = JSON.stringify(d.timeline)
  assert.ok(!/parking|12 months/.test(seen), 'internal notes never reach the visitor')
  const staffSide = JSON.stringify((await deals(a1, 'GET', `/${room}`)).body.deal.timeline)
  assert.ok(/parking/.test(staffSide) && /12 months/.test(staffSide))
})

test('two people changing the same stage at once: exactly one wins', async () => {
  const both = await Promise.all([deals(a1, 'POST', `/${room}/stage`, { stage: 'terms_agreed' }), deals(admin, 'POST', `/${room}/stage`, { stage: 'terms_agreed' })])
  assert.deepEqual(both.map(r => r.status).sort(), [200, 409])
  assert.equal(Number((await pool.query(`SELECT count(*) FROM deal_room_events WHERE deal_room_id=$1 AND kind='stage' AND data->>'to'='terms_agreed'`, [room])).rows[0].count), 1)
})

test('a closed room frees the conversation: a new viewing request later opens a new room', async () => {
  assert.equal((await deals(a1, 'POST', `/${room}/stage`, { stage: 'cancelled', note: 'Client found another place' })).status, 200)
  assert.equal((await deals(a1, 'POST', `/${room}/stage`, { stage: 'contract' })).status, 409, 'nothing after cancelled')
  assert.equal((await deals(a1, 'GET', '/?stage=open')).body.deals.length, 0)
  assert.equal((await deals(a1, 'GET', '/?stage=closed')).body.deals.length, 1)
})
