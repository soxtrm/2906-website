'use strict'
// HTTP tests: the real routers on Express with real JWTs and real signatures
// (Claude, 2026-11-11). Proves who may call what — and that the private owner
// surface is closed without a session or a valid service signature.
const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')
const jwt = require('jsonwebtoken')

process.env.JWT_SECRET = 'test-jwt-secret-not-production'
delete process.env.NEXUS_OWNER_LINK_URL
delete process.env.NEXUS_LINK_INBOUND_SECRET
const H = require('./helpers/harness')
const S = H.load('services/nexusOwnerLink')
const C = H.load('services/nexusLinkCrypto')

const INBOUND = 'inbound-secret-0123456789abcdef0123456789'
let server, base, admin, plain, entitled, board
const token = (a, aud = 'crm') => jwt.sign({ id: a.id, role: a.role, aud }, process.env.JWT_SECRET, { expiresIn: '5m' })
async function call(method, path, { as, body, headers = {} } = {}) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(as ? { authorization: `Bearer ${as}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => null) }
}
function signedHeaders(path, body, { secret = INBOUND, key = 'nexus', timestamp = Math.floor(Date.now() / 1000) } = {}) {
  return { 'X-Nexus-Link-Key': key, 'X-Nexus-Link-Timestamp': String(timestamp), 'X-Nexus-Link-Signature': C.sign(secret, { timestamp, method: 'POST', path, body }) }
}

test.before(async () => {
  await H.migrate(); await H.reset()
  admin = await H.agent('admin'); plain = await H.agent('agent'); entitled = await H.agent('agent', { nexus_owner_link: true }); board = await H.agent('board')
  const app = express()
  app.use(express.json({ limit: '10mb' }))
  // Same order as index.js: specific mounts before the /api/crm catch-all.
  app.use('/api/crm/owner-nexus', H.load('routes/crmOwnerNexus'))
  app.use('/api/nexus-link/v1', H.load('routes/nexusLinkService'))
  app.use('/api/crm', (req, res) => res.status(418).json({ error: 'fell through to the catch-all' }))
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r) })
  base = `http://127.0.0.1:${server.address().port}`
})
test.after(async () => { await new Promise(r => server.close(r)); await H.reset() })
test.beforeEach(() => { delete process.env.NEXUS_LINK_INBOUND_SECRET })

