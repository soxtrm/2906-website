'use strict'
// Owner portal: access control, identity separation and the viewing flow over
// real HTTP against a local Postgres (Claude, 2026-11-16).
const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')
const T = require('./helpers/db')
const routes = require('../routes/ownerPortalRoutes')

let base, server
const INTERNAL = /INTERNAL-|Secret Street|\+35699/

async function call(method, path, { token, body, agent, raw, headers = {} } = {}) {
  const h = { ...headers }
  if (token) h.authorization = `Bearer ${token}`
  if (agent) h['x-test-agent'] = String(agent)
  if (body !== undefined && !raw) h['content-type'] = 'application/json'
  const r = await fetch(base + path, { method, headers: h, body: raw || (body !== undefined ? JSON.stringify(body) : undefined) })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: r.status, json, text }
}

// Malta-local 'YYYY-MM-DD' n days from today.
const dayPlus = n => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Malta' }).format(new Date(Date.now() + n * 86400000))
const S = require('../services/ownerSchedule')
const at = (n, hhmm) => new Date(S.zonedToEpoch(dayPlus(n), hhmm)).toISOString()
const allWeek = (extra = {}) => ({ weekly: [0, 1, 2, 3, 4, 5, 6].map(day => ({ day, start: '08:00', end: '20:00' })), breaks: [], exceptions: [], blocked: [], durationMin: 30, bufferMin: 15, noticeHours: 0, horizonDays: 14, approval: 'manual', ...extra })

let admin, plainAgent, entitled, ownerA, ownerB, dncOwner, pA1, pA2, pB1
test.before(async () => {
  await T.setup()
  admin = await T.agent('admin')
  plainAgent = await T.agent('agent')
  entitled = await T.agent('agent', { owner_portal: true })
  ownerA = await T.owner(); ownerB = await T.owner(); dncOwner = await T.owner({ do_not_contact: true })
  pA1 = await T.property(ownerA.id); pA2 = await T.property(ownerA.id, { town: 'Gzira' }); pB1 = await T.property(ownerB.id)
  await T.property(dncOwner.id)
  const app = express()
  const staffAuth = (req, res, next) => { const id = Number(req.headers['x-test-agent']); if (!id) return res.status(401).json({ error: 'Unauthorized' }); req.agent = { id }; next() }
  const r = routes({ db: T.pool, staffAuth, portalUrl: 'https://test.local/owner', shareUrl: 'https://test.local/property-link' })
  app.use('/api/owner-portal', r.owner); app.use('/api/owner-share', r.share); app.use('/api/crm/owner-portal', r.staff)
  global.__portal = r.portal
  await new Promise(res => { server = app.listen(0, '127.0.0.1', res) })
  base = `http://127.0.0.1:${server.address().port}`
})
test.after(async () => { server && server.close(); await T.pool.end() })

const tokenFrom = url => url.split('#t=')[1]
let sessA, sessB

