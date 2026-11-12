'use strict'
// Integration gate on HOSTED staging (Claude, 2026-11-13).
// Runs inside the staging network (see ../gate.sh). Talks to the two running
// staging services over HTTPS only, as an owner, as professionals and as staff
// would; uses the two staging databases to seed synthetic data, to shift the
// clock of one delayed release, and to assert what was persisted.
// Every check is reported; the exit code is non-zero if any fails.
const crypto = require('crypto')
const fs = require('fs')
const jwt = require('jsonwebtoken')
const { Client } = require('pg')
const C = require('/srv/argus/services/nexusLinkCrypto')

const A = 'https://argus.staging.test:8443'
const N = 'https://nexus.staging.test:8443'
const RECEIVER = '/api/nexus/workspaces/argus-link/v1/events'
const env = k => { if (!process.env[k]) throw new Error(`${k} missing`); return process.env[k] }
const TO_ARGUS = env('SECRET_NEXUS_TO_ARGUS'), TO_NEXUS = env('SECRET_ARGUS_TO_NEXUS')
const PROS = JSON.parse(fs.readFileSync('/control/professionals.json', 'utf8'))
const run = crypto.randomBytes(3).toString('hex')
const results = []
const sleep = ms => new Promise(r => setTimeout(r, ms))

const argusDb = new Client({ host: 'argus_pg', user: 'argus_stg', password: env('ARGUS_DB_PASSWORD'), database: 'argus_staging' })
const nexusDb = new Client({ host: 'nexus_pg', user: 'nexus_stg', password: env('NEXUS_DB_PASSWORD'), database: 'nexus_staging' })
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0]

