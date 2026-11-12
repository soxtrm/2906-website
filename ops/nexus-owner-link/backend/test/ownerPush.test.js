'use strict'
// NEXUS pushes owner changes to ARGUS (Claude, 2026-11-12; decision Kev 2026-11-12).
// Every event below goes through the real signed HTTP surface, exactly as the
// NEXUS server sends it. Real Postgres; the NEXUS receiver for the opposite
// direction is a stub whose answers are chosen per test.
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const express = require('express')

process.env.JWT_SECRET = 'test-jwt-secret-not-production'
const INBOUND = 'inbound-secret-0123456789abcdef0123456789'
process.env.NEXUS_LINK_INBOUND_SECRET = INBOUND
const H = require('./helpers/harness')
const S = H.load('services/nexusOwnerLink')
const C = H.load('services/nexusLinkCrypto')
const R = H.load('services/nexusDistributionRouting')
const P = H.load('services/nexusPermissionMap')
const { db } = H

let server, base, admin
const headers = (path, body, secret = INBOUND) => { const timestamp = Math.floor(Date.now() / 1000); return { 'content-type': 'application/json', 'X-Nexus-Link-Key': 'nexus', 'X-Nexus-Link-Timestamp': String(timestamp), 'X-Nexus-Link-Signature': C.sign(secret, { timestamp, method: 'POST', path, body }) } }
async function post(path, body, { sign = true } = {}) {
  const res = await fetch(`${base}/api/nexus-link/v1${path}`, { method: 'POST', headers: sign ? headers(path, body) : { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => null) }
}
const minutesAgo = m => new Date(Date.now() - m * 60000).toISOString()
// One owner change, as NEXUS sends it.
const push = (eventType, data, { occurredAt = minutesAgo(0), eventId = `nx-${crypto.randomBytes(10).toString('hex')}` } = {}) =>
  post('/events', { contractVersion: S.CONTRACT_VERSION, agencyKey: '2906', eventId, eventType, occurredAt, data })
const n = async (table, where = 'TRUE', params = []) => (await db.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`, params)).rows[0].n
const rowHash = async id => (await db.query(`SELECT md5(row_to_json(t)::text) AS h FROM properties t WHERE id=$1`, [id])).rows[0].h

// invite → claim → (verify). Returns ids as NEXUS knows them.
async function owner({ verify = true, props = 1 } = {}) {
  const o = await H.owner()
  const list = []
  for (let i = 0; i < props; i++) list.push(await H.property(o.id, { listed_by_agent_id: admin.id }))
  const { invitation } = await S.createInvitation(o.id, admin)
  const token = invitation.url.split('#t=')[1]
  const r = await S.resolveInvitation(token)
  const account = `nxu_${crypto.randomBytes(16).toString('hex')}`
  const claim = await push('owner.claim_submitted', { token, nexusAccountRef: account, decisions: r.properties.map(p => ({ externalId: p.externalId, decision: 'confirm' })) })
  assert.equal(claim.status, 200); assert.equal(claim.json.applied, true)
  if (verify) await S.verifyOwner(o.id, admin, { method: 'test' })
  return { o, p: list[0], list, linkId: r.owner.linkId, ext: `2906:${list[0].ref}`, exts: list.map(p => `2906:${p.ref}`), account }
}
function nexusReceiver(answer) {
  process.env.NEXUS_OWNER_LINK_URL = 'https://nexus.invalid/api/nexus/housing/bridge/argus'
  process.env.NEXUS_LINK_OUTBOUND_SECRET = 'outbound-secret-0123456789abcdef0123456789'
  const seen = []
  S.setTransport(async (url, init) => { const body = JSON.parse(init.body); seen.push(body); const r = answer(body); return { status: r.status || 200, json: async () => r.json } })
  return seen
}
const applying = body => ({ json: { applied: true, properties: (body.data.confirmedExternalIds || []).map(x => ({ externalId: x, canonicalPropertyId: `uuid-${x}` })), canonicalPropertyId: `uuid-${body.data.externalId}`, publicationState: 'unpublished' } })
function noReceiver() { delete process.env.NEXUS_OWNER_LINK_URL; delete process.env.NEXUS_LINK_OUTBOUND_SECRET; delete process.env.NEXUS_LINK_ROUTING_EVENTS }

test.before(async () => {
  await H.migrate(); await H.reset(); admin = await H.agent('admin')
  const app = express()
  app.use(express.json({ limit: '10mb' }))
  app.use('/api/nexus-link/v1', H.load('routes/nexusLinkService'))
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r) })
  base = `http://127.0.0.1:${server.address().port}`
})
test.beforeEach(async () => { await H.reset(); noReceiver() })
test.after(async () => { await new Promise(r => server.close(r)); noReceiver(); await H.reset() })

