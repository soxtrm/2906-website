'use strict'
// Viewing request follow-up (2026-11-21) against a throwaway PostgreSQL with the
// live schema of the tables involved (no rows). Synthetic agents, owners and
// bookings only; the WhatsApp sender is a stub.
//   BACKEND_DIR=/app PGHOST=... node --test test/viewing-followups.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const http = require('http')

process.env.JWT_SECRET = 'test-secret-not-production'
process.env.NODE_ENV = 'test'
const ROOT = process.env.BACKEND_DIR || '/app'
const R = p => path.join(ROOT, p)
const jwt = require(R('node_modules/jsonwebtoken'))
const express = require(R('node_modules/express'))
const { Pool } = require(R('node_modules/pg'))
const pool = new Pool({ host: process.env.PGHOST, user: 'postgres', password: 'test', database: 'postgres', max: 6 })
const noop = () => {}
function stub(rel, exports) { const file = require.resolve(R(rel)); require.cache[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [] } }
stub('db.js', { query: (s, p) => pool.query(s, p), connect: () => pool.connect() })
stub('logger.js', { info: noop, warn: noop, error: noop, debug: noop })
stub('waha.js', new Proxy({}, { get: () => async () => ({}) }))

const F = require(R('services/viewingFollowups.js'))
const sent = []
let failNext = false
F.setTransport({ send: async (session, chat, text) => { if (failNext) { failNext = false; throw new Error('gateway down') } sent.push({ session, chat, text }) }, pick: async () => 'Argus1' })

const sign = (id, username, role, aud = 'crm') => jwt.sign({ id, username, role, aud }, process.env.JWT_SECRET)
const T = { katya: sign(13, 'katya', 'board', 'board'), olga: sign(2, 'olga', 'admin'), nico: sign(57, 'nico', 'agent') }
let server, base, propId, ownerId
const malta = (y, m, d, h, mi) => require(R('lib/maltaTime.js')).maltaToUtc(y, m, d, h, mi)