async function step(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log(`PASS  ${name}`) }
  catch (err) { results.push({ name, ok: false, error: String(err.message || err).slice(0, 400) }); console.log(`FAIL  ${name}\n      ${String(err.message || err).split('\n').slice(0, 6).join('\n      ')}`) }
}
const eq = (a, b, msg = '') => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${msg} expected ${y}, got ${x}`) }
const ok = (v, msg) => { if (!v) throw new Error(msg) }

async function http(base, method, path, { body, headers = {} } = {}) {
  const res = await fetch(base + path, { method, redirect: 'manual', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text(); let json = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, headers: res.headers }
}
// Host-side control (../gate.sh): stop or start one staging service.
async function control(cmd) {
  const id = crypto.randomBytes(4).toString('hex')
  fs.writeFileSync('/control/request', `${id} ${cmd}\n`)
  for (let i = 0; i < 120; i++) { if (fs.existsSync('/control/done') && fs.readFileSync('/control/done', 'utf8').startsWith(id)) return; await sleep(500) }
  throw new Error(`control "${cmd}" not acknowledged`)
}
async function waitUp(base, path) { for (let i = 0; i < 60; i++) { try { if ((await http(base, 'GET', path)).status === 200) return } catch { /* down */ } await sleep(1000) } throw new Error(`${base} did not come back`) }

;(async () => {
  await argusDb.connect(); await nexusDb.connect()
  const admin = await one(argusDb, `SELECT id, role FROM agents WHERE username='stg_admin' AND active`)
  const staffToken = jwt.sign({ id: admin.id, role: admin.role, aud: 'crm' }, env('ARGUS_JWT_SECRET'), { expiresIn: '30m' })
  const crm = (method, path, body) => http(A, method, '/api/crm/owner-nexus' + path, { body, headers: { authorization: `Bearer ${staffToken}` } })
  const asNexus = (path, body, secret = TO_ARGUS) => { const timestamp = Math.floor(Date.now() / 1000); return http(A, 'POST', '/api/nexus-link/v1' + path, { body, headers: { 'X-Nexus-Link-Key': 'nexus', 'X-Nexus-Link-Timestamp': String(timestamp), 'X-Nexus-Link-Signature': C.sign(secret, { timestamp, method: 'POST', path, body }) } }) }
  const asArgusHeaders = (body, { secret = TO_NEXUS, key = 'argus-2906' } = {}) => { const timestamp = Math.floor(Date.now() / 1000); return { 'X-Nexus-Link-Key': key, 'X-Nexus-Link-Timestamp': String(timestamp), 'X-Nexus-Link-Signature': C.sign(secret, { timestamp, method: 'POST', path: '/events', body }) } }

  // Synthetic owner and two listings for this run.
  const o = await one(argusDb, `INSERT INTO owner_contacts (name, phone_normalized) VALUES ($1,$2) RETURNING id`, [`Gate Owner ${run}`, `+35699${String(parseInt(run, 16)).padStart(8, '0').slice(-8)}`])
  const mk = (n, rent) => one(argusDb, `INSERT INTO properties (ref, owner_id, town, property_type, bedrooms, longlet_price, available_status, street, listed_by_agent_id, feature_tags) VALUES ($1,$2,'Sliema','apartment',2,$3,'available','1 Staging Street (synthetic)',$4,ARRAY['lift','ac']) RETURNING id, ref`, [`STG-G${run}-${n}`, o.id, rent, admin.id])
  const p1 = await mk(1, 1500), p2 = await mk(2, 1900)
  const ext1 = `2906:${p1.ref}`, ext2 = `2906:${p2.ref}`

  // NEXUS sessions.
  const session = async (email, password, register) => {
    const r = await http(N, 'POST', `/api/nexus/auth/${register ? 'register' : 'login'}`, { body: register ? { name: 'Gate Owner', email, password } : { email, password }, headers: { origin: N } })
    ok(r.status === 200, `${register ? 'register' : 'login'} ${email}: ${r.status} ${JSON.stringify(r.json)}`)
    const cookie = r.headers.get('set-cookie').split(';')[0]
    const s = await http(N, 'GET', '/api/nexus/housing/session', { headers: { cookie } })
    return { cookie, 'X-Nexus-CSRF': s.json.csrfToken, origin: N }
  }
  let owner, stranger, ids = {}
  const view = async (id, who = owner) => (await http(N, 'GET', `/api/nexus/housing/properties/${id}`, { headers: who })).json
  const act = async (id, change, body, who = owner) => http(N, 'POST', `/api/nexus/housing/properties/${id}/${change}`, { headers: who, body: { version: (await view(id)).version, ...body } })
  const discover = async (who, query = '') => (await http(N, 'GET', `/api/nexus/housing/professional/listings${query}`, { headers: who }))
  const sees = async (who, ref, query = '') => { const r = await discover(who, query); ok(r.status === 200, `discovery ${r.status} ${JSON.stringify(r.json)}`); return r.json.properties.find(x => x.listingRef === ref) || null }
  const grants = async id => (await argusDb.query(`SELECT channel, scopes FROM nexus_distribution_grants WHERE property_id=$1 AND revoked_at IS NULL ORDER BY channel`, [id])).rows
  const confirmedAt = async id => (await one(argusDb, `SELECT last_confirmed_available_at t FROM properties WHERE id=$1`, [id])).t

  await step('1  ARGUS owner → invitation → NEXUS activation; pending owner sees nothing', async () => {
    const inv = await crm('POST', `/${o.id}/invitation`, {})
    ok(inv.status === 200, JSON.stringify(inv.json))
    const url = new URL(inv.json.invitation.url)
    eq(url.origin + url.pathname, `${N}/owner/activate`, 'invitation target')
    eq((await http(N, 'GET', url.pathname)).status, 200, 'activation page')
    const token = url.hash.replace(/^#t=/, '')
    owner = await session(`gate-owner-${run}@example.org`, `Gate-${crypto.randomBytes(9).toString('hex')}!`, true)
    stranger = await session(`gate-other-${run}@example.org`, `Gate-${crypto.randomBytes(9).toString('hex')}!`, true)
    const preview = await http(N, 'POST', '/api/nexus/housing/argus-claim-preview', { headers: owner, body: { token } })
    ok(preview.status === 200 && preview.json.properties.length === 2, `preview ${preview.status} ${JSON.stringify(preview.json)}`)
    ok(!/Staging Street|\+356/.test(JSON.stringify(preview.json)), 'preview leaks private data')
    const claim = await http(N, 'POST', '/api/nexus/housing/argus-claim', { headers: owner, body: { token, decisions: [{ externalId: ext1, decision: 'confirm' }, { externalId: ext2, decision: 'confirm' }] } })
    eq(claim.status, 200, `claim ${JSON.stringify(claim.json)}`)
    eq((await http(N, 'GET', '/api/nexus/housing/properties', { headers: owner })).json.properties, [], 'pending owner')
    eq((await crm('GET', `/${o.id}`)).json.link.state, 'claim_pending')
  })

  await step('2  owner verification → property linking; acknowledgement is applied; no synced before that', async () => {
    eq((await crm('POST', `/${o.id}/sync-owner`, {})).json.blockedReasons, ['OWNER_LINK_NOT_VERIFIED'])
    eq((await crm('POST', `/${o.id}/verify`, { method: 'gate run: ID checked' })).status, 200)
    const sync = await crm('POST', `/${o.id}/sync-owner`, {})
    eq([sync.json.delivery.delivered, sync.json.delivery.failed], [1, 0], `owner sync ${JSON.stringify(sync.json)}`)
    const st = (await crm('GET', `/${o.id}`)).json
    eq(st.link.sync.state, 'synced')
    const list = (await http(N, 'GET', '/api/nexus/housing/properties', { headers: owner })).json.properties
    eq(list.map(x => x.listingRef).sort(), [p1.ref, p2.ref].sort())
    for (const x of list) ids[x.listingRef] = x.id
    // canonical ids: one per listing, reported back to ARGUS
    eq(st.properties.map(x => x.statuses.canonicalPropertyId).sort(), Object.values(ids).sort(), 'canonical ids')
    eq((await http(N, 'GET', '/api/nexus/housing/properties', { headers: stranger })).json.properties, [], 'other account')
  })

  await step('3  distribution authorisation from NEXUS is applied in ARGUS; unknown values never leave NEXUS', async () => {
    for (const bad of [{ channel: 'public_web', action: 'grant', scopes: ['listing_data'] }, { channel: 'origin_agency', action: 'grant', scopes: ['owner_phone'] }]) eq((await act(ids[p1.ref], 'distribution', { ...bad, commandId: crypto.randomUUID() })).status, 400)
    eq(await grants(p1.id), [])
    for (const id of [p1, p2]) eq((await act(ids[id.ref], 'distribution', { channel: 'all_eligible_agencies', action: 'grant', scopes: ['listing_data', 'availability'], commandId: crypto.randomUUID() })).status, 200)
    eq((await act(ids[p1.ref], 'distribution', { channel: 'origin_agency', action: 'grant', scopes: ['listing_data', 'availability'], commandId: crypto.randomUUID() })).status, 200)
    eq(await grants(p1.id), [{ channel: 'all_eligible_agencies', scopes: ['availability', 'listing_data'] }, { channel: 'origin_agency', scopes: ['availability', 'listing_data'] }])
  })

  await step('4  availability: one timestamp, shown identically by NEXUS; duplicates and holds do not move it', async () => {
    eq(await confirmedAt(p1.id), null)
    const commandId = crypto.randomUUID()
    const r = await act(ids[p1.ref], 'availability', { outcome: 'available', commandId })
    eq(r.status, 200, JSON.stringify(r.json))
    const at = await confirmedAt(p1.id)
    ok(at, 'ARGUS timestamp not set')
    eq(new Date(r.json.availability.lastConfirmedAt).getTime(), new Date(at).getTime(), 'NEXUS shows')
    eq((await one(nexusDb, `SELECT availability_last_confirmed_at t FROM nexus_private.housing_properties WHERE id=$1`, [ids[p1.ref]])).t, null, 'NEXUS own timestamp')
    eq((await act(ids[p1.ref], 'availability', { outcome: 'available', commandId })).status, 200)
    eq((await one(argusDb, `SELECT COUNT(*)::int n FROM owner_availability_answers WHERE property_id=$1`, [p1.id])).n, 1, 'answers after duplicate')
    eq((await act(ids[p1.ref], 'availability', { outcome: 'temporarily_held', commandId: crypto.randomUUID() })).status, 200)
    eq(new Date(await confirmedAt(p1.id)).getTime(), new Date(at).getTime(), 'after hold')
    eq((await act(ids[p1.ref], 'availability', { outcome: 'available', commandId: crypto.randomUUID() })).status, 200)
    eq((await act(ids[p2.ref], 'availability', { outcome: 'available', commandId: crypto.randomUUID() })).status, 200)
  })

  await step('5  passport update in NEXUS → persisted in ARGUS for review → signed acknowledgement; listing not overwritten', async () => {
    const r = await act(ids[p1.ref], 'passport', { fields: { bedrooms: 3, description: 'private note for the gate run' } })
    eq(r.status, 200, JSON.stringify(r.json))
    const u = await one(argusDb, `SELECT version, fields, review_state FROM nexus_owner_property_updates WHERE property_id=$1 ORDER BY version DESC LIMIT 1`, [p1.id])
    ok(u, 'no owner update stored in ARGUS')
    eq([u.fields.bedrooms, u.review_state, u.fields.description], [3, 'pending', undefined])
    eq((await one(argusDb, `SELECT bedrooms FROM properties WHERE id=$1`, [p1.id])).bedrooms, 2, 'ARGUS listing')
    const ev = await one(argusDb, `SELECT outcome FROM nexus_inbound_events WHERE event_type='property.owner_updated' ORDER BY received_at DESC LIMIT 1`)
    eq(ev.outcome, 'applied')
    eq((await crm('GET', `/${o.id}`)).json.properties.find(x => x.ref === p1.ref).ownerInput.passportUpdate.fields.bedrooms, 3)
  })

  await step('6  authorised listing synchronisation ARGUS → NEXUS: applied, then (and only then) synced', async () => {
    eq((await one(nexusDb, `SELECT COUNT(*)::int n FROM nexus_private.housing_argus_listings WHERE external_id = ANY($1)`, [[ext1, ext2]])).n, 0)
    const sync = await crm('POST', `/${o.id}/sync-properties`, {})
    eq([sync.json.delivery.delivered, sync.json.delivery.failed], [2, 0], JSON.stringify(sync.json))
    eq((await crm('GET', `/${o.id}`)).json.properties.map(x => x.statuses.sync), ['synced', 'synced'])
    const rows = (await nexusDb.query(`SELECT external_id, facts FROM nexus_private.housing_argus_listings WHERE external_id = ANY($1) ORDER BY external_id`, [[ext1, ext2]])).rows
    eq(rows.map(r => [r.external_id, r.facts.amount]), [[ext1, 1500], [ext2, 1900]])
    await argusDb.query(`UPDATE properties SET longlet_price=1650 WHERE id=$1`, [p1.id])
    await crm('POST', `/${o.id}/sync-properties`, {})
    eq((await view(ids[p1.ref])).passport.rent, 1650, 'NEXUS passport rent')
    eq((await crm('POST', `/${o.id}/sync-properties`, {})).json.properties.map(x => x.unchanged), [true, true])
  })

  let own, agencyA, agencyB
  await step('7  Marketplace visibility: own agency yes; other agencies only after an authorised release, and only the named audience', async () => {
    own = await session(PROS.own.email, PROS.own.password); agencyA = await session(PROS.agencyA.email, PROS.agencyA.password); agencyB = await session(PROS.agencyB.email, PROS.agencyB.password)
    eq((await discover(stranger)).status, 403, 'unverified professional')
    ok((await sees(own, p1.ref))?.ownAgency === true, 'own agency does not see its listing')
    eq(await sees(agencyA, p1.ref), null, 'agency A before release')
    // immediate release to agency A only
    eq((await crm('PUT', `/property/${p1.id}/route`, { mode: 'immediate', audienceType: 'selected_agencies', audienceRefs: [PROS.agencyA.agencyKey], commercialTermsRef: 'AGR-GATE-1' })).status, 200)
    eq(await sees(agencyA, p1.ref), null, 'draft rule must not release')
    eq((await crm('POST', `/property/${p1.id}/route/approve`, {})).json.route.state, 'scheduled')
    eq((await crm('POST', '/routes/process-due', {})).json.released, 1)
    await crm('POST', `/${o.id}/retry`, {})
    const a = await sees(agencyA, p1.ref)
    ok(a && a.approvedRelease === true && a.commercialTermsRef === 'AGR-GATE-1' && a.ownAgency === false, `agency A: ${JSON.stringify(a)}`)
    ok(!/Staging Street|\+356|Gate Owner/.test(JSON.stringify(a)), 'discovery leaks private data')
    eq(await sees(agencyB, p1.ref), null, 'agency B is not in the audience')
  })

  await step('8  delayed release: nothing before the delay has passed, counted from approval', async () => {
    eq((await crm('PUT', `/property/${p2.id}/route`, { mode: 'delay_days', delayDays: 7, audienceType: 'all_eligible_agencies' })).status, 200)
    const ap = await crm('POST', `/property/${p2.id}/route/approve`, {})
    eq(Math.round((new Date(ap.json.route.scheduledReleaseAt) - new Date(ap.json.route.approvedReleaseAt)) / 86400000), 7, 'delay')
    eq((await crm('POST', '/routes/process-due', {})).json.released, 0)
    eq(await sees(agencyA, p2.ref), null, 'before the delay')
    // Staging-only clock shift: move this one route eight days into the past.
    await argusDb.query(`UPDATE nexus_distribution_routes SET approved_release_at = approved_release_at - interval '8 days', scheduled_release_at = scheduled_release_at - interval '8 days' WHERE property_id=$1 AND release_state='scheduled'`, [p2.id])
    eq((await crm('POST', '/routes/process-due', {})).json.released, 1)
    await crm('POST', `/${o.id}/retry`, {})
    ok(await sees(agencyA, p2.ref), 'agency A after the delay'); ok(await sees(agencyB, p2.ref), 'agency B after the delay (all eligible agencies)')
  })

  await step('9  on-market and stale filtering', async () => {
    await argusDb.query(`UPDATE properties SET available_status='not_available' WHERE id=$1`, [p2.id])
    eq(await sees(agencyA, p2.ref), null, 'off-market listing in discovery')
    await argusDb.query(`UPDATE properties SET available_status='available' WHERE id=$1`, [p2.id])
    ok(await sees(agencyA, p2.ref), 'back on market')
    // Six days without a confirmation: still on the market, but not presented as freshly confirmed.
    await argusDb.query(`UPDATE properties SET last_confirmed_available_at = NOW() - interval '6 days' WHERE id=$1`, [p2.id])
    eq(await sees(agencyA, p2.ref, '?freshness=recently_confirmed'), null, 'stale listing under "recently confirmed"')
    const stale = await sees(agencyA, p2.ref)
    eq(stale.availability.freshness, 'confirmation_overdue')
    const m = (await asNexus('/read/market', { externalIds: [ext2] })).json.properties[0]
    eq([m.eligible, m.availability.consumerDiscoverable], [true, false], 'consumer flag')
    eq((await one(argusDb, `SELECT available_status s FROM properties WHERE id=$1`, [p2.id])).s, 'available', 'stale must not change status')
  })

  await step('10 failed deliveries stay pending and retry safely (both directions, services really stopped)', async () => {
    // ARGUS → NEXUS with NEXUS down
    await argusDb.query(`UPDATE properties SET longlet_price=1700 WHERE id=$1`, [p1.id])
    await control('stop nexus')
    const failed = await crm('POST', `/${o.id}/sync-properties`, {})
    await control('start nexus'); await waitUp(N, '/housing/owner')
    eq([failed.json.delivery.delivered, failed.json.delivery.failed], [0, 1], JSON.stringify(failed.json.delivery))
    eq((await crm('GET', `/${o.id}`)).json.properties.find(x => x.ref === p1.ref).statuses.sync, 'error', 'no false synced')
    eq((await crm('POST', `/${o.id}/retry`, {})).json.delivery.delivered, 1)
    eq((await one(nexusDb, `SELECT facts->>'amount' a FROM nexus_private.housing_argus_listings WHERE external_id=$1`, [ext1])).a, '1700')
    eq((await one(argusDb, `SELECT COUNT(*)::int n FROM nexus_sync_outbox WHERE event_type='property.upserted' AND aggregate_id=$1 AND payload->'rent'->>'amount'='1700'`, [p1.id])).n, 1)
    // NEXUS → ARGUS with ARGUS down
    const before = (await one(argusDb, `SELECT COUNT(*)::int n FROM owner_availability_answers WHERE property_id=$1`, [p1.id])).n
    const version = (await view(ids[p1.ref])).version, commandId = crypto.randomUUID()
    await control('stop argus')
    const down = await http(N, 'POST', `/api/nexus/housing/properties/${ids[p1.ref]}/availability`, { headers: owner, body: { version, outcome: 'reserved', commandId } })
    await control('start argus'); await waitUp(A, '/healthz')
    eq(down.status, 503, JSON.stringify(down.json))
    eq((await one(argusDb, `SELECT COUNT(*)::int n FROM owner_availability_answers WHERE property_id=$1`, [p1.id])).n, before)
    eq((await http(N, 'POST', `/api/nexus/housing/properties/${ids[p1.ref]}/availability`, { headers: owner, body: { version, outcome: 'reserved', commandId } })).status, 200)
    eq((await one(argusDb, `SELECT COUNT(*)::int n FROM owner_availability_answers WHERE property_id=$1`, [p1.id])).n, before + 1)
    eq((await act(ids[p1.ref], 'availability', { outcome: 'available', commandId: crypto.randomUUID() })).status, 200)
  })

  await step('11 unauthorised requests, replays and other tenants are rejected', async () => {
    const body = { contractVersion: '2026-11-11.v1', agencyKey: '2906', eventId: `gate-unauth-${run}`, eventType: 'property.withdrawn', occurredAt: new Date().toISOString(), data: { externalId: ext1, reason: 'forged' } }
    eq((await http(N, 'POST', RECEIVER, { body })).status, 401, 'NEXUS unsigned')
    eq((await http(N, 'POST', RECEIVER, { body, headers: asArgusHeaders(body, { secret: TO_ARGUS }) })).status, 401, 'NEXUS wrong secret')
    eq((await http(N, 'POST', RECEIVER, { body, headers: asArgusHeaders(body, { key: 'argus-9999' }) })).status, 401, 'NEXUS wrong key')
    const foreign = { ...body, agencyKey: 'benestates' }
    eq((await http(N, 'POST', RECEIVER, { body: foreign, headers: asArgusHeaders(foreign) })).status, 403, 'NEXUS other tenant')
    eq((await one(nexusDb, `SELECT withdrawn FROM nexus_private.housing_argus_listings WHERE external_id=$1`, [ext1])).withdrawn, false)
    const linkId = (await crm('GET', `/${o.id}`)).json.link.id
    const evt = { contractVersion: '2026-11-11.v1', agencyKey: '2906', eventId: `gate-unauth2-${run}`, eventType: 'distribution.granted', occurredAt: new Date().toISOString(), data: { linkId, externalId: ext1, channel: 'independent_agents', scopes: ['listing_data'] } }
    eq((await http(A, 'POST', '/api/nexus-link/v1/events', { body: evt })).status, 401, 'ARGUS unsigned')
    eq((await asNexus('/events', evt, TO_NEXUS)).status, 401, 'ARGUS wrong direction secret')
    eq((await asNexus('/events', { ...evt, agencyKey: 'benestates' })).status, 403, 'ARGUS other tenant')
    eq((await http(A, 'GET', `/api/crm/owner-nexus/${o.id}`)).status, 401, 'ARGUS staff API without session')
    // replay of a delivered ARGUS event: stored answer, nothing new
    const prev = await one(argusDb, `SELECT * FROM nexus_sync_outbox WHERE event_type='owner.profile_upserted' AND aggregate_type='owner' AND state='delivered' ORDER BY id DESC LIMIT 1`)
    const replay = { eventId: prev.event_id, eventType: prev.event_type, contractVersion: prev.contract_version, agencyKey: prev.agency_key, occurredAt: new Date(prev.created_at).toISOString(), idempotencyKey: prev.idempotency_key, data: prev.payload }
    const count = async () => (await one(nexusDb, `SELECT COUNT(*)::int n FROM nexus_private.housing_properties`)).n
    const n0 = await count()
    eq((await http(N, 'POST', RECEIVER, { body: replay, headers: asArgusHeaders(replay) })).status, 200, 'replay')
    const changed = { ...replay, data: { ...replay.data, displayName: 'Someone Else' } }
    eq((await http(N, 'POST', RECEIVER, { body: changed, headers: asArgusHeaders(changed) })).status, 409, 'replay with changed content')
    eq(await count(), n0, 'no new records from a replay')
    // another NEXUS account cannot act on the listing, and nothing reaches ARGUS
    const events = (await one(argusDb, `SELECT COUNT(*)::int n FROM nexus_inbound_events`)).n
    const f = await http(N, 'POST', `/api/nexus/housing/properties/${ids[p1.ref]}/distribution`, { headers: stranger, body: { version: (await view(ids[p1.ref])).version, channel: 'independent_agents', action: 'grant', scopes: ['listing_data'], commandId: crypto.randomUUID() } })
    ok([403, 404].includes(f.status), `stranger got ${f.status}`)
    eq((await one(argusDb, `SELECT COUNT(*)::int n FROM nexus_inbound_events`)).n, events)
  })

  await step('12 revocation: the owner withdraws → sharing stops in ARGUS, in NEXUS and in discovery; a replayed update cannot revive it', async () => {
    const earlier = await one(argusDb, `SELECT * FROM nexus_sync_outbox WHERE event_type='property.upserted' AND aggregate_id=$1 AND state='delivered' ORDER BY id DESC LIMIT 1`, [p1.id])
    for (const channel of ['all_eligible_agencies', 'origin_agency']) eq((await act(ids[p1.ref], 'distribution', { channel, action: 'revoke', commandId: crypto.randomUUID() })).status, 200)
    eq(await grants(p1.id), [])
    const route = await one(argusDb, `SELECT release_state, revoked_by FROM nexus_distribution_routes WHERE property_id=$1 ORDER BY id DESC LIMIT 1`, [p1.id])
    eq([route.release_state, route.revoked_by], ['revoked', 'owner'])
    await crm('POST', `/${o.id}/retry`, {})
    eq((await one(nexusDb, `SELECT withdrawn FROM nexus_private.housing_argus_listings WHERE external_id=$1`, [ext1])).withdrawn, true)
    eq(await sees(agencyA, p1.ref), null, 'agency A after revocation'); eq(await sees(own, p1.ref), null, 'own agency after revocation')
    const st = (await crm('GET', `/${o.id}`)).json.properties.find(x => x.ref === p1.ref)
    eq([st.eligible, st.blockedReasons, st.statuses.publication], [false, ['NO_DISTRIBUTION_AUTHORIZATION'], 'withdrawn'])
    const replay = { eventId: `gate-replay-${run}`, eventType: 'property.upserted', contractVersion: earlier.contract_version, agencyKey: earlier.agency_key, occurredAt: new Date(earlier.created_at).toISOString(), data: earlier.payload }
    await http(N, 'POST', RECEIVER, { body: replay, headers: asArgusHeaders(replay) })
    eq((await one(nexusDb, `SELECT withdrawn FROM nexus_private.housing_argus_listings WHERE external_id=$1`, [ext1])).withdrawn, true, 'after replay')
    // the agency can also take a release back: listing 2
    eq((await crm('POST', `/property/${p2.id}/route/revoke`, { reason: 'gate run' })).json.withdrawalQueued, true)
    await crm('POST', `/${o.id}/retry`, {})
    eq(await sees(agencyB, p2.ref), null, 'agency B after the agency revoked the release')
  })

  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} gate steps passed`)
  fs.writeFileSync('/control/result.json', JSON.stringify({ run, at: new Date().toISOString(), results }, null, 1))
  await argusDb.end(); await nexusDb.end()
  process.exit(failed.length ? 1 : 0)
})().catch(e => { console.error('gate aborted:', e.message); process.exit(2) })