test('owner edits the Property Passport → ARGUS persists it for review; the listing row and the outbox are untouched', async () => {
  const a = await owner()
  const before = await rowHash(a.p.id)
  const ok = await push('property.owner_updated', { linkId: a.linkId, externalId: a.ext, version: 3, fields: { rent: 1650, bedrooms: 3, amenities: ['lift', 'ac', 'ac'], description: ' Bright corner flat ' } })
  assert.equal(ok.status, 200, JSON.stringify(ok.json))
  assert.deepEqual([ok.json.applied, ok.json.result.version, ok.json.result.reviewState], [true, 3, 'pending'])
  const { rows: [u] } = await db.query(`SELECT * FROM nexus_owner_property_updates WHERE property_id=$1`, [a.p.id])
  assert.deepEqual(u.fields, { rent: 1650, bedrooms: 3, amenities: ['ac', 'lift'], description: 'Bright corner flat' })
  // The owner's statement is not the listing: existing inventory is never overwritten by an event …
  assert.equal(await rowHash(a.p.id), before)
  // … and applying it sends nothing back (no feedback loop).
  assert.equal(await n('nexus_sync_outbox'), 0)
  const st = (await S.status(a.o.id, admin)).properties[0].ownerInput
  assert.deepEqual([st.passportUpdate.version, st.passportUpdate.reviewState, st.passportUpdate.fields.rent], [3, 'pending', 1650])

  // Out of order: an older version delivered late is acknowledged, not applied.
  const late = await push('property.owner_updated', { linkId: a.linkId, externalId: a.ext, version: 2, fields: { rent: 1 } })
  assert.equal(late.status, 200)
  assert.deepEqual([late.json.applied, late.json.result.reason, late.json.result.currentVersion], [false, 'STALE_VERSION', 3])
  // A newer version supersedes the pending one.
  assert.equal((await push('property.owner_updated', { linkId: a.linkId, externalId: a.ext, version: 4, fields: { rent: 1700 } })).json.applied, true)
  assert.deepEqual((await db.query(`SELECT version, review_state FROM nexus_owner_property_updates WHERE property_id=$1 ORDER BY version`, [a.p.id])).rows, [{ version: 3, review_state: 'superseded' }, { version: 4, review_state: 'pending' }])
})

test('passport updates fail closed: unknown fields, bad values, unverified owners and foreign listings are refused and leave no trace', async () => {
  const a = await owner(); const other = await owner(); const unverified = await owner({ verify: false })
  const bad = [
    [{ linkId: a.linkId, externalId: a.ext, version: 1, fields: { owner_phone: '+35699' } }, 'FIELD_UNKNOWN'],
    [{ linkId: a.linkId, externalId: a.ext, version: 1, fields: { rent: '1500' } }, 'FIELD_INVALID'],
    [{ linkId: a.linkId, externalId: a.ext, version: 1, fields: { amenities: ['helipad'] } }, 'FIELD_INVALID'],
    [{ linkId: a.linkId, externalId: a.ext, version: 1, fields: {} }, 'FIELDS_INVALID'],
    [{ linkId: a.linkId, externalId: a.ext, fields: { rent: 1500 } }, 'VERSION_REQUIRED'],
    [{ linkId: a.linkId, externalId: other.ext, version: 1, fields: { rent: 1500 } }, 'PROPERTY_NOT_IN_LINK'],
    [{ linkId: unverified.linkId, externalId: unverified.ext, version: 1, fields: { rent: 1500 } }, 'OWNER_LINK_NOT_VERIFIED'],
    [{ linkId: crypto.randomUUID(), externalId: a.ext, version: 1, fields: { rent: 1500 } }, 'LINK_NOT_FOUND'],
  ]
  for (const [data, code] of bad) {
    const r = await push('property.owner_updated', data)
    assert.equal(r.json.error, code, JSON.stringify(data)); assert.ok(r.status >= 400)
  }
  assert.equal(await n('nexus_owner_property_updates'), 0)
  // a refused event leaves no receipt, so the corrected event may reuse its id
  assert.equal(await n('nexus_inbound_events', `event_type='property.owner_updated'`), 0)
  // unsigned and wrongly signed pushes never reach the handler
  const body = { contractVersion: S.CONTRACT_VERSION, agencyKey: '2906', eventId: 'nx-unsigned-0001', eventType: 'property.owner_updated', data: { linkId: a.linkId, externalId: a.ext, version: 1, fields: { rent: 1 } } }
  assert.equal((await post('/events', body, { sign: false })).status, 401)
  const forged = await fetch(`${base}/api/nexus-link/v1/events`, { method: 'POST', headers: headers('/events', body, 'some-other-secret-0123456789abcdef012345'), body: JSON.stringify(body) })
  assert.equal(forged.status, 401)
  assert.equal((await push('property.owner_updated', body.data, { eventId: 'nx-agency-0001' }).then(async () => post('/events', { ...body, agencyKey: 'benestates' }))).status, 403)
})

