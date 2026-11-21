'use strict'
// SYNC representatives + private owner documents (2026-11-21), throwaway PostgreSQL with the live schema (no rows)
// plus both SYNC migrations. Synthetic owners and files only; nothing is sent anywhere.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs')
const http = require('http')

const SECRET = 'x'.repeat(48)
process.env.JWT_SECRET = 'test-secret-not-production-0123456789'
process.env.NEXUS_LINK_INBOUND_SECRET = SECRET
process.env.ARGUS_AGENCY_KEY = '2906'
process.env.SYNC_PRIVATE_DOCS_DIR = '/tmp/sync-docs-test'
process.env.SYNC_STAFF_FILE_ORIGIN = 'http://staff.test'
process.env.SYNC_DOCUMENTS_ENABLED = '1'
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
// the CRM router pulls in Redis-backed queues; this test needs none of them
const fake = new Proxy({}, { get: (t, k) => (k === 'then' ? undefined : (k === 'on' || k === 'once') ? () => fake : async () => null) })
stub('redis.js', fake); stub('queues.js', fake)
const C = require(R('services/nexusLinkCrypto.js'))
const S = require(R('services/syncAccount.js'))
const L = require(R('services/nexusOwnerLink.js'))
const SDOC = require(R('services/syncDocuments.js'))
S._test.setSender(async () => {}); S._test.setMailer(async () => true)
const windowsMade = []
S._test.setWindows({ addWindow: async (pid, w) => { windowsMade.push([pid, w.start]); return { id: windowsMade.length } }, cancelWindow: async () => {}, windowFromConfirmedViewing: async () => {} })

