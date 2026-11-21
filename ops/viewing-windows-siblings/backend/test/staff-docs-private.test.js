'use strict'
// Staff-side owner documents in private storage + the Cloudinary migration (2026-11-21).
// Throwaway PostgreSQL with the live schema + migrations; "Cloudinary" is a local test server; ClamAV is stubbed
// (the real scanner is checked by test/clamd-live-check.js against the running clamd).
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path'); const fs = require('fs'); const http = require('http'); const crypto = require('crypto')

process.env.JWT_SECRET = 'test-secret-not-production-0123456789'
process.env.ARGUS_AGENCY_KEY = '2906'
process.env.SYNC_PRIVATE_DOCS_DIR = '/tmp/staff-docs-test'
process.env.SYNC_STAFF_FILE_ORIGIN = 'http://staff.test'
process.env.SYNC_DOCUMENTS_ENABLED = '1'
process.env.MIGRATION_MANIFEST = '/tmp/staff-docs-test-manifest/manifest.json'
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
const fake = new Proxy({}, { get: (t, k) => (k === 'then' ? undefined : (k === 'on' || k === 'once') ? () => fake : async () => null) })
stub('waha.js', fake); stub('redis.js', fake); stub('queues.js', fake)
const SD = require(R('services/syncDocuments.js'))
let scan = async () => ({ clean: true })
SD._test.setScanner(b => scan(b))

const DOCX = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), crypto.randomBytes(900)])
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(1200)])
const MP4 = Buffer.concat([Buffer.from('\x00\x00\x00\x18ftypmp42', 'latin1'), crypto.randomBytes(3000)])
const sha = b => crypto.createHash('sha256').update(b).digest('hex')
let server, base, cdn, cdnBase, ownerId, propertyId
const tok = jwt.sign({ id: 1, username: 'admin1', role: 'admin', aud: 'crm' }, process.env.JWT_SECRET)
const H = { authorization: `Bearer ${tok}` }
async function crmUpload(buf, name, type) {
  const fd = new FormData(); fd.append('files', new Blob([buf], { type }), name); fd.append('category', 'contract')
  const r = await fetch(`${base}/api/crm/owners/${ownerId}/documents`, { method: 'POST', headers: H, body: fd })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}
const get = async u => { const x = new URL(u); return fetch(`${base}${x.pathname}${x.search}`) }

test.before(async () => {
  for (let i = 0; i < 60; i++) { try { await pool.query('SELECT 1'); break } catch { await new Promise(r => setTimeout(r, 500)) } }
  await pool.query(`INSERT INTO agents (id, username, name, role, active, board_access) VALUES (1,'admin1','Admin One','admin',true,true) ON CONFLICT DO NOTHING`)
  const { rows: [o] } = await pool.query(`INSERT INTO owner_contacts (phone_normalized, name) VALUES ('35699000301','Doc Owner') RETURNING id`); ownerId = o.id
  const { rows: [p] } = await pool.query(`INSERT INTO properties (ref, town, property_type, longlet_price, bedrooms, bathrooms, owner_id) VALUES ('DOC-1','Msida','Apartment',1200,2,1,$1) RETURNING id`, [ownerId]); propertyId = p.id
  const app = express(); app.use(express.json()); app.use('/api/crm', require(R('routes/crm.js')))
  server = http.createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`
  const files = { 'a.jpg': ['image/jpeg', JPG], 'b.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', DOCX], 'c.mp4': ['video/mp4', MP4], 'plan.jpg': ['image/jpeg', JPG] }
  cdn = http.createServer((req, res) => { const f = files[path.basename(req.url)]; if (!f) { res.statusCode = 404; return res.end() } res.setHeader('content-type', f[0]); res.setHeader('content-length', f[1].length); res.end(req.method === 'HEAD' ? undefined : f[1]) })
  await new Promise(r => cdn.listen(0, '127.0.0.1', r)); cdnBase = `http://127.0.0.1:${cdn.address().port}/`
  process.env.MIGRATE_URL_REWRITE = `https://res.cloudinary.com/=>${cdnBase}`
})
test.after(async () => { server.close(); cdn.close(); await pool.end(); fs.rmSync('/tmp/staff-docs-test', { recursive: true, force: true }); fs.rmSync('/tmp/staff-docs-test-manifest', { recursive: true, force: true }) })