test('staff: only admins or entitled agents; identity method required; do-not-contact refused; nothing is sent', async () => {
  assert.equal((await call('POST', `/api/crm/owner-portal/${ownerA.id}/invitation`, { body: { identityMethod: 'Known number, phone call' } })).status, 401)
  assert.equal((await call('POST', `/api/crm/owner-portal/${ownerA.id}/invitation`, { agent: plainAgent.id, body: { identityMethod: 'Known number' } })).status, 403)
  assert.equal((await call('POST', `/api/crm/owner-portal/${ownerA.id}/invitation`, { agent: admin.id, body: {} })).json.code, 'FIELD_REQUIRED')
  assert.equal((await call('POST', `/api/crm/owner-portal/${dncOwner.id}/invitation`, { agent: admin.id, body: { identityMethod: 'In person' } })).json.code, 'OWNER_DO_NOT_CONTACT')
  const inv = await call('POST', `/api/crm/owner-portal/${ownerA.id}/invitation`, { agent: entitled.id, body: { identityMethod: 'Called from the number on file' } })
  assert.equal(inv.status, 200)
  assert.match(inv.json.url, /^https:\/\/test\.local\/owner#t=inv_/) // token in the fragment, never sent to a server log
  const { rows } = await T.pool.query(`SELECT token_hash FROM owner_portal_invitations`)
  assert.ok(rows.every(r => /^[0-9a-f]{64}$/.test(r.token_hash) && !inv.json.token.includes(r.token_hash)))
  const ov = await call('GET', `/api/crm/owner-portal/${ownerA.id}`, { agent: admin.id })
  assert.equal(ov.json.invitation.state, 'open'); assert.equal(ov.json.account.state, 'invited')
  assert.doesNotMatch(ov.text, /inv_/)
  // ownerA's link is claimed here; B gets one too.
  sessA = (await call('POST', '/api/owner-portal/session/claim', { body: { token: tokenFrom(inv.json.url) } })).json.sessionToken
  const invB = await call('POST', `/api/crm/owner-portal/${ownerB.id}/invitation`, { agent: admin.id, body: { identityMethod: 'In person at the office' } })
  sessB = (await call('POST', '/api/owner-portal/session/claim', { body: { token: tokenFrom(invB.json.url) } })).json.sessionToken
  assert.match(sessA, /^ses_/); assert.match(sessB, /^ses_/)
  // Second use of the same invitation fails like an unknown one.
  const again = await call('POST', '/api/owner-portal/session/claim', { body: { token: tokenFrom(inv.json.url) } })
  assert.equal(again.status, 404); assert.equal(again.json.code, 'INVITATION_INVALID')
})

test('invitation lifecycle: replaced and revoked links stop working, expired ones too', async () => {
  const o = await T.owner(); await T.property(o.id)
  const first = await call('POST', `/api/crm/owner-portal/${o.id}/invitation`, { agent: admin.id, body: { identityMethod: 'Phone call' } })
  const second = await call('POST', `/api/crm/owner-portal/${o.id}/invitation`, { agent: admin.id, body: { identityMethod: 'Phone call' } })
  assert.equal((await call('POST', '/api/owner-portal/session/claim', { body: { token: tokenFrom(first.json.url) } })).status, 404)
  await call('POST', `/api/crm/owner-portal/${o.id}/invitation/revoke`, { agent: admin.id })
  assert.equal((await call('POST', '/api/owner-portal/session/claim', { body: { token: tokenFrom(second.json.url) } })).status, 404)
  const third = await call('POST', `/api/crm/owner-portal/${o.id}/invitation`, { agent: admin.id, body: { identityMethod: 'Phone call' } })
  await T.pool.query(`UPDATE owner_portal_invitations SET expires_at = NOW() - INTERVAL '1 minute' WHERE consumed_at IS NULL AND revoked_at IS NULL`)
  assert.equal((await call('POST', '/api/owner-portal/session/claim', { body: { token: tokenFrom(third.json.url) } })).status, 404)
  assert.equal((await call('POST', '/api/owner-portal/session/claim', { body: { token: 'inv_garbage' } })).status, 404)
})

test('identity separation: owner sees own properties only, never internal CRM data', async () => {
  const me = await call('GET', '/api/owner-portal/me', { token: sessA })
  assert.equal(me.status, 200)
  assert.deepEqual(me.json.properties.map(p => p.id).sort(), [pA1.id, pA2.id].sort())
  assert.doesNotMatch(me.text, /INTERNAL-|\+35699/)
  const detail = await call('GET', `/api/owner-portal/properties/${pA1.id}`, { token: sessA })
  assert.equal(detail.status, 200)
  assert.doesNotMatch(detail.text, /INTERNAL-/) // street is the owner's own address and allowed here
  assert.equal(detail.json.property.commission_note, undefined)
  // Another owner's property, a staging id, nonsense ids: all 404.
  for (const id of [pB1.id, 999999, 'abc', -1]) assert.equal((await call('GET', `/api/owner-portal/properties/${id}`, { token: sessA })).status, 404)
  assert.equal((await call('GET', '/api/owner-portal/me')).status, 401)
})

test('tokens are not interchangeable: share, request and invitation tokens are not sessions', async () => {
  const link = await call('POST', '/api/owner-portal/share-links', { token: sessA, body: { propertyIds: [pA1.id], label: 'Agents' } })
  assert.equal(link.status, 200)
  const shr = link.json.token
  assert.equal((await call('GET', '/api/owner-portal/me', { token: shr })).status, 401)
  assert.equal((await call('GET', '/api/owner-portal/me', { token: 'inv_' + 'a'.repeat(43) })).status, 401)
  // Owner B cannot attach A's property to a share link.
  assert.equal((await call('POST', '/api/owner-portal/share-links', { token: sessB, body: { propertyIds: [pA1.id] } })).status, 400)
  // Owner B cannot revoke A's link.
  assert.equal((await call('DELETE', `/api/owner-portal/share-links/${link.json.id}`, { token: sessB })).status, 404)
})

test('availability rules materialise into the ONE calendar (property_viewing_windows)', async () => {
  const bad = await call('PUT', `/api/owner-portal/properties/${pA1.id}/rules`, { token: sessA, body: { schedule: { ...allWeek(), durationMin: 7 } } })
  assert.equal(bad.status, 400)
  const ok = await call('PUT', `/api/owner-portal/properties/${pA1.id}/rules`, { token: sessA, body: { schedule: allWeek() } })
  assert.equal(ok.status, 200)
  const { rows } = await T.pool.query(`SELECT COUNT(*)::int AS n FROM property_viewing_windows WHERE property_id=$1 AND source_type='owner_portal' AND confirmation='full_window'`, [pA1.id])
  assert.ok(rows[0].n >= 13)
  assert.equal((await call('PUT', `/api/owner-portal/properties/${pB1.id}/rules`, { token: sessA, body: { schedule: allWeek() } })).status, 404)
  // Saving again replaces, never duplicates.
  await call('PUT', `/api/owner-portal/properties/${pA1.id}/rules`, { token: sessA, body: { schedule: allWeek() } })
  const { rows: again } = await T.pool.query(`SELECT COUNT(*)::int AS n FROM property_viewing_windows WHERE property_id=$1 AND source_type='owner_portal'`, [pA1.id])
  assert.equal(again[0].n, rows[0].n)
})

let shareToken, reqA, reqA2
test('agent share page: allow-listed, free slots only, no owner identity or contact', async () => {
  const link = await call('POST', '/api/owner-portal/share-links', { token: sessA, body: { propertyIds: [pA1.id, pA2.id], label: 'For agents' } })
  shareToken = link.json.token
  const view = await call('GET', `/api/owner-share/${shareToken}`)
  assert.equal(view.status, 200)
  assert.doesNotMatch(view.text, INTERNAL)
  assert.doesNotMatch(view.text, new RegExp(ownerA.name))
  const p = view.json.properties.find(x => x.id === pA1.id)
  assert.equal(p.street, undefined); assert.equal(p.owner_id, undefined)
  assert.ok(p.viewing.slots.length > 10)
  assert.ok(view.json.properties.find(x => x.id === pA2.id).viewing === null) // no rules yet
})

test('two-stage confirmation: request → owner proposes → agent checks → confirmed', async () => {
  const slot = at(2, '10:00')
  const r = await call('POST', `/api/owner-share/${shareToken}/requests`, { body: {
    propertyId: pA1.id, agent: { name: 'Cedric', agency: 'Partner Homes' },
    client: { people: 2, groupType: 'couple', moveIn: dayPlus(30), pets: 'one small dog', clientRef: 'IT-couple' }, preferred: [{ start: slot }] } })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.json.request.state, 'REQUESTED')
  assert.equal(r.json.request.client, undefined) // agents never get client blocks back
  reqA = r.json.requestToken
  const dup = await call('POST', `/api/owner-share/${shareToken}/requests`, { body: { propertyId: pA1.id, agent: { name: 'cedric', agency: 'Partner Homes' }, client: { clientRef: 'IT-couple' } } })
  assert.equal(dup.json.code, 'DUPLICATE_REQUEST')
  // Agent cannot confirm before the owner proposed.
  assert.equal((await call('POST', `/api/owner-share/request/${reqA}/confirm`)).json.code, 'INVALID_STATE')

  const desk = await call('GET', '/api/owner-portal/desk?days=7', { token: sessA })
  const item = desk.json.requests.find(x => x.agent.name === 'Cedric')
  assert.equal(item.client.pets, 'one small dog') // the owner sees the requirements
  assert.equal((await call('GET', '/api/owner-portal/desk', { token: sessB })).json.requests.length, 0) // B sees nothing of A
  assert.equal((await call('POST', `/api/owner-portal/requests/${item.id}/propose`, { token: sessB, body: { start: slot } })).status, 404)

  const outside = await call('POST', `/api/owner-portal/requests/${item.id}/propose`, { token: sessA, body: { start: at(2, '21:00') } })
  assert.equal(outside.json.code, 'OUTSIDE_AVAILABILITY'); assert.equal(outside.json.overridable, true)
  const prop = await call('POST', `/api/owner-portal/requests/${item.id}/propose`, { token: sessA, body: { start: slot } })
  assert.equal(prop.status, 200, prop.text)
  assert.equal(prop.json.request.state, 'OWNER_SLOT_PROPOSED')
  assert.match(prop.json.agentMessage, /^Viewing slot proposed for #OPT-\d+ on .+ at 10:00 AM\. Please confirm availability with your client and reconfirm in ARGUS\.$/)
  let { rows: [v] } = await T.pool.query(`SELECT status, source FROM property_viewings WHERE id=(SELECT viewing_id FROM viewing_coordination WHERE id=$1)`, [item.id])
  assert.deepEqual(v, { status: 'pending', source: 'owner_portal' }) // held, NOT confirmed

  const st = await call('GET', `/api/owner-share/request/${reqA}`)
  assert.equal(st.json.request.state, 'OWNER_SLOT_PROPOSED')
  assert.ok(st.json.history.some(h => /reconfirm in ARGUS/.test(h.message || '')))
  assert.doesNotMatch(st.text, INTERNAL)
  assert.equal((await call('POST', `/api/owner-share/request/${reqA}/checking`)).json.request.state, 'AGENT_CLIENT_CONFIRMATION_PENDING')
  assert.equal((await call('POST', `/api/owner-share/request/${reqA}/confirm`)).json.request.state, 'CONFIRMED');
  ({ rows: [v] } = await T.pool.query(`SELECT status FROM property_viewings WHERE id=(SELECT viewing_id FROM viewing_coordination WHERE id=$1)`, [item.id]))
  assert.equal(v.status, 'confirmed')
})

test('no double booking across agencies; buffers need explicit permission', async () => {
  const slot = at(2, '10:00')
  const r = await call('POST', `/api/owner-share/${shareToken}/requests`, { body: { propertyId: pA1.id, agent: { name: 'Maria', agency: 'Other Agency' }, client: { people: 1, notes: 'PRIVATE-CLIENT-NOTE' }, preferred: [{ start: slot }] } })
  reqA2 = r.json.requestToken
  const id = (await call('GET', '/api/owner-portal/desk', { token: sessA })).json.requests.find(x => x.agent.name === 'Maria').id
  assert.equal((await call('POST', `/api/owner-portal/requests/${id}/propose`, { token: sessA, body: { start: slot } })).json.code, 'SLOT_CONFLICT')
  const buf = await call('POST', `/api/owner-portal/requests/${id}/propose`, { token: sessA, body: { start: at(2, '10:40') } }) // 10 min after the 10:30 end, buffer 15
  assert.equal(buf.json.code, 'BUFFER_CONFLICT')
  assert.equal((await call('POST', `/api/owner-portal/requests/${id}/propose`, { token: sessA, body: { start: at(2, '10:40'), allowBufferOverlap: true } })).json.request.state, 'OWNER_SLOT_PROPOSED')
  // Cedric's request page never shows Maria's client.
  assert.doesNotMatch((await call('GET', `/api/owner-share/request/${reqA}`)).text, /PRIVATE-CLIENT-NOTE|Maria|Other Agency/)
  // The public share view shows the held time as gone, without names.
  const view = await call('GET', `/api/owner-share/${shareToken}`)
  assert.ok(!view.json.properties.find(x => x.id === pA1.id).viewing.slots.some(s => s.start === slot))
  assert.doesNotMatch(view.text, /Maria|Cedric/)
})

test('agent asks for another time → slot released; expiry releases unconfirmed proposals', async () => {
  const other = await call('POST', `/api/owner-share/request/${reqA2}/other_time`, { body: { preferred: [{ start: at(3, '11:00') }] } })
  assert.equal(other.json.request.state, 'RESCHEDULE_REQUESTED')
  const { rows } = await T.pool.query(`SELECT v.status FROM viewing_coordination c JOIN property_viewings v ON v.id=c.viewing_id WHERE c.requester_name='Maria'`)
  assert.equal(rows[0].status, 'cancelled')
  const id = (await call('GET', '/api/owner-portal/desk', { token: sessA })).json.requests.find(x => x.agent.name === 'Maria').id
  await call('POST', `/api/owner-portal/requests/${id}/propose`, { token: sessA, body: { start: at(3, '11:00') } })
  await T.pool.query(`UPDATE viewing_coordination SET expires_at = NOW() - INTERVAL '1 minute' WHERE id=$1`, [id])
  assert.equal((await global.__portal.expireDue()).expired, 1)
  assert.equal((await call('GET', `/api/owner-share/request/${reqA2}`)).json.request.state, 'EXPIRED')
  assert.equal((await call('POST', `/api/owner-share/request/${reqA2}/confirm`)).status, 409)
})

test('auto-approval proposes inside the rules but never confirms on its own', async () => {
  await call('PUT', `/api/owner-portal/properties/${pA2.id}/rules`, { token: sessA, body: { schedule: allWeek({ approval: 'auto' }) } })
  const r = await call('POST', `/api/owner-share/${shareToken}/requests`, { body: { propertyId: pA2.id, agent: { name: 'Leo', agency: 'Agency C' }, preferred: [{ start: at(4, '07:00') }, { start: at(4, '09:00') }] } })
  assert.equal(r.json.request.state, 'OWNER_SLOT_PROPOSED') // 07:00 is outside, 09:00 fits
  assert.equal(new Date(r.json.request.proposedStart).toISOString(), at(4, '09:00'))
  assert.match(r.json.agentMessage, /reconfirm in ARGUS/)
})

test('owner edits go to review; agent-owned terms are not editable; listing untouched', async () => {
  const bad = await call('POST', `/api/owner-portal/properties/${pA1.id}/proposals`, { token: sessA, body: { fields: { commission_note: '0%' } } })
  assert.equal(bad.json.code, 'FIELD_NOT_EDITABLE')
  assert.equal((await call('POST', `/api/owner-portal/properties/${pA1.id}/proposals`, { token: sessA, body: { fields: { longlet_price: 1 } } })).json.code, 'FIELD_NOT_EDITABLE')
  const ok = await call('POST', `/api/owner-portal/properties/${pA1.id}/proposals`, { token: sessA, body: { fields: { asking_rent: 1650, available_status: 'on_hold', conditions: { pets: 'Only small dogs' } } } })
  assert.equal(ok.json.review_state, 'pending')
  const { rows: [p] } = await T.pool.query(`SELECT longlet_price, available_status FROM properties WHERE id=$1`, [pA1.id])
  assert.equal(Number(p.longlet_price), 1500); assert.equal(p.available_status, 'available')
  const list = await call('GET', '/api/crm/owner-portal/review/proposals', { agent: admin.id })
  const pr = list.json.find(x => x.property_id === pA1.id)
  assert.equal((await call('POST', `/api/crm/owner-portal/review/proposals/${pr.id}`, { agent: plainAgent.id, body: { decision: 'accepted' } })).status, 403)
  assert.equal((await call('POST', `/api/crm/owner-portal/review/proposals/${pr.id}`, { agent: admin.id, body: { decision: 'accepted' } })).json.reviewState, 'accepted')
})

test('photos and documents stay private to the owner and ARGUS', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5b00000000049454e44ae426082', 'hex')
  const up = await call('POST', `/api/owner-portal/properties/${pA1.id}/media`, { token: sessA, raw: png, headers: { 'content-type': 'image/png', 'x-media-kind': 'photo', 'x-filename': 'kitchen.png' } })
  assert.equal(up.status, 200, up.text)
  const mine = await fetch(`${base}/api/owner-portal/media/${up.json.id}`, { headers: { authorization: `Bearer ${sessA}` } })
  assert.equal(mine.status, 200); assert.equal(Buffer.from(await mine.arrayBuffer()).length, png.length)
  assert.equal((await call('GET', `/api/owner-portal/media/${up.json.id}`, { token: sessB })).status, 404)
  assert.equal((await call('POST', `/api/owner-portal/properties/${pA1.id}/media`, { token: sessA, raw: Buffer.from('x'), headers: { 'content-type': 'text/html', 'x-media-kind': 'photo', 'x-filename': 'a.html' } })).json.code, 'FILE_TYPE')
})