let server, base
async function svc(p, body, { secret = SECRET, ip = '10.8.0.1' } = {}) {
  const timestamp = Math.floor(Date.now() / 1000)
  const headers = { 'content-type': 'application/json', 'X-Nexus-Link-Key': 'nexus-sync', 'X-Nexus-Link-Timestamp': String(timestamp), 'X-Sync-Client-IP': ip }
  if (secret) headers['X-Nexus-Link-Signature'] = C.sign(secret, { timestamp, method: 'POST', path: p, body })
  const res = await fetch(`${base}/api/sync-account/v1${p}`, { method: 'POST', headers, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() }
}
let ipn = 1
async function account(email, name) {
  const up = await svc('/signup', { email, password: 'harbour-view-22', name }, { ip: `10.8.${ipn++}.1` })
  assert.equal(up.status, 200, JSON.stringify(up.body))
  const { rows: [a] } = await pool.query(`SELECT * FROM sync_accounts WHERE email=$1`, [email])
  return { session: up.body.session.token, a }
}
async function owner(name, phone, email, refs) {
  const { rows: [o] } = await pool.query(`INSERT INTO owner_contacts (phone_normalized, name) VALUES ($1,$2) RETURNING id`, [phone, name])
  const ids = []
  for (const ref of refs) {
    const { rows: [p] } = await pool.query(`INSERT INTO properties (ref, town, property_type, longlet_price, bedrooms, bathrooms, owner_id, published) VALUES ($1,'Gzira','Apartment',1400,2,1,$2,true) RETURNING id`, [ref, o.id])
    ids.push(p.id)
    const { rows: [row] } = await pool.query(`SELECT ${L._internal.PROPERTY_COLUMNS} FROM properties p WHERE p.id=$1`, [p.id])
    await L._internal.ensurePropertyLink(pool, row)
  }
  const acc = await account(email, name)
  const { rows: [l] } = await pool.query(`INSERT INTO nexus_owner_links (agency_key, owner_contact_id, nexus_account_ref, link_state) VALUES ('2906',$1,$2,'verified') RETURNING id`, [o.id, `sync:${acc.a.public_id}`])
  for (const id of ids) await pool.query(`INSERT INTO nexus_owner_property_claims (owner_link_id, property_id, claim_state) VALUES ($1,$2,'confirmed')`, [l.id, id])
  return { ...acc, ownerId: o.id, ids, linkId: l.id }
}
const token = link => link.split('/invite/')[1]
const homes = async who => (await svc('/me', { session: who.session })).body.owner.links.flatMap(l => (l.properties || []).map(p => ({ id: p.sourcePropertyId, role: l.role || 'owner', permissions: l.permissions })))

let O, B, D, X
test.before(async () => {
  for (let i = 0; i < 60; i++) { try { await pool.query('SELECT 1'); break } catch { await new Promise(r => setTimeout(r, 500)) } }
  await pool.query(`INSERT INTO agents (id, username, name, role, active, board_access) VALUES (1,'admin1','Admin One','admin',true,true) ON CONFLICT DO NOTHING`)
  const app = express(); app.use(express.json({ limit: '6mb' }))
  app.use('/api/sync-account/v1', require(R('routes/syncAccountService.js')))
  app.use('/api/crm', require(R('routes/crm.js')))
  server = http.createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`
  O = await owner('Olga Owner', '35699000201', 'olga@example.test', ['D-1', 'D-2', 'D-3'])
  B = await owner('Bruno Owner', '35699000202', 'bruno@example.test', ['D-9'])
  D = await account('dan@example.test', 'Dan Helper')        // the representative
  X = await account('xena@example.test', 'Xena Stranger')    // knows the link, is not the invited person
})
test.after(async () => { server.close(); await pool.end(); fs.rmSync('/tmp/sync-docs-test', { recursive: true, force: true }) })

let inv
test('owner invites for chosen homes; link works once, only for the invited, confirmed identity', async () => {
  assert.equal((await svc('/delegates/invite', { session: O.session, name: 'Dan', kind: 'email', target: 'dan@example.test', propertyIds: [B.ids[0]], permissions: ['view'] })).status, 404, 'not someone else\'s home')
  assert.equal((await svc('/delegates/invite', { session: D.session, name: 'Dan', kind: 'email', target: 'x@example.test', propertyIds: [O.ids[0]], permissions: ['view'] })).status, 404, 'a stranger cannot hand out homes')
  const r = await svc('/delegates/invite', { session: O.session, name: 'Dan Helper', kind: 'email', target: 'Dan@Example.test', propertyIds: [O.ids[0], O.ids[1]], permissions: ['schedule', 'message'] })
  assert.equal(r.status, 200, JSON.stringify(r.body)); inv = r.body
  assert.match(inv.link, /\/invite\/[A-Za-z0-9_-]{43}$/)
  assert.deepEqual(inv.delegate.permissions, ['view', 'message', 'schedule'])
  assert.equal(inv.delegate.target, 'd•••n@example.test')
  const { rows: [row] } = await pool.query(`SELECT token_hash FROM nexus_owner_delegates`)
  assert.notEqual(row.token_hash, token(inv.link), 'only the hash is stored')
  const pv = await svc('/invites/preview', { token: token(inv.link) })
  assert.equal(pv.body.invite.homes, 2); assert.equal(pv.body.invite.ownerName, 'Olga'); assert.ok(!JSON.stringify(pv.body).includes('35699'))
  // a stranger holding the link
  const x = await svc('/invites/accept', { session: X.session, token: token(inv.link) })
  assert.equal(x.status, 403); assert.equal(x.body.error, 'IDENTITY_MISMATCH')
  // the right e-mail, but not confirmed yet
  assert.equal((await svc('/invites/accept', { session: D.session, token: token(inv.link) })).status, 403)
  // somebody who only knows the owner's number gets nothing either
  await pool.query(`UPDATE sync_accounts SET phone_e164='35699000201', phone_verified_at=NOW() WHERE id=$1`, [X.a.id])
  assert.equal((await svc('/invites/accept', { session: X.session, token: token(inv.link) })).status, 403)
  assert.deepEqual(await homes(X), [])
  await pool.query(`UPDATE sync_accounts SET email_verified_at=NOW() WHERE id=$1`, [D.a.id])
  const ok = await svc('/invites/accept', { session: D.session, token: token(inv.link) })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.equal((await svc('/invites/accept', { session: D.session, token: token(inv.link) })).status, 404, 'single use')
  assert.equal((await svc('/invites/accept', { session: D.session, token: 'A'.repeat(43) })).status, 404)
})

test('expired invitations cannot be used', async () => {
  const r = await svc('/delegates/invite', { session: O.session, name: 'Late', kind: 'phone', target: '+356 7900 1111', propertyIds: [O.ids[2]], permissions: ['view'] })
  await pool.query(`UPDATE nexus_owner_delegates SET expires_at = NOW() - interval '1 minute' WHERE public_id=$1`, [r.body.delegate.id])
  const e = await svc('/invites/accept', { session: X.session, token: token(r.body.link) })
  assert.equal(e.status, 410); assert.equal(e.body.error, 'INVITE_EXPIRED')
  assert.equal((await svc('/delegates', { session: O.session })).body.delegates.find(d => d.id === r.body.delegate.id).state, 'expired')
})

test('a representative sees and does only what was granted, for the granted homes', async () => {
  const h = await homes(D)
  assert.deepEqual(h.map(x => x.id).sort(), [O.ids[0], O.ids[1]].sort())
  assert.ok(h.every(x => x.role === 'delegate' && x.permissions.includes('schedule')))
  assert.equal((await svc('/owner/conditions', { session: D.session, propertyId: O.ids[0] })).status, 200, 'view')
  assert.equal((await svc('/owner/conditions', { session: D.session, propertyId: O.ids[2] })).status, 404, 'home not granted')
  assert.equal((await svc('/owner/conditions', { session: D.session, propertyId: B.ids[0] })).status, 404, 'other owner')
  assert.equal((await svc('/owner/conditions/set', { session: D.session, propertyId: O.ids[0], key: 'smoking', status: 'not_allowed', baseVersion: 0 })).status, 404, 'no edit permission')
  const day = new Date(Date.now() + 3 * 86400e3).toISOString().slice(0, 10)
  const hrs = await svc('/owner/hours', { session: D.session, propertyId: O.ids[0], days: [{ date: day, ranges: [{ start: `${day}T09:00:00Z`, end: `${day}T11:00:00Z` }] }] })
  assert.equal(hrs.status, 200, JSON.stringify(hrs.body)); assert.equal(windowsMade.length, 1)
  assert.equal((await svc('/owner/hours', { session: D.session, propertyId: O.ids[2], days: [{ date: day, ranges: [] }] })).status, 404)
  const ev = await svc('/owner/event', { session: D.session, eventType: 'availability.answered', data: { externalId: `2906:D-1`, outcome: 'available' } })
  assert.equal(ev.status, 409, 'no edit permission: availability stays with the owner')
  assert.equal((await svc('/owner/event', { session: D.session, eventType: 'distribution.granted', data: { externalId: `2906:D-1`, channel: 'all_eligible_agencies' } })).status, 409, 'sharing is never delegated')
  assert.deepEqual((await svc('/documents', { session: D.session })).body.documents, [], 'documents stay with the owner')
})

test('message permission: the owner\'s conversation, only about granted homes', async () => {
  const m = await svc('/messages/send', { session: D.session, text: 'Viewing on Friday is fine for the tenant.', propertyId: O.ids[0] })
  assert.equal(m.status, 200, JSON.stringify(m.body))
  const { rows: [row] } = await pool.query(`SELECT account_id, sender_name FROM nexus_owner_messages WHERE id=$1`, [m.body.message.id])
  assert.equal(Number(row.account_id), Number(O.a.id)); assert.equal(row.sender_name, 'Dan Helper (representative)')
  await pool.query(`INSERT INTO nexus_owner_messages (agency_key, account_id, property_id, direction, sender_kind, body) VALUES ('2906',$1,$2,'out','agent','About D-3 only'), ('2906',$1,NULL,'out','agent','General to Olga')`, [O.a.id, O.ids[2]])
  const seen = (await svc('/messages', { session: D.session })).body.messages.map(x => x.text)
  assert.ok(seen.includes('Viewing on Friday is fine for the tenant.'))
  assert.ok(!seen.includes('About D-3 only') && !seen.includes('General to Olga'), 'nothing about other homes or general owner talk')
})

test('changing permissions and revoking work immediately', async () => {
  const id = inv.delegate.id
  assert.equal((await svc('/delegates/update', { session: D.session, delegateId: id, propertyIds: [O.ids[0]], permissions: ['edit'] })).status, 404, 'only the owner changes access')
  assert.equal((await svc('/delegates/update', { session: O.session, delegateId: id, propertyIds: [O.ids[0]], permissions: ['edit'] })).status, 200)
  assert.equal((await svc('/owner/conditions/set', { session: D.session, propertyId: O.ids[0], key: 'smoking', status: 'not_allowed', baseVersion: 0 })).status, 200, 'edit now granted')
  assert.equal((await svc('/owner/conditions', { session: D.session, propertyId: O.ids[1] })).status, 404, 'D-2 removed')
  const ev = await svc('/owner/event', { session: D.session, eventType: 'availability.answered', data: { externalId: `2906:D-1`, outcome: 'available' } })
  assert.notEqual(ev.body.error, 'OWNER_LINK_NOT_VERIFIED', JSON.stringify(ev.body))
  assert.equal((await svc('/delegates/revoke', { session: X.session, delegateId: id })).status, 404)
  assert.equal((await svc('/delegates/revoke', { session: O.session, delegateId: id })).status, 200)
  assert.deepEqual(await homes(D), [])
  assert.equal((await svc('/owner/conditions', { session: D.session, propertyId: O.ids[0] })).status, 404)
  assert.equal((await svc('/messages/send', { session: D.session, text: 'still here?', propertyId: O.ids[0] })).status, 200)
  const { rows } = await pool.query(`SELECT COUNT(*)::int n FROM nexus_owner_messages WHERE account_id=$1 AND body='still here?'`, [O.a.id])
  assert.equal(rows[0].n, 0, 'after revocation nothing reaches the owner\'s conversation')
})

test('the owner sees the representative\'s actions in the history', async () => {
  const a = (await svc('/owner/activity', { session: O.session })).body.activity
  const kinds = a.map(x => x.kind)
  for (const k of ['SYNC_DELEGATE_INVITED', 'SYNC_DELEGATE_ACCEPTED', 'SYNC_DELEGATE_REVOKED', 'SYNC_VIEWING_HOURS', 'SYNC_CONDITION_SET']) assert.ok(kinds.includes(k), k)
  assert.ok(a.some(x => x.kind === 'SYNC_CONDITION_SET' && x.by === 'Dan Helper'))
  const b = (await svc('/owner/activity', { session: B.session })).body.activity
  assert.ok(!b.some(x => x.kind.startsWith('SYNC_DELEGATE')), 'another owner sees none of it')
})

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n')
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)])
const up = (who, buf, extra = {}) => svc('/documents/upload', { session: who.session, category: 'contract', title: 'Lease 2026', dataBase64: buf.toString('base64'), ...extra })
const staffTok = jwt.sign({ id: 1, username: 'admin1', role: 'admin', aud: 'crm' }, process.env.JWT_SECRET)
const staffProfile = async () => { const r = await fetch(`${base}/api/crm/owners/${O.ownerId}`, { headers: { authorization: `Bearer ${staffTok}` } }); return { status: r.status, body: await r.json() } }

test('documents switched off: nothing stored, nothing served', async () => {
  process.env.SYNC_DOCUMENTS_ENABLED = '0'
  try {
    for (const [op, body] of [['/documents', {}], ['/documents/upload', { category: 'contract', title: 'x', dataBase64: PDF.toString('base64') }], ['/documents/file', { id: 1 }], ['/documents/share', { id: 1, share: true }], ['/documents/delete', { id: 1 }]]) {
      const r = await svc(op, { session: O.session, ...body })
      assert.equal(r.status, 503, op); assert.equal(r.body.error, 'DOCUMENTS_NOT_ENABLED')
    }
    assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM owner_documents`)).rows[0].n, 0)
  } finally { process.env.SYNC_DOCUMENTS_ENABLED = '1' }
})

