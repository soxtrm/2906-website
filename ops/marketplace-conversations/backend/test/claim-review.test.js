'use strict'
// NEXUS SYNC ownership review end to end (2026-11-21): owner confirms homes -> review requested (audit, staff notice
// only to the staff number) -> CRM queue -> approve / reject -> owner sees the result and a message. Synthetic data.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path'); const http = require('http')
const SECRET = 'x'.repeat(48)
process.env.JWT_SECRET = 'test-secret-not-production-0123456789'
process.env.NEXUS_LINK_INBOUND_SECRET = SECRET
process.env.ARGUS_AGENCY_KEY = '2906'
process.env.SYNC_STAFF_NOTIFY_TO = '35699990000'
const ROOT = process.env.BACKEND_DIR || '/app'; const R = p => path.join(ROOT, p)
const express = require(R('node_modules/express')); const jwt = require(R('node_modules/jsonwebtoken')); const { Pool } = require(R('node_modules/pg'))
const pool = new Pool({ host: process.env.PGHOST, user: 'postgres', password: 'test', database: 'postgres', max: 6 })
const noop = () => {}
function stub(rel, exports) { const file = require.resolve(R(rel)); require.cache[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [] } }
stub('db.js', { query: (s, p) => pool.query(s, p), connect: () => pool.connect() })
stub('logger.js', { info: noop, warn: noop, error: noop, debug: noop })
stub('waha.js', new Proxy({}, { get: () => async () => ({}) }))
const C = require(R('services/nexusLinkCrypto.js')); const S = require(R('services/syncAccount.js'))
const sent = []; S._test.setSender(async (session, chat, text) => { sent.push({ chat, text }) }); S._test.setMailer(async () => true)