test('owner confirms availability → the one ARGUS timestamp moves → NEXUS reads back exactly that value', async () => {
  const a = await owner()
  const read = async () => (await post('/read/properties', { linkId: a.linkId, externalIds: [a.ext] })).json.properties[0].availability
  assert.equal((await read()).availability_last_confirmed_at, null)
  // not a confirmation: nothing moves
  assert.equal((await push('availability.answered', { linkId: a.linkId, externalId: a.ext, outcome: 'ask_later' }, { occurredAt: minutesAgo(30) })).json.applied, true)
  assert.equal((await read()).availability_last_confirmed_at, null)
  // explicit confirmation
  const id = 'nx-avail-confirm-0001'
  const ok = await push('availability.answered', { linkId: a.linkId, externalId: a.ext, outcome: 'available' }, { occurredAt: minutesAgo(10), eventId: id })
  assert.deepEqual([ok.status, ok.json.applied, ok.json.result.countedAsConfirmation], [200, true, true])
  const { rows: [p] } = await db.query(`SELECT last_confirmed_available_at FROM properties WHERE id=$1`, [a.p.id])
  assert.ok(p.last_confirmed_available_at)
  const shown = await read()
  assert.equal(shown.availability_last_confirmed_at, new Date(p.last_confirmed_available_at).toISOString())
  assert.equal(shown.freshness, 'recently_confirmed')
  // Duplicate delivery: same answer, one ledger row, timestamp unchanged.
  const dup = await push('availability.answered', { linkId: a.linkId, externalId: a.ext, outcome: 'available' }, { occurredAt: minutesAgo(10), eventId: id })
  assert.deepEqual([dup.json.duplicate, dup.json.applied], [true, true])
  assert.equal(await n('owner_availability_answers', `outcome='available'`), 1)
  // Out of order: an answer the owner gave BEFORE the confirmation arrives late and changes nothing.
  const late = await push('availability.answered', { linkId: a.linkId, externalId: a.ext, outcome: 'rented' }, { occurredAt: minutesAgo(20) })
  assert.deepEqual([late.status, late.json.applied, late.json.result.reason], [200, false, 'OUT_OF_ORDER'])
  const after = await read()
  assert.equal(after.availability_last_confirmed_at, shown.availability_last_confirmed_at)
  assert.equal(after.status, shown.status)
  // A passport edit or a schedule change never refreshes availability.
  await push('property.owner_updated', { linkId: a.linkId, externalId: a.ext, version: 1, fields: { rent: 1500 } })
  assert.equal((await read()).availability_last_confirmed_at, shown.availability_last_confirmed_at)
})

