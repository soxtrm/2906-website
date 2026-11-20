'use strict'
// Property type from evidence + the website review route. Patched copy of the live backend, throwaway
// PostgreSQL with the live SCHEMA only. Synthetic rows; nothing is sent anywhere.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const http = require('http')
process.env.JWT_SECRET = 'test-secret-not-production'
const ROOT = process.env.BACKEND_DIR || '/app'
const R = p => path.join(ROOT, p)
const jwt = require(R('node_modules/jsonwebtoken'))
const express = require(R('node_modules/express'))
const { Pool } = require(R('node_modules/pg'))
const pool = new Pool({ host: process.env.PGHOST, user: 'postgres', password: 'test', database: 'postgres', max: 6 })
const noop = () => {}
function stub(rel, exports) { const f = require.resolve(R(rel)); require.cache[f] = { id: f, filename: f, loaded: true, exports, children: [], paths: [] } }
stub('db.js', { query: (s, p) => pool.query(s, p), connect: () => pool.connect() })
stub('logger.js', { info: noop, warn: noop, error: noop, debug: noop })
const T = require(R('services/propertyTypeResolver.js'))

test('the kind of property comes from the text, never from a default', () => {
  const cases = [
    ['MODERN 2-BEDROOM APARTMENT – SLIEMA', 'apartment', 'apartment'], ['STUDIO APARTMENT IN GZIRA', 'apartment', 'studio'],
    ['STUNNING CORNER PENTHOUSE – ST JULIAN’S', 'apartment', 'penthouse'], ['3-BEDROOM VILLA WITH POOL – MADLIENA', 'house', 'villa'],
    ['TOWNHOUSE IN RABAT', 'apartment', 'house'], ['House of character, Zebbug', '', 'house'], ['Bright flat near the sea', '', 'apartment'],
    ['2-BEDROOM MAISONETTE – BUGIBBA', 'maisonette', 'maisonette'], ['Semi-detached villa', '', 'villa'], ['Duplex penthouse', '', 'penthouse'],
    ['Great deal in Sliema\n2 bedrooms\nLovely apartment close to the seafront', '', 'apartment'],
    // nothing named, or two different kinds: unresolved
    ['LUXURY 3-BEDROOM WITH HUGE TERRACE\n€2,000', 'apartment', null], ['Great deal in Sliema\n2 bedrooms', 'penthouse', null],
    ['MAISONETTE / PENTHOUSE OPTIONS – MOSTA', 'apartment', null], ['Garage for rent', 'apartment', null], ['', 'apartment', null],
  ]
  for (const [text, read, want] of cases) assert.equal(T.resolve(read, text).type, want, JSON.stringify(text.slice(0, 40)))
})

