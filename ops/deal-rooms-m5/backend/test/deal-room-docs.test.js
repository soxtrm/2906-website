'use strict'
// NEXUS Deal Room M5 (2026-11-21) against a throwaway PostgreSQL with the live schema + migrations. Synthetic data only;
// the virus scanner is stubbed per test (clean / infected / down), files go to a temporary private folder.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path'), http = require('http'), fs = require('fs'), os = require('os')

process.env.JWT_SECRET = 'test-secret-not-production'
process.env.ARGUS_AGENCY_KEY = '2906'
process.env.SYNC_PRIVATE_DOCS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-docs-'))
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
const X = require(R('services/dealRoomDocs.js'))
let scanner = async () => ({ clean: true })
X._test.setScanner(b => scanner(b))

let server, base, admin, a1, a2, conv, token, room
const tok = a => jwt.sign({ id: a.id, username: a.username, aud: 'crm' }, process.env.JWT_SECRET)
async function http_(method, p, body, headers = {}) {
  const res = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined })
  const ct = res.headers.get('content-type') || ''
  return { status: res.status, ct, body: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) }
}
const deals = (a, m, p, b) => http_(m, `/api/crm/deal-rooms${p}`, b, { authorization: `Bearer ${tok(a)}` })
const mp = (m, p, b, t) => http_(m, `/api/nexus/mp${p}`, b, t ? { 'x-mp-token': t } : {})
const md = (m, p, b, t = token) => http_(m, `/api/nexus/mp-deal${p}`, b, t ? { 'x-mp-token': t } : {})
const maltaDay = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Malta' }).format(new Date(Date.now() + d * 86400e3))
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 7)]).toString('base64')
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF').toString('base64')
const PDF_JS = Buffer.from('%PDF-1.4\n1 0 obj << /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj\n%%EOF').toString('base64')

