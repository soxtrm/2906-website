'use strict'
// SYNC owner conditions + activity (2026-11-21) against a throwaway PostgreSQL with the live schema
// (no rows) plus the new migration. Synthetic owners only; nothing is sent anywhere.
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
const PC = require(R('services/syncPropertyConditions.js'))
S._test.setSender(async () => {}); S._test.setMailer(async () => true)

let server, base
async function svc(p, body, { secret = SECRET, ip = '10.9.0.1' } = {}) {
  const timestamp = Math.floor(Date.now() / 1000)
  const headers = { 'content-type': 'application/json', 'X-Nexus-Link-Key': 'nexus-sync', 'X-Nexus-Link-Timestamp': String(timestamp), 'X-Sync-Client-IP': ip }
  if (secret) headers['X-Nexus-Link-Signature'] = C.sign(secret, { timestamp, method: 'POST', path: p, body })
  const res = await fetch(`${base}/api/sync-account/v1${p}`, { method: 'POST', headers, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() }
}
async function owner(name, phone, email, refs, { verified = true } = {}) {
  const { rows: [o] } = await pool.query(`INSERT INTO owner_contacts (phone_normalized, name) VALUES ($1,$2) RETURNING id`, [phone, name])
  const ids = []
  for (const ref of refs) {
    const { rows: [p] } = await pool.query(`INSERT INTO properties (ref, town, property_type, longlet_price, bedrooms, bathrooms, owner_id) VALUES ($1,'Sliema','Apartment',1500,2,1,$2) RETURNING id`, [ref, o.id])
    ids.push(p.id)
  }
  const up = await svc('/signup', { email, password: 'harbour-view-22', name }, { ip: `10.9.${ids[0] % 250}.1` })
  assert.equal(up.status, 200, JSON.stringify(up.body))
  const { rows: [a] } = await pool.query(`SELECT * FROM sync_accounts WHERE email=$1`, [email])
  const { rows: [l] } = await pool.query(`INSERT INTO nexus_owner_links (agency_key, owner_contact_id, nexus_account_ref, link_state) VALUES ('2906',$1,$2,$3) RETURNING id`,
    [o.id, `sync:${a.public_id}`, verified ? 'verified' : 'claim_pending'])
  for (const id of ids) await pool.query(`INSERT INTO nexus_owner_property_claims (owner_link_id, property_id, claim_state) VALUES ($1,$2,'confirmed')`, [l.id, id])
  return { session: up.body.session.token, ownerId: o.id, ids, account: a }
}
const count = async t => Number((await pool.query(`SELECT COUNT(*)::int n FROM ${t}`)).rows[0].n)

let A, B, P
test.before(async () => {
  for (let i = 0; i < 60; i++) { try { await pool.query('SELECT 1'); break } catch { await new Promise(r => setTimeout(r, 500)) } }
  const app = express(); app.use(express.json()); app.use('/api/sync-account/v1', require(R('routes/syncAccountService.js')))
  server = http.createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`
  A = await owner('Owner A', '35699000101', 'a-owner@example.test', ['C-1', 'C-2', 'C-3'])
  B = await owner('Owner B', '35699000102', 'b-owner@example.test', ['C-9'])
  P = await owner('Owner P', '35699000103', 'p-owner@example.test', ['C-7'], { verified: false })
  // an existing ARGUS chat signal for owner A (owner-wide) — must stay untouched and show as a hint
  await pool.query(`INSERT INTO owner_tenant_preferences (owner_contact_id, field, value, is_explicit, source_trigger) VALUES ($1,'pets','no pets',true,'owner_chat')`, [A.ownerId])
})
test.after(async () => { server.close(); await pool.end() })

const setC = (who, propertyId, key, status, extra = {}) => svc('/owner/conditions/set', { session: who.session, propertyId, key, status, ...extra })

test('empty at first, with the ARGUS chat hint and the schema', async () => {
  const r = await svc('/owner/conditions', { session: A.session, propertyId: A.ids[0] })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body.conditions, []); assert.deepEqual(r.body.proposals, [])
  assert.deepEqual(r.body.hints.map(h => [h.field, h.value, h.scope]), [['pets', 'no pets', 'owner']])
  assert.ok(r.body.schema.pets_dogs.chips.includes('meet_pet_first'))
})

test('one owner, several homes, different rules per home', async () => {
  const d1 = await setC(A, A.ids[0], 'pets_dogs', 'conditional', { baseVersion: 0, details: { chips: ['small_only', 'extra_deposit'], insurance: 'required', maxCount: 1, exceptions: 'Assistance dogs always welcome' }, note: 'Ground floor with garden' })
  assert.equal(d1.status, 200, JSON.stringify(d1.body)); assert.equal(d1.body.condition.version, 1); assert.equal(d1.body.condition.source, 'owner')
  assert.equal((await setC(A, A.ids[1], 'pets_dogs', 'not_allowed', { baseVersion: 0 })).status, 200)
  assert.equal((await setC(A, A.ids[1], 'tenancy_duration', 'conditional', { baseVersion: 0, details: { minMonths: 6, maxMonths: 24, chips: ['renewal_possible'] } })).status, 200)
  assert.equal((await setC(A, A.ids[2], 'smoking', 'conditional', { baseVersion: 0, details: { chips: ['balcony_only'] } })).status, 200)
  assert.equal((await setC(A, A.ids[2], 'viewing', 'conditional', { baseVersion: 0, details: { noticeHours: 24, chips: ['tenant_present'] } })).status, 200)
  assert.equal((await setC(A, A.ids[2], 'other', 'conditional', { baseVersion: 0, details: { items: ['No parties', 'Keep the garden watered'] } })).status, 200)
  const g = async i => (await svc('/owner/conditions', { session: A.session, propertyId: A.ids[i] })).body.conditions
  const c1 = await g(0), c2 = await g(1), c3 = await g(2)
  assert.deepEqual(c1.map(c => [c.key, c.status]), [['pets_dogs', 'conditional']])
  assert.deepEqual(c1[0].details, { chips: ['small_only', 'extra_deposit'], insurance: 'required', maxCount: 1, exceptions: 'Assistance dogs always welcome' })
  assert.deepEqual(c2.map(c => [c.key, c.status]).sort(), [['pets_dogs', 'not_allowed'], ['tenancy_duration', 'conditional']])
  assert.deepEqual(c2.find(c => c.key === 'tenancy_duration').details, { chips: ['renewal_possible'], minMonths: 6, maxMonths: 24 })
  assert.deepEqual(c3.map(c => c.key).sort(), ['other', 'smoking', 'viewing'])
})

test('survives a new session (log out, sign in again, other device)', async () => {
  await svc('/logout', { session: A.session })
  assert.equal((await svc('/owner/conditions', { session: A.session, propertyId: A.ids[0] })).status, 401)
  const li = await svc('/login', { email: 'a-owner@example.test', password: 'harbour-view-22' }, { ip: '10.9.77.1' })
  assert.equal(li.status, 200, JSON.stringify(li.body)); A.session = li.body.session.token
  const r = await svc('/owner/conditions', { session: A.session, propertyId: A.ids[0] })
  assert.equal(r.body.conditions[0].details.insurance, 'required')
})

test('an older device cannot overwrite a newer value', async () => {
  assert.equal((await setC(A, A.ids[0], 'pets_dogs', 'allowed', { baseVersion: 1 })).status, 200)
  const stale = await setC(A, A.ids[0], 'pets_dogs', 'not_allowed', { baseVersion: 1 })
  assert.equal(stale.status, 409); assert.equal(stale.body.error, 'VERSION_CONFLICT')
  assert.equal((await setC(A, A.ids[0], 'pets_cats', 'allowed', {})).status, 409, 'a write without a base version is refused')
  const r = await svc('/owner/conditions', { session: A.session, propertyId: A.ids[0] })
  assert.deepEqual(r.body.conditions.map(c => [c.key, c.status, c.version]), [['pets_dogs', 'allowed', 2]])
  const { rows } = await pool.query(`SELECT state, version FROM nexus_property_conditions WHERE property_id=$1 AND condition_key='pets_dogs' ORDER BY version`, [A.ids[0]])
  assert.deepEqual(rows.map(r => [r.state, r.version]), [['superseded', 1], ['confirmed', 2]], 'old versions stay as history')
})

test('other owners, unverified links and outsiders get nothing', async () => {
  for (const [who, pid] of [[B, A.ids[0]], [A, B.ids[0]], [P, P.ids[0]]]) {
    const g = await svc('/owner/conditions', { session: who.session, propertyId: pid })
    assert.equal(g.status, 404, JSON.stringify(g.body)); assert.equal(g.body.error, 'PROPERTY_NOT_IN_LINK')
    assert.equal((await setC(who, pid, 'smoking', 'not_allowed', { baseVersion: 0 })).status, 404)
  }
  assert.equal((await svc('/owner/conditions', { session: 'not-a-session', propertyId: A.ids[0] })).status, 401)
  assert.equal((await svc('/owner/conditions', { session: A.session, propertyId: A.ids[0] }, { secret: null })).status, 401)
  assert.equal((await svc('/owner/conditions/set', { session: A.session, propertyId: A.ids[0], key: 'smoking', status: 'not_allowed', baseVersion: 0 }, { secret: 'y'.repeat(48) })).status, 401)
})

test('validation: statuses, details, limits, protected characteristics', async () => {
  const bad = async (key, status, details, note) => (await setC(A, A.ids[1], key, status, { baseVersion: 0, details, note })).body.error
  assert.equal(await bad('pets_fish', 'allowed'), 'CONDITION_UNKNOWN')
  assert.equal(await bad('smoking', 'maybe'), 'STATUS_INVALID')
  assert.equal(await bad('smoking', 'conditional', { chips: ['anything'] }), 'DETAILS_INVALID')
  assert.equal(await bad('occupancy', 'conditional', { maxPeople: 0 }), 'DETAILS_INVALID')
  assert.equal(await bad('viewing', 'conditional', { noticeHours: 500 }), 'DETAILS_INVALID')
  assert.equal(await bad('other', 'conditional', { items: ['No tenants of a certain religion'] }), 'PROTECTED_CHARACTERISTIC')
  assert.equal(await bad('occupancy', 'conditional', { maxPeople: 3 }, 'Only one nationality please'), 'PROTECTED_CHARACTERISTIC')
  const t = await setC(A, A.ids[0], 'tenancy_duration', 'conditional', { baseVersion: 0, details: { minMonths: 12, maxMonths: 6 } })
  assert.equal(t.body.error, 'DETAILS_INVALID')
})

test('ARGUS proposals stay apart until the owner decides', async () => {
  const pr = await PC.propose({ propertyId: A.ids[1], key: 'smoking', status: 'not_allowed', evidence: { quote: 'please no smokers in this flat', messageId: 5 } })
  let r = (await svc('/owner/conditions', { session: A.session, propertyId: A.ids[1] })).body
  assert.equal(r.proposals.length, 1); assert.equal(r.proposals[0].source, 'ai'); assert.equal(r.proposals[0].state, 'proposed')
  assert.equal(r.proposals[0].evidence.quote, 'please no smokers in this flat')
  assert.ok(!r.conditions.some(c => c.key === 'smoking'), 'a proposal is not a condition')
  assert.equal((await svc('/owner/conditions/decide', { session: B.session, propertyId: A.ids[1], proposalId: pr.proposal.id, decision: 'accept' })).status, 404)
  const ok = await svc('/owner/conditions/decide', { session: A.session, propertyId: A.ids[1], proposalId: pr.proposal.id, decision: 'accept' })
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.condition.source, 'ai'); assert.equal(ok.body.condition.state, 'confirmed')
  r = (await svc('/owner/conditions', { session: A.session, propertyId: A.ids[1] })).body
  assert.deepEqual(r.conditions.find(c => c.key === 'smoking') && [r.conditions.find(c => c.key === 'smoking').status, r.conditions.find(c => c.key === 'smoking').source], ['not_allowed', 'ai'])
  const pr2 = await PC.propose({ propertyId: A.ids[1], key: 'occupancy', status: 'conditional', details: { maxPeople: 2 } })
  assert.equal((await svc('/owner/conditions/decide', { session: A.session, propertyId: A.ids[1], proposalId: pr2.proposal.id, decision: 'reject' })).body.rejected, true)
  assert.equal((await svc('/owner/conditions/decide', { session: A.session, propertyId: A.ids[1], proposalId: pr2.proposal.id, decision: 'accept' })).status, 404)
  // an owner statement closes an open proposal for the same topic
  const pr3 = await PC.propose({ propertyId: A.ids[1], key: 'pets_cats', status: 'allowed' })
  assert.equal((await setC(A, A.ids[1], 'pets_cats', 'not_allowed', { baseVersion: 0 })).status, 200)
  const { rows: [x] } = await pool.query(`SELECT state FROM nexus_property_conditions WHERE id=$1`, [pr3.proposal.id])
  assert.equal(x.state, 'superseded')
})

test('nothing goes to agencies, ARGUS signals untouched', async () => {
  assert.equal(await count('nexus_distribution_grants'), 0)
  assert.equal(await count('nexus_sync_outbox'), 0)
  const { rows } = await pool.query(`SELECT field, value FROM owner_tenant_preferences`)
  assert.deepEqual(rows, [{ field: 'pets', value: 'no pets' }])
  const { rows: pr } = await pool.query(`SELECT pets_allowed FROM properties WHERE id = ANY($1::int[])`, [A.ids])
  assert.ok(pr.every(p => p.pets_allowed === null), 'listing fields are not changed by owner conditions')
})

test('activity: the owner sees their own changes, never another owner\'s', async () => {
  const a = await svc('/owner/activity', { session: A.session })
  assert.equal(a.status, 200)
  const kinds = a.body.activity.map(x => x.kind)
  assert.ok(kinds.includes('SYNC_CONDITION_SET')); assert.ok(kinds.includes('SYNC_CONDITION_ACCEPTED')); assert.ok(kinds.includes('SYNC_CONDITION_REJECTED'))
  assert.ok(a.body.activity.every(x => !x.propertyId || A.ids.includes(x.propertyId)))
  assert.ok(a.body.activity.some(x => x.topic === 'pets_dogs' && x.label === 'Updated house rules'))
  const b = await svc('/owner/activity', { session: B.session })
  assert.ok(b.body.activity.every(x => !x.propertyId || B.ids.includes(x.propertyId)))
  assert.ok(!b.body.activity.some(x => x.kind.startsWith('SYNC_CONDITION')))
  const { rows } = await pool.query(`SELECT details FROM agent_activity_log WHERE action_type='SYNC_CONDITION_SET' ORDER BY id LIMIT 1`)
  assert.ok(rows[0].details.after && 'before' in rows[0].details, 'history keeps before and after')
})