let doc
test('documents: only checked file types, sizes and safe PDFs', async () => {
  assert.equal((await up(O, Buffer.from('MZ\x90\x00 this is an exe'))).body.error, 'FILE_TYPE')
  assert.equal((await up(O, Buffer.from('%PDF-1.4\n<< /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>'))).body.error, 'FILE_UNSAFE')
  assert.equal((await up(O, Buffer.concat([PDF, Buffer.alloc(3 * 1024 * 1024)]))).status, 413)
  assert.equal((await up(O, PDF, { category: 'plan' })).body.error, 'CATEGORY_INVALID', 'never the public floor-plan category')
  assert.equal((await up(O, PDF, { propertyId: B.ids[0] })).status, 404)
  const r = await up(O, PDF, { propertyId: O.ids[0] })
  assert.equal(r.status, 200, JSON.stringify(r.body)); doc = r.body.document
  assert.equal(doc.shared, false); assert.equal(doc.mime, 'application/pdf')
  assert.equal((await up(O, PNG, { category: 'energy_certificate', title: 'EPC' })).status, 200)
  const { rows: [row] } = await pool.query(`SELECT url, storage, visibility, storage_key FROM owner_documents WHERE id=$1`, [doc.id])
  assert.equal(row.storage, 'sync_private'); assert.ok(!/^https?:/.test(row.url), 'no file address in the table')
  assert.ok(fs.existsSync(path.join('/tmp/sync-docs-test', row.storage_key)))
})