test.before(async () => {
  for (let i = 0; i < 60; i++) { try { await pool.query('SELECT 1'); break } catch { await new Promise(r => setTimeout(r, 500)) } }
  await pool.query(`INSERT INTO agents (id, username, name, role, active, board_access, can_create_owner_group, can_view_owner_contact) VALUES
    (2,'olga','Olga Test','admin',true,true,true,true), (13,'katya','Katya Test','board',true,true,true,true), (57,'nico','Nico Test','agent',true,false,false,false)`)
  await pool.query(`INSERT INTO agent_workspace_config (agent_id, agent_name, workspace_slug, access_token, whatsapp_group_jid) VALUES (13,'Katya','test-katya','test-token-not-real','120363000000000001@g.us')`)
  const { rows: [o] } = await pool.query(`INSERT INTO owner_contacts (phone_normalized, name) VALUES ('35699000111','Synthetic Owner') RETURNING id`)
  ownerId = o.id
  const { rows: [p] } = await pool.query(`INSERT INTO properties (ref, town, property_type, longlet_price, owner_id) VALUES ('T-500','Sliema','Apartment',1500,$1) RETURNING id`, [ownerId])
  propId = p.id
  const app = express(); app.use(express.json())
  app.use('/api/crm/viewing-followups', require(R('routes/crmViewingFollowups.js')))
  server = http.createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}/api/crm/viewing-followups`
})
test.after(async () => { server.close(); await pool.end() })

async function call(method, p, tok, body) {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, body: await r.json() }
}
async function booking(startsAt, { agent = 13, status = 'pending' } = {}) {
  const { rows: [v] } = await pool.query(
    `INSERT INTO property_viewings (property_id, viewing_date, starts_at, duration_min, status, user_id, viewing_agent_id, source, requester_phone)
     VALUES ($1, ($2::timestamptz AT TIME ZONE 'Europe/Malta')::date, $2::timestamptz, 20, $3, $4, $4, 'board_slot', '35699999999') RETURNING id`, [propId, startsAt, status, agent])
  return v.id
}

test('the question is due the day after, 09:30 Malta', () => {
  const s = F.schedule(malta(2026, 12, 7, 16, 30))
  assert.equal(s.dueDate, '2026-12-08')
  assert.equal(s.askAfter.toISOString(), '2026-12-08T08:30:00.000Z')
  assert.equal(F.quiet(malta(2026, 12, 8, 21, 0)), true)
  assert.equal(F.quiet(malta(2026, 12, 8, 10, 0)), false)
})

test('a requested viewing is never described as one that happened', () => {
  const now = malta(2026, 12, 8, 10, 0)
  const req = F.questionText({ agentName: 'Katya Test', ref: '9502', town: 'Sliema', slotAt: malta(2026, 12, 7, 16, 30), confirmed: false, now, link: 'x' })
  assert.match(req, /^Hi Katya, a viewing for #9502 Sliema was requested for yesterday at 16:30; the owner had not confirmed it\. Did it take place\?/)
  const conf = F.questionText({ agentName: 'Katya', ref: '9502', town: 'Sliema', slotAt: malta(2026, 12, 7, 16, 30), confirmed: true, now, link: 'x' })
  assert.match(conf, /^Hi Katya, you had a viewing planned for #9502 Sliema yesterday at 16:30\. Did it take place\?/)
  assert.doesNotMatch(req + conf, /How was the viewing/)
})

let vid, fid
test('a booking request is tracked at once, without the owner', async () => {
  vid = await booking(new Date(Date.now() + 3 * 86400e3))
  await F.syncAll({ send: false })
  const { rows: [f] } = await pool.query(`SELECT * FROM viewing_followups WHERE viewing_id=$1`, [vid])
  assert.equal(f.state, 'requested'); assert.equal(f.feedback_state, 'scheduled'); assert.equal(f.requesting_agent_id, 13)
  fid = f.id
  await F.syncAll({ send: false })
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM viewing_followups WHERE viewing_id=$1`, [vid])).rows[0].n, 1, 'no duplicate')
})

test('the follow-up follows the booking: confirmed, moved, cancelled, reinstated', async () => {
  await pool.query(`UPDATE property_viewings SET status='confirmed' WHERE id=$1`, [vid])
  await F.syncAll({ send: false })
  assert.equal((await pool.query(`SELECT state FROM viewing_followups WHERE id=$1`, [fid])).rows[0].state, 'confirmed')
  const moved = new Date(Date.now() + 5 * 86400e3)
  await pool.query(`UPDATE property_viewings SET starts_at=$2 WHERE id=$1`, [vid, moved])
  await F.syncAll({ send: false })
  let f = (await pool.query(`SELECT * FROM viewing_followups WHERE id=$1`, [fid])).rows[0]
  assert.equal(f.state, 'rescheduled'); assert.equal(new Date(f.slot_at).getTime(), moved.getTime())
  assert.equal(String(f.due_date instanceof Date ? f.due_date.toISOString() : f.due_date).slice(0, 10) >= new Date(moved.getTime()).toISOString().slice(0, 10), true)
  await pool.query(`UPDATE property_viewings SET status='cancelled' WHERE id=$1`, [vid])
  await F.syncAll({ send: false })
  f = (await pool.query(`SELECT * FROM viewing_followups WHERE id=$1`, [fid])).rows[0]
  assert.equal(f.state, 'cancelled'); assert.equal(f.feedback_state, 'cancelled')
  await pool.query(`UPDATE property_viewings SET status='pending' WHERE id=$1`, [vid])
  await F.syncAll({ send: false })
  f = (await pool.query(`SELECT * FROM viewing_followups WHERE id=$1`, [fid])).rows[0]
  assert.equal(f.state, 'requested'); assert.equal(f.feedback_state, 'scheduled')
  const kinds = (await pool.query(`SELECT kind FROM viewing_followup_events WHERE followup_id=$1 ORDER BY id`, [fid])).rows.map(r => r.kind)
  assert.deepEqual(kinds, ['created', 'confirmed', 'rescheduled', 'cancelled', 'reinstated'])
})

