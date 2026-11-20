'use strict'
// NEXUS SYNC accounts (2026-11-19) against a throwaway PostgreSQL that carries
// the live schema of the owner/NEXUS tables (schema only, no rows) plus the
// SYNC migration. Synthetic owners and numbers only; nothing is sent anywhere.
//   BACKEND_DIR=/app PGHOST=... node --test test/sync-account.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const http = require('http')

const SECRET = 'x'.repeat(48)
process.env.JWT_SECRET = 'test-secret-not-production'
process.env.NEXUS_LINK_INBOUND_SECRET = SECRET
process.env.ARGUS_AGENCY_KEY = '2906'
process.env.FB_APP_ID = 'test-app'
process.env.FB_APP_SECRET = 'test-secret'
const ROOT = process.env.BACKEND_DIR || '/app'
const R = p => path.join(ROOT, p)
const jwt = require(R('node_modules/jsonwebtoken'))
const express = require(R('node_modules/express'))
const { Pool } = require(R('node_modules/pg'))

const pool = new Pool({ host: process.env.PGHOST, user: 'postgres', password: 'test', database: 'postgres', max: 6 })
const noop = () => {}
function stub(rel, exports) {
  const file = require.resolve(R(rel))
  require.cache[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [] }
}
stub('db.js', { query: (s, p) => pool.query(s, p), connect: () => pool.connect() })
stub('logger.js', { info: noop, warn: noop, error: noop, debug: noop })
stub('waha.js', new Proxy({}, { get: () => async () => ({}) }))

const C = require(R('services/nexusLinkCrypto.js'))
const S = require(R('services/syncAccount.js'))
const L = require(R('services/nexusOwnerLink.js'))
const sent = [], mails = []
S._test.setSender(async (session, chat, text) => { sent.push({ session, chat, text }) })
S._test.setMailer(async m => { mails.push(m); return true })