let wordDoc
test('CRM upload: Word file stored privately, virus-checked, staff get a download link', async () => {
  const r = await crmUpload(DOCX, 'Lease.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  assert.equal(r.status, 200, JSON.stringify(r.body)); wordDoc = r.body.documents[0]
  assert.match(wordDoc.url, /^http:\/\/staff\.test\/api\/crm\/owner-documents\/\d+\/file\?exp=\d+&sig=/, 'no file address, a 10-minute link')
  const { rows: [d] } = await pool.query(`SELECT * FROM owner_documents WHERE id=$1`, [wordDoc.id])
  assert.equal(d.storage, 'sync_private'); assert.equal(d.visibility, 'agency'); assert.equal(d.scan_state, 'clean'); assert.equal(d.sha256, sha(DOCX))
  assert.ok(fs.existsSync(path.join('/tmp/staff-docs-test', d.storage_key)))
  const f = await get(wordDoc.url)
  assert.equal(f.status, 200); assert.match(f.headers.get('content-disposition'), /^attachment/); assert.equal(f.headers.get('content-type'), 'application/octet-stream')
  assert.equal(sha(Buffer.from(await f.arrayBuffer())), sha(DOCX))
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM owner_document_staging`)).rows[0].n, 0)
})

test('CRM upload: a photo opens in the browser', async () => {
  const r = await crmUpload(JPG, 'Meter.jpg', 'image/jpeg')
  const f = await get(r.body.documents[0].url)
  assert.equal(f.status, 200); assert.match(f.headers.get('content-disposition'), /^inline/); assert.equal(f.headers.get('content-type'), 'image/jpeg')
})

test('CRM upload: an infected file is refused, nothing is kept', async () => {
  const before = (await pool.query(`SELECT COUNT(*)::int n FROM owner_documents`)).rows[0].n
  scan = async () => ({ clean: false, signature: 'Eicar-Test-Signature' })
  try { assert.notEqual((await crmUpload(DOCX, 'Bad.docx', 'application/msword')).status, 200) } finally { scan = async () => ({ clean: true }) }
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM owner_documents`)).rows[0].n, before)
  assert.equal(fs.readdirSync('/tmp/staff-docs-test').length, 2, 'no extra file')
})

test('CRM upload while the scanner is down: kept pending, unreachable until the re-check', async () => {
  scan = async () => { throw new Error('down') }
  let r; try { r = await crmUpload(JPG, 'Later.jpg', 'image/jpeg') } finally { scan = async () => ({ clean: true }) }
  assert.equal(r.status, 200)
  const id = r.body.documents[0]?.id
  const { rows: [d] } = await pool.query(`SELECT scan_state FROM owner_documents WHERE filename='Later.jpg'`)
  assert.equal(d.scan_state, 'pending')
  const prof = await (await fetch(`${base}/api/crm/owners/${ownerId}`, { headers: H })).json()
  const listed = prof.documents.find(x => x.filename === 'Later.jpg')
  assert.equal((await get(listed.url)).status, 404, 'not served before it is clean')
  await pool.query(`UPDATE owner_documents SET created_at = NOW() - interval '5 minutes' WHERE filename='Later.jpg'`)
  assert.equal((await SD.rescanPending()).clean, 1)
  assert.equal((await get(listed.url)).status, 200)
  void id
})

test('CRM edit and delete keep working for staff uploads; deleting removes the file', async () => {
  const p = await fetch(`${base}/api/crm/owners/${ownerId}/documents/${wordDoc.id}`, { method: 'PATCH', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ notes: 'signed copy' }) })
  const pb = await p.json()
  assert.equal(p.status, 200, JSON.stringify(pb)); assert.match(pb.document.url, /owner-documents\/\d+\/file\?exp=/)
  const { rows: [d] } = await pool.query(`SELECT storage_key FROM owner_documents WHERE id=$1`, [wordDoc.id])
  await fetch(`${base}/api/crm/owners/${ownerId}/documents/${wordDoc.id}`, { method: 'DELETE', headers: H })
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM owner_documents WHERE id=$1`, [wordDoc.id])).rows[0].n, 0)
  assert.ok(!fs.existsSync(path.join('/tmp/staff-docs-test', d.storage_key)))
})

test('the CRM cannot change or delete an owner\'s own SYNC upload', async () => {
  const { rows: [a] } = await pool.query(`INSERT INTO sync_accounts (email, display_name) VALUES ('doc-owner@example.test','Doc Owner') RETURNING id`)
  const url = await SD.storeStaffDocument(JPG, 'image/jpeg', 'own.jpg')
  const { rows: [d] } = await pool.query(`INSERT INTO owner_documents (owner_contact_id, filename, url, uploaded_by) VALUES ($1,'own.jpg',$2,'owner-sync') RETURNING id`, [ownerId, url])
  await pool.query(`UPDATE owner_documents SET sync_account_id=$2, visibility='agency' WHERE id=$1`, [d.id, a.id])
  await fetch(`${base}/api/crm/owners/${ownerId}/documents/${d.id}`, { method: 'DELETE', headers: H })
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM owner_documents WHERE id=$1`, [d.id])).rows[0].n, 1)
})

