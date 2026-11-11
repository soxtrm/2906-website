'use strict'
// Agency distribution routing — delayed release, owner authorisation, revocation
// (Claude, 2026-11-11, queue addendum 01). Real Postgres, stub NEXUS receiver.
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')

process.env.JWT_SECRET = 'test-jwt-secret-not-production'
delete process.env.NEXUS_OWNER_LINK_URL
delete process.env.NEXUS_LINK_OUTBOUND_SECRET
const H = require('./helpers/harness')
const S = H.load('services/nexusOwnerLink')
const R = H.load('services/nexusDistributionRouting')
const { db } = H

const DAY = 86400000
const evt = (eventType, data) => ({ eventId: `evt-${crypto.randomBytes(12).toString('hex')}`, eventType, contractVersion: S.CONTRACT_VERSION, agencyKey: '2906', occurredAt: new Date().toISOString(), data })
const outbox = async type => (await db.query(`SELECT * FROM nexus_sync_outbox WHERE event_type=$1 AND state <> 'superseded' ORDER BY id`, [type])).rows
const routeRow = async id => (await db.query(`SELECT * FROM nexus_distribution_routes WHERE property_id=$1 AND release_state <> 'revoked'`, [id])).rows[0]
const at = ms => new Date(Date.now() + ms).toISOString()

let admin
// invite → claim → verify; optionally grant channels. Returns { owner, p, linkId, ext }.
async function listing({ channels = [], fields = {} } = {}) {
  const owner = await H.owner()
  const p = await H.property(owner.id, { listed_by_agent_id: admin.id, ...fields })
  const { invitation } = await S.createInvitation(owner.id, admin)
  const token = invitation.url.split('#t=')[1]
  const r = await S.resolveInvitation(token)
  const ext = r.properties[0].externalId
  await S.applyInboundEvent(evt('owner.claim_submitted', { token, nexusAccountRef: `nxo_${crypto.randomBytes(6).toString('hex')}`, decisions: [{ externalId: ext, decision: 'confirm' }] }))
  await S.verifyOwner(owner.id, admin, { method: 'test' })
  for (const c of channels) await grant(r.owner.linkId, ext, c)
  return { owner, p, linkId: r.owner.linkId, ext }
}
const grant = (linkId, externalId, c) => S.applyInboundEvent(evt('distribution.granted', { linkId, externalId, ...(typeof c === 'string' ? { channel: c } : c), scopes: ['listing_data'] }))

test.before(async () => { await H.migrate(); await H.reset(); admin = await H.agent('admin') })
test.beforeEach(async () => { await H.reset() })
test.after(async () => { await H.reset() })

test('no rule exists by default, and the offered default is "no external distribution"', async () => {
  const { p } = await listing({ channels: ['all_eligible_agencies'] })
  const g = await R.getRoute(p.id, admin)
  assert.equal(g.route.state, 'none'); assert.equal(g.route.mode, 'none')
  assert.equal(g.options.defaultMode, 'none')
  assert.equal((await db.query(`SELECT COUNT(*)::int n FROM nexus_distribution_routes`)).rows[0].n, 0)
  // even with the owner's blanket authorisation nothing is released without an agency rule
  assert.deepEqual(await R.processDueReleases(), { due: 0, released: 0, waitingForOwner: 0, heldOffMarket: 0, revokedEnded: 0, errors: 0 })
  assert.equal((await outbox('distribution.released')).length, 0)
  // every option carries an explanation
  for (const m of g.options.modes) assert.ok(m.explain.length > 20, m.mode)
  await assert.rejects(R.setRoute(p.id, admin, {}), e => e.code === 'MODE_REQUIRED')
  await assert.rejects(R.setRoute(p.id, admin, { mode: 'immediate' }), e => e.code === 'AUDIENCE_REQUIRED')
})

