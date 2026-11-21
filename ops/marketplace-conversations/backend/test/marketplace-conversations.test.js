'use strict'
// NEXUS Marketplace conversations (2026-11-21) against a throwaway PostgreSQL with the live schema + migration.
// Synthetic agents, listing and visitor only; staff notices are stubbed, nothing is sent anywhere.
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
const pool = new Pool({ host: process.env.PGHOST, user: 'postgres', password: 'test', database: 'postgres', max: 6 })
const noop = () => {}
function stub(rel, exports) { const file = require.resolve(R(rel)); require.cache[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [] } }
stub('db.js', { query: (s, p) => pool.query(s, p), connect: () => pool.connect() })
stub('logger.js', { info: noop, warn: noop, error: noop, debug: noop })
stub('waha.js', new Proxy({}, { get: () => async () => ({}) }))
const notices = []
stub('services/syncAccount.js', { staffNotice: async t => { notices.push(t); return true } })

let server, base, admin, a1, a2, propId
const tok = a => jwt.sign({ id: a.id, username: a.username, aud: 'crm' }, process.env.JWT_SECRET)
async function http_(method, p, body, headers = {}) {
  const res = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, body: await res.json() }
}
const staff = (a, method, p, body) => http_(method, `/api/crm/marketplace-inbox${p}`, body, { authorization: `Bearer ${tok(a)}` })
const visitor = (method, p, body, token) => http_(method, `/api/nexus/mp${p}`, body, token ? { 'x-mp-token': token } : {})
const maltaDay = days => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Malta' }).format(new Date(Date.now() + days * 86400e3))

