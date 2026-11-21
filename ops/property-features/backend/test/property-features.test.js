'use strict'
// NEXUS adaptive property features (2026-11-21): dictionary + synonyms, owner and agent statements with provenance,
// candidates, confirmation/verification, public projection, curation. Throwaway PostgreSQL, synthetic data.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path'); const http = require('http')
const SECRET = 'x'.repeat(48)
process.env.JWT_SECRET = 'test-secret-not-production-0123456789'
process.env.NEXUS_LINK_INBOUND_SECRET = SECRET
process.env.ARGUS_AGENCY_KEY = '2906'
const ROOT = process.env.BACKEND_DIR || '/app'; const R = p => path.join(ROOT, p)
const express = require(R('node_modules/express')); const jwt = require(R('node_modules/jsonwebtoken')); const { Pool } = require(R('node_modules/pg'))
const pool = new Pool({ host: process.env.PGHOST, user: 'postgres', password: 'test', database: 'postgres', max: 6 })
const noop = () => {}
function stub(rel, exports) { const file = require.resolve(R(rel)); require.cache[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [] } }
stub('db.js', { query: (s, p) => pool.query(s, p), connect: () => pool.connect() })
stub('logger.js', { info: noop, warn: noop, error: noop, debug: noop })
stub('waha.js', new Proxy({}, { get: () => async () => ({}) }))
const C = require(R('services/nexusLinkCrypto.js')); const S = require(R('services/syncAccount.js')); const F = require(R('services/propertyFeatures.js'))
S._test.setSender(async () => {}); S._test.setMailer(async () => true)