test('distribution permissions: one vocabulary, a tested mapping, and everything unrecognised is refused', async () => {
  // the mapping itself
  assert.deepEqual(P.fromNexusPermissions(['manage_viewings', 'view_facts']), { channel: 'origin_agency', scopes: ['listing_data', 'viewing_schedule'] })
  assert.deepEqual(P.toNexusPermissions([{ channel: 'origin_agency', scopes: ['listing_data', 'availability'] }, { channel: 'all_eligible_agencies', scopes: ['viewing_schedule'] }]), ['view_facts'])
  for (const p of P.NEXUS_WITHOUT_MEANING) assert.throws(() => P.fromNexusPermissions(['view_facts', p]), e => e.code === 'PERMISSION_NOT_MAPPED')
  assert.throws(() => P.fromNexusPermissions(['publish_everywhere']), e => e.code === 'PERMISSION_UNRECOGNIZED')
  assert.throws(() => P.fromNexusPermissions([]), e => e.code === 'PERMISSIONS_INVALID')

  const a = await owner()
  const grant = data => push('distribution.granted', { linkId: a.linkId, externalId: a.ext, ...data })
  const refused = [
    [{ nexusPermissions: ['market'] }, 'PERMISSION_NOT_MAPPED'],
    [{ nexusPermissions: ['view_facts', 'contact_owner'] }, 'PERMISSION_NOT_MAPPED'],
    [{ nexusPermissions: ['everything'] }, 'PERMISSION_UNRECOGNIZED'],
    [{ nexusPermissions: ['view_facts'], channel: 'all_eligible_agencies' }, 'CHANNEL_INVALID'],
    [{ channel: 'public_web', scopes: ['listing_data'] }, 'CHANNEL_INVALID'],
    [{ channel: 'origin_agency', scopes: ['listing_data', 'owner_phone'] }, 'SCOPES_INVALID'],
    [{ channel: 'origin_agency', scopes: [] }, 'SCOPES_INVALID'],
    [{ channel: 'origin_agency' }, 'SCOPES_INVALID'],
    [{ channel: 'selected_agency', scopes: ['listing_data'] }, 'AUDIENCE_REQUIRED'],
  ]
  for (const [data, code] of refused) assert.equal((await grant(data)).json.error, code, JSON.stringify(data))
  assert.equal(await n('nexus_distribution_grants'), 0)
  // With nothing granted the gate keeps the listing in: no sharing without valid authorisation.
  assert.deepEqual((await S.syncProperties(a.o.id, admin)).properties[0].blockedReasons, ['NO_DISTRIBUTION_AUTHORIZATION'])

  const mapped = await grant({ nexusPermissions: ['view_facts', 'manage_viewings'] })
  assert.deepEqual([mapped.json.applied, mapped.json.result.channel, mapped.json.result.scopes], [true, 'origin_agency', ['listing_data', 'viewing_schedule']])
  const canonical = await grant({ channel: 'all_eligible_agencies', scopes: ['listing_data', 'availability'] })
  assert.equal(canonical.json.applied, true)
  const got = (await post('/read/properties', { linkId: a.linkId, externalIds: [a.ext] })).json.properties[0].grants
  assert.deepEqual(got.map(g => [g.channel, g.scopes]), [['all_eligible_agencies', ['availability', 'listing_data']], ['origin_agency', ['listing_data', 'viewing_schedule']]])
  assert.deepEqual(P.toNexusPermissions(got), ['manage_viewings', 'view_facts'])
})

test('grants and revocations are applied in the order the owner made them, not the order they arrive', async () => {
  const a = await owner()
  const g = (data, at) => push('distribution.granted', { linkId: a.linkId, externalId: a.ext, scopes: ['listing_data'], ...data }, { occurredAt: minutesAgo(at) })
  const r = (data, at) => push('distribution.revoked', { linkId: a.linkId, externalId: a.ext, ...data }, { occurredAt: minutesAgo(at) })
  const active = () => n('nexus_distribution_grants', 'revoked_at IS NULL')

  // owner: grant (t-30) then revoke (t-20). The revoke arrives first.
  assert.equal((await r({ channel: 'origin_agency' }, 20)).json.result.revoked, 0)
  const lateGrant = await g({ channel: 'origin_agency' }, 30)
  assert.deepEqual([lateGrant.status, lateGrant.json.applied, lateGrant.json.result.reason], [200, false, 'OUT_OF_ORDER'])
  assert.equal(await active(), 0)

  // owner: revoke (t-15) then grant (t-10). The grant arrives first; the late revoke must not undo it.
  assert.equal((await g({ channel: 'all_eligible_agencies' }, 10)).json.applied, true)
  assert.equal((await r({ channel: 'all_eligible_agencies' }, 15)).json.result.revoked, 0)
  assert.equal(await active(), 1)
  // "revoke everything" from before that grant does not touch it either; a current one does.
  assert.equal((await r({}, 12)).json.result.revoked, 0)
  assert.equal(await active(), 1)
  assert.equal((await r({}, 1)).json.result.revoked, 1)
  assert.equal(await active(), 0)
  // … and an older grant for any audience arriving after "revoke everything" stays history.
  assert.equal((await g({ channel: 'independent_agents' }, 5)).json.applied, false)
  assert.equal(await active(), 0)
})