test('property manager: only delegated properties and scopes; owner-only controls refused; revocation is immediate', async () => {
  const d = await call('POST', '/api/owner-portal/delegates', { token: sessA, body: { name: 'Anna (manager)', propertyIds: [pA2.id, pB1.id], scopes: ['schedule', 'requests'] } })
  assert.equal(d.status, 200)
  assert.deepEqual(d.json.delegate.property_ids, [pA2.id]) // B's property silently dropped
  const sessD = (await call('POST', '/api/owner-portal/session/claim', { body: { token: tokenFrom(d.json.url) } })).json.sessionToken
  const me = await call('GET', '/api/owner-portal/me', { token: sessD })
  assert.deepEqual(me.json.properties.map(p => p.id), [pA2.id]); assert.equal(me.json.role, 'property_manager')
  assert.equal((await call('GET', `/api/owner-portal/properties/${pA1.id}`, { token: sessD })).status, 404)
  assert.equal((await call('PUT', `/api/owner-portal/properties/${pA2.id}/rules`, { token: sessD, body: { schedule: allWeek() } })).status, 200)
  assert.equal((await call('POST', `/api/owner-portal/properties/${pA2.id}/proposals`, { token: sessD, body: { fields: { description: 'x' } } })).status, 404) // no inventory scope
  assert.equal((await call('POST', '/api/owner-portal/share-links', { token: sessD, body: { propertyIds: [pA2.id] } })).status, 404) // no sharing scope
  assert.equal((await call('GET', '/api/owner-portal/delegates', { token: sessD })).status, 403)
  assert.equal((await call('PUT', `/api/owner-portal/properties/${pA2.id}/distribution`, { token: sessD, body: { destination: 'partner_agencies', allowed: true } })).status, 403)
  const desk = await call('GET', '/api/owner-portal/desk', { token: sessD })
  assert.ok(desk.json.requests.every(r => r.propertyId === pA2.id))
  await call('DELETE', `/api/owner-portal/delegates/${d.json.delegate.id}`, { token: sessA })
  assert.equal((await call('GET', '/api/owner-portal/me', { token: sessD })).status, 401)
})

