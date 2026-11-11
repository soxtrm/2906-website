'use strict'
// Scheduler, due-release handling, system revocation and smart defaults
// (Claude, 2026-11-12, queue addendum 01). Real Postgres, stub NEXUS receiver.
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')

process.env.JWT_SECRET = 'test-jwt-secret-not-production'
const H = require('./helpers/harness')
const S = H.load('services/nexusOwnerLink')
const R = H.load('services/nexusDistributionRouting')
const D = H.load('services/nexusSmartDefaults')
const T = H.load('services/nexusLinkScheduler')
const { db } = H

const evt = (eventType, data) => ({ eventId: `evt-${crypto.randomBytes(12).toString('hex')}`, eventType, contractVersion: S.CONTRACT_VERSION, agencyKey: '2906', occurredAt: new Date().toISOString(), data })
const outbox = async type => (await db.query(`SELECT * FROM nexus_sync_outbox WHERE event_type=$1 AND state <> 'superseded' ORDER BY id`, [type])).rows
const routeOf = async id => (await db.query(`SELECT * FROM nexus_distribution_routes WHERE property_id=$1 ORDER BY id DESC LIMIT 1`, [id])).rows[0]

let admin
async function listing({ mode = 'immediate', approve = true } = {}) {
  const owner = await H.owner()
  const p = await H.property(owner.id, { listed_by_agent_id: admin.id })
  const { invitation } = await S.createInvitation(owner.id, admin)
  const token = invitation.url.split('#t=')[1]
  const r = await S.resolveInvitation(token)
  const ext = r.properties[0].externalId
  await S.applyInboundEvent(evt('owner.claim_submitted', { token, nexusAccountRef: `nxo_${crypto.randomBytes(6).toString('hex')}`, decisions: [{ externalId: ext, decision: 'confirm' }] }))
  await S.verifyOwner(owner.id, admin, { method: 'test' })
  await S.applyInboundEvent(evt('distribution.granted', { linkId: r.owner.linkId, externalId: ext, channel: 'all_eligible_agencies', scopes: ['listing_data'] }))
  await R.setRoute(p.id, admin, mode === 'immediate' ? { mode, audienceType: 'all_eligible_agencies' } : { mode: 'delay_days', delayDays: 7, audienceType: 'all_eligible_agencies' })
  if (approve) await R.approveRelease(p.id, admin)
  return { owner, p, ext, linkId: r.owner.linkId }
}
function receiverOn(handler) {
  process.env.NEXUS_OWNER_LINK_URL = 'https://nexus.invalid/bridge'
  process.env.NEXUS_LINK_OUTBOUND_SECRET = 'outbound-secret-0123456789abcdef0123456789'
  const seen = []
  S.setTransport(async (url, init) => { const body = JSON.parse(init.body); seen.push(body); const r = handler ? handler(body) : { status: 200, json: {} }; return { status: r.status, json: async () => r.json } })
  return seen
}
function receiverOff() { delete process.env.NEXUS_OWNER_LINK_URL; delete process.env.NEXUS_LINK_OUTBOUND_SECRET; delete process.env.NEXUS_LINK_ROUTING_EVENTS }

test.before(async () => { await H.migrate(); await H.reset(); admin = await H.agent('admin') })
test.beforeEach(async () => { await H.reset(); receiverOff() })
test.after(async () => { T.stop(); receiverOff(); await H.reset() })

test('the scheduler is off unless explicitly enabled, and one pass releases what is due', async () => {
  assert.deepEqual(T.start({}), { started: false, reason: 'NEXUS_LINK_SCHEDULER is not 1' })
  assert.equal(T.intervalMs({}), 300000)
  assert.equal(T.intervalMs({ NEXUS_LINK_SCHEDULER_SECONDS: '5' }), 300000) // below the 30 s floor → default
  assert.equal(T.intervalMs({ NEXUS_LINK_SCHEDULER_SECONDS: '60' }), 60000)
  const started = T.start({ NEXUS_LINK_SCHEDULER: '1', NEXUS_LINK_SCHEDULER_SECONDS: '3600' })
  assert.deepEqual(started, { started: true, everySeconds: 3600 })
  assert.equal(T.start({ NEXUS_LINK_SCHEDULER: '1' }).already, true)
  T.stop()

  const a = await listing()
  const later = await listing({ mode: 'delay_days' })
  const pass = await T.runOnce()
  assert.equal(pass.routing.released, 1)
  assert.equal(pass.delivery.receiverConfigured, false) // nothing is sent anywhere without a receiver
  assert.equal((await routeOf(a.p.id)).release_state, 'released')
  assert.equal((await routeOf(later.p.id)).release_state, 'scheduled')
  // overlapping passes do not double-release
  const many = await Promise.all([T.runOnce(), T.runOnce(), T.runOnce()])
  assert.ok(many.some(r => r.skipped))
  assert.equal((await outbox('distribution.released')).length, 1)
})