test.before(async () => {
  for (let i = 0; i < 60; i++) { try { await pool.query('SELECT 1'); break } catch { await new Promise(r => setTimeout(r, 500)) } }
  const mk = async (username, role) => (await pool.query(`INSERT INTO agents (username, name, role, active, password_hash) VALUES ($1,$1,$2,true,'x') RETURNING id, username`, [username, role])).rows[0]
  admin = await mk('mp-admin', 'admin'); a1 = await mk('mp-agent-1', 'agent'); a2 = await mk('mp-agent-2', 'agent')
  const { rows: [p] } = await pool.query(`INSERT INTO properties (ref, town, property_type, longlet_price, bedrooms, bathrooms, listed_by_agent_id) VALUES ('2906-9765','Msida','apartment',1750,2,2,$1) RETURNING id`, [a1.id])
  propId = p.id
  // a legacy row stored without the agency prefix is still found
  await pool.query(`INSERT INTO properties (ref, town, property_type, longlet_price, bedrooms, bathrooms, listed_by_agent_id) VALUES ('4411','Gzira','maisonette',1500,3,1,$1)`, [a2.id])
  const app = express(); app.use(express.json())
  app.use('/api/crm/marketplace-inbox', require(R('routes/crmMarketplaceInbox.js')))
  app.use('/api/nexus/mp', require(R('routes/marketplaceConversations.js')))
  server = http.createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`
})
test.after(async () => { server.close(); await pool.end() })

let conv, token
test('a visitor starts a conversation about a listing; contact is required, owner data never appears', async () => {
  const bad = await visitor('POST', '/conversations', { ref: '2906-9765', name: 'Mia', message: 'Hi' })
  assert.equal(bad.status, 400); assert.equal(bad.body.error, 'CONTACT_REQUIRED')
  const none = await visitor('POST', '/conversations', { ref: 'WSI-X-1', name: 'Mia', email: 'mia@example.test', message: 'Hi' })
  assert.equal(none.status, 404); assert.equal(none.body.error, 'LISTING_NOT_AGENCY')
  const legacy = await visitor('POST', '/conversations', { ref: '2906-4411', name: 'Leo', message: 'Hi' })
  assert.equal(legacy.status, 400, 'legacy short ref resolves to the listing (then asks for contact)'); assert.equal(legacy.body.error, 'CONTACT_REQUIRED')
  const gone = await visitor('POST', '/conversations', { ref: '2906-0000', name: 'Leo', email: 'leo@example.test', message: 'Hi' })
  assert.equal(gone.status, 404); assert.equal(gone.body.error, 'LISTING_NOT_FOUND')
  const r = await visitor('POST', '/conversations', { ref: '2906-9765', name: 'Mia Visitor', email: 'mia@example.test', role: 'home-seeker', message: 'Is it still available from January?' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  conv = r.body.conversation; token = r.body.token
  assert.ok(token && token.length >= 30); assert.equal(conv.title, '2-Bedroom Apartment in Msida'); assert.equal(conv.agent.id, a1.id)
  assert.equal(conv.messages.length, 1); assert.ok(!JSON.stringify(r.body).match(/owner/i), 'no owner fields')
  const { rows: [row] } = await pool.query(`SELECT token_hash, staff_unread, assigned_agent_id FROM mp_conversations WHERE id=$1`, [conv.id])
  assert.notEqual(row.token_hash, token, 'only the hash is stored'); assert.equal(row.staff_unread, 1); assert.equal(row.assigned_agent_id, a1.id)
  assert.ok(notices.some(n => n.includes('2906-9765')), 'staff notified')
})

test('only the token opens the conversation', async () => {
  assert.equal((await visitor('GET', `/conversations/${conv.id}`, null, 'wrong-token-wrong-token-wrong')).status, 404)
  assert.equal((await visitor('GET', `/conversations/${conv.id}`)).status, 404)
  const ok = await visitor('GET', `/conversations/${conv.id}`, null, token)
  assert.equal(ok.status, 200); assert.equal(ok.body.conversation.messages[0].from, 'visitor')
})

test('inbox: listing agent and admin see it grouped by property; another agent does not', async () => {
  const mine = await staff(a1, 'GET', '/')
  assert.equal(mine.status, 200, JSON.stringify(mine.body))
  assert.equal(mine.body.groups.length, 1); assert.equal(mine.body.groups[0].ref, '2906-9765'); assert.equal(mine.body.groups[0].unread, 1)
  assert.equal((await staff(admin, 'GET', '/')).body.groups.length, 1)
  assert.equal((await staff(a2, 'GET', '/')).body.groups.length, 0)
  assert.equal((await staff(a2, 'GET', `/${conv.id}`)).status, 404)
  assert.equal((await http_('GET', '/api/crm/marketplace-inbox/')).status, 401)
})

test('staff reply reaches the visitor; unread counters follow', async () => {
  const r = await staff(a1, 'POST', `/${conv.id}/messages`, { body: 'Yes, available from 1 January. When would you like to view?' })
  assert.equal(r.status, 200); assert.equal(r.body.conversation.visitor.email, 'mia@example.test')
  assert.equal((await staff(a1, 'GET', '/count')).body.unread, 0)
  const v = await visitor('GET', `/conversations/${conv.id}`, null, token)
  assert.equal(v.body.conversation.messages.at(-1).from, 'staff'); assert.equal(v.body.conversation.unread, 1)
  assert.equal((await visitor('GET', `/conversations/${conv.id}`, null, token)).body.conversation.unread, 0)
  const more = await visitor('POST', `/conversations/${conv.id}/messages`, { body: 'Great, thank you!' }, token)
  assert.equal(more.status, 200); assert.equal((await staff(a1, 'GET', '/count')).body.unread, 1)
})

test('viewing request -> staff books a real ARGUS slot -> waiting for the owner -> confirmed', async () => {
  const bad = await visitor('POST', `/conversations/${conv.id}/viewing`, { preferred: [{ date: '2020-01-01' }] }, token)
  assert.equal(bad.status, 400)
  const day = maltaDay(5)
  const r = await visitor('POST', `/conversations/${conv.id}/viewing`, { preferred: [{ date: day, part: 'evening' }], note: 'After work please' }, token)
  assert.equal(r.status, 200, JSON.stringify(r.body)); const req = r.body.conversation.requests[0]
  assert.equal(req.state, 'requested')
  assert.equal((await visitor('POST', `/conversations/${conv.id}/viewing`, { preferred: [{ date: day }] }, token)).status, 409, 'one open request at a time')
  const inbox = await staff(a1, 'GET', '/?filter=requests'); assert.equal(inbox.body.groups[0].openRequests, 1)
  // no owner hours at that time: the booking engine refuses and nothing changes
  const at = new Date(`${day}T17:00:00Z`)
  const refused = await staff(a1, 'POST', `/${conv.id}/requests/${req.id}/book`, { startsAt: at.toISOString(), durationMin: 20 })
  assert.equal(refused.status, 409, JSON.stringify(refused.body)); assert.equal(refused.body.error, 'BOOKING_REFUSED')
  // owner opens hours; now the slot can be booked
  await pool.query(`INSERT INTO property_viewing_windows (property_id, kind, starts_at, ends_at, status, source_type, created_by, confidence, confirmation)
                    VALUES ($1,'window',$2,$3,'active','owner_sync','owner','explicit','full_window')`, [propId, new Date(at.getTime() - 3600e3).toISOString(), new Date(at.getTime() + 3600e3).toISOString()])
  const booked = await staff(a1, 'POST', `/${conv.id}/requests/${req.id}/book`, { startsAt: at.toISOString(), durationMin: 20 })
  assert.equal(booked.status, 200, JSON.stringify(booked.body))
  const { rows: [pv] } = await pool.query(`SELECT pv.id, pv.status FROM mp_viewing_requests r JOIN property_viewings pv ON pv.id=r.property_viewing_id WHERE r.id=$1`, [req.id])
  assert.ok(pv, 'a real property_viewings row exists (the owner sees it in SYNC)')
  let v = (await visitor('GET', `/conversations/${conv.id}`, null, token)).body.conversation
  assert.equal(v.requests[0].state, pv.status === 'confirmed' ? 'confirmed' : 'waiting_owner', 'never shown as confirmed before the owner/ARGUS says so')
  await pool.query(`UPDATE property_viewings SET status='confirmed' WHERE id=$1`, [pv.id])
  v = (await visitor('GET', `/conversations/${conv.id}`, null, token)).body.conversation
  assert.equal(v.requests[0].state, 'confirmed')
  assert.equal((await staff(a1, 'POST', `/${conv.id}/requests/${req.id}/book`, { startsAt: at.toISOString() })).status, 409, 'handled once')
})

test('closing stops visitor messages', async () => {
  assert.equal((await staff(a1, 'POST', `/${conv.id}/close`, {})).status, 200)
  const r = await visitor('POST', `/conversations/${conv.id}/messages`, { body: 'Hello?' }, token)
  assert.equal(r.status, 409); assert.equal(r.body.error, 'CONVERSATION_CLOSED')
})