test('owner revokes access → sharing stops downstream: withdrawal queued, released route taken back, gate closed', async () => {
  const a = await owner()
  await push('distribution.granted', { linkId: a.linkId, externalId: a.ext, channel: 'all_eligible_agencies', scopes: ['listing_data', 'availability'] }, { occurredAt: minutesAgo(30) })
  const seen = nexusReceiver(applying)
  assert.equal((await S.syncOwner(a.o.id, admin)).delivery.delivered, 1)
  assert.equal((await S.syncProperties(a.o.id, admin)).delivery.delivered, 1)
  await R.setRoute(a.p.id, admin, { mode: 'immediate', audienceType: 'all_eligible_agencies' })
  await R.approveRelease(a.p.id, admin)
  assert.equal((await R.tick()).released, 1)

  const revoke = await push('distribution.revoked', { linkId: a.linkId, externalId: a.ext })
  assert.deepEqual([revoke.json.applied, revoke.json.result.remaining, revoke.json.result.withdrawalQueued], [true, 0, true])
  const st = (await S.status(a.o.id, admin)).properties[0]
  assert.deepEqual([st.statuses.distribution, st.eligible, st.blockedReasons], ['withdrawn', false, ['NO_DISTRIBUTION_AUTHORIZATION']])
  const { rows: [route] } = await db.query(`SELECT release_state, revoked_by FROM nexus_distribution_routes WHERE property_id=$1`, [a.p.id])
  assert.deepEqual([route.release_state, route.revoked_by], ['revoked', 'owner'])
  process.env.NEXUS_LINK_ROUTING_EVENTS = '1'
  await S.deliverDue()
  const types = seen.map(b => b.eventType)
  assert.ok(types.includes('property.withdrawn') && types.includes('distribution.release_revoked'), types.join(','))
  // nothing can be sent for this listing any more
  seen.length = 0
  const again = await S.syncProperties(a.o.id, admin)
  assert.equal(again.properties[0].queued, false); assert.equal(seen.length, 0)
})

test('viewing schedule and approved answers: persisted, versioned, withdrawable, validated', async () => {
  const a = await owner()
  const schedule = { duration: 30, notice: 24, buffer: 15, weekly: [{ day: 1, kind: 'available', start: '09:00', end: '13:00' }, { day: 1, kind: 'blocked', start: '11:00', end: '11:30' }], exceptions: [{ date: '2026-12-25', start: '00:00', end: '24:00' }] }
  const s1 = await push('viewing.schedule_updated', { linkId: a.linkId, externalId: a.ext, version: 5, schedule })
  assert.deepEqual([s1.status, s1.json.applied], [200, true])
  assert.equal((await push('viewing.schedule_updated', { linkId: a.linkId, externalId: a.ext, version: 4, schedule: { ...schedule, duration: 60 } })).json.applied, false)
  assert.equal((await push('viewing.schedule_updated', { linkId: a.linkId, externalId: a.ext, version: 6, schedule: { ...schedule, duration: 60 } })).json.applied, true)
  const { rows: [row] } = await db.query(`SELECT version, schedule FROM nexus_owner_viewing_schedules WHERE property_id=$1`, [a.p.id])
  assert.deepEqual([row.version, row.schedule.duration], [6, 60])
  for (const broken of [{ ...schedule, duration: 20 }, { ...schedule, weekly: [{ day: 9, kind: 'available', start: '09:00', end: '10:00' }] }, { ...schedule, extra: true }, { ...schedule, weekly: [{ day: 1, kind: 'available', start: '13:00', end: '09:00' }] }]) {
    assert.equal((await push('viewing.schedule_updated', { linkId: a.linkId, externalId: a.ext, version: 9, schedule: broken })).json.error, 'SCHEDULE_INVALID')
  }
  // A schedule is not an appointment: nothing is written to the booking tables.
  assert.equal(await n('property_viewings', 'property_id=$1', [a.p.id]), 0)

  const q = data => ({ linkId: a.linkId, externalId: a.ext, questionKey: 'pets', ...data })
  assert.equal((await push('qa.answer_approved', q({ version: 1, question: 'Are pets allowed?', answer: 'Small dogs, yes.' }))).json.applied, true)
  assert.equal((await push('qa.answer_approved', q({ version: 3, question: 'Are pets allowed?', answer: 'No pets.' }))).json.applied, true)
  assert.equal((await push('qa.answer_approved', q({ version: 2, question: 'Are pets allowed?', answer: 'Cats only.' }))).json.applied, false)
  assert.equal((await db.query(`SELECT answer FROM nexus_owner_answers WHERE property_id=$1`, [a.p.id])).rows[0].answer, 'No pets.')
  assert.equal((await S.status(a.o.id, admin)).properties[0].ownerInput.approvedAnswers, 1)
  assert.equal((await push('qa.answer_withdrawn', q({ version: 4 }))).json.result.state, 'withdrawn')
  assert.equal((await S.status(a.o.id, admin)).properties[0].ownerInput.approvedAnswers, 0)
  assert.equal((await push('qa.answer_approved', q({ version: 5, question: 'Are pets allowed?', answer: '' }))).json.error, 'ANSWER_INVALID')
  assert.equal((await push('qa.answer_approved', q({ questionKey: 'Bad Key', version: 5, question: 'x', answer: 'y' }))).json.error, 'QUESTION_KEY_INVALID')
  assert.equal(await n('nexus_sync_outbox'), 0)
})