test.before(async () => {
  for (let i = 0; i < 60; i++) { try { await pool.query('SELECT 1'); break } catch { await new Promise(r => setTimeout(r, 500)) } }
  const mk = async (u, role) => (await pool.query(`INSERT INTO agents (username, name, role, active, password_hash) VALUES ($1,$1,$2,true,'x') RETURNING id, username, role`, [u, role])).rows[0]
  admin = await mk('m5-admin', 'admin'); a1 = await mk('m5-agent-1', 'agent'); a2 = await mk('m5-agent-2', 'agent')
  await pool.query(`INSERT INTO properties (ref, town, property_type, longlet_price, bedrooms, bathrooms, listed_by_agent_id) VALUES ('2906-9765','Msida','apartment',1750,2,2,$1)`, [a1.id])
  const app = express(); app.use(express.json({ limit: '10mb' }))
  app.use('/api/crm/marketplace-inbox', require(R('routes/crmMarketplaceInbox.js')))
  app.use('/api/crm/deal-rooms', require(R('routes/crmDealRooms.js')))
  app.use('/api/nexus/mp-deal', require(R('routes/marketplaceDealRoom.js')))
  app.use('/api/nexus/mp', require(R('routes/marketplaceConversations.js')))
  server = http.createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`
  const s = await mp('POST', '/conversations', { ref: '2906-9765', name: 'Mia Visitor', email: 'mia@example.test', message: 'Hi' }); conv = s.body.conversation; token = s.body.token
  const v = await mp('POST', `/conversations/${conv.id}/viewing`, { preferred: [{ date: maltaDay(5) }] }, token); room = v.body.conversation.deal.id
})
test.after(async () => { server.close(); await pool.end() })

let clientDoc, staffDoc
test('the client adds a photo as evidence; hash, size and server time are kept; capture data stored as reported, no GPS', async () => {
  const r = await md('POST', `/${conv.id}/documents`, { kind: 'condition_evidence', title: 'Kitchen at viewing', filename: 'kitchen.jpg', dataBase64: JPEG, captureMeta: { capturedAt: '2026-11-21T10:00:00Z', device: 'iPhone', gps: '35.9,14.5' } })
  assert.equal(r.status, 200, JSON.stringify(r.body)); clientDoc = r.body.deal.documents.find(d => d.title === 'Kitchen at viewing')
  assert.ok(clientDoc && clientDoc.from === 'client' && clientDoc.scan === 'clean')
  const { rows: [d] } = await pool.query(`SELECT sha256, size_bytes, capture_meta, storage_key FROM deal_room_documents WHERE id=$1`, [clientDoc.id])
  assert.equal(d.sha256.length, 64); assert.equal(d.size_bytes, 304); assert.equal(d.capture_meta.gps, undefined); assert.equal(d.capture_meta.device, 'iPhone')
  assert.equal((fs.statSync(path.join(process.env.SYNC_PRIVATE_DOCS_DIR, 'deal-rooms', d.storage_key)).mode & 0o777), 0o600, 'private file mode')
})

test('wrong types, active PDFs and infected files are refused; a scanner outage keeps the file pending and unserved', async () => {
  assert.equal((await md('POST', `/${conv.id}/documents`, { kind: 'document', title: 'x', dataBase64: Buffer.from('MZ fake exe').toString('base64') })).body.error, 'TYPE_NOT_ALLOWED')
  assert.equal((await md('POST', `/${conv.id}/documents`, { kind: 'document', title: 'x', dataBase64: PDF_JS })).body.error, 'PDF_ACTIVE')
  scanner = async () => ({ clean: false, signature: 'Eicar-Test' })
  assert.equal((await md('POST', `/${conv.id}/documents`, { kind: 'document', title: 'x', dataBase64: PDF })).body.error, 'INFECTED')
  scanner = async () => { throw new Error('clamd down') }
  const p = await md('POST', `/${conv.id}/documents`, { kind: 'document', title: 'Reference letter', dataBase64: PDF }); assert.equal(p.status, 200)
  const pend = p.body.deal.documents.find(d => d.title === 'Reference letter'); assert.equal(pend.scan, 'pending')
  assert.equal((await md('GET', `/${conv.id}/documents/${pend.id}`)).status, 409, 'not served while pending')
  scanner = async () => ({ clean: true })
  const ok = await md('GET', `/${conv.id}/documents/${pend.id}`); assert.equal(ok.status, 200); assert.ok(ok.body.slice(0, 5).toString() === '%PDF-')
})

test('staff-only documents never reach the client; an unrelated agent sees nothing; every download is logged', async () => {
  const s = await deals(a1, 'POST', `/${room}/documents`, { kind: 'document', title: 'Owner ID check notes', dataBase64: PDF, visibility: 'staff' })
  assert.equal(s.status, 200, JSON.stringify(s.body)); staffDoc = s.body.deal.documents.find(d => d.title === 'Owner ID check notes'); assert.ok(staffDoc.internal)
  const mine = await md('GET', `/${conv.id}`); assert.ok(!JSON.stringify(mine.body).includes('Owner ID check notes'))
  assert.equal((await md('GET', `/${conv.id}/documents/${staffDoc.id}`)).status, 404)
  assert.equal(Number((await pool.query(`SELECT count(*) FROM deal_room_document_access WHERE document_id=$1 AND action='refused'`, [staffDoc.id])).rows[0].count), 1)
  assert.equal((await deals(a2, 'GET', `/${room}/documents/${clientDoc.id}`)).status, 404)
  assert.equal((await md('GET', `/${conv.id}/documents/${clientDoc.id}`, null, 'wrong-token')).status, 404)
  const dl = await deals(a1, 'GET', `/${room}/documents/${clientDoc.id}`); assert.equal(dl.status, 200); assert.equal(dl.ct, 'image/jpeg')
  const v = (await deals(a1, 'GET', `/${room}`)).body.deal
  assert.equal(v.documents.find(d => d.id === clientDoc.id).downloads, 1)
})

test('a tampered file is not served (fingerprint check)', async () => {
  const { rows: [d] } = await pool.query(`SELECT storage_key FROM deal_room_documents WHERE id=$1`, [clientDoc.id])
  const f = path.join(process.env.SYNC_PRIVATE_DOCS_DIR, 'deal-rooms', d.storage_key); const orig = fs.readFileSync(f)
  fs.chmodSync(f, 0o600); fs.writeFileSync(f, Buffer.concat([orig, Buffer.from('x')]))
  assert.equal((await deals(a1, 'GET', `/${room}/documents/${clientDoc.id}`)).body.error, 'INTEGRITY')
  fs.writeFileSync(f, orig)
})

test('contract and invoice drafts are generated, versioned and clearly marked as drafts', async () => {
  assert.equal((await deals(a1, 'POST', `/${room}/drafts/contract`, { monthlyRent: '' })).body.error, 'TERMS_REQUIRED')
  const c1 = await deals(a1, 'POST', `/${room}/drafts/contract`, { monthlyRent: '1750', deposit: '1750', startDate: maltaDay(30), months: 12 })
  assert.equal(c1.status, 200, JSON.stringify(c1.body))
  const c2 = await deals(a1, 'POST', `/${room}/drafts/contract`, { monthlyRent: '1700', deposit: '1700', startDate: maltaDay(30), months: 12, notes: 'Pets considered' })
  const drafts = c2.body.deal.documents.filter(d => d.kind === 'contract_draft'); assert.deepEqual(drafts.map(d => d.version), [1, 2])
  const html = (await md('GET', `/${conv.id}/documents/${drafts[1].id}`)).body.toString()
  assert.ok(/DRAFT · NOT SIGNED/.test(html) && /€1,700/.test(html) && /Mia Visitor/.test(html) && !/olga|owner@/i.test(html))
  const inv = await deals(a1, 'POST', `/${room}/drafts/invoice`, { items: [{ label: 'Security deposit', amount: '1700' }, { label: 'First month', amount: '1700' }], dueDate: maltaDay(25) })
  const ih = (await deals(a1, 'GET', `/${room}/documents/${inv.body.deal.documents.find(d => d.kind === 'invoice_draft').id}`)).body.toString()
  assert.ok(/NO PAYMENT RECEIVED/.test(ih) && /€3,400/.test(ih))
})

test('payment requests: explicit states, never "received" by a message, verified only by an admin with a reference', async () => {
  const r = await deals(a1, 'POST', `/${room}/payments`, { kind: 'deposit', label: 'Security deposit', amount: '1700' }); assert.equal(r.status, 200)
  const p = r.body.deal.paymentRequests[0]; assert.equal(p.status, 'requested')
  const client = (await md('GET', `/${conv.id}`)).body.deal; assert.equal(client.payments[0].statusLabel, 'Requested · not received')
  assert.equal((await deals(a1, 'POST', `/${room}/payments/${p.id}/status`, { status: 'verified' })).status, 409, 'requested -> verified is not a step')
  assert.equal((await deals(a1, 'POST', `/${room}/payments/${p.id}/status`, { status: 'pending' })).status, 200)
  assert.equal((await deals(a1, 'POST', `/${room}/payments/${p.id}/status`, { status: 'verified', reference: 'BOV-123' })).status, 403, 'agents cannot verify')
  assert.equal((await deals(admin, 'POST', `/${room}/payments/${p.id}/status`, { status: 'verified' })).status, 403, 'no reference, no verification')
  assert.equal((await deals(admin, 'POST', `/${room}/payments/${p.id}/status`, { status: 'verified', reference: 'BOV-123', note: 'Matched on statement' })).status, 200)
  const { rows: [row] } = await pool.query(`SELECT status, verified_via, reference FROM deal_room_payment_requests WHERE id=$1`, [p.id])
  assert.deepEqual(row, { status: 'verified', verified_via: 'manual_reconciliation', reference: 'BOV-123' })
})

test('everything is on the Deal Room timeline', async () => {
  const kinds = (await deals(a1, 'GET', `/${room}`)).body.deal.timeline.map(e => e.kind)
  for (const k of ['created', 'viewing_requested', 'document_added', 'draft_created', 'payment_requested', 'payment_status']) assert.ok(kinds.includes(k), k)
  const clientKinds = (await md('GET', `/${conv.id}`)).body.deal.timeline
  assert.ok(!clientKinds.some(e => e.internal), 'no internal entries for the client')
})