test('seven-day routing: the delay counts from the agency approval, not from creation or sync', async () => {
  const { p, owner } = await listing({ channels: ['all_eligible_agencies'] })
  // the listing was imported and synced long ago — irrelevant for the clock
  await db.query(`UPDATE properties SET created_at = NOW() - interval '60 days' WHERE id=$1`, [p.id])
  await S.syncProperties(owner.id, admin)
  const saved = await R.setRoute(p.id, admin, { mode: 'delay_days', delayDays: 7, audienceType: 'all_eligible_agencies', commercialTermsRef: 'AGR-2026-014' })
  assert.equal(saved.route.state, 'draft'); assert.equal(saved.route.approvedReleaseAt, null)
  // a draft is never released, however old
  assert.equal((await R.processDueReleases({ now: at(30 * DAY) })).due, 0)
  const ap = await R.approveRelease(p.id, admin)
  assert.equal(ap.route.state, 'scheduled')
  const approved = new Date(ap.route.approvedReleaseAt).getTime(), scheduled = new Date(ap.route.scheduledReleaseAt).getTime()
  assert.equal(scheduled - approved, 7 * DAY)
  assert.ok(Math.abs(approved - Date.now()) < 60000)
  // approving again does not restart the clock
  const again = await R.approveRelease(p.id, admin)
  assert.equal(again.changed, false); assert.equal(new Date(again.route.scheduledReleaseAt).getTime(), scheduled)
  // day 6: nothing. day 7: released, exactly once.
  assert.deepEqual(await R.processDueReleases({ now: at(6 * DAY) }), { due: 0, released: 0, waitingForOwner: 0, heldOffMarket: 0, revokedEnded: 0, errors: 0 })
  assert.equal((await R.processDueReleases({ now: at(7 * DAY + 60000) })).released, 1)
  assert.equal((await R.processDueReleases({ now: at(8 * DAY) })).due, 0)
  const [ev, ...rest] = await outbox('distribution.released')
  assert.equal(rest.length, 0)
  assert.equal(ev.payload.audienceType, 'all_eligible_agencies'); assert.equal(ev.payload.commercialTermsRef, 'AGR-2026-014')
  assert.equal(ev.payload.originAgency, '2906'); assert.equal(ev.payload.originAgentId, admin.id)
  assert.equal(new Date(ev.payload.approvedReleaseAt).getTime(), approved)
  assert.equal((await routeRow(p.id)).release_state, 'released')
})

test('immediate, custom date and selected agencies', async () => {
  const a = await listing({ channels: ['all_eligible_agencies'] })
  await R.setRoute(a.p.id, admin, { mode: 'immediate', audienceType: 'all_eligible_agencies' })
  await R.approveRelease(a.p.id, admin)
  assert.equal((await R.processDueReleases()).released, 1)

  const b = await listing({ channels: [{ channel: 'selected_agency', audienceRef: 'agency-a' }] })
  await assert.rejects(R.setRoute(b.p.id, admin, { mode: 'release_at', releaseAt: at(-DAY), audienceType: 'selected_agencies', audienceRefs: ['agency-a'] }), e => e.code === 'RELEASE_AT_INVALID')
  await assert.rejects(R.setRoute(b.p.id, admin, { mode: 'release_at', releaseAt: at(3 * DAY), audienceType: 'selected_agencies', audienceRefs: [] }), e => e.code === 'AUDIENCE_REFS_INVALID')
  // the owner authorised agency-a only → a route to a + b must wait
  await R.setRoute(b.p.id, admin, { mode: 'release_at', releaseAt: at(3 * DAY), audienceType: 'selected_agencies', audienceRefs: ['agency-a', 'agency-b'] })
  assert.equal((await R.approveRelease(b.p.id, admin)).route.state, 'awaiting_owner_authorization')
  await grant(b.linkId, b.ext, { channel: 'selected_agency', audienceRef: 'agency-b' })
  assert.equal((await routeRow(b.p.id)).release_state, 'scheduled')
  assert.equal((await R.processDueReleases({ now: at(2 * DAY) })).released, 0)
  assert.equal((await R.processDueReleases({ now: at(3 * DAY + 60000) })).released, 1)
  assert.deepEqual((await outbox('distribution.released')).at(-1).payload.audienceRefs, ['agency-a', 'agency-b'])
})