test('ARGUS never reports "synced" for an acknowledgement that did not apply; the event stays queued and retries safely', async () => {
  const a = await owner()
  await push('distribution.granted', { linkId: a.linkId, externalId: a.ext, channel: 'origin_agency', scopes: ['listing_data'] })
  // A receiver that answers 200 but ignores the payload (NEXUS Stage A at ee61326 behaved like this).
  let mode = 'ignore'
  const seen = nexusReceiver(body => (mode === 'ignore' ? { json: { linkedProperties: 1, canonicalPropertyId: 'x', publicationState: 'unpublished' } }
    : mode === 'partial' ? { json: { applied: true, properties: [] } } : mode === 'down' ? { status: 503, json: { message: 'temporarily unavailable' } } : applying(body)))
  const first = await S.syncOwner(a.o.id, admin)
  assert.deepEqual([first.delivery.delivered, first.delivery.failed], [0, 1])
  let st = await S.status(a.o.id, admin)
  assert.equal(st.link.sync.state, 'error')
  assert.match(st.link.sync.lastError, /without confirming it was applied/)
  assert.equal(st.queue.waiting, 1)
  // "Applied" but fewer listings linked than the owner confirmed is not success either.
  mode = 'partial'
  assert.equal((await S.retrySync(a.o.id, admin)).delivery.failed, 1)
  assert.match((await S.status(a.o.id, admin)).link.sync.lastError, /linked 0 of 1 confirmed properties/)
  // A failed delivery stays pending and is retried with the same event id.
  mode = 'down'
  assert.equal((await S.retrySync(a.o.id, admin)).delivery.failed, 1)
  mode = 'apply'
  assert.equal((await S.retrySync(a.o.id, admin)).delivery.delivered, 1)
  st = await S.status(a.o.id, admin)
  assert.equal(st.link.sync.state, 'synced')
  // The canonical id arrives with the owner acknowledgement, before any listing data is shared.
  assert.equal(st.properties[0].statuses.canonicalPropertyId, `uuid-${a.ext}`)
  const ownerEvents = seen.filter(b => b.eventType === 'owner.profile_upserted')
  assert.equal(ownerEvents.length, 4); assert.equal(new Set(ownerEvents.map(b => b.eventId)).size, 1)
  assert.equal(await n('nexus_sync_outbox', `event_type='owner.profile_upserted'`), 1)

  // Same rule for a listing.
  mode = 'ignore'
  assert.equal((await S.syncProperties(a.o.id, admin)).delivery.failed, 1)
  assert.equal((await S.status(a.o.id, admin)).properties[0].statuses.sync, 'error')
  mode = 'apply'
  assert.equal((await S.retrySync(a.o.id, admin)).delivery.delivered, 1)
  assert.equal((await S.status(a.o.id, admin)).properties[0].statuses.sync, 'synced')
  assert.equal(await n('nexus_sync_outbox', `event_type='property.upserted'`), 1)
})