test('a listing that ends before its release date: the rule is revoked by the system, nothing is sent', async () => {
  const rented = await listing(); const archived = await listing(); const fine = await listing()
  await db.query(`UPDATE properties SET available_status='rented' WHERE id=$1`, [rented.p.id])
  await db.query(`UPDATE properties SET archived_at=NOW() WHERE id=$1`, [archived.p.id])
  const out = await R.processDueReleases()
  assert.deepEqual({ released: out.released, revokedEnded: out.revokedEnded, errors: out.errors }, { released: 1, revokedEnded: 2, errors: 0 })
  for (const l of [rented, archived]) {
    const r = await routeOf(l.p.id)
    assert.deepEqual([r.release_state, r.revoked_by], ['revoked', 'system'])
  }
  assert.equal((await routeOf(fine.p.id)).release_state, 'released')
  assert.equal((await outbox('distribution.released')).length, 1)
  assert.equal((await outbox('distribution.release_revoked')).length, 0)
  // back on the market later: the old rule does not come back by itself
  await db.query(`UPDATE properties SET available_status='available' WHERE id=$1`, [rented.p.id])
  assert.equal((await R.tick()).released, 0)
})

test('a released listing that is later rented or archived is taken back exactly once; a temporary state is left alone', async () => {
  const rented = await listing(); const archived = await listing(); const check = await listing()
  assert.equal((await R.tick()).released, 3)
  await db.query(`UPDATE properties SET available_status='rented' WHERE id=$1`, [rented.p.id])
  await db.query(`UPDATE properties SET archived_at=NOW() WHERE id=$1`, [archived.p.id])
  await db.query(`UPDATE properties SET available_status='pending_check' WHERE id=$1`, [check.p.id])
  const runs = await Promise.all([R.tick(), R.tick()])
  assert.equal(runs.reduce((n, r) => n + r.withdrawnEnded, 0), 2)
  assert.equal((await R.tick()).withdrawnEnded, 0)
  const revoked = await outbox('distribution.release_revoked')
  assert.deepEqual(revoked.map(e => e.payload.externalId).sort(), [rented.ext, archived.ext].sort())
  assert.ok(revoked.every(e => e.payload.revokedBy === 'system'))
  assert.equal((await routeOf(check.p.id)).release_state, 'released')
})

test('one broken route does not stop the others; held routes do not starve newer ones', async () => {
  const held = []
  for (let i = 0; i < 3; i++) { const l = await listing(); await db.query(`UPDATE properties SET available_status='pending_check' WHERE id=$1`, [l.p.id]); held.push(l) }
  const good = await listing()
  // With room for only two routes per pass, the held ones are looked at first …
  assert.deepEqual(await R.processDueReleases({ limit: 2 }).then(r => [r.heldOffMarket, r.released]), [2, 0])
  // … and then make way: the next pass reaches the releasable one.
  assert.equal((await R.processDueReleases({ limit: 2 })).released, 1)
  assert.equal((await routeOf(good.p.id)).release_state, 'released')

  // A route whose release cannot be written (its link id is taken by another listing) is counted, not fatal.
  const broken = await listing(); const ok = await listing(); const spare = await listing({ approve: false })
  await db.query(`DELETE FROM nexus_property_links WHERE property_id=$1`, [broken.p.id])
  await db.query(`UPDATE nexus_property_links SET external_id=$2 WHERE property_id=$1`, [spare.p.id, broken.ext])
  const out = await R.processDueReleases()
  assert.equal(out.errors, 1)
  assert.equal((await routeOf(ok.p.id)).release_state, 'released')
  assert.equal((await routeOf(broken.p.id)).release_state, 'scheduled')
})