test('a valid agency rule never overrides missing owner authorisation', async () => {
  // verified owner, but no distribution grant at all
  const { p, linkId, ext } = await listing()
  await R.setRoute(p.id, admin, { mode: 'immediate', audienceType: 'all_eligible_agencies' })
  const ap = await R.approveRelease(p.id, admin)
  assert.equal(ap.route.state, 'awaiting_owner_authorization')
  assert.equal((await R.processDueReleases({ now: at(365 * DAY) })).due, 0)
  assert.equal((await outbox('distribution.released')).length, 0)
  assert.equal((await R.getRoute(p.id, admin)).route.ownerAuthorised, false)
  // a grant for a DIFFERENT audience does not help
  await grant(linkId, ext, 'nexus_direct_from_owner')
  assert.equal((await routeRow(p.id)).release_state, 'awaiting_owner_authorization')
  // the right grant arrives late: the agency's clock is not restarted, it is already due
  await grant(linkId, ext, 'all_eligible_agencies')
  assert.equal((await routeRow(p.id)).release_state, 'scheduled')
  assert.equal((await R.processDueReleases()).released, 1)

  // an owner who is not verified at all: same answer
  const o = await H.owner(); const raw = await H.property(o.id, { listed_by_agent_id: admin.id })
  await R.setRoute(raw.id, admin, { mode: 'immediate', audienceType: 'independent_agents' })
  assert.equal((await R.approveRelease(raw.id, admin)).route.state, 'awaiting_owner_authorization')
})

test('authorisation is re-checked at release time; off-market listings are not released', async () => {
  const a = await listing({ channels: ['all_eligible_agencies'] })
  await R.setRoute(a.p.id, admin, { mode: 'delay_days', delayDays: 7, audienceType: 'all_eligible_agencies' })
  await R.approveRelease(a.p.id, admin)
  // the owner withdraws on day 3
  await S.applyInboundEvent(evt('distribution.revoked', { linkId: a.linkId, externalId: a.ext }))
  assert.equal((await routeRow(a.p.id)).release_state, 'awaiting_owner_authorization')
  assert.equal((await R.processDueReleases({ now: at(8 * DAY) })).released, 0)

  const b = await listing({ channels: ['all_eligible_agencies'] })
  await R.setRoute(b.p.id, admin, { mode: 'immediate', audienceType: 'all_eligible_agencies' })
  await R.approveRelease(b.p.id, admin)
  // "Rented?" is a temporary state: the route waits, it is not cancelled.
  await db.query(`UPDATE properties SET available_status='pending_check' WHERE id=$1`, [b.p.id])
  assert.deepEqual(await R.processDueReleases(), { due: 1, released: 0, waitingForOwner: 0, heldOffMarket: 1, revokedEnded: 0, errors: 0 })
  assert.equal((await outbox('distribution.released')).length, 0)
  await db.query(`UPDATE properties SET available_status='available' WHERE id=$1`, [b.p.id])
  assert.equal((await R.processDueReleases()).released, 1)
})