test('read API: NEXUS gets operational facts over signed HTTP — scoped to the link, no contact data, closed when unsigned', async () => {
  const a = await owner({ props: 2 }); const b = await owner(); const unverified = await owner({ verify: false })
  for (const path of ['/read/owner-link', '/read/properties', '/read/viewing-busy', '/read/source-match']) assert.equal((await post(path, { linkId: a.linkId }, { sign: false })).status, 401)

  const mine = await post('/read/owner-link', { linkId: a.linkId, nexusAccountRef: a.account })
  assert.equal(mine.status, 200, JSON.stringify(mine.json))
  assert.deepEqual([mine.json.verified, mine.json.properties.map(p => p.externalId).sort()], [true, [...a.exts].sort()])
  assert.deepEqual(Object.keys(mine.json.properties[0].facts).sort(), ['amenities', 'availableFrom', 'bathrooms', 'bedrooms', 'locality', 'photos', 'rent', 'sale', 'type'])
  assert.doesNotMatch(JSON.stringify(mine.json), /Secret Street|\+356|phone|Test Owner/)
  // another account, another link, an unverified link
  assert.equal((await post('/read/owner-link', { linkId: a.linkId, nexusAccountRef: b.account })).status, 404)
  assert.equal((await post('/read/owner-link', { linkId: crypto.randomUUID(), nexusAccountRef: a.account })).status, 404)
  assert.deepEqual((await post('/read/owner-link', { linkId: unverified.linkId, nexusAccountRef: unverified.account })).json.properties, [])

  // a listing of another owner is simply not in the answer
  const props = await post('/read/properties', { linkId: a.linkId, externalIds: [a.ext, b.ext, '2906:does-not-exist'] })
  assert.deepEqual(props.json.properties.map(p => [p.externalId, p.accessValid]), [[a.ext, true]])
  assert.equal((await post('/read/properties', { linkId: a.linkId, externalIds: [] })).json.error, 'EXTERNAL_IDS_INVALID')
  // a dispute closes access at the next read
  await S.disputeOwner(a.o.id, admin, { reason: 'second claimant' })
  const closed = (await post('/read/properties', { linkId: a.linkId, externalIds: [a.ext] })).json
  assert.deepEqual([closed.linkState, closed.properties[0].accessValid, closed.properties[0].availability, closed.properties[0].grants], ['disputed', false, null, []])
  assert.deepEqual((await post('/read/owner-link', { linkId: a.linkId, nexusAccountRef: a.account })).json.properties, [])
  assert.equal((await post('/read/viewing-busy', { linkId: a.linkId, externalId: a.ext, from: '2026-11-16', days: 14 })).status, 404)

  // appointments: timing only
  const { rows: cols } = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name='property_viewings' AND is_nullable='NO' AND column_default IS NULL`)
  if (cols.every(c => ['property_id', 'viewing_date'].includes(c.column_name))) {
    await db.query(`INSERT INTO property_viewings (property_id, viewing_date, viewing_time, starts_at, duration_min, status, notes) VALUES ($1,'2026-11-17','10:00','2026-11-17T09:00:00Z',20,'confirmed','client: private note')`, [b.p.id])
    const busy = await post('/read/viewing-busy', { linkId: b.linkId, externalId: b.ext, from: '2026-11-16', days: 14 })
    assert.deepEqual(busy.json.busy, [{ date: '2026-11-17', time: '10:00', startsAt: '2026-11-17T09:00:00.000Z', durationMin: 20 }])
    await db.query(`DELETE FROM property_viewings WHERE property_id=$1`, [b.p.id])
  }
  assert.equal((await post('/read/viewing-busy', { linkId: b.linkId, externalId: b.ext, from: 'tomorrow', days: 14 })).json.error, 'RANGE_INVALID')
  assert.equal((await post('/read/viewing-busy', { linkId: b.linkId, externalId: a.ext, from: '2026-11-16', days: 14 })).status, 404)
  assert.equal((await post('/read/source-match', { linkId: b.linkId, externalId: b.ext, url: 'https://example.org/none' })).json.error, 'SOURCE_NOT_REVIEWED')
  assert.equal((await post('/read/source-match', { linkId: b.linkId, externalId: b.ext, url: 'http://example.org/x' })).json.error, 'URL_INVALID')
})

test('agency-wide market read: only shareable listings carry data, each "no" names its reason, and staleness is explicit', async () => {
  const F = H.load('services/availabilityFreshness')
  const ok = await owner(); const noGrant = await owner(); const off = await owner(); const held = await owner(); const unverified = await owner({ verify: false }); const noAvail = await owner()
  const grant = (x, scopes, channel = 'all_eligible_agencies', at = 60) => push('distribution.granted', { linkId: x.linkId, externalId: x.ext, channel, scopes }, { occurredAt: minutesAgo(at) })
  for (const x of [ok, off, held]) await grant(x, ['listing_data', 'availability', 'viewing_schedule'])
  await grant(noAvail, ['listing_data'])
  await push('availability.answered', { linkId: ok.linkId, externalId: ok.ext, outcome: 'available' }, { occurredAt: minutesAgo(5) })
  await db.query(`UPDATE properties SET available_status='not_available' WHERE id=$1`, [off.p.id])
  await push('availability.answered', { linkId: held.linkId, externalId: held.ext, outcome: 'reserved' }, { occurredAt: minutesAgo(5) })
  await db.query(`UPDATE properties SET feature_tags=ARRAY['lift','ac','secret_internal_tag'] WHERE id=$1`, [ok.p.id])
  await db.query(`INSERT INTO property_viewing_windows (property_id, kind, starts_at, ends_at, source_type) VALUES ($1,'window', NOW() + interval '1 day', NOW() + interval '1 day 2 hours', 'test')`, [ok.p.id])
  await R.setRoute(ok.p.id, admin, { mode: 'immediate', audienceType: 'selected_agencies', audienceRefs: ['agency-a'], commercialTermsRef: 'AGR-7' })
  await R.approveRelease(ok.p.id, admin); await R.tick()

  assert.equal((await post('/read/market', { externalIds: [ok.ext] }, { sign: false })).status, 401)
  const res = await post('/read/market', { externalIds: [ok.ext, noGrant.ext, off.ext, held.ext, unverified.ext, noAvail.ext, '2906:nope'] })
  assert.equal(res.status, 200, JSON.stringify(res.json))
  const by = Object.fromEntries(res.json.properties.map(x => [x.externalId, x]))
  assert.deepEqual(by[noGrant.ext], { externalId: noGrant.ext, eligible: false, reason: 'NO_DISTRIBUTION_AUTHORIZATION' })
  assert.deepEqual(by[off.ext], { externalId: off.ext, eligible: false, reason: 'OFF_MARKET' })
  assert.deepEqual(by[held.ext], { externalId: held.ext, eligible: false, reason: 'HELD_BY_OWNER' })
  assert.deepEqual(by[unverified.ext], { externalId: unverified.ext, eligible: false, reason: 'OWNER_NOT_VERIFIED' })
  assert.deepEqual(by['2906:nope'], { externalId: '2906:nope', eligible: false, reason: 'UNKNOWN_LISTING' })

  const m = by[ok.ext]
  assert.equal(m.eligible, true)
  assert.deepEqual(m.features, ['ac', 'lift'])
  assert.deepEqual([m.availability.freshness, m.availability.consumerDiscoverable], ['recently_confirmed', true])
  assert.deepEqual(m.releases.map(r => [r.audienceType, r.audienceRefs, r.commercialTermsRef]), [['selected_agencies', ['agency-a'], 'AGR-7']])
  assert.ok(m.viewingWindow.startsAt < m.viewingWindow.endsAt)
  assert.doesNotMatch(JSON.stringify(res.json), /Secret Street|\+356|Test Owner|secret_internal_tag/)
  // Without the owner's `availability` scope: on-market yes, timing and history no. Never confirmed → not for consumers.
  assert.deepEqual(by[noAvail.ext].availability, { status: 'available', consumerDiscoverable: false })
  assert.equal(by[noAvail.ext].viewingWindow, null)
  // Agency revokes the release → it is gone from the next read.
  await R.revokeRoute(ok.p.id, admin, 'exclusive')
  assert.deepEqual((await post('/read/market', { externalIds: [ok.ext] })).json.properties[0].releases, [])

  // Staleness: about five days without a fresh confirmation ends consumer discovery, without changing the status.
  const now = Date.now(); const h = n => new Date(now - n * 3600000)
  assert.deepEqual([F.classify(h(100), { now }).consumerDiscoverable, F.classify(h(100), { now }).state], [true, 'confirmation_overdue'])
  assert.equal(F.classify(h(121), { now }).consumerDiscoverable, false)
  assert.equal(F.classify(null, { now }).consumerDiscoverable, false)
  assert.equal(F.settings({ NEXUS_AVAILABILITY_CONSUMER_HOURS: '72' }).consumerHours, 72)

  // Staff lookup by reference: the listing agent and admins only; for anyone else it does not exist.
  const other = await H.agent('agent', { nexus_owner_link: true })
  assert.deepEqual(await R.findListing(ok.p.ref, admin), { propertyId: ok.p.id, ref: ok.p.ref, onMarket: true })
  await assert.rejects(R.findListing(ok.p.ref, other), e => e.code === 'PROPERTY_NOT_FOUND' && e.status === 404)
  await assert.rejects(R.findListing('no-such-ref', admin), e => e.code === 'PROPERTY_NOT_FOUND')
})
