'use strict'
// Cross-system compatibility run (Claude, 2026-11-12): the REAL ARGUS routers
// against the REAL NEXUS Owner Portal Stage A handler (Codex, ee61326), both on
// local throw-away databases. No stub receiver, no mocked signer.
//
// This is a local run, not the staging gate. It answers one question: do the two
// implementations actually interoperate, and where do they not.
// Assertions marked GAP pin today's behaviour of a known mismatch; when the
// mismatch is fixed the assertion fails and must be turned around.
//
// Needs: NEXUS_REPO_DIR (checkout of codex/nexus-property-network-20261111),
//        NEXUS_PYTHON (python with psycopg + tzdata). Skipped otherwise.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const express = require('express')
const jwt = require('jsonwebtoken')
const { Client } = require('pg')

const REPO = process.env.NEXUS_REPO_DIR
const PY = process.env.NEXUS_PYTHON
const skip = !REPO || !PY ? 'NEXUS_REPO_DIR and NEXUS_PYTHON are required' : false

process.env.JWT_SECRET = 'test-jwt-secret-not-production'
const TO_ARGUS = 'nexus-to-argus-secret-0123456789abcdef01'
const TO_NEXUS = 'argus-to-nexus-secret-0123456789abcdef01'
const PGPORT = Number(process.env.ARGUS_TEST_PGPORT || 55439)
const NEXUS_DB = 'nexus_xsys'
const NEXUS_PUBLIC = 'https://nexus.invalid'

let H, S, C, argus, argusBase, nexus, nexusBase, admin, tmp
const pg = database => new Client({ host: '127.0.0.1', port: PGPORT, user: 'test', password: 'test', database })
const staff = () => jwt.sign({ id: admin.id, role: 'admin', aud: 'crm' }, process.env.JWT_SECRET, { expiresIn: '10m' })

