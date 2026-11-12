'use strict'
// Integration-gate scenarios, real code on both sides (Claude, 2026-11-12):
// the ARGUS routers of this branch against the NEXUS handler of a committed
// NEXUS revision that pushes owner changes (a2068ab or later). Two local
// throw-away databases, real signatures, no stub receiver.
//
// Local run, not hosted staging. Steps marked GAP pin behaviour that does not
// yet meet the decisions of 2026-11-12; they fail when NEXUS closes the gap.
//
// Needs NEXUS_REPO_DIR (clean export of the NEXUS commit) and NEXUS_PYTHON.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')
const express = require('express')
const jwt = require('jsonwebtoken')
const { Client } = require('pg')

const REPO = process.env.NEXUS_REPO_DIR
const PY = process.env.NEXUS_PYTHON
const skip = !REPO || !PY ? 'NEXUS_REPO_DIR and NEXUS_PYTHON are required'
  : !fs.existsSync(path.join(REPO, 'nexus_housing_market.py')) ? 'needs a NEXUS revision that pushes owner changes (a2068ab or later)' : false
// From 9947028 NEXUS also pushes passport and schedule edits (behind its own flag, switched on below).
const PUSHES = !skip && fs.readFileSync(path.join(REPO, 'nexus_housing.py'), 'utf8').includes('def push_owner_change')

process.env.JWT_SECRET = 'test-jwt-secret-not-production'
const TO_ARGUS = 'nexus-to-argus-secret-0123456789abcdef01'
const TO_NEXUS = 'argus-to-nexus-secret-0123456789abcdef01'
const PGPORT = Number(process.env.ARGUS_TEST_PGPORT || 55439)
const NEXUS_DB = 'nexus_xpush'
const NEXUS_PUBLIC = 'https://nexus.invalid'
const RECEIVER = '/api/nexus/workspaces/argus-link/v1'

let H, S, C, app, argus, argusPort, argusBase, nexus, nexusBase, admin, tmp, transportFault = null
const pg = database => new Client({ host: '127.0.0.1', port: PGPORT, user: 'test', password: 'test', database })
const staff = () => jwt.sign({ id: admin.id, role: 'admin', aud: 'crm' }, process.env.JWT_SECRET, { expiresIn: '10m' })
const one = async (sql, params) => (await H.db.query(sql, params)).rows[0]
const nexusSql = async (sql, params) => { const c = pg(NEXUS_DB); await c.connect(); try { return (await c.query(sql, params)).rows } finally { await c.end() } }