test('staff controls: 401 without a session, 403 for board and non-entitled agents, 200 for admin and entitled agents', async () => {
  const o = await H.owner(); await H.property(o.id)
  assert.equal((await call('GET', `/api/crm/owner-nexus/${o.id}`)).status, 401)
  assert.equal((await call('GET', `/api/crm/owner-nexus/${o.id}`, { as: 'garbage' })).status, 401)
  assert.equal((await call('GET', `/api/crm/owner-nexus/${o.id}`, { as: token(board, 'board') })).status, 403)
  assert.equal((await call('POST', `/api/crm/owner-nexus/${o.id}/invitation`, { as: token(plain), body: {} })).status, 403)
  // A stale JWT that still says "admin" does not help once the live row says otherwise.
  const stale = jwt.sign({ id: plain.id, role: 'admin', aud: 'crm' }, process.env.JWT_SECRET, { expiresIn: '5m' })
  assert.equal((await call('POST', `/api/crm/owner-nexus/${o.id}/invitation`, { as: stale, body: {} })).status, 403)
  await H.db.query(`UPDATE agents SET active=false WHERE id=$1`, [board.id])
  assert.equal((await call('GET', `/api/crm/owner-nexus/${o.id}`, { as: token(board) })).status, 401)
  assert.equal(await H.db.query(`SELECT COUNT(*)::int n FROM nexus_owner_invitations`).then(r => r.rows[0].n), 0)

  const st = await call('GET', `/api/crm/owner-nexus/${o.id}`, { as: token(entitled) })
  assert.equal(st.status, 200); assert.equal(st.json.link.state, 'not_invited'); assert.equal(st.json.receiver.configured, false)
  const inv = await call('POST', `/api/crm/owner-nexus/${o.id}/invitation`, { as: token(admin), body: {} })
  assert.equal(inv.status, 200); assert.match(inv.json.invitation.url, /#t=/)
  const copy = await call('POST', `/api/crm/owner-nexus/${o.id}/invitation/copy`, { as: token(entitled), body: {} })
  assert.equal(copy.json.invitation.url, inv.json.invitation.url)
  // status never carries the invitation URL or token
  const after = await call('GET', `/api/crm/owner-nexus/${o.id}`, { as: token(admin) })
  assert.equal(after.json.invitation.state, 'active'); assert.equal(after.json.invitation.url, undefined)
  assert.ok(!JSON.stringify(after.json).includes(inv.json.invitation.url.split('#t=')[1]))
})

test('staff controls: clear errors, no fall-through to the catch-all', async () => {
  const o = await H.owner(); await H.property(o.id)
  const t = token(admin)
  assert.deepEqual(await call('GET', '/api/crm/owner-nexus/abc', { as: t }), { status: 400, json: { error: 'Invalid owner id', code: 'INVALID_ID' } })
  assert.equal((await call('GET', '/api/crm/owner-nexus/999999999', { as: t })).json.code, 'OWNER_NOT_FOUND')
  assert.equal((await call('POST', `/api/crm/owner-nexus/${o.id}/invitation/copy`, { as: t, body: {} })).json.code, 'NO_ACTIVE_INVITATION')
  assert.equal((await call('POST', `/api/crm/owner-nexus/${o.id}/verify`, { as: t, body: { method: 'call' } })).json.code, 'NOT_CLAIMED')
  const sync = await call('POST', `/api/crm/owner-nexus/${o.id}/sync-properties`, { as: t, body: {} })
  assert.equal(sync.status, 200); assert.equal(sync.json.properties[0].queued, false)
  assert.equal((await call('POST', `/api/crm/owner-nexus/${o.id}/retry`, { as: t, body: {} })).json.retried, 0)
  assert.equal((await call('POST', `/api/crm/owner-nexus/${o.id}/availability-answer`, { as: t, body: { propertyId: 1, outcome: 'available' } })).json.code, 'PROPERTY_NOT_FOUND')
})

test('service surface is closed: 503 while unconfigured, 401 for missing, wrong, stale or tampered signatures', async () => {
  const o = await H.owner(); await H.property(o.id)
  const { invitation } = await S.createInvitation(o.id, admin)
  const body = { token: invitation.url.split('#t=')[1] }
  const path = '/invitations/resolve', url = `/api/nexus-link/v1${path}`
  // not configured → nothing answers, not even to a CRM admin session
  assert.equal((await call('POST', url, { body })).status, 503)
  assert.equal((await call('POST', url, { body, as: token(admin) })).status, 503)
  process.env.NEXUS_LINK_INBOUND_SECRET = INBOUND
  assert.equal((await call('POST', url, { body })).status, 401)
  assert.equal((await call('POST', url, { body, as: token(admin) })).status, 401) // a staff session is not a service signature
  assert.equal((await call('POST', url, { body, headers: signedHeaders(path, body, { secret: 'wrong-secret-0123456789abcdef0123456789' }) })).status, 401)
  assert.equal((await call('POST', url, { body, headers: signedHeaders(path, body, { key: 'someone-else' }) })).status, 401)
  assert.equal((await call('POST', url, { body, headers: signedHeaders(path, body, { timestamp: Math.floor(Date.now() / 1000) - 3600 }) })).json.message, 'TIMESTAMP_OUT_OF_RANGE')
  // signature made for another body or another path does not carry over
  assert.equal((await call('POST', url, { body, headers: signedHeaders(path, { token: 'other' }) })).status, 401)
  assert.equal((await call('POST', url, { body, headers: signedHeaders('/events', body) })).status, 401)

  const ok = await call('POST', url, { body, headers: signedHeaders(path, body) })
  assert.equal(ok.status, 200); assert.equal(ok.json.contractVersion, S.CONTRACT_VERSION); assert.equal(ok.json.properties.length, 1)
  const bad = { token: 'zz.nope' }
  assert.deepEqual(await call('POST', url, { body: bad, headers: signedHeaders(path, bad) }), { status: 404, json: { error: 'INVITATION_INVALID', message: 'Invitation not valid' } })
})

test('signed events drive claim → staff verification → grant → status, end to end over HTTP', async () => {
  process.env.NEXUS_LINK_INBOUND_SECRET = INBOUND
  const o = await H.owner(); const p = await H.property(o.id)
  const t = token(admin)
  const inv = await call('POST', `/api/crm/owner-nexus/${o.id}/invitation`, { as: t, body: {} })
  const send = (eventType, data, eventId) => { const body = { eventId, eventType, contractVersion: S.CONTRACT_VERSION, agencyKey: '2906', occurredAt: new Date().toISOString(), data }; return call('POST', '/api/nexus-link/v1/events', { body, headers: signedHeaders('/events', body) }) }
  const ext = `2906:${p.ref}`
  const claim = await send('owner.claim_submitted', { token: inv.json.invitation.url.split('#t=')[1], nexusAccountRef: 'nxo_http_owner', decisions: [{ externalId: ext, decision: 'confirm' }] }, 'evt-http-claim-0001')
  assert.equal(claim.status, 200); assert.equal(claim.json.result.linkState, 'claim_pending')
  assert.equal((await send('owner.claim_submitted', { token: inv.json.invitation.url.split('#t=')[1], nexusAccountRef: 'nxo_http_owner', decisions: [{ externalId: ext, decision: 'confirm' }] }, 'evt-http-claim-0001')).json.duplicate, true)
  const linkId = (await call('GET', `/api/crm/owner-nexus/${o.id}`, { as: t })).json.link.id
  // not verified yet → the grant is refused with a contract error code
  const early = await send('distribution.granted', { linkId, externalId: ext, channel: 'origin_agency', scopes: ['listing_data'] }, 'evt-http-grant-0001')
  assert.deepEqual([early.status, early.json.error], [409, 'OWNER_LINK_NOT_VERIFIED'])
  assert.equal((await call('POST', `/api/crm/owner-nexus/${o.id}/verify`, { as: t, body: { method: 'ID checked in office' } })).json.linkState, 'verified')
  assert.equal((await send('distribution.granted', { linkId, externalId: ext, channel: 'origin_agency', scopes: ['listing_data'] }, 'evt-http-grant-0002')).status, 200)
  const sync = await call('POST', `/api/crm/owner-nexus/${o.id}/sync-properties`, { as: t, body: {} })
  assert.equal(sync.json.properties[0].queued, true); assert.equal(sync.json.delivery.receiverConfigured, false)
  const st = (await call('GET', `/api/crm/owner-nexus/${o.id}`, { as: t })).json
  assert.equal(st.link.state, 'verified'); assert.equal(st.properties[0].statuses.sync, 'pending'); assert.equal(st.queue.waiting, 1)
  assert.equal(st.properties[0].eligible, true)
})