test('routing events are held, not dead-lettered, until NEXUS consumes them; they never disturb the listing sync state', async () => {
  const a = await listing()
  await R.tick()
  const seen = receiverOn(body => (body.eventType.startsWith('distribution.') ? { status: 400, json: { message: 'Unsupported ARGUS event or contract version.' } } : { status: 200, json: { canonicalPropertyId: 'c0ffee00-0000-4000-8000-000000000001', publicationState: 'unpublished' } }))
  // Default: Stage A does not know routing events → they wait.
  const sync = await S.syncProperties(a.owner.id, admin)
  assert.equal(sync.delivery.delivered, 1); assert.equal(sync.delivery.heldRoutingEvents, 1)
  assert.deepEqual(seen.map(b => b.eventType), ['property.upserted'])
  assert.equal((await outbox('distribution.released'))[0].state, 'pending')
  const before = (await db.query(`SELECT sync_state, last_payload_hash, publication_state FROM nexus_property_links WHERE property_id=$1`, [a.p.id])).rows[0]
  assert.equal(before.sync_state, 'synced')

  // Switched on against a receiver that still refuses them: the refusal is recorded with NEXUS's own words.
  process.env.NEXUS_LINK_ROUTING_EVENTS = '1'
  const refused = await S.deliverDue()
  assert.equal(refused.failed, 1)
  assert.match((await outbox('distribution.released'))[0].last_error, /HTTP 400 Unsupported ARGUS event/)

  // Against a receiver that accepts them: delivered, and the listing's own sync facts are untouched.
  receiverOn()
  process.env.NEXUS_LINK_ROUTING_EVENTS = '1'
  assert.equal((await S.retrySync(a.owner.id, admin)).delivery.delivered, 1)
  const after = (await db.query(`SELECT sync_state, last_payload_hash, publication_state FROM nexus_property_links WHERE property_id=$1`, [a.p.id])).rows[0]
  assert.equal(after.last_payload_hash, before.last_payload_hash)
  assert.equal(after.publication_state, before.publication_state)
  assert.equal((await S.syncProperties(a.owner.id, admin)).properties[0].unchanged, true)
})

test('smart defaults: harmless suggestions with a reason, and no decision is ever prefilled', async () => {
  const l = await listing({ mode: 'delay_days', approve: false })
  const fresh = await H.agent('admin')
  const std = await D.routeDefaults(db, fresh, { now: new Date('2026-11-13T10:00:00Z') }) // a Friday
  const by = f => std.suggestions.find(s => s.field === f)
  assert.equal(by('mode').value, 'none')
  assert.deepEqual([by('delayDays').value, by('delayDays').source], [7, 'standard'])
  // Friday → Monday 09:00 Malta (CET, UTC+1)
  assert.equal(by('releaseAt').value, '2026-11-16T08:00:00.000Z')
  // summer time: Tuesday → Wednesday 09:00 CEST = 07:00Z
  assert.equal(D.nextWorkingMorning(new Date('2026-07-14T10:00:00Z')).toISOString(), '2026-07-15T07:00:00.000Z')
  assert.ok(std.suggestions.every(s => s.explain && s.source))

  // "Smart": the agent's own last delay is offered, and says so.
  await R.setRoute(l.p.id, admin, { mode: 'delay_days', delayDays: 10, audienceType: 'all_eligible_agencies' })
  const mine = (await D.routeDefaults(db, admin)).suggestions.find(s => s.field === 'delayDays')
  assert.deepEqual([mine.value, mine.source], [10, 'your_last_rule'])
  assert.equal((await D.routeDefaults(db, fresh)).suggestions.find(s => s.field === 'delayDays').value, 7) // not another agent's habit

  // No suggestion exists for any decision field, and the builder refuses to make one.
  const decision = ['audienceType', 'audienceRefs', 'commercialTermsRef', 'approveRelease', 'verificationMethod', 'ownerDistribution', 'ownerContactSharing']
  assert.deepEqual(std.neverPreselected.map(f => f.field).sort(), [...decision].sort())
  assert.ok(std.suggestions.every(s => !decision.includes(s.field)))
  for (const f of decision) assert.throws(() => D.suggestion(f, 'x', 'standard', 'x'), /never be preselected/)

  // Applying every suggestion verbatim shares nothing and cannot be approved.
  const body = Object.fromEntries(std.suggestions.map(s => [s.field, s.value]))
  const saved = await R.setRoute(l.p.id, admin, body)
  assert.deepEqual([saved.route.mode, saved.route.audienceType, saved.route.state], ['none', 'none', 'draft'])
  await assert.rejects(R.approveRelease(l.p.id, admin), e => e.code === 'ROUTE_IS_NONE')
  // The server fills nothing in: a sharing mode without an audience is refused.
  await assert.rejects(R.setRoute(l.p.id, admin, { mode: 'delay_days', delayDays: 7 }), e => e.code === 'AUDIENCE_REQUIRED')
  // The form receives the defaults together with the rule.
  assert.equal((await R.getRoute(l.p.id, admin)).defaults.suggestions.length, 3)

  const ans = D.availabilityAnswerDefaults({ now: new Date('2026-11-12T00:00:00Z') })
  assert.equal(ans.suggestions[0].value, '2026-11-14T00:00:00.000Z')
  assert.deepEqual(ans.neverPreselected.map(f => f.field), ['outcome', 'availableFrom'])
})