test('both upload paths use the resolver and neither writes "apartment" by default any more', () => {
  const fs = require('fs')
  for (const f of ['handlers/upload.js', 'handlers/uploadListing.js']) {
    const src = fs.readFileSync(R(f), 'utf8')
    assert.ok(!/p\.type \|\| 'apartment'/.test(src), f + ' still has the default')
    assert.ok(/propertyTypeResolver'\)\.resolve\(/.test(src), f + ' uses the resolver')
  }
  assert.match(fs.readFileSync(R('handlers/uploadListing.js'), 'utf8'), /"studio" \| "apartment" \| "penthouse" \| "maisonette" \| "house" \| "villa" \| "commercial" \| ""/)
})

// ── website review route ────────────────────────────────────────────────────────────────────────────────
let server, base
const tok = (id, username) => jwt.sign({ id, username, aud: 'crm' }, process.env.JWT_SECRET)
async function call(t, method, p, body) {
  const res = await fetch(`${base}/api/crm/website-review${p}`, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  let j = null; try { j = await res.json() } catch {}
  return { status: res.status, body: j }
}
async function insertRow(table, row) {
  const cols = (await pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND is_nullable='NO' AND column_default IS NULL`, [table])).rows
  const full = { ...row }
  for (const { column_name: c, data_type: t } of cols) {
    if (c in full) continue
    full[c] = /int|numeric|double|real/.test(t) ? 0 : t === 'boolean' ? false : /json/.test(t) ? '{}' : t === 'ARRAY' ? '{}' : /timestamp|date/.test(t) ? new Date() : t === 'uuid' ? require('crypto').randomUUID() : 'x'
  }
  const keys = Object.keys(full)
  await pool.query(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(', ')})`, keys.map(k => full[k]))
}
const OLD = new Date('2026-05-01T10:00:00Z')
const wid = async ref => (await pool.query(`SELECT id::text id, is_published, status, updated_at FROM website_properties WHERE property_reference=$1`, [ref])).rows[0]
test.before(async () => {
  await pool.query(`INSERT INTO agents (id, username, name, role, active, board_access) VALUES (1,'admin1','Admin One','admin',true,true), (5,'agent5','Agent Five','agent',true,false) ON CONFLICT DO NOTHING`)
  const site = (ref, extra = {}) => insertRow('website_properties', { title: ref, slug: ref.toLowerCase(), price: 1200, status: 'available', is_published: false, property_reference: ref, location: 'Sliema', category: 'letting', price_type: 'month', created_at: OLD, updated_at: OLD, ...extra })
  await site('2906-ABCDE'); await site('2906-9001'); await site('2906-LIVE1', { is_published: true }); await site('2906-HAND1')
  await insertRow('properties', { id: 990001, ref: '2906-9001', town: 'Sliema', property_type: 'apartment', available_status: 'archived', system_online: true, published: true, images: '[]' })
  for (const [ref, reason, st] of [['2906-ABCDE', 'older website entry without an ARGUS listing: unverifiable', null], ['2906-9001', 'archived', 'archived']]) {
    await pool.query(`INSERT INTO website_reconcile_log (website_id, property_reference, action, reason, argus_status, before_state, after_state) VALUES ($1,$2,'hide',$3,$4,'{"is_published":true}','{"is_published":false}')`, [(await wid(ref)).id, ref, reason, st])
  }
  const app = express(); app.use(express.json()); app.use('/api/crm/website-review', require(R('routes/crmWebsiteReview.js')))
  server = http.createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`
})
test.after(async () => { server.close(); await pool.end() })

test('review list: admins only; shows what was hidden and why, and what can be shown again', async () => {
  assert.equal((await call(null, 'GET', '/')).status, 401)
  assert.equal((await call(tok(5, 'agent5'), 'GET', '/')).status, 403)
  const r = await call(tok(1, 'admin1'), 'GET', '/')
  assert.equal(r.status, 200); assert.equal(r.body.total, 2)
  const legacy = r.body.listings.find(x => x.ref === '2906-ABCDE'), argus = r.body.listings.find(x => x.ref === '2906-9001')
  assert.deepEqual([legacy.canShow, legacy.hasArgusListing, legacy.reason], [true, false, 'older website entry without an ARGUS listing: unverifiable'])
  assert.deepEqual([argus.canShow, argus.hasArgusListing, argus.argusStatus], [false, true, 'archived'])
  assert.ok(!r.body.listings.some(x => x.ref === '2906-HAND1'), 'only what the system hid, not what someone took off by hand')
})

test('showing again needs an admin and a reason, is logged, and never moves the public "updated" time', async () => {
  const id = (await wid('2906-ABCDE')).id
  assert.equal((await call(tok(5, 'agent5'), 'POST', `/${id}/show`, { reason: 'owner confirmed' })).status, 403)
  assert.equal((await call(tok(1, 'admin1'), 'POST', `/${id}/show`, { reason: '' })).status, 400)
  const ok = await call(tok(1, 'admin1'), 'POST', `/${id}/show`, { reason: 'Owner confirmed by phone today' })
  assert.equal(ok.status, 200)
  const w = await wid('2906-ABCDE')
  assert.equal(w.is_published, true); assert.equal(w.status, 'available'); assert.equal(new Date(w.updated_at).getTime(), OLD.getTime())
  const last = (await pool.query(`SELECT action, reason FROM website_reconcile_log WHERE property_reference='2906-ABCDE' ORDER BY id DESC LIMIT 1`)).rows[0]
  assert.equal(last.action, 'show'); assert.match(last.reason, /^shown again by admin1: Owner confirmed by phone today$/)
  assert.equal((await call(tok(1, 'admin1'), 'POST', `/${id}/show`, { reason: 'again please' })).status, 409, 'already on the website')
  assert.equal((await call(tok(1, 'admin1'), 'GET', '/')).body.total, 1, 'it left the review list')
})

test('a listing that follows ARGUS cannot be forced back here', async () => {
  const r = await call(tok(1, 'admin1'), 'POST', `/${(await wid('2906-9001')).id}/show`, { reason: 'please show it' })
  assert.equal(r.status, 409); assert.match(r.body.error, /follows ARGUS/)
  assert.equal((await wid('2906-9001')).is_published, false)
  assert.equal((await call(tok(1, 'admin1'), 'POST', '/does-not-exist/show', { reason: 'please show it' })).status, 404)
  assert.equal((await pool.query(`SELECT count(*)::int n FROM website_properties`)).rows[0].n, 4, 'nothing deleted')
})