test('revocation: by the agency before and after release, and by the owner after release', async () => {
  // before release: nothing was shared, nothing to withdraw
  const a = await listing({ channels: ['all_eligible_agencies'] })
  await R.setRoute(a.p.id, admin, { mode: 'delay_days', delayDays: 7, audienceType: 'all_eligible_agencies' })
  await R.approveRelease(a.p.id, admin)
  const r1 = await R.revokeRoute(a.p.id, admin, 'owner asked us to wait')
  assert.equal(r1.route.state, 'revoked'); assert.equal(r1.withdrawalQueued, false)
  assert.equal((await R.processDueReleases({ now: at(30 * DAY) })).due, 0)
  assert.equal((await R.getRoute(a.p.id, admin)).route.state, 'none')
  assert.equal((await R.getRoute(a.p.id, admin)).history.length, 1)

  // after release, agency revokes → NEXUS is told
  const b = await listing({ channels: ['all_eligible_agencies'] })
  await R.setRoute(b.p.id, admin, { mode: 'immediate', audienceType: 'all_eligible_agencies' })
  await R.approveRelease(b.p.id, admin); await R.processDueReleases()
  await assert.rejects(R.setRoute(b.p.id, admin, { mode: 'none' }), e => e.code === 'ALREADY_RELEASED')
  const r2 = await R.revokeRoute(b.p.id, admin, 'exclusive mandate signed')
  assert.equal(r2.withdrawalQueued, true)
  const rev = (await outbox('distribution.release_revoked')).filter(e => e.payload.externalId === b.ext)
  assert.equal(rev.length, 1); assert.equal(rev[0].payload.revokedBy, 'agency')
  await assert.rejects(R.revokeRoute(b.p.id, admin, 'again'), e => e.code === 'NO_ROUTE')

  // after release, the owner withdraws → revoked by owner, one withdrawal each
  const c = await listing({ channels: ['all_eligible_agencies'] })
  await R.setRoute(c.p.id, admin, { mode: 'immediate', audienceType: 'all_eligible_agencies' })
  await R.approveRelease(c.p.id, admin); await R.processDueReleases()
  await S.applyInboundEvent(evt('distribution.revoked', { linkId: c.linkId, externalId: c.ext }))
  const { rows: [row] } = await db.query(`SELECT release_state, revoked_by FROM nexus_distribution_routes WHERE property_id=$1`, [c.p.id])
  assert.deepEqual([row.release_state, row.revoked_by], ['revoked', 'owner'])
  assert.equal((await outbox('distribution.release_revoked')).filter(e => e.payload.externalId === c.ext).length, 1)
  // a new rule can be drafted afterwards, but it starts from scratch
  assert.equal((await R.setRoute(c.p.id, admin, { mode: 'none' })).route.state, 'draft')
  await assert.rejects(R.approveRelease(c.p.id, admin), e => e.code === 'ROUTE_IS_NONE')
})

test('release is durable and idempotent under concurrent ticks', async () => {
  const items = []
  for (let i = 0; i < 4; i++) {
    const l = await listing({ channels: ['all_eligible_agencies'] })
    await R.setRoute(l.p.id, admin, { mode: 'immediate', audienceType: 'all_eligible_agencies' })
    await R.approveRelease(l.p.id, admin)
    items.push(l)
  }
  // "restart": the schedule lives in the table, a fresh module instance sees it
  delete require.cache[require.resolve(require('path').join(H.ROOT, 'services', 'nexusDistributionRouting.js'))]
  const R2 = H.load('services/nexusDistributionRouting')
  const runs = await Promise.all([R2.processDueReleases(), R.processDueReleases(), R2.processDueReleases(), R.processDueReleases()])
  assert.equal(runs.reduce((n, r) => n + r.released, 0), 4)
  assert.equal((await outbox('distribution.released')).length, 4)
  assert.equal(new Set((await outbox('distribution.released')).map(e => e.payload.routeId)).size, 4)
  assert.equal((await db.query(`SELECT COUNT(*)::int n FROM nexus_distribution_routes WHERE release_state='released'`)).rows[0].n, 4)
})

test('only an admin or the listing agent may route a listing; one current rule per listing', async () => {
  const other = await H.agent('agent', { nexus_owner_link: true })
  const { p } = await listing({ channels: ['all_eligible_agencies'] })
  await assert.rejects(R.setRoute(p.id, other, { mode: 'immediate', audienceType: 'all_eligible_agencies' }), e => e.code === 'NOT_LISTING_AGENT' && e.status === 403)
  assert.equal((await R.getRoute(p.id, other)).canEdit, false)
  await R.setRoute(p.id, admin, { mode: 'delay_days', delayDays: 7, audienceType: 'all_eligible_agencies' })
  await R.setRoute(p.id, admin, { mode: 'delay_days', delayDays: 14, audienceType: 'approved_large_agencies' })
  assert.equal((await db.query(`SELECT COUNT(*)::int n FROM nexus_distribution_routes WHERE property_id=$1 AND release_state <> 'revoked'`, [p.id])).rows[0].n, 1)
  assert.equal((await routeRow(p.id)).delay_days, 14)
  await assert.rejects(R.approveRelease(p.id, other), e => e.code === 'NOT_LISTING_AGENT')
  await assert.rejects(R.setRoute(999999999, admin, { mode: 'none' }), e => e.code === 'PROPERTY_NOT_FOUND')
})