async function crm(method, p, body) {
  const res = await fetch(argusBase + '/api/crm/owner-nexus' + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${staff()}` }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => null) }
}
async function nx(method, p, { body, headers = {} } = {}) {
  const res = await fetch(nexusBase + p, { method, redirect: 'manual', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json', origin: nexusBase }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* html */ }
  return { status: res.status, json, headers: res.headers }
}
// What ARGUS would send, signed exactly as services/nexusOwnerLink.js signs.
function asArgus(method, signPath, body, { secret = TO_NEXUS, key = 'argus-2906' } = {}) {
  const timestamp = Math.floor(Date.now() / 1000)
  return { 'X-Nexus-Link-Key': key, 'X-Nexus-Link-Timestamp': String(timestamp), 'X-Nexus-Link-Signature': C.sign(secret, { timestamp, method, path: signPath, body: body ?? null }) }
}
async function nexusOwner(email) {
  const reg = await nx('POST', '/api/nexus/auth/register', { body: { name: 'Cross Test Owner', email, password: 'TestPassword99!' } })
  assert.equal(reg.status, 200, JSON.stringify(reg.json))
  const cookie = reg.headers.get('set-cookie').split(';')[0]
  const session = await nx('GET', '/api/nexus/housing/session', { headers: { cookie } })
  assert.equal(session.status, 200)
  return { cookie, 'X-Nexus-CSRF': session.json.csrfToken }
}

async function prepareNexusDatabase() {
  const root = pg('postgres'); await root.connect()
  await root.query(`DROP DATABASE IF EXISTS ${NEXUS_DB} WITH (FORCE)`)
  await root.query(`CREATE DATABASE ${NEXUS_DB}`)
  // Roles are cluster-wide; the vanilla shim's CREATE ROLE lines only work once.
  for (const [role, extra] of [['anon', ''], ['authenticated', ''], ['service_role', ' BYPASSRLS']]) {
    const { rowCount } = await root.query(`SELECT 1 FROM pg_roles WHERE rolname=$1`, [role])
    if (!rowCount) await root.query(`CREATE ROLE ${role} NOLOGIN${extra}`)
  }
  await root.end()
  const c = pg(NEXUS_DB); await c.connect()
  const read = f => fs.readFileSync(path.join(REPO, f), 'utf8')
  await c.query(read('tests/fixtures/nexus_housing_vanilla_pg.sql').split(/\r?\n/).filter(l => !/^create role /i.test(l)).join('\n'))
  await c.query(read('supabase/migrations/20261030231646_nexus_foundation.sql'))
  await c.query(read('supabase/migrations/20261111193832_nexus_property_network.sql'))
  await c.end()
}
const nexusSql = async (sql, params) => { const c = pg(NEXUS_DB); await c.connect(); try { return (await c.query(sql, params)).rows } finally { await c.end() } }

test.before(async () => {
  if (skip) return
  process.env.NEXUS_LINK_INBOUND_SECRET = TO_ARGUS
  process.env.NEXUS_LINK_OUTBOUND_SECRET = TO_NEXUS
  process.env.NEXUS_OWNER_LINK_URL = `${NEXUS_PUBLIC}/api/nexus/housing/bridge/argus`
  process.env.NEXUS_OWNER_PORTAL_URL = `${NEXUS_PUBLIC}/owner/activate`
  H = require('./helpers/harness')
  S = H.load('services/nexusOwnerLink')
  C = H.load('services/nexusLinkCrypto')
  await H.migrate(); await H.reset()
  admin = await H.agent('admin')
  const app = express()
  app.use(express.json({ limit: '10mb' }))
  app.use('/api/crm/owner-nexus', H.load('routes/crmOwnerNexus'))
  app.use('/api/nexus-link/v1', H.load('routes/nexusLinkService'))
  await new Promise(r => { argus = app.listen(0, '127.0.0.1', r) })
  argusBase = `http://127.0.0.1:${argus.address().port}`

  await prepareNexusDatabase()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-xsys-'))
  const dsn = db => `postgresql://test:test@127.0.0.1:${PGPORT}/${db}`
  nexus = spawn(PY, [path.join(__dirname, 'helpers', 'nexus_server.py'), REPO, '0'], {
    env: { ...process.env, NEXUS_ENV: 'development', NEXUS_ACCOUNT_AUTH: '1', NEXUS_HOUSING_OWNER: '1', NEXUS_HOUSING_PREVERIFIED_INVITES: '0',
      NEXUS_BOOKING_DB: path.join(tmp, 'booking.sqlite'), NEXUS_HOUSING_DB_DSN: dsn(NEXUS_DB), NEXUS_HOUSING_ARGUS_READ_DSN: dsn('argus_test'),
      NEXUS_HOUSING_2906_BRIDGE_SECRET: TO_NEXUS, NEXUS_HOUSING_ARGUS_LINK_URL: `${argusBase}/api/nexus-link/v1`, NEXUS_HOUSING_ARGUS_LINK_SECRET: TO_ARGUS, PYTHONDONTWRITEBYTECODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let err = ''
  nexus.stderr.on('data', d => { err += d })
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('NEXUS did not start: ' + err.slice(-800))), 30000)
    nexus.stdout.on('data', d => { const m = /NEXUS_READY (\d+)/.exec(String(d)); if (m) { clearTimeout(timer); resolve(Number(m[1])) } })
    nexus.on('exit', code => { clearTimeout(timer); reject(new Error(`NEXUS exited ${code}: ${err.slice(-800)}`)) })
  })
  nexusBase = `http://127.0.0.1:${port}`
  // ARGUS only delivers to https. Locally the same request is carried to the loopback NEXUS.
  S.setTransport((url, init) => fetch(url.replace(NEXUS_PUBLIC, nexusBase), init))
})
test.after(async () => {
  if (skip) return
  if (nexus) nexus.kill()
  if (argus) await new Promise(r => argus.close(r))
  await H.reset()
  await H.db.end().catch(() => {})
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* sqlite file still held on Windows */ }
})