test('a row can never point at an unregistered private file', async () => {
  await assert.rejects(pool.query(`INSERT INTO owner_documents (owner_contact_id, filename, url, uploaded_by) VALUES ($1,'x','sync-private:nothing.pdf','t')`, [ownerId]), /not registered/)
})

test('orphaned files (upload without a row) are removed after a day', async () => {
  const url = await SD.storeStaffDocument(JPG, 'image/jpeg', 'orphan.jpg')
  const key = url.slice('sync-private:'.length)
  await pool.query(`UPDATE owner_document_staging SET created_at = NOW() - interval '2 days' WHERE storage_key=$1`, [key])
  await SD.rescanPending()
  assert.ok(!fs.existsSync(path.join('/tmp/staff-docs-test', key)))
})

test('Cloudinary migration: manifest first, every type handled, originals kept, verified, reversible', async () => {
  const M = require(R('scripts/cloudinary-docs-migrate.js'))
  const ins = async (name, cat, prop) => (await pool.query(`INSERT INTO owner_documents (owner_contact_id, filename, url, uploaded_by, category, property_id) VALUES ($1,$2,$3,'owner-whatsapp',$4,$5) RETURNING id`,
    [ownerId, name, `https://res.cloudinary.com/demo/image/upload/v17/2906-owner-documents/${name}`, cat, prop])).rows[0].id
  const ids = { jpg: await ins('a.jpg', null, propertyId), docx: await ins('b.docx', 'other', null), mp4: await ins('c.mp4', null, propertyId), plan: await ins('plan.jpg', 'plan', propertyId) }
  assert.equal(await M.check(), 3, 'floor plans are not part of it')
  await assert.rejects(M.copy(), /manifest/, 'no copy without a recorded manifest')
  assert.equal(await M.manifest(), 4)
  const c = await M.copy()
  assert.equal(c.copied, 3); assert.deepEqual(c.failed, [])
  const { rows } = await pool.query(`SELECT id, storage, mime, legacy_url, property_id FROM owner_documents WHERE id = ANY($1::int[]) ORDER BY id`, [Object.values(ids)])
  const by = Object.fromEntries(rows.map(r => [r.id, r]))
  assert.equal(by[ids.docx].mime, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  assert.equal(by[ids.mp4].mime, 'video/mp4'); assert.equal(by[ids.jpg].property_id, propertyId)
  assert.equal(by[ids.plan].storage, 'cloudinary', 'floor plan untouched')
  assert.ok(by[ids.jpg].legacy_url.startsWith('https://res.cloudinary.com/'), 'original address kept')
  const v = await M.verify()
  assert.equal(v.length, 3); assert.ok(v.every(x => x.ok))
  // CRM access through the private copy, then revocation
  const prof = await (await fetch(`${base}/api/crm/owners/${ownerId}`, { headers: H })).json()
  const mp4 = prof.documents.find(d => d.id === ids.mp4)
  const f = await get(mp4.url)
  assert.equal(f.status, 200); assert.match(f.headers.get('content-disposition'), /^attachment/)
  await pool.query(`UPDATE owner_documents SET visibility='private' WHERE id=$1`, [ids.mp4])
  assert.equal((await get(mp4.url)).status, 404, 'revoked: the link stops at once')
  await pool.query(`UPDATE owner_documents SET visibility='agency' WHERE id=$1`, [ids.mp4])
  // a message still quoting an original address shows up as a dependency
  await pool.query(`INSERT INTO agent_activity_log (actor_role, action_type, details) VALUES ('system','TEST_REF',$1::jsonb)`, [JSON.stringify({ note: 'see https://res.cloudinary.com/demo/image/upload/v17/2906-owner-documents/a.jpg' })])
  const rep = await M.report()
  const a = rep.find(x => x.id === ids.jpg)
  assert.ok(a.migrated && a.verified && a.originalPublic); assert.ok(a.otherReferences.some(r => r.startsWith('agent_activity_log.details')))
  assert.ok(fs.existsSync('/tmp/staff-docs-test-manifest/.cloudinary-cleanup-report.json'))
  assert.equal(await M.revert(), 3)
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM owner_documents WHERE storage='cloudinary' AND url LIKE 'https://res.cloudinary.com/%'`)).rows[0].n, 4)
})