let server, base
async function svc(p, body) {
  const timestamp = Math.floor(Date.now() / 1000)
  const res = await fetch(`${base}/api/sync-account/v1${p}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'X-Nexus-Link-Key': 'nexus-sync', 'X-Nexus-Link-Timestamp': String(timestamp), 'X-Sync-Client-IP': '10.6.0.1', 'X-Nexus-Link-Signature': C.sign(SECRET, { timestamp, method: 'POST', path: p, body }) } })
  return { status: res.status, body: await res.json() }
}
const tok = (id, role) => jwt.sign({ id, username: `u${id}`, role, aud: 'crm' }, process.env.JWT_SECRET)
async function crm(t, method, p, body) {
  const res = await fetch(`${base}/api/crm/property-features${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, body: await res.json() }
}
let n = 0
async function owner(name, phone, refs, agentId) {
  const { rows: [o] } = await pool.query(`INSERT INTO owner_contacts (phone_normalized, name) VALUES ($1,$2) RETURNING id`, [phone, name])
  const ids = []
  for (const ref of refs) ids.push((await pool.query(`INSERT INTO properties (ref, town, property_type, longlet_price, bedrooms, bathrooms, owner_id, listed_by_agent_id) VALUES ($1,'Naxxar','Apartment',1300,3,2,$2,$3) RETURNING id`, [ref, o.id, agentId])).rows[0].id)
  const up = await svc('/signup', { email: `pf${++n}@example.test`, password: 'harbour-view-22', name })
  const { rows: [a] } = await pool.query(`SELECT * FROM sync_accounts WHERE email=$1`, [`pf${n}@example.test`])
  const { rows: [l] } = await pool.query(`INSERT INTO nexus_owner_links (agency_key, owner_contact_id, nexus_account_ref, link_state) VALUES ('2906',$1,$2,'verified') RETURNING id`, [o.id, `sync:${a.public_id}`])
  for (const id of ids) await pool.query(`INSERT INTO nexus_owner_property_claims (owner_link_id, property_id, claim_state) VALUES ($1,$2,'confirmed')`, [l.id, id])
  return { session: up.body.session.token, ids, ownerId: o.id, account: a, refs }
}
let A, B
const admin = tok(1, 'admin'), agentA = tok(2, 'agent'), agentB = tok(3, 'agent'), board = tok(4, 'board')
test.before(async () => {
  for (let i = 0; i < 60; i++) { try { await pool.query('SELECT 1'); break } catch { await new Promise(r => setTimeout(r, 500)) } }
  // the stage runner empties every table between files: load the (idempotent) migration with its dictionary seed again
  await pool.query(require('fs').readFileSync(path.join(__dirname, '20261121e_property_features.sql'), 'utf8'))
  await pool.query(`INSERT INTO agents (id, username, name, role, active, board_access) VALUES (1,'u1','Admin','admin',true,true),(2,'u2','Agent A','agent',true,false),(3,'u3','Agent B','agent',true,false),(4,'u4','Board','board',true,true) ON CONFLICT DO NOTHING`)
  const app = express(); app.use(express.json())
  app.use('/api/sync-account/v1', require(R('routes/syncAccountService.js'))); app.use('/api/crm/property-features', require(R('routes/crmPropertyFeatures.js')))
  server = http.createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`
  A = await owner('Ada Owner', '35699300001', ['PF-1', 'PF-2'], 2)
  B = await owner('Ben Owner', '35699300002', ['PF-9'], 3)
})
test.after(async () => { server.close(); await pool.end() })

test('dictionary: the ARGUS tags, counters and extras are there', async () => {
  const { rows } = await pool.query(`SELECT COUNT(*) FILTER (WHERE status='standard')::int s, COUNT(*) FILTER (WHERE argus_tag IS NOT NULL)::int t FROM nexus_feature_dictionary`)
  assert.ok(rows[0].s >= 35); assert.ok(rows[0].t >= 20)
})

test('synonyms across wording and languages lead to the same feature', async () => {
  for (const q of ['soundproof glass', 'Acoustic windows', 'Schallschutzfenster', 'vetri insonorizzati', 'fenêtres insonorisées']) {
    const s = await F.suggest(q)
    assert.equal(s.suggestions[0]?.key, 'soundproof_windows', q); assert.equal(s.newCandidate, null, q)
  }
  assert.equal((await F.suggest('Balkon')).suggestions[0].key, 'balconies')
  assert.equal((await F.suggest('aircon')).suggestions[0].key, 'air_conditioning')
  const pizza = await F.suggest('pizza oven')
  assert.ok(!pizza.suggestions.some(x => x.score >= 0.95)); assert.deepEqual(pizza.newCandidate, { label: 'pizza oven' })
})

test('owner: counters, switches and own features, only on their own homes', async () => {
  const l = await svc('/owner/features', { session: A.session, propertyId: A.ids[0] })
  assert.equal(l.status, 200, JSON.stringify(l.body)); assert.deepEqual(l.body.core, { bedrooms: 3, bathrooms: 2 }); assert.ok(l.body.common.some(c => c.key === 'balconies'))
  assert.equal((await svc('/owner/features/set', { session: A.session, propertyId: A.ids[0], key: 'balconies', value: 2 })).body.feature.confirmation, 'declared')
  assert.equal((await svc('/owner/features/set', { session: A.session, propertyId: A.ids[0], key: 'furnishing', value: 'part_furnished' })).status, 200)
  assert.equal((await svc('/owner/features/set', { session: A.session, propertyId: A.ids[0], key: 'balconies', value: 99 })).body.error, 'VALUE_INVALID')
  const c = await svc('/owner/features/set', { session: A.session, propertyId: A.ids[0], text: 'Pizza oven' })
  assert.equal(c.status, 200); assert.equal(c.body.feature.key, 'c_pizza_oven'); assert.equal(c.body.feature.status, 'candidate'); assert.equal(c.body.feature.originalText, 'Pizza oven')
  const c2 = await svc('/owner/features/set', { session: B.session, propertyId: B.ids[0], text: 'pizza ovens' })
  assert.equal(c2.body.feature.key, 'c_pizza_oven', 'the same candidate, not a second one')
  assert.equal((await svc('/owner/features/set', { session: A.session, propertyId: A.ids[0], text: 'soundproof glass' })).body.feature.key, 'soundproof_windows', 'a known phrase becomes the canonical feature')
  assert.equal((await svc('/owner/features/set', { session: A.session, propertyId: B.ids[0], key: 'balconies', value: 1 })).status, 404, 'not her home')
  assert.equal((await svc('/owner/features/set', { session: A.session, propertyId: A.ids[1], text: 'only for one nationality' })).body.error, 'PROTECTED_CHARACTERISTIC')
})

test('nothing is public before the agency confirms; candidates are never public', async () => {
  let props = await F.attachPublic([{ id: 'PF-1' }, { id: 'PF-9' }])
  assert.deepEqual(props[0].features, []); assert.deepEqual(props[1].features, [])
  const q = await crm(agentA, 'GET', '/review')
  assert.equal(q.status, 200); assert.ok(q.body.features.every(f => f.ref.startsWith('PF-1') || f.ref === 'PF-2'), 'agent A sees only her listings')
  assert.equal((await crm(agentB, 'POST', `/${A.ids[0]}/decide`, { key: 'balconies', decision: 'confirm' })).status, 403, 'not her listing')
  assert.equal((await crm(board, 'GET', '/review')).status, 403)
  for (const key of ['balconies', 'soundproof_windows', 'c_pizza_oven']) assert.equal((await crm(agentA, 'POST', `/${A.ids[0]}/decide`, { key, decision: 'confirm' })).status, 200)
  props = await F.attachPublic([{ id: 'PF-1' }])
  const keys = props[0].features.map(f => f.key).sort()
  assert.deepEqual(keys, ['balconies', 'soundproof_windows'], 'candidate stays private even when confirmed')
  assert.equal(props[0].features.find(f => f.key === 'balconies').value, 2)
  assert.equal(props[0].features[0].evidenceLabel, 'Confirmed by the agency')
})

test('owner changes a confirmed value: back to declared, off the public listing', async () => {
  await svc('/owner/features/set', { session: A.session, propertyId: A.ids[0], key: 'balconies', value: 3 })
  const props = await F.attachPublic([{ id: 'PF-1' }])
  assert.ok(!props[0].features.some(f => f.key === 'balconies'))
})

test('verification levels: document needs the owner\'s document, independent check is admin-only', async () => {
  assert.equal((await crm(agentA, 'POST', `/${A.ids[0]}/decide`, { key: 'soundproof_windows', decision: 'verify', verification: 'verified' })).status, 403)
  assert.equal((await crm(agentA, 'POST', `/${A.ids[0]}/decide`, { key: 'soundproof_windows', decision: 'verify', verification: 'document', documentId: 999 })).body.code, 'DOCUMENT_REQUIRED')
  const { rows: [doc] } = await pool.query(`INSERT INTO owner_documents (owner_contact_id, filename, url, uploaded_by) VALUES ($1,'Window invoice','https://example.test/x','agent') RETURNING id`, [A.ownerId])
  const { rows: [foreign] } = await pool.query(`INSERT INTO owner_documents (owner_contact_id, filename, url, uploaded_by) VALUES ($1,'Other','https://example.test/y','agent') RETURNING id`, [B.ownerId])
  assert.equal((await crm(agentA, 'POST', `/${A.ids[0]}/decide`, { key: 'soundproof_windows', decision: 'verify', verification: 'document', documentId: foreign.id })).body.code, 'DOCUMENT_REQUIRED', 'another owner\'s document is no evidence')
  assert.equal((await crm(agentA, 'POST', `/${A.ids[0]}/decide`, { key: 'soundproof_windows', decision: 'verify', verification: 'document', documentId: doc.id })).status, 200)
  let f = (await F.attachPublic([{ id: 'PF-1' }]))[0].features.find(x => x.key === 'soundproof_windows')
  assert.equal(f.evidence, 'document'); assert.equal(f.evidenceLabel, 'Backed by a document')
  assert.equal((await crm(admin, 'POST', `/${A.ids[0]}/decide`, { key: 'soundproof_windows', decision: 'verify', verification: 'verified' })).status, 200)
  f = (await F.attachPublic([{ id: 'PF-1' }]))[0].features.find(x => x.key === 'soundproof_windows')
  assert.equal(f.evidenceLabel, 'Independently verified')
})

test('agents add features for their listings directly (confirmed by them), owners remove only their own', async () => {
  const r = await crm(agentA, 'POST', `/${A.ids[1]}`, { text: 'acoustic windows' })
  assert.equal(r.status, 200); assert.equal(r.body.feature.key, 'soundproof_windows'); assert.equal(r.body.feature.confirmation, 'agent_confirmed')
  assert.equal((await svc('/owner/features/remove', { session: A.session, propertyId: A.ids[1], key: 'soundproof_windows' })).status, 404, 'the agent\'s statement stays')
  assert.equal((await svc('/owner/features/remove', { session: A.session, propertyId: A.ids[0], key: 'furnishing' })).status, 200)
})

test('admins curate: promote a candidate, or merge it into a feature (the phrase becomes an alias)', async () => {
  assert.equal((await crm(agentA, 'POST', '/dictionary/curate', { key: 'c_pizza_oven', action: 'promote' })).status, 403)
  const list = await crm(admin, 'GET', '/dictionary/candidates')
  assert.equal(list.body.candidates.find(c => c.key === 'c_pizza_oven').used, 2)
  await svc('/owner/features/set', { session: B.session, propertyId: B.ids[0], text: 'noise proof windows' })
  const cand = (await crm(admin, 'GET', '/dictionary/candidates')).body.candidates.find(c => /noise/.test(c.label))
  assert.ok(cand, 'unknown wording kept as a candidate')
  assert.equal((await crm(admin, 'POST', '/dictionary/curate', { key: cand.key, action: 'merge', into: 'soundproof_windows' })).status, 200)
  assert.equal((await F.suggest('noise proof windows')).suggestions[0].key, 'soundproof_windows', 'next owner gets the canonical feature')
  const { rows } = await pool.query(`SELECT feature_key FROM nexus_property_features WHERE property_id=$1`, [B.ids[0]])
  assert.ok(rows.some(r => r.feature_key === 'soundproof_windows'))
  assert.equal((await crm(admin, 'POST', '/dictionary/curate', { key: 'c_pizza_oven', action: 'promote', label: 'Pizza oven', group: 'kitchen', filterable: true })).status, 200)
  const dict = await F.publicDictionary()
  assert.ok(dict.features.some(f => f.key === 'c_pizza_oven' && f.filterable))
})

test('representatives with edit may add features; view-only may not', async () => {
  const { rows: [l] } = await pool.query(`SELECT id FROM nexus_owner_links WHERE owner_contact_id=$1`, [A.ownerId])
  await svc('/signup', { email: 'rep@example.test', password: 'harbour-view-22', name: 'Rep' })
  const { rows: [rep] } = await pool.query(`SELECT * FROM sync_accounts WHERE email='rep@example.test'`)
  const li = await svc('/login', { email: 'rep@example.test', password: 'harbour-view-22' })
  const { rows: [d] } = await pool.query(`INSERT INTO nexus_owner_delegates (agency_key, owner_link_id, invited_by_account_id, delegate_account_id, invite_name, invite_kind, invite_target, permissions, state, expires_at)
     VALUES ('2906',$1,$2,$3,'Rep','email','rep@example.test','{view}','active',NOW()+interval '1 day') RETURNING id`, [l.id, A.account.id, rep.id])
  await pool.query(`INSERT INTO nexus_owner_delegate_properties (delegate_id, property_id) VALUES ($1,$2)`, [d.id, A.ids[0]])
  const s = li.body.session.token
  assert.equal((await svc('/owner/features', { session: s, propertyId: A.ids[0] })).status, 200, 'view')
  assert.equal((await svc('/owner/features/set', { session: s, propertyId: A.ids[0], key: 'lift', value: true })).status, 404, 'no edit')
  await pool.query(`UPDATE nexus_owner_delegates SET permissions='{view,edit}' WHERE id=$1`, [d.id])
  assert.equal((await svc('/owner/features/set', { session: s, propertyId: A.ids[0], key: 'lift', value: true })).status, 200, 'edit')
})
