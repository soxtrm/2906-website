'use strict'
// ARGUS × NEXUS owner link — service tests against a real Postgres with the
// production schema (Claude, 2026-11-11). The "NEXUS receiver" is an in-process
// stub: these tests prove the ARGUS side and the contract, NOT a live NEXUS.
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')

process.env.JWT_SECRET = 'test-jwt-secret-not-production'
delete process.env.NEXUS_OWNER_LINK_URL
delete process.env.NEXUS_LINK_OUTBOUND_SECRET
const H = require('./helpers/harness')
const S = H.load('services/nexusOwnerLink')
const C = H.load('services/nexusLinkCrypto')
const F = H.load('services/availabilityFreshness')
const { db } = H

const tokenOf = url => url.split('#t=')[1]
const evt = (eventType, data, extra = {}) => ({ eventId: `evt-${crypto.randomBytes(12).toString('hex')}`, eventType, contractVersion: S.CONTRACT_VERSION, agencyKey: '2906', occurredAt: new Date().toISOString(), data, ...extra })
const rowOf = async (table, id) => (await db.query(`SELECT md5(row_to_json(t)::text) AS h FROM ${table} t WHERE id=$1`, [id])).rows[0].h
const count = async table => (await db.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n

// A fake NEXUS receiver: records what it was sent and answers like the contract says.
function receiverStub({ status = 200, body } = {}) {
  const calls = []
  S.setTransport(async (url, init) => {
    const parsed = JSON.parse(init.body)
    calls.push({ url, headers: init.headers, body: parsed })
    const s = typeof status === 'function' ? status(calls.length) : status
    return { status: s, json: async () => (body ? body(parsed) : { applied: true, properties: (parsed.data.confirmedExternalIds || []).map(x => ({ externalId: x, canonicalPropertyId: `nxp_${C.sha256(x).slice(0, 24)}` })), canonicalPropertyId: `nxp_${C.sha256(parsed.data.externalId || 'owner').slice(0, 24)}`, publicationState: 'unpublished' }) }
  })
  process.env.NEXUS_OWNER_LINK_URL = 'https://nexus.test/api/nexus/argus-link/v1'
  process.env.NEXUS_LINK_OUTBOUND_SECRET = 'outbound-secret-0123456789abcdef0123456789'
  return calls
}
function noReceiver() { delete process.env.NEXUS_OWNER_LINK_URL; delete process.env.NEXUS_LINK_OUTBOUND_SECRET; S.setTransport(async () => { throw new Error('transport must not be used without a receiver') }) }

// invite → claim (confirm all) → verify → grant. Returns everything a test needs.
async function verifiedOwner(admin, { props = 1, grant = true, propFields = {} } = {}) {
  const o = await H.owner()
  const list = []
  for (let i = 0; i < props; i++) list.push(await H.property(o.id, propFields))
  const { invitation } = await S.createInvitation(o.id, admin)
  const resolved = await S.resolveInvitation(tokenOf(invitation.url))
  const account = `nxo_${crypto.randomBytes(8).toString('hex')}`
  await S.applyInboundEvent(evt('owner.claim_submitted', { token: tokenOf(invitation.url), nexusAccountRef: account, decisions: resolved.properties.map(p => ({ externalId: p.externalId, decision: 'confirm' })) }))
  await S.verifyOwner(o.id, admin, { method: 'ID document checked on call' })
  const linkId = resolved.owner.linkId
  if (grant) for (const p of resolved.properties) await S.applyInboundEvent(evt('distribution.granted', { linkId, externalId: p.externalId, channel: 'nexus_direct_from_owner', scopes: ['listing_data', 'availability'] }))
  return { owner: o, properties: list, linkId, account, externalIds: resolved.properties.map(p => p.externalId) }
}

let admin
test.before(async () => { await H.migrate(); await H.reset(); admin = await H.agent('admin') })
test.beforeEach(async () => { await H.reset(); noReceiver() })
test.after(async () => { await H.reset() })

test('migration is additive, idempotent and reversible', async () => {
  const before = await count('properties')
  await H.migrate(); await H.migrate()
  await H.migrate('down')
  const { rows } = await db.query(`SELECT to_regclass('public.nexus_owner_links') AS t`)
  assert.equal(rows[0].t, null)
  await H.migrate()
  assert.equal(await count('properties'), before)
  // No second availability timestamp was introduced anywhere.
  const { rows: cols } = await db.query(`SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='availability_last_confirmed_at'`)
  assert.equal(cols.length, 0)
})

test('1 · existing owner is linked once: repeated invites and claims create no duplicates', async () => {
  const o = await H.owner(); await H.property(o.id); await H.property(o.id)
  const owners = await count('owner_contacts'), props = await count('properties')
  const a = await S.createInvitation(o.id, admin)
  const b = await S.createInvitation(o.id, admin)
  assert.equal(a.created, true); assert.equal(b.created, false)
  assert.equal(a.invitation.url, b.invitation.url)
  assert.equal((await db.query(`SELECT COUNT(*)::int n FROM nexus_owner_links WHERE owner_contact_id=$1`, [o.id])).rows[0].n, 1)
  assert.equal((await db.query(`SELECT COUNT(*)::int n FROM nexus_owner_property_claims`)).rows[0].n, 2)
  const token = tokenOf(a.invitation.url)
  const claim = evt('owner.claim_submitted', { token, nexusAccountRef: 'nxo_owner_one', decisions: [] })
  assert.equal((await S.applyInboundEvent(claim)).duplicate, false)
  assert.equal((await S.applyInboundEvent(claim)).duplicate, true) // same event again: no-op
  const st = await S.status(o.id, admin)
  assert.equal(st.link.state, 'claim_pending') // claimed is NOT verified
  assert.equal(st.link.nexusAccountRef, 'nxo_owner_one')
  assert.equal(await count('owner_contacts'), owners); assert.equal(await count('properties'), props)
  // The same NEXUS account cannot be attached to a second owner of this agency.
  const o2 = await H.owner(); await H.property(o2.id)
  const inv2 = await S.createInvitation(o2.id, admin)
  await assert.rejects(S.applyInboundEvent(evt('owner.claim_submitted', { token: tokenOf(inv2.invitation.url), nexusAccountRef: 'nxo_owner_one', decisions: [] })), e => e.code === 'ACCOUNT_ALREADY_LINKED')
})

test('2 · operator generates and copies a valid invitation; revoke, rotate and expiry invalidate it', async () => {
  const o = await H.owner({ name: 'Maria Borg' }); const p = await H.property(o.id)
  const { invitation } = await S.createInvitation(o.id, admin)
  assert.match(invitation.url, /^https:\/\/nexuslink\.fit\/owner\/activate#t=[0-9a-z]+\.[A-Za-z0-9_-]{43}$/)
  const token = tokenOf(invitation.url)
  // Plaintext token is nowhere in the database.
  const { rows: [stored] } = await db.query(`SELECT row_to_json(i)::text AS j FROM nexus_owner_invitations i`)
  assert.ok(!stored.j.includes(token)); assert.ok(stored.j.includes(C.tokenHash(token)))
  const copy = await S.copyInvitationLink(o.id, admin)
  assert.equal(copy.invitation.url, invitation.url); assert.equal(copy.invitation.copyCount, 1)
  const r = await S.resolveInvitation(token)
  assert.equal(r.owner.displayName, 'Maria Borg')
  assert.deepEqual(Object.keys(r.properties[0]).sort(), ['bedrooms', 'claimState', 'externalId', 'propertyType', 'ref', 'town', 'transactionType'])
  assert.equal(r.properties[0].externalId, `2906:${p.ref}`)
  // Nothing private: no phone, no street.
  assert.ok(!JSON.stringify(r).includes(o.phone_normalized)); assert.ok(!JSON.stringify(r).includes('Secret Street'))
  // rotate → old link dead, new link works
  const rotated = await S.createInvitation(o.id, admin, { rotate: true })
  assert.notEqual(rotated.invitation.url, invitation.url)
  await assert.rejects(S.resolveInvitation(token), e => e.code === 'INVITATION_INVALID')
  await S.resolveInvitation(tokenOf(rotated.invitation.url))
  // expiry
  await db.query(`UPDATE nexus_owner_invitations SET expires_at = NOW() - interval '1 minute' WHERE revoked_at IS NULL`)
  await assert.rejects(S.resolveInvitation(tokenOf(rotated.invitation.url)), e => e.code === 'INVITATION_INVALID')
  await assert.rejects(S.copyInvitationLink(o.id, admin), e => e.code === 'NO_ACTIVE_INVITATION')
  // revoke
  const fresh = await S.createInvitation(o.id, admin)
  assert.equal(fresh.created, true)
  assert.equal((await S.revokeInvitation(o.id, admin, 'sent to wrong person')).revoked, 1)
  await assert.rejects(S.resolveInvitation(tokenOf(fresh.invitation.url)), e => e.code === 'INVITATION_INVALID')
  await assert.rejects(S.resolveInvitation('zz.not-a-token'), e => e.code === 'INVITATION_INVALID')
})

test('invitations are refused for do-not-contact owners (both DNC forms) and owners without a real listing', async () => {
  const a = await H.owner({ do_not_contact: true }); await H.property(a.id)
  const b = await H.owner({ status: 'do_not_contact' }); await H.property(b.id)
  const c = await H.owner()
  await assert.rejects(S.createInvitation(a.id, admin), e => e.code === 'OWNER_DO_NOT_CONTACT')
  await assert.rejects(S.createInvitation(b.id, admin), e => e.code === 'OWNER_DO_NOT_CONTACT')
  await assert.rejects(S.createInvitation(c.id, admin), e => e.code === 'NO_ELIGIBLE_PROPERTY')
  assert.equal(await count('nexus_owner_invitations'), 0)
})

test('3 + 12 + 13 · the owner link writes nothing to swipe links, outreach, website or the public NEXUS index', async () => {
  const watched = ['swipe_links', 'swipe_link_properties', 'outreach_log', 'outreach_plans', 'website_properties', 'nexus_link_index', 'availability_checks', 'owner_booking_portals', 'clients']
  const before = {}
  for (const t of watched) before[t] = await count(t)
  receiverStub()
  const v = await verifiedOwner(admin, { props: 2 })
  await S.syncOwner(v.owner.id, admin); await S.syncProperties(v.owner.id, admin)
  await S.applyInboundEvent(evt('distribution.revoked', { linkId: v.linkId, externalId: v.externalIds[0] }))
  for (const t of watched) assert.equal(await count(t), before[t], `${t} must be untouched`)
  // And the module does not even reference the messaging / outreach layer.
  const src = require('fs').readFileSync(require('path').join(H.ROOT, 'services', 'nexusOwnerLink.js'), 'utf8')
  for (const word of ['waha', 'queues', 'outreach', 'swipe', 'websiteSync', 'nexus_link_index', 'sendMessage']) assert.ok(!new RegExp(`require\\([^)]*${word}|\\b(FROM|INTO|UPDATE)\\s+${word}`, 'i').test(src), `module must not use ${word}`)
})

test('4 · an owner-verified, authorised property syncs to NEXUS once; canonical id comes from NEXUS', async () => {
  const calls = receiverStub()
  const v = await verifiedOwner(admin)
  const out = await S.syncProperties(v.owner.id, admin)
  assert.deepEqual(out.properties.map(p => p.queued), [true])
  assert.equal(out.delivery.delivered, 1)
  assert.equal(calls.length, 1)
  const sent = calls[0]
  assert.equal(sent.body.eventType, 'property.upserted'); assert.equal(sent.body.contractVersion, S.CONTRACT_VERSION)
  // The request is signed exactly as the contract says.
  const ok = C.verify(process.env.NEXUS_LINK_OUTBOUND_SECRET, { timestamp: sent.headers['X-Nexus-Link-Timestamp'], method: 'POST', path: '/events', body: sent.body }, sent.headers['X-Nexus-Link-Signature'])
  assert.equal(ok.ok, true)
  const d = sent.body.data
  assert.equal(d.transactionType, 'rent'); assert.deepEqual(d.rent, { amount: 1500, currency: 'EUR', period: 'month' }); assert.equal(d.sale, null)
  assert.ok('availability_last_confirmed_at' in d.availability)
  const wire = JSON.stringify(sent.body)
  assert.ok(!wire.includes(v.owner.phone_normalized)); assert.ok(!wire.includes('Secret Street'))
  const st = await S.status(v.owner.id, admin)
  const s = st.properties[0].statuses
  assert.equal(s.sync, 'synced'); assert.equal(s.linked, true); assert.match(s.canonicalPropertyId, /^nxp_/)
  assert.equal(s.ownerReview, 'verified'); assert.equal(s.distribution, 'approved'); assert.equal(s.publication, 'unpublished')
})

test('5 · nothing is sent while the owner is unverified, the claim unconfirmed or no distribution is authorised', async () => {
  const calls = receiverStub()
  // (a) invited only
  const o = await H.owner(); await H.property(o.id)
  await S.createInvitation(o.id, admin)
  let out = await S.syncProperties(o.id, admin)
  assert.deepEqual(out.properties[0].blockedReasons, ['OWNER_LINK_NOT_VERIFIED', 'OWNER_CLAIM_NOT_CONFIRMED', 'NO_DISTRIBUTION_AUTHORIZATION'])
  // (b) verified owner, no grant
  const v = await verifiedOwner(admin, { grant: false })
  out = await S.syncProperties(v.owner.id, admin)
  assert.deepEqual(out.properties[0].blockedReasons, ['NO_DISTRIBUTION_AUTHORIZATION'])
  // (c) an owner who was never invited at all
  const n = await H.owner(); await H.property(n.id)
  out = await S.syncProperties(n.id, admin)
  assert.equal(out.properties[0].queued, false)
  assert.equal(calls.length, 0); assert.equal(await count('nexus_sync_outbox'), 0)
  assert.equal((await S.status(v.owner.id, admin)).properties[0].statuses.sync, 'blocked')
  // a grant from an unverified owner is refused
  const inv = (await S.status(o.id, admin)).link.id
  await assert.rejects(S.applyInboundEvent(evt('distribution.granted', { linkId: inv, externalId: 'x', channel: 'all_eligible_agencies', scopes: ['listing_data'] })), e => e.code === 'OWNER_LINK_NOT_VERIFIED')
})

test('rent and sale stay distinct: a rental price is never sent as a sale price', async () => {
  const calls = receiverStub()
  assert.deepEqual(S.transactionType({ longlet_price: 1200, sale_price: null }), { type: 'rent', problems: [] })
  assert.deepEqual(S.transactionType({ longlet_price: null, sale_price: 350000 }), { type: 'sale', problems: [] })
  assert.equal(S.transactionType({ longlet_price: null, sale_price: 3500 }).type, null) // "€3,500 sale" is a rent typed in the wrong field
  assert.equal(S.transactionType({ longlet_price: 1500, sale_price: 300000 }).type, null)
  const v = await verifiedOwner(admin, { propFields: { longlet_price: null, sale_price: 3500 } })
  const out = await S.syncProperties(v.owner.id, admin)
  assert.deepEqual(out.properties[0].blockedReasons, ['SALE_PRICE_LOOKS_LIKE_RENT'])
  assert.equal(calls.length, 0)
  const sale = await verifiedOwner(admin, { propFields: { longlet_price: null, sale_price: 420000 } })
  await S.syncProperties(sale.owner.id, admin)
  assert.deepEqual(calls[0].body.data.sale, { amount: 420000, currency: 'EUR' }); assert.equal(calls[0].body.data.rent, null)
})

test('6 · owner permission changes are enforced: revoke stops sharing and queues a withdrawal', async () => {
  const calls = receiverStub()
  const v = await verifiedOwner(admin)
  await S.syncProperties(v.owner.id, admin)
  assert.equal(calls.length, 1)
  // scopes narrowed: photos never granted → grant replaced, not stacked
  await S.applyInboundEvent(evt('distribution.granted', { linkId: v.linkId, externalId: v.externalIds[0], channel: 'nexus_direct_from_owner', scopes: ['availability'] }))
  assert.equal((await db.query(`SELECT COUNT(*)::int n FROM nexus_distribution_grants WHERE revoked_at IS NULL`)).rows[0].n, 1)
  await S.syncProperties(v.owner.id, admin)
  assert.equal(calls[1].body.data.rent, null) // listing_data no longer granted → price not sent
  // full revoke
  const r = await S.applyInboundEvent(evt('distribution.revoked', { linkId: v.linkId, externalId: v.externalIds[0] }))
  assert.equal(r.result.remaining, 0); assert.equal(r.result.withdrawalQueued, true)
  let st = (await S.status(v.owner.id, admin)).properties[0]
  assert.equal(st.statuses.distribution, 'withdrawn'); assert.equal(st.eligible, false)
  assert.deepEqual(st.blockedReasons, ['NO_DISTRIBUTION_AUTHORIZATION'])
  const again = await S.syncProperties(v.owner.id, admin)
  assert.equal(again.properties[0].queued, false)
  const d = await S.deliverDue()
  assert.equal(d.delivered, 1)
  assert.equal(calls[2].body.eventType, 'property.withdrawn')
  assert.equal(calls.filter(c => c.body.eventType === 'property.upserted').length, 2) // no upsert after the revoke
  st = (await S.status(v.owner.id, admin)).properties[0]
  assert.equal(st.statuses.publication, 'withdrawn')
})

test('7 · agency boundary: another agency key cannot read or change a link, and unsigned agencies are refused', async () => {
  const v = await verifiedOwner(admin, { grant: false })
  await assert.rejects(S.applyInboundEvent(evt('distribution.granted', { linkId: v.linkId, externalId: v.externalIds[0], channel: 'all_eligible_agencies', scopes: ['listing_data'] }, { agencyKey: 'benestates' })), e => e.code === 'AGENCY_MISMATCH' && e.status === 403)
  // Same database, different agency instance: the 2906 link does not exist for it.
  process.env.ARGUS_AGENCY_KEY = 'benestates'
  try {
    await assert.rejects(S.applyInboundEvent(evt('distribution.granted', { linkId: v.linkId, externalId: v.externalIds[0], channel: 'all_eligible_agencies', scopes: ['listing_data'] }, { agencyKey: 'benestates' })), e => e.code === 'LINK_NOT_FOUND')
    const other = await S.status(v.owner.id, admin)
    assert.equal(other.link.state, 'not_invited'); assert.equal(other.link.nexusAccountRef, null)
    assert.equal(other.properties[0].statuses.ownerReview, 'pending')
  } finally { delete process.env.ARGUS_AGENCY_KEY }
  assert.equal((await db.query(`SELECT COUNT(*)::int n FROM nexus_distribution_grants`)).rows[0].n, 0)
  // An owner cannot authorise a property that is not theirs.
  const stranger = await H.owner(); const foreign = await H.property(stranger.id)
  await assert.rejects(S.applyInboundEvent(evt('distribution.granted', { linkId: v.linkId, externalId: `2906:${foreign.ref}`, channel: 'all_eligible_agencies', scopes: ['listing_data'] })), e => e.code === 'PROPERTY_NOT_IN_LINK')
})

test('8 + 14 · syncing never modifies the source rows; 2906 stays the origin agency', async () => {
  const calls = receiverStub()
  const v = await verifiedOwner(admin)
  const p = v.properties[0]
  const ownerBefore = await rowOf('owner_contacts', v.owner.id), propBefore = await rowOf('properties', p.id)
  await S.syncOwner(v.owner.id, admin); await S.syncProperties(v.owner.id, admin); await S.retrySync(v.owner.id, admin); await S.status(v.owner.id, admin)
  assert.equal(await rowOf('owner_contacts', v.owner.id), ownerBefore)
  assert.equal(await rowOf('properties', p.id), propBefore)
  const up = calls.find(c => c.body.eventType === 'property.upserted').body.data
  assert.equal(up.originAgency, '2906'); assert.equal(up.provenance.origin_agency, '2906'); assert.equal(up.provenance.argus_ref, p.ref)
  const ownerEvt = calls.find(c => c.body.eventType === 'owner.profile_upserted').body.data
  assert.deepEqual(Object.keys(ownerEvt).sort(), ['confirmedExternalIds', 'displayName', 'nexusAccountRef', 'originAgency', 'ownerLinkId', 'verifiedAt'])
})

test('9 · an explicit availability confirmation moves properties.last_confirmed_available_at (and only that column)', async () => {
  const v = await verifiedOwner(admin)
  const p = v.properties[0]
  assert.equal((await db.query(`SELECT last_confirmed_available_at t FROM properties WHERE id=$1`, [p.id])).rows[0].t, null)
  const e = evt('availability.answered', { linkId: v.linkId, externalId: v.externalIds[0], outcome: 'available' })
  const r = await S.applyInboundEvent(e)
  assert.equal(r.result.countedAsConfirmation, true)
  const { rows: [after] } = await db.query(`SELECT last_confirmed_available_at t, available_status s FROM properties WHERE id=$1`, [p.id])
  assert.ok(after.t instanceof Date); assert.equal(after.s, 'available_confirmed')
  assert.equal((await S.status(v.owner.id, admin)).properties[0].statuses.freshness.state, 'recently_confirmed')
  // replay of the same event does not confirm twice
  await db.query(`UPDATE properties SET last_confirmed_available_at = NOW() - interval '3 days' WHERE id=$1`, [p.id])
  assert.equal((await S.applyInboundEvent(e)).duplicate, true)
  assert.equal((await S.status(v.owner.id, admin)).properties[0].statuses.freshness.state, 'confirmation_overdue')
  // "available from <date>" is a genuine confirmation of a future fact
  await S.recordAnswerByStaff(v.owner.id, admin, { propertyId: p.id, outcome: 'available_from', availableFrom: '2027-03-01' })
  const { rows: [up] } = await db.query(`SELECT available_status s, available_date::text d, last_confirmed_available_at t FROM properties WHERE id=$1`, [p.id])
  assert.equal(up.s, 'upcoming'); assert.equal(up.d, '2027-03-01'); assert.ok(Date.now() - up.t.getTime() < 60000)
})

test('10 · answers that are not an availability confirmation never reset freshness', async () => {
  const v = await verifiedOwner(admin)
  const p = v.properties[0]
  const stamp = new Date(Date.now() - 40 * 3600 * 1000)
  await db.query(`UPDATE properties SET last_confirmed_available_at=$2, available_status='available_confirmed' WHERE id=$1`, [p.id, stamp])
  const same = async () => (await db.query(`SELECT last_confirmed_available_at t FROM properties WHERE id=$1`, [p.id])).rows[0].t.getTime()
  for (const outcome of ['ask_later', 'temporarily_held', 'reserved']) {
    const r = await S.applyInboundEvent(evt('availability.answered', { linkId: v.linkId, externalId: v.externalIds[0], outcome }))
    assert.equal(r.result.countedAsConfirmation, false)
    assert.equal(await same(), stamp.getTime(), outcome)
  }
  // unrelated owner activity: a permission change, a dispute on another matter, an owner sync
  await S.applyInboundEvent(evt('distribution.granted', { linkId: v.linkId, externalId: v.externalIds[0], channel: 'origin_agency', scopes: ['approved_answers'] }))
  await S.syncOwner(v.owner.id, admin)
  assert.equal(await same(), stamp.getTime())
  // "rented" does not confirm availability and does not flip the listing public state on the owner's word alone
  const r = await S.applyInboundEvent(evt('availability.answered', { linkId: v.linkId, externalId: v.externalIds[0], outcome: 'rented' }))
  assert.equal(r.result.countedAsConfirmation, false)
  const { rows: [row] } = await db.query(`SELECT available_status s, last_confirmed_available_at t FROM properties WHERE id=$1`, [p.id])
  assert.equal(row.s, 'pending_check'); assert.equal(row.t.getTime(), stamp.getTime())
  assert.equal((await db.query(`SELECT COUNT(*)::int n FROM owner_availability_answers WHERE property_id=$1`, [p.id])).rows[0].n, 4)
  assert.equal((await S.status(v.owner.id, admin)).properties[0].statuses.freshness.state, 'reconfirmation_approaching')
})

test('freshness ladder: recent → approaching → overdue → unknown; an expired window never marks a listing unavailable', () => {
  const now = new Date('2026-11-11T12:00:00Z'), h = n => new Date(now.getTime() - n * 3600 * 1000)
  const cfg = F.settings({})
  assert.deepEqual([cfg.intervalHours, cfg.approachingHours, cfg.staleHours], [48, 36, 336])
  assert.equal(F.classify(h(2), { now }).state, 'recently_confirmed')
  assert.equal(F.classify(h(40), { now }).state, 'reconfirmation_approaching')
  assert.equal(F.classify(h(72), { now }).state, 'confirmation_overdue')
  assert.equal(F.classify(h(24 * 20), { now }).state, 'unknown_stale')
  assert.equal(F.classify(null, { now }).state, 'unknown_stale')
  assert.equal(F.classify(h(2), { now, settings: F.settings({ NEXUS_AVAILABILITY_INTERVAL_HOURS: '1' }) }).state, 'confirmation_overdue')
  assert.equal(Object.keys(F).includes('markUnavailable'), false)
})

test('15 · retries are idempotent: no duplicate owners, properties, links or events', async () => {
  let fail = true
  const calls = receiverStub({ status: () => (fail ? 503 : 200) })
  const v = await verifiedOwner(admin, { props: 2 })
  const first = await S.syncProperties(v.owner.id, admin)
  assert.equal(first.delivery.failed, 2)
  let st = await S.status(v.owner.id, admin)
  assert.deepEqual(st.properties.map(p => p.statuses.sync), ['error', 'error']); assert.equal(st.queue.errors, 2)
  // pressing Sync again while it is failing queues nothing new
  await S.syncProperties(v.owner.id, admin); await S.syncProperties(v.owner.id, admin)
  assert.equal((await db.query(`SELECT COUNT(*)::int n FROM nexus_sync_outbox WHERE state <> 'superseded'`)).rows[0].n, 2)
  fail = false
  const retry = await S.retrySync(v.owner.id, admin)
  assert.equal(retry.retried, 2); assert.equal(retry.delivery.delivered, 2)
  // the receiver saw the SAME idempotency keys on every attempt
  const keys = new Set(calls.map(c => c.body.idempotencyKey)); assert.equal(keys.size, 2)
  const ids = new Set(calls.map(c => c.body.eventId)); assert.equal(ids.size, 2)
  // unchanged content afterwards → nothing to send
  const again = await S.syncProperties(v.owner.id, admin)
  assert.deepEqual(again.properties.map(p => p.unchanged), [true, true]); assert.equal(again.delivery, null)
  assert.equal((await S.retrySync(v.owner.id, admin)).retried, 0)
  assert.equal(await count('nexus_owner_links'), 1); assert.equal(await count('nexus_property_links'), 2)
  st = await S.status(v.owner.id, admin)
  assert.deepEqual(st.properties.map(p => p.statuses.sync), ['synced', 'synced'])
  // a 4xx from NEXUS is a permanent refusal: not retried automatically
  await db.query(`UPDATE properties SET bedrooms=3 WHERE id=$1`, [v.properties[0].id])
  receiverStub({ status: 422, body: () => ({ error: 'VALIDATION_FAILED' }) })
  const refused = await S.syncProperties(v.owner.id, admin)
  assert.equal(refused.delivery.failed, 1)
  assert.equal((await db.query(`SELECT state, last_error FROM nexus_sync_outbox ORDER BY id DESC LIMIT 1`)).rows[0].state, 'dead')
})

test('NEXUS sync is reported as pending — never as synced — while no receiver is configured', async () => {
  const v = await verifiedOwner(admin)
  const out = await S.syncProperties(v.owner.id, admin)
  assert.equal(out.delivery.receiverConfigured, false); assert.equal(out.delivery.delivered, 0); assert.equal(out.delivery.pending, 1)
  const st = await S.status(v.owner.id, admin)
  assert.equal(st.receiver.configured, false); assert.match(st.receiver.note, /not connected/)
  assert.equal(st.properties[0].statuses.sync, 'pending'); assert.equal(st.properties[0].statuses.linked, false)
  assert.equal(st.queue.waiting, 1)
  // an http:// receiver or a short secret is not a receiver
  process.env.NEXUS_OWNER_LINK_URL = 'http://nexus.test/x'; process.env.NEXUS_LINK_OUTBOUND_SECRET = 'x'.repeat(40)
  assert.equal(S.receiver().configured, false)
})

test('verification is explicit; disputes block sync until resolved and re-verified', async () => {
  const calls = receiverStub()
  const o = await H.owner(); await H.property(o.id)
  const { invitation } = await S.createInvitation(o.id, admin)
  await assert.rejects(S.verifyOwner(o.id, admin, { method: 'call' }), e => e.code === 'NOT_CLAIMED')
  const r = await S.resolveInvitation(tokenOf(invitation.url))
  await S.applyInboundEvent(evt('owner.claim_submitted', { token: tokenOf(invitation.url), nexusAccountRef: 'nxo_disputer', decisions: [{ externalId: r.properties[0].externalId, decision: 'reject', note: 'sold in 2025' }] }))
  await assert.rejects(S.verifyOwner(o.id, admin, {}), e => e.code === 'VERIFICATION_METHOD_REQUIRED')
  await S.verifyOwner(o.id, admin, { method: 'contract on file' })
  let st = await S.status(o.id, admin)
  assert.equal(st.properties[0].statuses.ownerReview, 'rejected')
  assert.ok(st.properties[0].blockedReasons.includes('OWNER_CLAIM_REJECTED'))
  // the used invitation cannot be replayed
  await assert.rejects(S.applyInboundEvent(evt('owner.claim_submitted', { token: tokenOf(invitation.url), nexusAccountRef: 'nxo_someone_else', decisions: [] })), e => e.code === 'INVITATION_CONSUMED')
  await S.applyInboundEvent(evt('owner.dispute_opened', { linkId: r.owner.linkId, reason: 'Not my profile' }))
  st = await S.status(o.id, admin)
  assert.equal(st.link.state, 'disputed')
  assert.deepEqual((await S.syncOwner(o.id, admin)).blockedReasons, ['OWNER_LINK_DISPUTED'])
  await assert.rejects(S.verifyOwner(o.id, admin, { method: 'x' }), e => e.code === 'LINK_DISPUTED')
  await S.resolveDispute(o.id, admin, { note: 'Owner confirmed by phone, wrong tap' })
  assert.equal((await S.status(o.id, admin)).link.state, 'claim_pending')
  assert.equal(calls.length, 0)
})

test('inbound events: version, id reuse and unknown types are rejected; every action is audited', async () => {
  const v = await verifiedOwner(admin)
  await assert.rejects(S.applyInboundEvent({ ...evt('distribution.revoked', { linkId: v.linkId, externalId: v.externalIds[0] }), contractVersion: '2025-01-01.v0' }), e => e.code === 'CONTRACT_VERSION_UNSUPPORTED')
  await assert.rejects(S.applyInboundEvent(evt('owner.deleted', {})), e => e.code === 'EVENT_TYPE_UNKNOWN')
  const e1 = evt('availability.answered', { linkId: v.linkId, externalId: v.externalIds[0], outcome: 'ask_later' })
  await S.applyInboundEvent(e1)
  await assert.rejects(S.applyInboundEvent({ ...e1, data: { ...e1.data, outcome: 'available' } }), e => e.code === 'EVENT_ID_REUSED')
  // a failed event leaves no trace and can be retried
  const bad = evt('distribution.granted', { linkId: v.linkId, externalId: v.externalIds[0], channel: 'selected_agency', scopes: ['listing_data'] })
  await assert.rejects(S.applyInboundEvent(bad), e => e.code === 'AUDIENCE_REQUIRED')
  assert.equal((await db.query(`SELECT COUNT(*)::int n FROM nexus_inbound_events WHERE event_id=$1`, [bad.eventId])).rows[0].n, 0)
  const { rows } = await db.query(`SELECT DISTINCT action_type FROM agent_activity_log WHERE action_type LIKE 'NEXUS_%' ORDER BY 1`)
  for (const a of ['NEXUS_OWNER_INVITE_CREATED', 'NEXUS_OWNER_CLAIM_SUBMITTED', 'NEXUS_OWNER_VERIFIED', 'NEXUS_DISTRIBUTION_GRANTED']) assert.ok(rows.some(r => r.action_type === a), a)
})