test('distribution: allowing never connects by itself; future destinations stay unavailable', async () => {
  const r = await call('PUT', `/api/owner-portal/properties/${pA1.id}/distribution`, { token: sessA, body: { destination: 'partner_agencies', allowed: true } })
  assert.equal(r.json.find(x => x.destination === 'partner_agencies').state, 'pending_approval')
  assert.equal(r.json.find(x => x.destination === 'nexus_marketplace').available, false)
  const pause = await call('PUT', `/api/owner-portal/properties/${pA1.id}/distribution`, { token: sessA, body: { destination: 'argus_agency', allowed: false } })
  assert.equal(pause.json.find(x => x.destination === 'argus_agency').state, 'paused')
})

test('legacy board bookings appear read-only in the desk and still block the time', async () => {
  const start = at(5, '12:00')
  await T.pool.query(`INSERT INTO property_viewings (property_id, starts_at, duration_min, status, source) VALUES ($1,$2,20,'pending','agent_book')`, [pA1.id, start])
  const desk = await call('GET', '/api/owner-portal/desk?days=7', { token: sessA })
  assert.ok(desk.json.external.some(e => e.managedBy === 'board_booking'))
  const r = await call('POST', `/api/owner-share/${shareToken}/requests`, { body: { propertyId: pA1.id, agent: { name: 'Zed', agency: 'Zed Lettings' } } })
  assert.equal(r.status, 200, r.text)
  const id = (await call('GET', '/api/owner-portal/desk', { token: sessA })).json.requests.find(x => x.agent.name === 'Zed').id
  assert.equal((await call('POST', `/api/owner-portal/requests/${id}/propose`, { token: sessA, body: { start } })).json.code, 'SLOT_CONFLICT')
  assert.ok(r.json.requestToken)
})