async function crm(method, p, body) {
  const res = await fetch(argusBase + '/api/crm/owner-nexus' + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${staff()}`, connection: 'close' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => null) }
}
async function nx(method, p, { body, headers = {} } = {}) {
  const res = await fetch(nexusBase + p, { method, redirect: 'manual', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json', origin: nexusBase }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* html */ }
  return { status: res.status, json, headers: res.headers }
}
function asArgus(body, { secret = TO_NEXUS, key = 'argus-2906' } = {}) {
  const timestamp = Math.floor(Date.now() / 1000)
  return { 'X-Nexus-Link-Key': key, 'X-Nexus-Link-Timestamp': String(timestamp), 'X-Nexus-Link-Signature': C.sign(secret, { timestamp, method: 'POST', path: '/events', body }) }
}
async function nexusOwner(email) {
  const reg = await nx('POST', '/api/nexus/auth/register', { body: { name: 'Cross Test Owner', email, password: 'TestPassword99!' } })
  assert.equal(reg.status, 200, JSON.stringify(reg.json))
  const cookie = reg.headers.get('set-cookie').split(';')[0]
  const session = await nx('GET', '/api/nexus/housing/session', { headers: { cookie } })
  return { cookie, 'X-Nexus-CSRF': session.json.csrfToken }
}
const listen = port => new Promise(r => { argus = app.listen(port, '127.0.0.1', r) })
async function stopArgus() { argus.closeAllConnections(); await new Promise(r => argus.close(r)) }

async function prepareNexusDatabase() {
  const root = pg('postgres'); await root.connect()
  await root.query(`DROP DATABASE IF EXISTS ${NEXUS_DB} WITH (FORCE)`)
  await root.query(`CREATE DATABASE ${NEXUS_DB}`)
  for (const [role, extra] of [['anon', ''], ['authenticated', ''], ['service_role', ' BYPASSRLS']]) {
    const { rowCount } = await root.query(`SELECT 1 FROM pg_roles WHERE rolname=$1`, [role])
    if (!rowCount) await root.query(`CREATE ROLE ${role} NOLOGIN${extra}`)
  }
  await root.end()
  const c = pg(NEXUS_DB); await c.connect()
  await c.query(fs.readFileSync(path.join(REPO, 'tests/fixtures/nexus_housing_vanilla_pg.sql'), 'utf8').split(/\r?\n/).filter(l => !/^create role /i.test(l)).join('\n'))
  const dir = path.join(REPO, 'supabase', 'migrations')
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await c.query(fs.readFileSync(path.join(dir, f), 'utf8'))
  await c.end()
}

test.before(async () => {
  if (skip) return
  Object.assign(process.env, { NEXUS_LINK_INBOUND_SECRET: TO_ARGUS, NEXUS_LINK_OUTBOUND_SECRET: TO_NEXUS, NEXUS_OWNER_LINK_URL: NEXUS_PUBLIC + RECEIVER, NEXUS_OWNER_PORTAL_URL: `${NEXUS_PUBLIC}/owner/activate`, NEXUS_LINK_ROUTING_EVENTS: '1' })
  H = require('./helpers/harness')
  S = H.load('services/nexusOwnerLink')
  C = H.load('services/nexusLinkCrypto')
  await H.migrate(); await H.reset()
  admin = await H.agent('admin')
  app = express()
  app.use(express.json({ limit: '10mb' }))
  app.use('/api/crm/owner-nexus', H.load('routes/crmOwnerNexus'))
  app.use('/api/nexus-link/v1', H.load('routes/nexusLinkService'))
  await listen(0)
  argusPort = argus.address().port
  argusBase = `http://127.0.0.1:${argusPort}`

  await prepareNexusDatabase()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-xpush-'))
  const dsn = db => `postgresql://test:test@127.0.0.1:${PGPORT}/${db}`
  nexus = spawn(PY, [path.join(__dirname, 'helpers', 'nexus_server.py'), REPO, '0'], {
    env: { ...process.env, NEXUS_ENV: 'development', NEXUS_ACCOUNT_AUTH: '1', NEXUS_HOUSING_OWNER: '1', NEXUS_HOUSING_PREVERIFIED_INVITES: '0', NEXUS_HOUSING_PROFESSIONAL: '0', NEXUS_HOUSING_ARGUS_OWNER_PUSH: '1',
      NEXUS_BOOKING_DB: path.join(tmp, 'booking.sqlite'), NEXUS_HOUSING_DB_DSN: dsn(NEXUS_DB),
      // GAP (decision 5): this NEXUS revision still needs a login on the ARGUS database.
      NEXUS_HOUSING_ARGUS_READ_DSN: dsn('argus_test'),
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
  S.setTransport((url, init) => { if (transportFault) { const f = transportFault; transportFault = null; throw new Error(f) } return fetch(url.replace(NEXUS_PUBLIC, nexusBase), init) })
})
test.after(async () => {
  if (skip) return
  if (nexus) nexus.kill()
  if (argus) await stopArgus().catch(() => {})
  await H.reset()
  await H.db.end().catch(() => {})
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* sqlite file still held on Windows */ }
})

test('integration gate, local: NEXUS pushes owner changes to ARGUS and ARGUS synchronises back', { skip }, async t => {
  const o = await H.owner()
  const p = await H.property(o.id, { longlet_price: 1500, bedrooms: 2 })
  const ext = `2906:${p.ref}`
  let owner, stranger, id
  const view = async (who = owner) => (await nx('GET', `/api/nexus/housing/properties/${id}`, { headers: who })).json
  // One owner action in the NEXUS Owner Portal, with the current version like the browser sends it.
  const act = async (change, body, who = owner) => nx('POST', `/api/nexus/housing/properties/${id}/${change}`, { headers: who, body: { version: (await view()).version, ...body } })
  const grants = async () => (await H.db.query(`SELECT channel, scopes FROM nexus_distribution_grants WHERE property_id=$1 AND revoked_at IS NULL ORDER BY channel`, [p.id])).rows
  const confirmedAt = async () => (await one(`SELECT last_confirmed_available_at t FROM properties WHERE id=$1`, [p.id])).t

  await t.test('activation: invitation → claim → staff verification → owner sync acknowledged as applied', async () => {
    const inv = await crm('POST', `/${o.id}/invitation`, {})
    const token = new URL(inv.json.invitation.url).hash.replace(/^#t=/, '')
    owner = await nexusOwner(`owner-${process.pid}-${Date.now()}@example.org`)
    stranger = await nexusOwner(`other-${process.pid}-${Date.now()}@example.org`)
    assert.equal((await nx('POST', '/api/nexus/housing/argus-claim', { headers: owner, body: { token, decisions: [{ externalId: ext, decision: 'confirm' }] } })).status, 200)
    const pending = await nx('GET', '/api/nexus/housing/properties', { headers: owner })
    assert.deepEqual([pending.json.properties, pending.json.claimStatus], [[], 'claim_pending'])
    await crm('POST', `/${o.id}/verify`, { method: 'ID seen in office' })
    const sync = await crm('POST', `/${o.id}/sync-owner`, {})
    assert.deepEqual({ d: sync.json.delivery.delivered, f: sync.json.delivery.failed }, { d: 1, f: 0 }, JSON.stringify(sync.json))
    assert.equal((await crm('GET', `/${o.id}`)).json.link.sync.state, 'synced')
    const list = (await nx('GET', '/api/nexus/housing/properties', { headers: owner })).json.properties
    assert.deepEqual(list.map(x => x.listingRef), [p.ref])
    id = list[0].id
  })

  await t.test('owner changes distribution permissions → ARGUS applies them; anything outside the vocabulary is refused before it leaves NEXUS', async () => {
    assert.deepEqual(await grants(), [])
    for (const bad of [{ channel: 'public_web', action: 'grant', scopes: ['listing_data'] }, { channel: 'origin_agency', action: 'grant', scopes: ['owner_phone'] }, { channel: 'origin_agency', action: 'grant', scopes: [] }]) {
      assert.equal((await act('distribution', { ...bad, commandId: crypto.randomUUID() })).status, 400)
    }
    assert.deepEqual(await grants(), [])
    const ok = await act('distribution', { channel: 'origin_agency', action: 'grant', scopes: ['listing_data', 'availability'], commandId: crypto.randomUUID() })
    assert.equal(ok.status, 200, JSON.stringify(ok.json))
    assert.deepEqual(await grants(), [{ channel: 'origin_agency', scopes: ['availability', 'listing_data'] }])
    // NEXUS shows what ARGUS holds, in both vocabularies.
    assert.deepEqual(ok.json.argusGrants.map(g => [g.channel, g.scopes]), [['origin_agency', ['availability', 'listing_data']]])
    assert.deepEqual(ok.json.permissions, ['view_facts'])
  })

  await t.test('owner confirms availability → the ARGUS timestamp updates → NEXUS displays exactly that value; duplicates create nothing', async () => {
    assert.equal(await confirmedAt(), null)
    const commandId = crypto.randomUUID()
    const ok = await act('availability', { outcome: 'available', commandId })
    assert.equal(ok.status, 200, JSON.stringify(ok.json))
    const at = await confirmedAt()
    assert.ok(at)
    assert.equal(new Date(ok.json.availability.lastConfirmedAt).getTime(), new Date(at).getTime())
    assert.equal(ok.json.availability.freshness, 'recently_confirmed')
    // NEXUS keeps no competing confirmation time for an ARGUS-linked listing.
    assert.equal((await nexusSql(`SELECT availability_last_confirmed_at t FROM nexus_private.housing_properties WHERE id=$1`, [id]))[0].t, null)
    // The same owner action delivered again (same command) is one answer in ARGUS and moves nothing.
    assert.equal((await act('availability', { outcome: 'available', commandId })).status, 200)
    assert.equal((await one(`SELECT COUNT(*)::int n FROM owner_availability_answers WHERE property_id=$1 AND outcome='available'`, [p.id])).n, 1)
    assert.equal(new Date(await confirmedAt()).getTime(), new Date(at).getTime())
    // A hold is recorded but is not a confirmation.
    assert.equal((await act('availability', { outcome: 'temporarily_held', commandId: crypto.randomUUID() })).status, 200)
    assert.equal(new Date(await confirmedAt()).getTime(), new Date(at).getTime())
    assert.equal((await view()).availability.status, 'held')
    assert.equal((await act('availability', { outcome: 'available', commandId: crypto.randomUUID() })).status, 200)
  })

  await t.test('ARGUS → NEXUS: an approved listing change is applied in NEXUS, and only then reported as synced', async () => {
    await H.db.query(`UPDATE properties SET longlet_price=1650 WHERE id=$1`, [p.id])
    const sync = await crm('POST', `/${o.id}/sync-properties`, {})
    assert.deepEqual({ d: sync.json.delivery.delivered, f: sync.json.delivery.failed }, { d: 1, f: 0 }, JSON.stringify(sync.json))
    const s = (await crm('GET', `/${o.id}`)).json.properties[0].statuses
    assert.deepEqual([s.sync, s.canonicalPropertyId, s.publication], ['synced', id, 'unpublished'])
    assert.equal((await view()).passport.rent, 1650)
    assert.equal((await crm('POST', `/${o.id}/sync-properties`, {})).json.properties[0].unchanged, true)
    assert.equal((await nexusSql(`SELECT COUNT(*)::int n FROM nexus_private.housing_argus_listings`))[0].n, 1)
  })

  await t.test('failed deliveries stay pending and retry safely, in both directions', async () => {
    // ARGUS → NEXUS: the network drops once.
    await H.db.query(`UPDATE properties SET longlet_price=1700 WHERE id=$1`, [p.id])
    transportFault = 'connection reset'
    const failed = await crm('POST', `/${o.id}/sync-properties`, {})
    assert.deepEqual({ d: failed.json.delivery.delivered, f: failed.json.delivery.failed }, { d: 0, f: 1 })
    assert.equal((await crm('GET', `/${o.id}`)).json.properties[0].statuses.sync, 'error')
    assert.equal((await view()).passport.rent, 1650)
    assert.equal((await crm('POST', `/${o.id}/retry`, {})).json.delivery.delivered, 1)
    assert.equal((await view()).passport.rent, 1700)
    assert.equal((await one(`SELECT COUNT(*)::int n FROM nexus_sync_outbox WHERE event_type='property.upserted' AND payload->'rent'->>'amount'='1700'`)).n, 1)

    // NEXUS → ARGUS: ARGUS is down while the owner answers. Nothing is half-recorded; the same command succeeds later.
    const before = (await one(`SELECT COUNT(*)::int n FROM owner_availability_answers WHERE property_id=$1`, [p.id])).n
    const version = (await view()).version
    const commandId = crypto.randomUUID()
    await stopArgus()
    const down = await nx('POST', `/api/nexus/housing/properties/${id}/availability`, { headers: owner, body: { version, outcome: 'reserved', commandId } })
    await listen(argusPort)
    assert.equal(down.status, 503, JSON.stringify(down.json))
    assert.equal((await one(`SELECT COUNT(*)::int n FROM owner_availability_answers WHERE property_id=$1`, [p.id])).n, before)
    assert.equal((await view()).version, version)
    assert.equal((await nx('POST', `/api/nexus/housing/properties/${id}/availability`, { headers: owner, body: { version, outcome: 'reserved', commandId } })).status, 200)
    assert.equal((await one(`SELECT COUNT(*)::int n FROM owner_availability_answers WHERE property_id=$1`, [p.id])).n, before + 1)
  })

  await t.test('unauthorised events and actors are rejected on both sides', async () => {
    const body = { contractVersion: S.CONTRACT_VERSION, agencyKey: '2906', eventId: 'xpush-unauth-0001', eventType: 'property.withdrawn', occurredAt: new Date().toISOString(), data: { externalId: ext, reason: 'forged' } }
    const url = RECEIVER + '/events'
    assert.equal((await nx('POST', url, { body })).status, 401)
    assert.equal((await nx('POST', url, { body, headers: asArgus(body, { secret: TO_ARGUS }) })).status, 401)
    assert.equal((await nx('POST', url, { body, headers: asArgus(body, { key: 'argus-9999' }) })).status, 401)
    assert.equal((await nx('POST', url, { body: { ...body, agencyKey: 'benestates' }, headers: asArgus({ ...body, agencyKey: 'benestates' }) })).status, 403)
    assert.equal((await nexusSql(`SELECT withdrawn FROM nexus_private.housing_argus_listings`))[0].withdrawn, false)
    // ARGUS: an unsigned owner event, and one signed with the wrong direction's secret.
    const evt = { contractVersion: S.CONTRACT_VERSION, agencyKey: '2906', eventId: 'xpush-unauth-0002', eventType: 'distribution.granted', data: { linkId: (await crm('GET', `/${o.id}`)).json.link.id, externalId: ext, channel: 'all_eligible_agencies', scopes: ['listing_data'] } }
    const raw = h => fetch(argusBase + '/api/nexus-link/v1/events', { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(evt) })
    assert.equal((await raw({})).status, 401)
    const ts = Math.floor(Date.now() / 1000)
    assert.equal((await raw({ 'X-Nexus-Link-Key': 'nexus', 'X-Nexus-Link-Timestamp': String(ts), 'X-Nexus-Link-Signature': C.sign(TO_NEXUS, { timestamp: ts, method: 'POST', path: '/events', body: evt }) })).status, 401)
    assert.deepEqual((await grants()).map(g => g.channel), ['origin_agency'])
    // Another NEXUS account cannot act on this owner's listing, and nothing reaches ARGUS.
    const n = (await one(`SELECT COUNT(*)::int n FROM nexus_inbound_events`)).n
    const foreign = await nx('POST', `/api/nexus/housing/properties/${id}/distribution`, { headers: stranger, body: { version: (await view()).version, channel: 'all_eligible_agencies', action: 'grant', scopes: ['listing_data'], commandId: crypto.randomUUID() } })
    assert.ok([403, 404].includes(foreign.status), String(foreign.status))
    assert.equal((await one(`SELECT COUNT(*)::int n FROM nexus_inbound_events`)).n, n)
  })

  await t.test(PUSHES ? 'owner edits the passport and the viewing schedule in NEXUS → ARGUS receives exactly what the owner consented to share' : 'GAP: passport edits and viewing-schedule changes are saved in NEXUS but not pushed to ARGUS', async () => {
    const schedule = { duration: 30, notice: 24, buffer: 0, exceptions: [], weekly: [{ day: 1, kind: 'available', start: '09:00', end: '13:00' }] }
    const count = async table => (await one(`SELECT COUNT(*)::int n FROM ${table}`)).n
    if (!PUSHES) {
      assert.equal((await act('passport', { fields: { bedrooms: 3, description: 'Bright corner flat' } })).status, 200)
      assert.equal((await act('schedule', { schedule })).status, 200)
      assert.deepEqual([await count('nexus_owner_property_updates'), await count('nexus_owner_viewing_schedules')], [0, 0])
      return
    }
    // The owner has shared listing data but not the viewing schedule: the schedule stays in NEXUS.
    const kept = await act('schedule', { schedule })
    assert.equal(kept.status, 200, JSON.stringify(kept.json))
    assert.equal(await count('nexus_owner_viewing_schedules'), 0)
    // The passport edit is pushed, limited to shareable facts: the private description never leaves NEXUS.
    const edit = await act('passport', { fields: { bedrooms: 3, description: 'Bright corner flat, private note' } })
    assert.equal(edit.status, 200, JSON.stringify(edit.json))
    const { rows: [u] } = await H.db.query(`SELECT version, fields, review_state FROM nexus_owner_property_updates WHERE property_id=$1`, [p.id])
    assert.ok(u, 'ARGUS stored the owner update')
    assert.equal(u.fields.bedrooms, 3); assert.equal(u.review_state, 'pending')
    assert.equal(u.fields.description, undefined)
    assert.doesNotMatch(JSON.stringify(u.fields), /private note/)
    // Stored for review: the ARGUS listing itself is not overwritten.
    assert.equal((await one(`SELECT bedrooms FROM properties WHERE id=$1`, [p.id])).bedrooms, 2)
    const shown = (await crm('GET', `/${o.id}`)).json.properties[0].ownerInput.passportUpdate
    assert.deepEqual([shown.version, shown.reviewState, shown.fields.bedrooms], [u.version, 'pending', 3])
    // After the owner also shares the viewing schedule, a schedule change reaches ARGUS.
    assert.equal((await act('distribution', { channel: 'origin_agency', action: 'grant', scopes: ['listing_data', 'availability', 'viewing_schedule'], commandId: crypto.randomUUID() })).status, 200)
    const sent = await act('schedule', { schedule: { ...schedule, duration: 60 } })
    assert.equal(sent.status, 200, JSON.stringify(sent.json))
    const { rows: [sc] } = await H.db.query(`SELECT version, schedule FROM nexus_owner_viewing_schedules WHERE property_id=$1`, [p.id])
    assert.equal(sc.schedule.duration, 60)
    assert.ok(sc.version > u.version)
    // No echo: storing the owner's input queued nothing back to NEXUS, and created no appointment.
    assert.equal((await one(`SELECT COUNT(*)::int n FROM nexus_sync_outbox WHERE state IN ('pending','failed')`)).n, 0)
    assert.equal((await one(`SELECT COUNT(*)::int n FROM property_viewings WHERE property_id=$1`, [p.id])).n, 0)
  })

  await t.test('owner revokes access → ARGUS stops sharing and NEXUS withdraws; an older update cannot bring the listing back', async () => {
    const { rows: [earlier] } = await H.db.query(`SELECT * FROM nexus_sync_outbox WHERE event_type='property.upserted' AND state='delivered' ORDER BY id DESC LIMIT 1`)
    const revoke = await act('distribution', { channel: 'origin_agency', action: 'revoke', commandId: crypto.randomUUID() })
    assert.equal(revoke.status, 200, JSON.stringify(revoke.json))
    assert.deepEqual(await grants(), [])
    assert.deepEqual(revoke.json.argusGrants, [])
    const st = (await crm('GET', `/${o.id}`)).json.properties[0]
    assert.deepEqual([st.statuses.distribution, st.eligible, st.blockedReasons], ['withdrawn', false, ['NO_DISTRIBUTION_AUTHORIZATION']])
    assert.equal((await one(`SELECT COUNT(*)::int n FROM nexus_sync_outbox WHERE event_type='property.withdrawn' AND state='pending'`)).n, 1)
    const out = await S.deliverDue()
    assert.deepEqual([out.delivered, out.failed], [1, 0])
    assert.equal((await nexusSql(`SELECT withdrawn FROM nexus_private.housing_argus_listings`))[0].withdrawn, true)
    assert.equal((await crm('GET', `/${o.id}`)).json.properties[0].statuses.publication, 'withdrawn')
    // Nothing more can be sent for this listing …
    const again = await crm('POST', `/${o.id}/sync-properties`, {})
    assert.equal(again.json.properties[0].queued, false)
    // … and replaying the earlier, validly signed update does not revive it.
    const replay = { eventId: `xpush-replay-${Date.now()}`, eventType: 'property.upserted', contractVersion: earlier.contract_version, agencyKey: earlier.agency_key, occurredAt: new Date(earlier.created_at).toISOString(), data: earlier.payload }
    await nx('POST', RECEIVER + '/events', { body: replay, headers: asArgus(replay) })
    assert.equal((await nexusSql(`SELECT withdrawn FROM nexus_private.housing_argus_listings`))[0].withdrawn, true)
  })

  await t.test('existing ARGUS data is untouched by the whole run', async () => {
    const row = await one(`SELECT longlet_price::int rent, bedrooms, street FROM properties WHERE id=$1`, [p.id])
    // rent was changed by the test itself (staff edit); the owner's NEXUS edit of bedrooms did not overwrite inventory
    assert.deepEqual(row, { rent: 1700, bedrooms: 2, street: '12 Secret Street' })
    assert.equal((await one(`SELECT COUNT(*)::int n FROM swipe_links`)).n, 0)
  })
})