test('the day after: asked once in the agent workspace group, never in quiet hours, retried after a failure', async () => {
  const yesterday = new Date(Date.now() - 86400e3); yesterday.setUTCHours(15, 0, 0, 0)
  const v = await booking(yesterday)
  await F.ensureOne(v)
  const { rows: [f] } = await pool.query(`SELECT id FROM viewing_followups WHERE viewing_id=$1`, [v])
  // pretend the question is due now; a pass at night sends nothing
  const p = require(R('lib/maltaTime.js')).maltaParts(new Date())
  const nightAt = malta(p.y, p.m, p.d, 23, 0), day = malta(p.y, p.m, p.d, 11, 0)
  await pool.query(`UPDATE viewing_followups SET ask_after=$2 WHERE id=$1`, [f.id, new Date(day.getTime() - 60e3)])
  await F.syncAll({ now: nightAt })
  assert.equal(sent.length, 0)
  failNext = true
  let r = await F.syncAll({ now: day })
  const dbg = (await pool.query(`SELECT feedback_state, ask_after, ask_count, slot_at FROM viewing_followups WHERE id=$1`, [f.id])).rows[0]
  assert.equal(r.failed, 1, JSON.stringify({ r, dbg, day, nightAt })); assert.equal(sent.length, 0)
  assert.equal((await pool.query(`SELECT feedback_state FROM viewing_followups WHERE id=$1`, [f.id])).rows[0].feedback_state, 'due')
  await pool.query(`UPDATE viewing_followups SET ask_after=$2 WHERE id=$1`, [f.id, new Date(day.getTime() - 60e3)])
  r = await F.syncAll({ now: day })
  assert.equal(r.asked, 1); assert.equal(sent.length, 1)
  assert.equal(sent[0].chat, '120363000000000001@g.us')
  assert.match(sent[0].text, /had not confirmed it\. Did it take place\?/)
  assert.match(sent[0].text, /bookings\?feedback=\d+/)
  await F.syncAll({ now: day }); await F.syncAll({ now: day })
  assert.equal(sent.length, 1, 'asked once')
})

test('answers: only the requesting agent (or an admin); rescheduled moves the question; cancelled cannot be answered', async () => {
  const { rows: [f] } = await pool.query(`SELECT id FROM viewing_followups WHERE feedback_state='asked' LIMIT 1`)
  assert.equal((await call('POST', `/${f.id}/answer`, T.nico, { outcome: 'completed' })).status, 404)
  const later = new Date(Date.now() + 2 * 86400e3)
  const r = await call('POST', `/${f.id}/answer`, T.katya, { outcome: 'rescheduled', newStartsAt: later.toISOString(), note: 'Client asked for Friday' })
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.followup.feedback, 'scheduled'); assert.equal(new Date(r.body.followup.slotAt).getTime(), later.getTime())
  await F.syncAll({ send: false })
  assert.equal((await pool.query(`SELECT agent_slot_at IS NOT NULL AS kept FROM viewing_followups WHERE id=$1`, [f.id])).rows[0].kept, true, 'the agent’s new time survives a pass')
  const done = await call('POST', `/${f.id}/answer`, T.katya, { outcome: 'completed', nextStep: 'offer' })
  assert.equal(done.body.followup.state, 'completed'); assert.equal(done.body.followup.nextStep, 'offer')
  assert.ok(done.body.timeline.some(e => e.kind === 'answered'))
  const c = await booking(new Date(Date.now() + 86400e3), { status: 'cancelled' })
  await F.ensureOne(c)
  const { rows: [cf] } = await pool.query(`SELECT id FROM viewing_followups WHERE viewing_id=$1`, [c])
  assert.equal((await call('POST', `/${cf.id}/answer`, T.katya, { outcome: 'completed' })).status, 409)
})

