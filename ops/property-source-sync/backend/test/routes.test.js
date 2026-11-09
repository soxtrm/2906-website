'use strict'
// Property Source Sync — real GET/POST/PATCH routes through Express with real
// JWTs and live agent rows (isolated test DB). Admin-only enforcement, URL
// policy at the API boundary, persistence across requests, review actions.
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const path = require('path')
const fs = require('fs')
const jwt = require('jsonwebtoken')
const express = require('express')
const H = require('./helpers/harness')
const Sync = H.load('services/propertySourceSync')
const router = H.load('routes/crmPropertySources')

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'observed_2026-11-09.json'), 'utf8')).listings
let server, base, admin, agentRow, inactive
const tok = (a, extra = {}) => jwt.sign({ id: a.id, role: a.role, aud: 'crm', ...extra }, process.env.JWT_SECRET)
async function call(method, url, body, token) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined })
  let data = null; try { data = await res.json() } catch {}
  return { status: res.status, data }
}

test.before(async () => {
  await H.migrate()
  admin = await H.agent('admin'); agentRow = await H.agent('agent'); inactive = await H.agent('admin')
  await H.db.query(`UPDATE agents SET active=false WHERE id=$1`, [inactive.id])
  const app = express(); app.use(express.json()); app.use('/api/crm/property-sources', router)
  server = http.createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
test.beforeEach(() => H.reset())
test.after(() => new Promise(r => server.close(r)))

test('non-admin, board, inactive, forged and missing tokens are refused on every route', async () => {
  const routes = [['GET', '/api/crm/property-sources/summary'], ['GET', '/api/crm/property-sources/sources'], ['POST', '/api/crm/property-sources/sources'],
                  ['PATCH', '/api/crm/property-sources/sources/1'], ['POST', '/api/crm/property-sources/sources/1/scan'], ['GET', '/api/crm/property-sources/events'],
                  ['POST', '/api/crm/property-sources/events/1/accept'], ['POST', '/api/crm/property-sources/sources/1/accept-safe-new']]
  for (const [m, u] of routes) {
    assert.equal((await call(m, u, {})).status, 401, `${m} ${u} anonymous`)
    assert.equal((await call(m, u, {}, tok(agentRow))).status, 403, `${m} ${u} agent`)
    assert.equal((await call(m, u, {}, tok(admin, { aud: 'board' }))).status, 403, `${m} ${u} board`)
    assert.equal((await call(m, u, {}, tok(inactive))).status, 401, `${m} ${u} inactive`)
    assert.equal((await call(m, u, {}, jwt.sign({ id: admin.id, role: 'admin' }, 'wrong-secret'))).status, 401, `${m} ${u} forged`)
  }
  // A stale token claiming admin for a demoted agent is refused (live role check).
  assert.equal((await call('GET', '/api/crm/property-sources/summary', null, tok({ ...agentRow, role: 'admin' }))).status, 403)
})

test('admin adds Long Let and Sale URLs; registry persists across requests', async () => {
  const T = tok(admin)
  const a = await call('POST', '/api/crm/property-sources/sources', { adapter: 'mynexthome', category: 'long_let', url: 'https://www.mynexthome.mt/long-let/' }, T)
  const b = await call('POST', '/api/crm/property-sources/sources', { adapter: 'mynexthome', category: 'sale', url: 'https://mynexthome.mt/for-sale?utm=x' }, T)
  assert.equal(a.status, 200); assert.equal(b.status, 200); assert.equal(b.data.url, 'https://www.mynexthome.mt/for-sale/')
  assert.equal(a.data.sync_enabled, false); assert.equal(a.data.polling_allowed, false)
  const list = await call('GET', '/api/crm/property-sources/sources', null, T)
  assert.deepEqual(list.data.map(s => s.category).sort(), ['long_let', 'sale'])
  assert.equal((await call('POST', '/api/crm/property-sources/sources', { adapter: 'mynexthome', category: 'long_let', url: 'https://www.mynexthome.mt/long-let/' }, T)).status, 409)
})

test('URL policy at the API: localhost, IP literals, other hosts, short-let and redirect-style tricks are rejected', async () => {
  const T = tok(admin)
  for (const [category, url] of [['long_let', 'https://127.0.0.1/long-let/'], ['long_let', 'http://www.mynexthome.mt/long-let/'], ['long_let', 'https://localhost/long-let/'],
    ['long_let', 'https://www.mynexthome.mt.attacker.io/long-let/'], ['long_let', 'https://attacker.io/?next=https://www.mynexthome.mt/long-let/'],
    ['short_let', 'https://www.mynexthome.mt/short-let/'], ['long_let', 'https://www.mynexthome.mt/short-let/'], ['sale', 'https://[::1]/for-sale/']]) {
    const r = await call('POST', '/api/crm/property-sources/sources', { adapter: 'mynexthome', category, url }, T)
    assert.equal(r.status, 400, url); assert.ok(r.data.error)
  }
})

test('manual scan without recorded permission is refused and fetches nothing', async () => {
  const T = tok(admin)
  const s = await call('POST', '/api/crm/property-sources/sources', { adapter: 'mynexthome', category: 'long_let', url: 'https://www.mynexthome.mt/long-let/' }, T)
  const r = await call('POST', `/api/crm/property-sources/sources/${s.data.id}/scan`, {}, T)
  assert.equal(r.status, 403); assert.equal(r.data.code, 'PERMISSION_REQUIRED')
  const en = await call('PATCH', `/api/crm/property-sources/sources/${s.data.id}`, { sync_enabled: true }, T)
  assert.equal(en.status, 403)
})

test('review queue over HTTP: list → detail → accept / reject; stale and repeated actions handled', async () => {
  const T = tok(admin)
  const s = await call('POST', '/api/crm/property-sources/sources', { adapter: 'mynexthome', category: 'long_let', url: 'https://www.mynexthome.mt/long-let/' }, T)
  const items = JSON.parse(JSON.stringify(fixture.filter(x => x.category === 'long_let')))
  items[0].private_address_candidate = 'Private 7 Test Street'
  await Sync.ingestSnapshot(s.data.id, items)
  const sum = await call('GET', '/api/crm/property-sources/summary', null, T)
  assert.equal(sum.data.totals.new, 4)
  const list = await call('GET', `/api/crm/property-sources/events?source=${s.data.id}`, null, T)
  assert.equal(list.data.length, 4); assert.ok(!JSON.stringify(list.data).includes('Private 7'))
  const target = list.data.find(e => e.current.external_id === items[0].external_id)
  const detail = await call('GET', `/api/crm/property-sources/events/${target.id}`, null, T)
  assert.match(detail.data.privacy.address, /PRIVATE/); assert.equal(detail.data.media.use, 'LINK_ONLY'); assert.deepEqual(detail.data.media.urls, [])
  const acc = await call('POST', `/api/crm/property-sources/events/${target.id}/accept`, { fingerprint: target.fingerprint }, T)
  assert.equal(acc.status, 200); assert.ok(acc.data.result.propertyId)
  const again = await call('POST', `/api/crm/property-sources/events/${target.id}/accept`, { fingerprint: target.fingerprint }, T)
  assert.equal(again.status, 200); assert.equal(again.data.idempotentReplay, true)
  const other = list.data.find(e => e.id !== target.id)
  assert.equal((await call('POST', `/api/crm/property-sources/events/${other.id}/accept`, { fingerprint: 'stale' }, T)).status, 409)
  assert.equal((await call('POST', `/api/crm/property-sources/events/${other.id}/reject`, { note: 'duplicate of our own listing' }, T)).status, 200)
  assert.equal((await call('POST', `/api/crm/property-sources/events/${other.id}/accept`, {}, T)).status, 409)
  assert.equal((await call('POST', `/api/crm/property-sources/events/${other.id}/delete`, {}, T)).status, 404)
  const audit = await H.db.query(`SELECT COUNT(*)::int n FROM agent_activity_log WHERE action_type='PROPERTY_SOURCE_REVIEW'`)
  assert.equal(audit.rows[0].n, 2)
})

test('recording permission over HTTP requires evidence; enabling then works', async () => {
  const T = tok(admin)
  const s = await call('POST', '/api/crm/property-sources/sources', { adapter: 'mynexthome', category: 'sale', url: 'https://www.mynexthome.mt/for-sale/' }, T)
  assert.equal((await call('PATCH', `/api/crm/property-sources/sources/${s.data.id}`, { permission: { read_permission: 'GRANTED' } }, T)).status, 400)
  const ok = await call('PATCH', `/api/crm/property-sources/sources/${s.data.id}`, { permission: { read_permission: 'GRANTED', reference: 'Email from provider 2026-11-09' }, version: s.data.version }, T)
  assert.equal(ok.status, 200); assert.equal(ok.data.polling_allowed, true)
  const en = await call('PATCH', `/api/crm/property-sources/sources/${s.data.id}`, { sync_enabled: true, interval_hours: 24, version: ok.data.version }, T)
  assert.equal(en.status, 200); assert.equal(en.data.sync_enabled, true); assert.ok(en.data.next_check_at)
  assert.equal((await call('PATCH', `/api/crm/property-sources/sources/${s.data.id}`, { label: 'x', version: s.data.version }, T)).status, 409)
})