const OWNER_PHONE = '35699000001'
let server, base, ownerId, propertyId
test.before(async () => {
  for (let i = 0; i < 60; i++) { try { await pool.query('SELECT 1'); break } catch { await new Promise(r => setTimeout(r, 500)) } }
  const { rows: [o] } = await pool.query(`INSERT INTO owner_contacts (phone_normalized, name) VALUES ($1,'Test Owner') RETURNING id`, [OWNER_PHONE])
  ownerId = o.id
  const { rows: [p] } = await pool.query(
    `INSERT INTO properties (ref, town, property_type, longlet_price, bedrooms, bathrooms, owner_id) VALUES ('T-100','Sliema','Apartment',1500,2,1,$1) RETURNING id`, [ownerId])
  propertyId = p.id
  await pool.query(`INSERT INTO agents (id, username, name, role, active, board_access) VALUES (1,'admin1','Admin One','admin',true,true) ON CONFLICT DO NOTHING`)
  const app = express()
  app.use(express.json())
  app.use('/api/sync-account/v1', require(R('routes/syncAccountService.js')))
  app.use('/api/crm/sync-inbox', require(R('routes/crmSyncInbox.js')))
  server = http.createServer(app)
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
test.after(async () => { server.close(); await pool.end() })

async function svc(p, body, { key = 'nexus-sync', secret = SECRET, ip = '10.0.0.1' } = {}) {
  const timestamp = Math.floor(Date.now() / 1000)
  const headers = { 'content-type': 'application/json', 'X-Nexus-Link-Key': key, 'X-Nexus-Link-Timestamp': String(timestamp), 'X-Sync-Client-IP': ip }
  if (secret) headers['X-Nexus-Link-Signature'] = C.sign(secret, { timestamp, method: 'POST', path: p, body })
  const res = await fetch(`${base}/api/sync-account/v1${p}`, { method: 'POST', headers, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() }
}
const staffTok = jwt.sign({ id: 1, username: 'admin1', role: 'admin', aud: 'crm' }, process.env.JWT_SECRET)
async function staff(method, p, body) {
  const res = await fetch(`${base}/api/crm/sync-inbox${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${staffTok}` }, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, body: await res.json() }
}

let session, accountId
test('refuses unsigned and wrongly signed calls', async () => {
  assert.equal((await svc('/signup', { email: 'a@b.mt' }, { secret: null })).status, 401)
  assert.equal((await svc('/signup', { email: 'a@b.mt' }, { secret: 'y'.repeat(48) })).status, 401)
  assert.equal((await svc('/signup', { email: 'a@b.mt' }, { key: 'nexus' })).status, 401)
})

test('sign-up checks the password and creates a session', async () => {
  const weak = await svc('/signup', { email: 'owner1@example.test', password: '12345678901', name: 'Owner One' })
  assert.equal(weak.status, 400); assert.equal(weak.body.error, 'PASSWORD_WEAK')
  const ok = await svc('/signup', { email: 'Owner1@Example.test', password: 'harbour-view-22', name: 'Owner One' }, { ip: '10.0.0.2' })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.equal(ok.body.account.email, 'owner1@example.test')
  assert.ok(ok.body.session.token.length > 30)
  session = ok.body.session.token; accountId = ok.body.account.id
  const dup = await svc('/signup', { email: 'owner1@example.test', password: 'harbour-view-22' }, { ip: '10.0.0.3' })
  assert.equal(dup.status, 409)
})

test('login answers the same for unknown e-mail and wrong password', async () => {
  const a = await svc('/login', { email: 'nobody@example.test', password: 'whatever-123' }, { ip: '10.0.1.1' })
  const b = await svc('/login', { email: 'owner1@example.test', password: 'wrong-password-1' }, { ip: '10.0.1.2' })
  assert.equal(a.status, 401); assert.equal(b.status, 401); assert.equal(a.body.message, b.body.message)
  const c = await svc('/login', { email: 'owner1@example.test', password: 'harbour-view-22' }, { ip: '10.0.1.3' })
  assert.equal(c.status, 200); assert.ok(c.body.session.token)
  assert.equal((await svc('/me', { session: 'not-a-session-token-at-all-0000000' })).status, 401)
})

test('e-mail code confirms the address', async () => {
  const s = await svc('/email/start', { session })
  assert.equal(s.status, 200)
  const code = /code is (\d{6})/.exec(mails.at(-1).text)[1]
  assert.equal((await svc('/email/confirm', { session, code: code === '000000' ? '111111' : '000000' })).status, 400)
  const ok = await svc('/email/confirm', { session, code })
  assert.equal(ok.status, 200); assert.equal(ok.body.account.emailVerified, true)
})

let token
test('WhatsApp confirmation: link to ARGUS Main, sender number becomes the confirmed number', async () => {
  const st = await svc('/phone/start', { session, channel: 'whatsapp', phone: '+356 9900 0001' })
  assert.equal(st.status, 200, JSON.stringify(st.body))
  assert.match(st.body.waLink, /^https:\/\/wa\.me\/35679675060\?text=SYNC%20verify%20[A-Z2-9]{6}$/)
  token = st.body.token
  // another session or another text is not touched
  assert.equal(await S.handleWhatsAppVerify({ session: 'Argus2', payload: { from: `${OWNER_PHONE}@c.us`, body: `SYNC verify ${token}` } }), false)
  assert.equal(await S.handleWhatsAppVerify({ session: 'Argus1', payload: { from: `${OWNER_PHONE}@c.us`, body: 'hello' } }), false)
  // the wrong number for a code bound to a number
  assert.equal(await S.handleWhatsAppVerify({ session: 'Argus1', payload: { id: 'm1', from: '35699000009@c.us', body: `SYNC verify ${token}` } }), true)
  assert.match(sent.at(-1).text, /different number/)
  assert.equal((await svc('/phone/status', { session })).body.verified, false)
  // the right one
  assert.equal(await S.handleWhatsAppVerify({ session: 'Argus1', payload: { id: 'm2', from: `${OWNER_PHONE}@c.us`, body: `sync verify ${token.toLowerCase()}` } }), true)
  assert.equal(sent.at(-1).session, 'Argus1'); assert.equal(sent.at(-1).chat, `${OWNER_PHONE}@c.us`)
  assert.match(sent.at(-1).text, /confirmed/)
  const ps = await svc('/phone/status', { session })
  assert.equal(ps.body.verified, true); assert.equal(ps.body.phone, `+${OWNER_PHONE}`)
  // single use
  await S.handleWhatsAppVerify({ session: 'Argus1', payload: { id: 'm3', from: `${OWNER_PHONE}@c.us`, body: `SYNC verify ${token}` } })
  assert.match(sent.at(-1).text, /not valid/)
})

test('a phone match is a claim, not access', async () => {
  const { rows: [link] } = await pool.query(`SELECT * FROM nexus_owner_links WHERE owner_contact_id=$1`, [ownerId])
  assert.equal(link.link_state, 'claim_pending')
  assert.equal(link.nexus_account_ref, `sync:${accountId}`)
  const me = await svc('/me', { session })
  const l = me.body.owner.links[0]
  assert.equal(l.state, 'claim_pending'); assert.equal(l.properties, undefined)
  assert.deepEqual(l.proposed.map(p => p.ref), ['T-100'])
  assert.equal(JSON.stringify(me.body).includes('Test Owner'), false, 'no owner record data before verification')
  const ev = await svc('/owner/event', { session, eventType: 'property.owner_updated', data: { externalId: '2906:T-100', version: 1, fields: { rent: 1600 } } })
  assert.equal(ev.status, 409)
})

test('a second account cannot take the same confirmed number', async () => {
  const b = await svc('/signup', { email: 'other@example.test', password: 'another-pass-77' }, { ip: '10.0.2.1' })
  const st = await svc('/phone/start', { session: b.body.session.token, channel: 'whatsapp' })
  await S.handleWhatsAppVerify({ session: 'Argus1', payload: { id: 'm4', from: `${OWNER_PHONE}@c.us`, body: `SYNC verify ${st.body.token}` } })
  assert.match(sent.at(-1).text, /already confirmed/)
  const { rows } = await pool.query(`SELECT nexus_account_ref FROM nexus_owner_links WHERE owner_contact_id=$1`, [ownerId])
  assert.equal(rows[0].nexus_account_ref, `sync:${accountId}`)
})

test('owner confirms the listing, staff verify, then the owner sees it and can change it', async () => {
  const d = await svc('/claims/decide', { session, decisions: [{ externalId: '2906:T-100', decision: 'confirm' }] })
  assert.equal(d.body.decided, 1)
  await L.verifyOwner(ownerId, { id: 1, name: 'Admin One', role: 'admin' }, { method: 'phone_whatsapp' })
  const me = await svc('/me', { session })
  const l = me.body.owner.links[0]
  assert.equal(l.state, 'verified')
  assert.deepEqual(l.properties.map(p => p.ref), ['T-100'])
  const ev = await svc('/owner/event', { session, eventType: 'property.owner_updated', data: { externalId: '2906:T-100', version: 1, fields: { rent: 1600 } } })
  assert.equal(ev.status, 200, JSON.stringify(ev.body)); assert.equal(ev.body.applied, true)
  const { rows: [u] } = await pool.query(`SELECT review_state, fields FROM nexus_owner_property_updates WHERE property_id=$1`, [propertyId])
  assert.equal(u.review_state, 'pending'); assert.equal(u.fields.rent, 1600)
  const { rows: [p] } = await pool.query(`SELECT longlet_price FROM properties WHERE id=$1`, [propertyId])
  assert.equal(Number(p.longlet_price), 1500, 'the listing itself is not changed by the owner edit')
  assert.equal((await svc('/owner/event', { session, eventType: 'property.deleted', data: {} })).status, 400)
})

test('messages: owner writes, staff see and answer with name and agency', async () => {
  const m = await svc('/messages/send', { session, text: 'Is the viewing on Friday still on?' })
  assert.equal(m.status, 200)
  const th = await staff('GET', '/threads')
  assert.equal(th.status, 200)
  const t = th.body.threads.find(x => x.accountId === accountId)
  assert.equal(t.unread, 1); assert.equal(t.phone, `+${OWNER_PHONE}`)
  const r = await staff('POST', `/threads/${accountId}/reply`, { text: 'Yes, 16:30 with Daniel.' })
  assert.equal(r.status, 200)
  const list = await svc('/messages', { session })
  const last = list.body.messages.at(-1)
  assert.equal(last.from, 'argus'); assert.equal(last.sender.name, 'Admin One'); assert.equal(last.sender.org, '2906 Real Estate')
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM owner_contact_log`).catch(() => ({ rows: [{ n: 0 }] }))
  assert.equal(rows[0].n, 0, 'outreach accounting is never written')
  assert.equal((await fetch(`${base}/api/crm/sync-inbox/threads`)).status, 401)
})

test('Facebook sign-in creates one identity and refuses a foreign redirect', async () => {
  S._test.setHttp(async url => ({ ok: true, json: async () => (String(url).includes('access_token?') ? { access_token: 'tok' } : { id: 'fb-1', name: 'Face Owner', email: 'face@example.test' }) }))
  const bad = await svc('/social', { provider: 'facebook', code: 'c', redirectUri: 'https://evil.example/cb' }, { ip: '10.0.3.1' })
  assert.equal(bad.status, 400)
  const a = await svc('/social', { provider: 'facebook', code: 'c', redirectUri: 'https://nexussync.one/api/auth/facebook/callback' }, { ip: '10.0.3.2' })
  assert.equal(a.status, 200, JSON.stringify(a.body)); assert.equal(a.body.account.name, 'Face Owner')
  const b = await svc('/social', { provider: 'facebook', code: 'c', redirectUri: 'https://nexussync.one/api/auth/facebook/callback' }, { ip: '10.0.3.3' })
  assert.equal(b.body.account.id, a.body.account.id)
  assert.equal((await svc('/social', { provider: 'google', code: 'c', redirectUri: 'x' }, { ip: '10.0.3.4' })).status, 503)
})

test('sign in with the mobile number over WhatsApp, no password', async () => {
  assert.equal((await svc('/login/phone/start', { phone: '+356 9900 0077' }, { ip: '10.0.4.1' })).status, 404)
  const st = await svc('/login/phone/start', { phone: `+${OWNER_PHONE}` }, { ip: '10.0.4.2' })
  assert.equal(st.status, 200, JSON.stringify(st.body))
  assert.match(st.body.waLink, /SYNC%20login%20[A-Z2-9]{6}$/)
  const tok = /SYNC login ([A-Z2-9]{6})/.exec(st.body.text)[1]
  assert.equal((await svc('/login/phone/status', { pollKey: st.body.pollKey })).body.waiting, true)
  await S.handleWhatsAppVerify({ session: 'Argus1', payload: { id: 'l1', from: '35699000009@c.us', body: `SYNC login ${tok}` } })
  assert.match(sent.at(-1).text, /different number/)
  assert.equal((await svc('/login/phone/status', { pollKey: st.body.pollKey })).body.waiting, true)
  await S.handleWhatsAppVerify({ session: 'Argus1', payload: { id: 'l2', from: `${OWNER_PHONE}@c.us`, body: `SYNC login ${tok}` } })
  assert.match(sent.at(-1).text, /signed in/)
  const ok = await svc('/login/phone/status', { pollKey: st.body.pollKey })
  assert.equal(ok.status, 200); assert.equal(ok.body.waiting, false); assert.ok(ok.body.session.token)
  assert.equal((await svc('/login/phone/status', { pollKey: st.body.pollKey })).status, 400, 'a sign-in is used once')
  session = ok.body.session.token
})

test('nicknames are kept on the account and shown with the home', async () => {
  const r = await svc('/prefs', { session, prefs: { nicknames: { [propertyId]: 'Sea flat' } } })
  assert.equal(r.status, 200)
  const me = await svc('/me', { session })
  const p = me.body.owner.links[0].properties[0]
  assert.equal(p.state.nickname, 'Sea flat')
  assert.equal(p.state.update.state, 'pending', 'the earlier price proposal shows as pending')
})

test('viewings: owner sees requests without client identity and decides', async () => {
  const calls = []
  S._test.setWindows({ windowFromConfirmedViewing: async id => calls.push(['confirmed', id]), addWindow: async (pid, w) => { calls.push(['add', pid, w.start]); return { id: 1 } }, cancelWindow: async () => ({}) })
  const soon = new Date(Date.now() + 2 * 86400e3)
  const { rows: [v1] } = await pool.query(`INSERT INTO property_viewings (property_id, viewing_date, status, starts_at, duration_min, requester_phone, requester_name, viewing_agent_name) VALUES ($1,$2::date,'pending',$2,20,'35699112233','Secret Client','Daniel') RETURNING id`, [propertyId, soon])
  const { rows: [v2] } = await pool.query(`INSERT INTO property_viewings (property_id, viewing_date, status, starts_at, duration_min) VALUES ($1,$2::date,'pending',$2,20) RETURNING id`, [propertyId, new Date(soon.getTime() + 3600e3)])
  const list = await svc('/owner/viewings', { session })
  assert.equal(list.status, 200)
  assert.equal(list.body.viewings.length, 2)
  assert.equal(JSON.stringify(list.body).includes('Secret Client'), false); assert.equal(JSON.stringify(list.body).includes('35699112233'), false)
  assert.equal(list.body.viewings[0].agent, 'Daniel')
  const a = await svc('/owner/viewings/decide', { session, viewingId: v1.id, decision: 'accept' })
  assert.equal(a.body.status, 'confirmed'); assert.deepEqual(calls[0], ['confirmed', v1.id])
  const p = await svc('/owner/viewings/decide', { session, viewingId: v2.id, decision: 'propose', proposeStart: new Date(soon.getTime() + 86400e3).toISOString() })
  assert.equal(p.body.proposed, true)
  const { rows } = await pool.query(`SELECT status, owner_survey_status, owner_decline_text FROM property_viewings WHERE id = ANY($1::int[]) ORDER BY id`, [[v1.id, v2.id]])
  assert.equal(rows[0].status, 'confirmed'); assert.equal(rows[1].status, 'cancelled'); assert.match(rows[1].owner_decline_text, /Owner suggests/)
  const { rows: [other] } = await pool.query(`INSERT INTO properties (ref, town, property_type, longlet_price) VALUES ('X-1','Gzira','Apartment',900) RETURNING id`)
  const { rows: [v3] } = await pool.query(`INSERT INTO property_viewings (property_id, viewing_date, status, starts_at) VALUES ($1,$2::date,'pending',$2) RETURNING id`, [other.id, soon])
  assert.equal((await svc('/owner/viewings/decide', { session, viewingId: v3.id, decision: 'accept' })).status, 404, 'not the owner of that home')
  const h = await svc('/owner/hours', { session, propertyId, days: [{ date: soon.toISOString().slice(0, 10), ranges: [{ start: soon.toISOString(), end: new Date(soon.getTime() + 2 * 3600e3).toISOString() }] }] })
  assert.equal(h.status, 200, JSON.stringify(h.body)); assert.equal(h.body.created, 1)
  assert.equal((await svc('/owner/hours', { session, propertyId: other.id, days: [{ date: '2030-01-01', ranges: [] }] })).status, 404)
})

test('CRM: counter, owner context with responsible agent, claim decisions need permission', async () => {
  const sum = await staff('GET', '/summary')
  assert.equal(sum.status, 200); assert.equal(typeof sum.body.unread, 'number')
  const ctx = await staff('GET', `/threads/${accountId}/context`)
  assert.equal(ctx.status, 200); assert.equal(ctx.body.links[0].ownerName, 'Test Owner'); assert.equal(ctx.body.links[0].properties[0].ref, 'T-100')
  await pool.query(`INSERT INTO agents (id, username, name, role, active, board_access) VALUES (5,'agent5','Agent Five','agent',true,false) ON CONFLICT DO NOTHING`)
  const t5 = jwt.sign({ id: 5, username: 'agent5', role: 'agent', aud: 'crm' }, process.env.JWT_SECRET)
  const res = await fetch(`${base}/api/crm/sync-inbox/threads/${accountId}/claim`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t5}` }, body: JSON.stringify({ ownerId, decision: 'reject' }) })
  assert.equal(res.status, 403)
})