test('revoked share links and suspended accounts close every door', async () => {
  const links = await call('GET', '/api/owner-portal/share-links', { token: sessA })
  for (const l of links.json) await call('DELETE', `/api/owner-portal/share-links/${l.id}`, { token: sessA })
  assert.equal((await call('GET', `/api/owner-share/${shareToken}`)).status, 404)
  assert.equal((await call('POST', `/api/crm/owner-portal/${ownerB.id}/state`, { agent: admin.id, body: { state: 'suspended' } })).json.state, 'suspended')
  assert.equal((await call('GET', '/api/owner-portal/me', { token: sessB })).status, 401)
})

test('pilot pipeline is staff-only and validated; owner audit trail records changes', async () => {
  assert.equal((await call('PUT', `/api/crm/owner-portal/${ownerA.id}/pilot`, { agent: admin.id, body: { state: 'maybe' } })).status, 400)
  for (const s of ['interested', 'pilot_invited', 'onboarding', 'active_pilot', 'feedback_received']) {
    assert.equal((await call('PUT', `/api/crm/owner-portal/${ownerA.id}/pilot`, { agent: admin.id, body: { state: s, note: 'Founding owner pilot' } })).json.state, s)
  }
  assert.equal((await call('PUT', `/api/crm/owner-portal/${ownerA.id}/pilot`, { agent: plainAgent.id, body: { state: 'interested' } })).status, 403)
  const log = await call('GET', '/api/owner-portal/audit', { token: sessA })
  const actions = log.json.map(x => x.action)
  for (const a of ['signed_in', 'availability_updated', 'viewing_propose', 'change_proposed', 'share_link_created', 'delegate_invited', 'pilot_state']) assert.ok(actions.includes(a), a)
  assert.doesNotMatch(log.text, /identityMethod|Called from/) // staff detail stays internal
})