let server, base
async function svc(p, body) {
  const timestamp = Math.floor(Date.now() / 1000)
  const res = await fetch(`${base}/api/sync-account/v1${p}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'X-Nexus-Link-Key': 'nexus-sync', 'X-Nexus-Link-Timestamp': String(timestamp), 'X-Sync-Client-IP': '10.7.0.1', 'X-Nexus-Link-Signature': C.sign(SECRET, { timestamp, method: 'POST', path: p, body }) } })
  return { status: res.status, body: await res.json() }
}
const tok = (id, username, role) => jwt.sign({ id, username, role, aud: 'crm' }, process.env.JWT_SECRET)
async function crm(t, method, p, body) {
  const res = await fetch(`${base}/api/crm/sync-inbox${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, body: await res.json() }
}
let n = 0
async function ownerWithClaim(name, phone, refs) {
  const { rows: [o] } = await pool.query(`INSERT INTO owner_contacts (phone_normalized, name) VALUES ($1,$2) RETURNING id`, [phone, name])
  for (const ref of refs) await pool.query(`INSERT INTO properties (ref, town, property_type, longlet_price, bedrooms, bathrooms, owner_id, listed_by_agent_id) VALUES ($1,'Mosta','Apartment',1100,2,1,$2,2)`, [ref, o.id])
  const up = await svc('/signup', { email: `owner${++n}@example.test`, password: 'harbour-view-22', name })
  const { rows: [a] } = await pool.query(`UPDATE sync_accounts SET phone_e164=$2, phone_verified_at=NOW(), phone_verified_via='whatsapp' WHERE email=$1 RETURNING *`, [`owner${n}@example.test`, phone])
  await S.claimByPhone(pool, a)          // what confirming the mobile does: proposed claims, link claim_pending
  return { session: up.body.session.token, account: a, ownerId: o.id }
}
const homes = async who => (await svc('/me', { session: who.session })).body.owner.links.flatMap(l => l.properties || [])

let A, B
const admin = tok(1, 'admin1', 'admin'), listingAgent = tok(2, 'agent2', 'agent'), otherAgent = tok(3, 'agent3', 'agent')
test.before(async () => {
  for (let i = 0; i < 60; i++) { try { await pool.query('SELECT 1'); break } catch { await new Promise(r => setTimeout(r, 500)) } }
  await pool.query(`INSERT INTO agents (id, username, name, role, active, board_access) VALUES (1,'admin1','Admin One','admin',true,true), (2,'agent2','Agent Two','agent',true,false), (3,'agent3','Agent Three','agent',true,false) ON CONFLICT DO NOTHING`)
  const app = express(); app.use(express.json())
  app.use('/api/sync-account/v1', require(R('routes/syncAccountService.js'))); app.use('/api/crm/sync-inbox', require(R('routes/crmSyncInbox.js')))
  server = http.createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`
  A = await ownerWithClaim('Anna Owner', '35699200001', ['RV-1', 'RV-2'])
  B = await ownerWithClaim('Boris Claimant', '35699200002', ['RV-9'])
})
test.after(async () => { server.close(); await pool.end() })

test('the owner confirms the homes: review requested, staff told once, the owner never messaged', async () => {
  const pending = (await svc('/me', { session: A.session })).body.owner.links[0]
  assert.equal(pending.state, 'claim_pending'); assert.equal(pending.proposed.length, 2)
  const d = await svc('/claims/decide', { session: A.session, decisions: pending.proposed.map(p => ({ externalId: p.externalId, decision: 'confirm' })) })
  assert.equal(d.status, 200, JSON.stringify(d.body)); assert.equal(d.body.reviewRequested, true)
  assert.equal(sent.length, 1); assert.equal(sent[0].chat, '35699990000@c.us'); assert.match(sent[0].text, /Anna confirmed 2 homes/)
  assert.ok(!sent.some(m => m.chat.startsWith('35699200001')), 'nothing to the owner')
  await svc('/claims/decide', { session: A.session, decisions: pending.proposed.map(p => ({ externalId: p.externalId, decision: 'confirm' })) })
  assert.equal(sent.length, 1, 'not twice within six hours')
  const { rows } = await pool.query(`SELECT COUNT(*)::int n FROM agent_activity_log WHERE action_type='SYNC_CLAIM_REVIEW_REQUESTED'`)
  assert.equal(rows[0].n, 1)
  const pb = (await svc('/me', { session: B.session })).body.owner.links[0]
  await svc('/claims/decide', { session: B.session, decisions: pb.proposed.map(p => ({ externalId: p.externalId, decision: 'confirm' })) })
})

test('the CRM queue shows who waits, which homes and the listing agent; summary counts them', async () => {
  const q = await crm(admin, 'GET', '/claims')
  assert.equal(q.status, 200, JSON.stringify(q.body)); assert.equal(q.body.canDecide, true)
  assert.equal(q.body.claims.length, 2)
  const a = q.body.claims.find(c => c.accountId === A.account.public_id)
  assert.deepEqual(a.links[0].properties.map(p => p.ref).sort(), ['RV-1', 'RV-2'])
  assert.equal(a.links[0].properties[0].agent, 'Agent Two')
  assert.equal((await crm(admin, 'GET', '/summary')).body.pendingClaims, 2)
  const la = await crm(listingAgent, 'GET', '/claims')
  assert.equal(la.status, 200); assert.equal(la.body.canDecide, false); assert.equal(la.body.claims.length, 0, 'unverified claimants stay with admins (privacy rule of the SYNC inbox)')
  assert.equal((await crm(otherAgent, 'GET', '/claims')).body.claims.length, 0, 'an unrelated agent sees nothing')
  assert.equal((await crm(listingAgent, 'POST', `/threads/${A.account.public_id}/claim`, { ownerId: A.ownerId, decision: 'approve' })).status, 403, 'only admins decide')
})

test('approve: the owner gets the homes and a message; the queue empties', async () => {
  assert.deepEqual(await homes(A), [])
  const r = await crm(admin, 'POST', `/threads/${A.account.public_id}/claim`, { ownerId: A.ownerId, decision: 'approve' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual((await homes(A)).map(h => h.ref).sort(), ['RV-1', 'RV-2'])
  const msgs = (await svc('/messages', { session: A.session })).body.messages
  assert.ok(msgs.some(m => m.from === 'argus' && /Your homes are confirmed/.test(m.text) && m.sender.name === 'Admin One'))
  assert.equal((await svc('/owner/conditions', { session: A.session, propertyId: (await homes(A))[0].sourcePropertyId })).status, 200, 'house rules open')
  assert.equal((await crm(admin, 'GET', '/claims')).body.claims.length, 1)
})

test('reject: nothing is linked, the owner is told why and can answer', async () => {
  const r = await crm(admin, 'POST', `/threads/${B.account.public_id}/claim`, { ownerId: B.ownerId, decision: 'reject' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(await homes(B), [])
  const me = (await svc('/me', { session: B.session })).body.owner.links
  assert.ok(!me.some(l => l.state === 'claim_pending'))
  const msgs = (await svc('/messages', { session: B.session })).body.messages
  assert.ok(msgs.some(m => /could not confirm/.test(m.text)))
  assert.equal((await crm(admin, 'GET', '/claims')).body.claims.length, 0)
  assert.equal((await crm(admin, 'GET', '/summary')).body.pendingClaims, 0)
})