test('owner info: Olga and Katya only, for a requested booking, every access logged', async () => {
  const v = await booking(new Date(Date.now() + 4 * 86400e3), { agent: 57 })
  assert.equal((await call('GET', `/by-viewing/${v}/owner-info`)).status, 401)
  assert.equal((await call('GET', `/by-viewing/${v}/owner-info`, T.nico)).status, 403)
  const k = await call('GET', `/by-viewing/${v}/owner-info`, T.katya)
  assert.equal(k.status, 200, JSON.stringify(k.body))
  assert.equal(k.body.owner.phone, '+35699000111'); assert.equal(k.body.bookingState, 'requested')
  const o = await call('GET', `/by-viewing/${v}/owner-info`, T.olga)
  assert.equal(o.status, 200)
  const { rows } = await pool.query(`SELECT agent_id, entity_type, entity_id FROM pii_reveal_log ORDER BY id`)
  assert.deepEqual(rows.map(r => [r.agent_id, r.entity_type, r.entity_id]), [[13, 'owner_contact_viewing', ownerId], [2, 'owner_contact_viewing', ownerId]])
  assert.equal((await call('GET', `/by-viewing/999999/owner-info`, T.katya)).status, 404)
})

test('dashboard: own requests for agents, all for owner-contact staff, no owner contact in lists', async () => {
  const nico = await call('GET', '/', T.nico)
  assert.equal(nico.body.scope, 'mine'); assert.ok(nico.body.followups.every(f => f.agent.id === 57))
  const katya = await call('GET', '/', T.katya)
  assert.equal(katya.body.scope, 'all'); assert.equal(katya.body.canViewOwnerContact, true)
  assert.ok(katya.body.followups.length >= 2)
  assert.equal(JSON.stringify(katya.body).includes('35699000111'), false)
  assert.equal(JSON.stringify(katya.body).includes('35699999999'), false)
  const s = await call('GET', '/summary', T.katya)
  assert.equal(typeof s.body.feedbackDue, 'number')
  assert.equal((await call('POST', '/sync', T.katya)).status, 403)
})

test('future appointments are tracked whatever their creation date, also from the old /book flow', async () => {
  const far = new Date(Date.now() + 40 * 86400e3)
  const { rows: [old] } = await pool.query(
    `INSERT INTO property_viewings (property_id, viewing_date, starts_at, duration_min, status, user_id, viewing_agent_id, source, created_at)
     VALUES ($1, ($2::timestamptz AT TIME ZONE 'Europe/Malta')::date, $2::timestamptz, 20, 'pending', 13, 13, 'board_slot', NOW() - interval '90 days') RETURNING id`, [propId, far])
  const d = new Date(Date.now() + 9 * 86400e3)
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Malta' }).format(d)
  const { rows: [legacy] } = await pool.query(
    `INSERT INTO property_viewings (property_id, viewing_date, viewing_time, status, user_id, viewing_agent_id, source, created_at)
     VALUES ($1, $2::date, '16:30', 'pending', 13, 13, 'agent_book', NOW() - interval '200 days') RETURNING id`, [propId, day])
  await F.syncAll({ send: false })
  const { rows } = await pool.query(`SELECT viewing_id, slot_at FROM viewing_followups WHERE viewing_id = ANY($1::int[]) ORDER BY viewing_id`, [[old.id, legacy.id]])
  assert.equal(rows.length, 2)
  const legacySlot = rows.find(r => r.viewing_id === legacy.id).slot_at
  assert.equal(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', hour: '2-digit', minute: '2-digit' }).format(new Date(legacySlot)), '16:30')
  const list = await call('GET', '/', T.katya)
  const ids = list.body.followups.map(f => f.viewingId)
  assert.ok(ids.includes(old.id) && ids.includes(legacy.id), 'both visible in the dashboard')
})