test('ARGUS owner → invitation → NEXUS activation → property link → owner update → synchronisation', { skip }, async t => {
  const o = await H.owner()
  const p1 = await H.property(o.id, { longlet_price: 1500 })
  const p2 = await H.property(o.id, { longlet_price: 900, town: 'Gzira' })
  const ext = p => `2906:${p.ref}`
  const before = (await H.db.query(`SELECT last_confirmed_available_at FROM properties WHERE id=$1`, [p1.id])).rows[0].last_confirmed_available_at
  let token, owner, stranger, nexusPropertyId

  await t.test('invitation link from ARGUS opens the real NEXUS activation page', async () => {
    const inv = await crm('POST', `/${o.id}/invitation`, {})
    assert.equal(inv.status, 200, JSON.stringify(inv.json))
    const url = new URL(inv.json.invitation.url)
    token = url.hash.replace(/^#t=/, '')
    const page = await nx('GET', url.pathname)
    assert.equal(page.status, 200)
  })

  await t.test('NEXUS resolves the token through the signed ARGUS service and shows locality-level facts only', async () => {
    owner = await nexusOwner(`owner-${process.pid}-${Date.now()}@example.org`)
    stranger = await nexusOwner(`other-${process.pid}-${Date.now()}@example.org`)
    assert.equal((await nx('POST', '/api/nexus/housing/argus-claim-preview', { body: { token } })).status, 401)
    const preview = await nx('POST', '/api/nexus/housing/argus-claim-preview', { body: { token }, headers: owner })
    assert.equal(preview.status, 200, JSON.stringify(preview.json))
    assert.deepEqual(preview.json.properties.map(x => x.externalId).sort(), [ext(p1), ext(p2)].sort())
    assert.deepEqual(Object.keys(preview.json.properties[0]).sort(), ['externalId', 'propertyType', 'town'])
    assert.doesNotMatch(JSON.stringify(preview.json), /Secret Street|\+356/)
  })

  await t.test('owner claims in NEXUS; ARGUS records a claim, not a verification', async () => {
    const claim = await nx('POST', '/api/nexus/housing/argus-claim', { headers: owner, body: { token, decisions: [{ externalId: ext(p1), decision: 'confirm' }, { externalId: ext(p2), decision: 'reject', note: 'sold in 2024' }] } })
    assert.equal(claim.status, 200, JSON.stringify(claim.json))
    const st = (await crm('GET', `/${o.id}`)).json
    assert.equal(st.link.state, 'claim_pending')
    assert.match(st.link.nexusAccountRef, /^nxu_[a-f0-9]{32}$/)
    assert.deepEqual((await nx('GET', '/api/nexus/housing/properties', { headers: owner })).json.properties, [])
    // The link is single-use: a second account cannot claim with it.
    assert.equal((await nx('POST', '/api/nexus/housing/argus-claim-preview', { body: { token }, headers: stranger })).status, 409)
    assert.equal((await nx('POST', '/api/nexus/housing/argus-claim', { headers: stranger, body: { token, decisions: [{ externalId: ext(p1), decision: 'confirm' }] } })).status, 409)
  })

  await t.test('sync before verification is refused by ARGUS; after staff verification NEXUS links exactly the confirmed property', async () => {
    assert.deepEqual((await crm('POST', `/${o.id}/sync-owner`, {})).json.blockedReasons, ['OWNER_LINK_NOT_VERIFIED'])
    assert.equal((await crm('POST', `/${o.id}/verify`, { method: 'ID seen in office' })).status, 200)
    const sync = await crm('POST', `/${o.id}/sync-owner`, {})
    assert.equal(sync.status, 200, JSON.stringify(sync.json))
    assert.deepEqual({ d: sync.json.delivery.delivered, f: sync.json.delivery.failed }, { d: 1, f: 0 })
    assert.equal((await crm('GET', `/${o.id}`)).json.link.sync.state, 'synced')
    const list = (await nx('GET', '/api/nexus/housing/properties', { headers: owner })).json.properties
    assert.deepEqual(list.map(x => x.listingRef), [p1.ref])
    nexusPropertyId = list[0].id
    // Account isolation on the NEXUS side.
    assert.deepEqual((await nx('GET', '/api/nexus/housing/properties', { headers: stranger })).json.properties, [])
    assert.notEqual((await nx('GET', `/api/nexus/housing/properties/${nexusPropertyId}`, { headers: stranger })).status, 200)
  })

  await t.test('negative authorisation and duplicate processing on the NEXUS receiver', async () => {
    const { rows: [row] } = await H.db.query(`SELECT * FROM nexus_sync_outbox WHERE event_type='owner.profile_upserted' AND state='delivered' ORDER BY id DESC LIMIT 1`)
    const body = { eventId: row.event_id, eventType: row.event_type, contractVersion: row.contract_version, agencyKey: row.agency_key, occurredAt: new Date(row.created_at).toISOString(), idempotencyKey: row.idempotency_key, data: row.payload }
    const url = '/api/nexus/housing/bridge/argus/events'
    assert.equal((await nx('POST', url, { body })).status, 401)
    assert.equal((await nx('POST', url, { body, headers: asArgus('POST', '/events', body, { secret: TO_ARGUS }) })).status, 401)
    assert.equal((await nx('POST', url, { body, headers: asArgus('POST', '/events', body, { key: 'argus-9999' }) })).status, 401)
    assert.equal((await nx('POST', url, { body: { ...body, agencyKey: 'benestates' }, headers: asArgus('POST', '/events', { ...body, agencyKey: 'benestates' }) })).status, 403)
    const again = await nx('POST', url, { body, headers: asArgus('POST', '/events', body) })
    assert.equal(again.status, 200); assert.deepEqual(again.json, { linkedProperties: 1 })
    const changed = { ...body, data: { ...body.data, displayName: 'Someone Else' } }
    assert.equal((await nx('POST', url, { body: changed, headers: asArgus('POST', '/events', changed) })).status, 409)
    assert.equal((await nexusSql(`SELECT COUNT(*)::int n FROM nexus_private.housing_properties`))[0].n, 1)
  })

  await t.test('GAP: owner confirms availability and grants distribution in NEXUS — ARGUS never hears of it', async () => {
    const view = await nx('GET', `/api/nexus/housing/properties/${nexusPropertyId}`, { headers: owner })
    assert.equal(view.status, 200, JSON.stringify(view.json))
    const a = await nx('POST', `/api/nexus/housing/properties/${nexusPropertyId}/availability`, { headers: owner, body: { status: 'available', recheckHours: 48, version: view.json.version } })
    assert.equal(a.status, 200, JSON.stringify(a.json))
    const d = await nx('POST', `/api/nexus/housing/properties/${nexusPropertyId}/distribution`, { headers: owner, body: { permissions: ['view_facts', 'market'], version: a.json.version } })
    assert.equal(d.status, 200, JSON.stringify(d.json))
    // NEXUS holds its own confirmation time …
    assert.ok(d.json.availability.lastConfirmedAt)
    // … ARGUS's single source of truth did not move, and no grant arrived.
    const after = (await H.db.query(`SELECT last_confirmed_available_at FROM properties WHERE id=$1`, [p1.id])).rows[0].last_confirmed_available_at
    assert.equal(String(after), String(before))
    assert.equal((await H.db.query(`SELECT COUNT(*)::int n FROM nexus_distribution_grants`)).rows[0].n, 0)
    assert.equal((await H.db.query(`SELECT COUNT(*)::int n FROM nexus_inbound_events WHERE event_type <> 'owner.claim_submitted'`)).rows[0].n, 0)
    // The changes wait in a NEXUS outbox that ARGUS would have to poll; ARGUS has no poller.
    const p = '/api/nexus/housing/bridge/events'
    const pending = await nx('GET', p, { headers: asArgus('GET', p, null) })
    assert.equal(pending.status, 200, JSON.stringify(pending.json))
    const types = pending.json.events.map(e => e.event_type)
    assert.ok(types.includes('property.availability_confirmed') && types.includes('property.distribution_changed'), types.join(','))
    // Consequence: ARGUS's own gate keeps the property out, so NEXUS never returns a canonical id.
    const sync = await crm('POST', `/${o.id}/sync-properties`, {})
    assert.deepEqual(sync.json.properties.find(x => x.ref === p1.ref).blockedReasons, ['NO_DISTRIBUTION_AUTHORIZATION'])
    assert.equal((await crm('GET', `/${o.id}`)).json.properties.find(x => x.ref === p1.ref).statuses.canonicalPropertyId, null)
  })

  await t.test('with a grant in the contract format, property sync is acknowledged with the NEXUS canonical id — and NEXUS ignores the payload (GAP)', async () => {
    const link = (await crm('GET', `/${o.id}`)).json.link
    const grant = { contractVersion: S.CONTRACT_VERSION, agencyKey: '2906', eventId: `xsys-grant-${Date.now()}`, eventType: 'distribution.granted', data: { linkId: link.id, externalId: ext(p1), channel: 'origin_agency', scopes: ['listing_data', 'availability'] } }
    const ts = Math.floor(Date.now() / 1000)
    const res = await fetch(argusBase + '/api/nexus-link/v1/events', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Nexus-Link-Key': 'nexus', 'X-Nexus-Link-Timestamp': String(ts), 'X-Nexus-Link-Signature': C.sign(TO_ARGUS, { timestamp: ts, method: 'POST', path: '/events', body: grant }) }, body: JSON.stringify(grant) })
    assert.equal(res.status, 200)
    await H.db.query(`UPDATE properties SET longlet_price=1650 WHERE id=$1`, [p1.id])
    const sync = await crm('POST', `/${o.id}/sync-properties`, {})
    assert.deepEqual({ d: sync.json.delivery.delivered, f: sync.json.delivery.failed }, { d: 1, f: 0 })
    const s = (await crm('GET', `/${o.id}`)).json.properties.find(x => x.ref === p1.ref).statuses
    assert.equal(s.canonicalPropertyId, nexusPropertyId)
    assert.equal(s.sync, 'synced'); assert.equal(s.publication, 'unpublished')
    // ARGUS says "synced", but the new rent never reached the NEXUS passport.
    const passport = (await nx('GET', `/api/nexus/housing/properties/${nexusPropertyId}`, { headers: owner })).json.passport
    assert.equal(passport.rent, 1500)
    // Nothing duplicated on either side by the second sync.
    assert.equal((await crm('POST', `/${o.id}/sync-properties`, {})).json.properties.find(x => x.ref === p1.ref).unchanged, true)
    assert.equal((await nexusSql(`SELECT COUNT(*)::int n FROM nexus_private.housing_properties`))[0].n, 1)
  })

  await t.test('an ARGUS dispute closes owner access in NEXUS at once', async () => {
    assert.equal((await crm('POST', `/${o.id}/dispute`, { reason: 'second person claims ownership' })).status, 200)
    assert.deepEqual((await nx('GET', '/api/nexus/housing/properties', { headers: owner })).json.properties, [])
    assert.equal((await nx('GET', `/api/nexus/housing/properties/${nexusPropertyId}`, { headers: owner })).status, 403)
  })
})