test('logout ends the session', async () => {
  await svc('/logout', { session })
  assert.equal((await svc('/me', { session })).status, 401)
})

// ── 2026-11-20: who may see which owner conversation ──────────────────────────────────────────────────────
// Appended to the SYNC account suite: same throwaway database, same synthetic owner. Agent 6 is responsible
// for T-100, agent 5 for nothing (later for T-200), agent 9 has NEXUS owner controls.
const tokFor = (id, username, extra = {}) => jwt.sign({ id, username, role: 'agent', aud: 'crm', ...extra }, process.env.JWT_SECRET)
async function as(tok, method, p, body) {
  const res = await fetch(`${base}/api/crm/sync-inbox${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json = null; try { json = JSON.parse(text) } catch {}
  return { status: res.status, body: json, text }
}
let ownerEmail
test('roles: the inbox is closed to Board accounts, inactive agents and foreign tokens', async () => {
  await pool.query(`INSERT INTO agents (id, username, name, role, active, board_access) VALUES
    (5,'agent5','Agent Five','agent',true,false), (6,'agent6','Agent Six','agent',true,false), (7,'board7','Board Seven','board',true,true),
    (8,'gone8','Gone Eight','agent',false,false), (9,'agent9','Agent Nine','agent',true,false) ON CONFLICT DO NOTHING`)
  await pool.query(`UPDATE agents SET feature_entitlements = '{"nexus_owner_link": true}'::jsonb WHERE id = 9`)
  await pool.query(`UPDATE properties SET listed_by_agent_id = 6 WHERE id = $1`, [propertyId])
  ownerEmail = (await pool.query(`SELECT email FROM sync_accounts LIMIT 1`)).rows[0].email
  assert.equal((await as(tokFor(7, 'board7'), 'GET', '/threads')).status, 403)
  assert.equal((await as(tokFor(6, 'agent6', { aud: 'board' }), 'GET', '/threads')).status, 401, 'a Board login token of a CRM agent is refused')
  assert.equal((await as(tokFor(8, 'gone8'), 'GET', '/threads')).status, 401)
  assert.equal((await as(tokFor(6, 'someone-else'), 'GET', '/threads')).status, 401, 'token name must match the account')
  assert.equal((await as(jwt.sign({ id: 6, username: 'agent6', kind: 'owner_upload' }, process.env.JWT_SECRET), 'GET', '/threads')).status, 401)
  assert.equal((await as(jwt.sign({ id: 6, username: 'agent6', aud: 'crm' }, 'another-secret'), 'GET', '/threads')).status, 401)
  assert.equal((await as('', 'GET', '/summary')).status, 401)
})

test('roles: an agent without a listing of this owner sees nothing and cannot read or answer', async () => {
  const t5 = tokFor(5, 'agent5')
  const th = await as(t5, 'GET', '/threads')
  assert.equal(th.status, 200); assert.deepEqual(th.body.threads, [])
  assert.equal((await as(t5, 'GET', `/threads/${accountId}`)).status, 404)
  assert.equal((await as(t5, 'GET', `/threads/${accountId}/context`)).status, 404)
  const before = (await pool.query(`SELECT count(*)::int n FROM nexus_owner_messages`)).rows[0].n
  assert.equal((await as(t5, 'POST', `/threads/${accountId}/reply`, { text: 'hello' })).status, 404)
  assert.equal((await pool.query(`SELECT count(*)::int n FROM nexus_owner_messages`)).rows[0].n, before, 'nothing was stored')
  const sum = await as(t5, 'GET', '/summary')
  assert.deepEqual([sum.body.unread, sum.body.pendingClaims], [0, 0])
  assert.equal((await as(t5, 'POST', `/threads/${accountId}/claim`, { ownerId, decision: 'reject' })).status, 403)
  assert.equal((await pool.query(`SELECT link_state FROM nexus_owner_links WHERE owner_contact_id=$1`, [ownerId])).rows[0].link_state, 'verified', 'the link is untouched')
})

test('roles: the responsible agent reads and answers their owner, without the owner\'s e-mail or number', async () => {
  const t6 = tokFor(6, 'agent6')
  const th = await as(t6, 'GET', '/threads')
  assert.equal(th.body.threads.length, 1)
  assert.equal(th.body.threads[0].accountId, accountId); assert.equal(th.body.threads[0].email, null); assert.equal(th.body.threads[0].phone, null)
  const msgs = await as(t6, 'GET', `/threads/${accountId}`)
  assert.equal(msgs.status, 200); assert.ok(msgs.body.messages.length >= 2)
  assert.equal(msgs.body.account.email, null); assert.equal(msgs.body.account.phone, null)
  const ctx = await as(t6, 'GET', `/threads/${accountId}/context`)
  assert.equal(ctx.status, 200); assert.deepEqual(ctx.body.links[0].properties.map(p => p.ref), ['T-100'])
  for (const r of [th, msgs, ctx]) {
    assert.ok(!r.text.includes(OWNER_PHONE) && !r.text.includes(OWNER_PHONE.slice(-8)), 'no owner number anywhere in the answer')
    assert.ok(!ownerEmail || !r.text.includes(ownerEmail), 'no owner e-mail anywhere in the answer')
    assert.ok(!/password|hash|token|secret/i.test(r.text), 'no credential fields')
  }
  const reply = await as(t6, 'POST', `/threads/${accountId}/reply`, { text: 'I will call you about the keys.' })
  assert.equal(reply.status, 200)
  const last = (await pool.query(`SELECT direction, sender_kind, agent_id, sender_name, sender_org FROM nexus_owner_messages ORDER BY id DESC LIMIT 1`)).rows[0]
  assert.deepEqual([last.direction, last.sender_kind, last.agent_id, last.sender_name, last.sender_org], ['out', 'agent', 6, 'Agent Six', '2906 Real Estate'])
  assert.equal((await as(t6, 'POST', `/threads/${accountId}/claim`, { ownerId, decision: 'reject' })).status, 403, 'answering is not deciding claims')
})

test('roles: each agent sees only their own listing of a shared owner', async () => {
  const { rows: [p2] } = await pool.query(
    `INSERT INTO properties (ref, town, property_type, longlet_price, bedrooms, bathrooms, owner_id, listed_by_agent_id) VALUES ('T-200','Gzira','Apartment',1300,1,1,$1,5) RETURNING id`, [ownerId])
  const { rows: [claim] } = await pool.query(`SELECT * FROM nexus_owner_property_claims WHERE property_id=$1 LIMIT 1`, [propertyId])
  const cols = Object.keys(claim).filter(k => k !== 'id')
  await pool.query(`INSERT INTO nexus_owner_property_claims (${cols.join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')})`,
    cols.map(k => (k === 'property_id' ? p2.id : claim[k])))
  const c6 = await as(tokFor(6, 'agent6'), 'GET', `/threads/${accountId}/context`)
  assert.deepEqual(c6.body.links[0].properties.map(p => p.ref), ['T-100'])
  const c5 = await as(tokFor(5, 'agent5'), 'GET', `/threads/${accountId}/context`)
  assert.equal(c5.status, 200); assert.deepEqual(c5.body.links[0].properties.map(p => p.ref), ['T-200'])
  assert.equal((await as(tokFor(5, 'agent5'), 'GET', '/threads')).body.threads.length, 1)
})

test('roles: admins and agents with NEXUS owner controls keep the full inbox', async () => {
  for (const tok of [staffTok, tokFor(9, 'agent9')]) {
    const th = await as(tok, 'GET', '/threads')
    const t = th.body.threads.find(x => x.accountId === accountId)
    assert.equal(t.phone, `+${OWNER_PHONE}`)
    const ctx = await as(tok, 'GET', `/threads/${accountId}/context`)
    assert.deepEqual(ctx.body.links[0].properties.map(p => p.ref).sort(), ['T-100', 'T-200'])
    assert.equal(typeof (await as(tok, 'GET', '/summary')).body.pendingClaims, 'number')
  }
})

test('roles: an unknown account id answers 404 for everyone, with no detail', async () => {
  for (const tok of [staffTok, tokFor(6, 'agent6')]) {
    const r = await as(tok, 'GET', '/threads/00000000-0000-0000-0000-000000000000')
    assert.equal(r.status, 404); assert.equal(r.body.error, 'Account not found')
  }
})