test('documents: the owner downloads, nobody else; staff only after sharing, through expiring links', async () => {
  const f = await svc('/documents/file', { session: O.session, id: doc.id })
  assert.equal(Buffer.from(f.body.file.dataBase64, 'base64').toString('latin1'), PDF.toString('latin1'))
  for (const who of [B, D, X]) assert.equal((await svc('/documents/file', { session: who.session, id: doc.id })).status, 404)
  assert.equal((await svc('/documents/share', { session: B.session, id: doc.id, share: true })).status, 404)
  let p = await staffProfile()
  assert.equal(p.status, 200, JSON.stringify(p.body).slice(0, 300))
  assert.ok(!p.body.documents.some(d => d.id === doc.id), 'private: not in the CRM')
  assert.equal((await svc('/documents/share', { session: O.session, id: doc.id, share: true })).status, 200)
  p = await staffProfile()
  const listed = p.body.documents.find(d => d.id === doc.id)
  assert.ok(listed, 'shared: in the CRM'); assert.match(listed.url, /^http:\/\/staff\.test\/api\/crm\/owner-documents\/\d+\/file\?exp=\d+&sig=/)
  const u = new URL(listed.url)
  const got = await fetch(`${base}${u.pathname}${u.search}`)
  assert.equal(got.status, 200); assert.equal(got.headers.get('cache-control'), 'private, no-store'); assert.equal(got.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(Buffer.from(await got.arrayBuffer()).toString('latin1'), PDF.toString('latin1'))
  assert.equal((await fetch(`${base}${u.pathname}?exp=${u.searchParams.get('exp')}&sig=${'A'.repeat(43)}`)).status, 404, 'tampered')
  const old = Math.floor(Date.now() / 1000) - 5
  assert.equal((await fetch(`${base}${u.pathname}?exp=${old}&sig=${u.searchParams.get('sig')}`)).status, 404, 'expired')
  // the CRM cannot change or delete the owner's own document
  await fetch(`${base}/api/crm/owners/${O.ownerId}/documents/${doc.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${staffTok}` } })
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM owner_documents WHERE id=$1`, [doc.id])).rows[0].n, 1)
  assert.equal((await svc('/documents/share', { session: O.session, id: doc.id, share: false })).status, 200)
  assert.equal((await fetch(`${base}${u.pathname}${u.search}`)).status, 404, 'un-shared: the link stops working at once')
  const a = (await svc('/owner/activity', { session: O.session })).body.activity
  assert.ok(a.some(x => x.kind === 'SYNC_DOCUMENT_OPENED_BY_AGENCY' && x.by === 'agency'))
})

test('documents: deleting removes the file at once', async () => {
  const { rows: [row] } = await pool.query(`SELECT storage_key FROM owner_documents WHERE id=$1`, [doc.id])
  assert.equal((await svc('/documents/delete', { session: B.session, id: doc.id })).status, 404)
  assert.equal((await svc('/documents/delete', { session: O.session, id: doc.id })).status, 200)
  assert.ok(!fs.existsSync(path.join('/tmp/sync-docs-test', row.storage_key)))
  assert.equal((await svc('/documents/file', { session: O.session, id: doc.id })).status, 404)
  assert.ok(!(await svc('/documents', { session: O.session })).body.documents.some(d => d.id === doc.id))
  const { rows: [after] } = await pool.query(`SELECT deleted_at, url FROM owner_documents WHERE id=$1`, [doc.id])
  assert.ok(after.deleted_at); assert.equal(after.url, 'sync-deleted')
})
