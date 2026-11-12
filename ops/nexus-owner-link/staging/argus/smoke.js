'use strict'
// Hosted-staging smoke test for the ARGUS side (Claude, 2026-11-12).
//   docker compose exec argus node smoke.js
// Plays the NEXUS server against ARGUS staging THROUGH the staging HTTPS proxy
// (certificate verified against the staging CA), with real signatures, on
// synthetic data. It proves the hosted surface works; it is not the gate —
// the gate needs the real NEXUS service of a pinned commit.
const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const db = require('./db')
const C = require('./services/nexusLinkCrypto')

const BASE = 'https://argus.staging.test:8443'
const SECRET = process.env.NEXUS_LINK_INBOUND_SECRET
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  — ${detail}`}`) }

async function service(path, body, { sign = true, secret = SECRET } = {}) {
  const timestamp = Math.floor(Date.now() / 1000)
  const headers = { 'content-type': 'application/json' }
  if (sign) Object.assign(headers, { 'X-Nexus-Link-Key': 'nexus', 'X-Nexus-Link-Timestamp': String(timestamp), 'X-Nexus-Link-Signature': C.sign(secret, { timestamp, method: 'POST', path, body }) })
  const res = await fetch(`${BASE}/api/nexus-link/v1${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => null) }
}
async function staff(token, method, path, body) {
  const res = await fetch(`${BASE}/api/crm/owner-nexus${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => null) }
}
const event = (eventType, data, minutesAgo = 0) => ({ contractVersion: '2026-11-11.v1', agencyKey: '2906', eventId: `smoke-${crypto.randomBytes(10).toString('hex')}`, eventType, occurredAt: new Date(Date.now() - minutesAgo * 60000).toISOString(), data })

;(async () => {
  const run = crypto.randomBytes(3).toString('hex')
  const { rows: [admin] } = await db.query(`SELECT id, role FROM agents WHERE username='stg_admin' AND active`)
  if (!admin) throw new Error('run seed.js first')
  const token = jwt.sign({ id: admin.id, role: admin.role, aud: 'crm' }, process.env.JWT_SECRET, { expiresIn: '10m' })
  // A fresh synthetic owner and listing per run, so the smoke test is repeatable.
  const { rows: [o] } = await db.query(`INSERT INTO owner_contacts (name, phone_normalized) VALUES ($1,$2) RETURNING id`, [`Smoke Owner ${run}`, `+35699${String(parseInt(run, 16)).padStart(8, '0').slice(-8)}`])
  const ref = `STG-SMOKE-${run}`
  const { rows: [p] } = await db.query(`INSERT INTO properties (ref, owner_id, town, property_type, bedrooms, longlet_price, available_status, street, listed_by_agent_id) VALUES ($1,$2,'Sliema','apartment',2,1500,'available','1 Staging Street (synthetic)',$3) RETURNING id`, [ref, o.id, admin.id])
  const ext = `2906:${ref}`

  const inv = await staff(token, 'POST', `/${o.id}/invitation`, {})
  check('staff creates an invitation over HTTPS', inv.status === 200 && /^https:\/\/nexus\.staging\.test:8443\/owner\/activate#t=/.test(inv.json?.invitation?.url || ''), JSON.stringify(inv.json))
  const tokenValue = (inv.json.invitation.url.split('#t=')[1])
  check('unsigned service call is rejected', (await service('/invitations/resolve', { token: tokenValue }, { sign: false })).status === 401)
  check('call signed with a wrong secret is rejected', (await service('/invitations/resolve', { token: tokenValue }, { secret: 'x'.repeat(64) })).status === 401)
  const resolved = await service('/invitations/resolve', { token: tokenValue })
  check('signed invitation resolve returns locality-level facts only', resolved.status === 200 && resolved.json.properties.length === 1 && !/Staging Street|\+356/.test(JSON.stringify(resolved.json)))
  const account = `nxu_${crypto.randomBytes(16).toString('hex')}`
  const claim = await service('/events', event('owner.claim_submitted', { token: tokenValue, nexusAccountRef: account, decisions: [{ externalId: ext, decision: 'confirm' }] }))
  check('claim is applied and leaves the owner unverified', claim.json?.applied === true && claim.json.result.linkState === 'claim_pending')
  const linkId = resolved.json.owner.linkId
  check('unverified owner cannot push changes', (await service('/events', event('distribution.granted', { linkId, externalId: ext, channel: 'origin_agency', scopes: ['listing_data'] }))).status === 409)
  check('staff verification', (await staff(token, 'POST', `/${o.id}/verify`, { method: 'smoke test' })).status === 200)
  check('unknown permission is refused', (await service('/events', event('distribution.granted', { linkId, externalId: ext, nexusPermissions: ['market'] }))).json?.error === 'PERMISSION_NOT_MAPPED')
  check('grant is applied', (await service('/events', event('distribution.granted', { linkId, externalId: ext, channel: 'all_eligible_agencies', scopes: ['listing_data', 'availability'] }, 5))).json?.applied === true)
  const confirmId = event('availability.answered', { linkId, externalId: ext, outcome: 'available' }, 2)
  const a1 = await service('/events', confirmId)
  const { rows: [t1] } = await db.query(`SELECT last_confirmed_available_at t FROM properties WHERE id=$1`, [p.id])
  const read = await service('/read/properties', { linkId, externalIds: [ext] })
  check('availability confirmation moves the one timestamp and the read API returns exactly it', a1.json?.applied === true && t1.t && read.json.properties[0].availability.availability_last_confirmed_at === new Date(t1.t).toISOString())
  const a2 = await service('/events', confirmId)
  check('replayed event is a duplicate and changes nothing', a2.json?.duplicate === true && (await db.query(`SELECT COUNT(*)::int n FROM owner_availability_answers WHERE property_id=$1`, [p.id])).rows[0].n === 1)
  const late = await service('/events', event('availability.answered', { linkId, externalId: ext, outcome: 'rented' }, 30))
  check('older answer arriving late is not applied', late.json?.applied === false)
  const upd = await service('/events', event('property.owner_updated', { linkId, externalId: ext, version: 2, fields: { bedrooms: 3 } }))
  const { rows: [after] } = await db.query(`SELECT bedrooms FROM properties WHERE id=$1`, [p.id])
  check('passport edit is stored for review, listing not overwritten', upd.json?.applied === true && after.bedrooms === 2)
  const market = await service('/read/market', { externalIds: [ext, '2906:STG-3001', '2906:nope'] })
  const m = Object.fromEntries((market.json?.properties || []).map(x => [x.externalId, x]))
  check('market read: eligible listing with grants; others closed with a reason', m[ext]?.eligible === true && m['2906:nope']?.reason === 'UNKNOWN_LISTING' && m['2906:STG-3001']?.eligible === false)
  // Immediate release through the staff API, then the scheduler path.
  await staff(token, 'PUT', `/property/${p.id}/route`, { mode: 'immediate', audienceType: 'all_eligible_agencies' })
  await staff(token, 'POST', `/property/${p.id}/route/approve`, {})
  const due = await staff(token, 'POST', '/routes/process-due', {})
  check('immediate release is released once', due.status === 200 && (await db.query(`SELECT release_state FROM nexus_distribution_routes WHERE property_id=$1`, [p.id])).rows[0].release_state === 'released')
  // No NEXUS service is connected in this smoke run: sync must be queued and reported as not delivered, never "synced".
  const sync = await staff(token, 'POST', `/${o.id}/sync-owner`, {})
  const st = await staff(token, 'GET', `/${o.id}`)
  check('no false "synced" while NEXUS staging is not running', sync.status === 200 && sync.json.delivery.delivered === 0 && st.json.link.sync.state !== 'synced', JSON.stringify(sync.json.delivery))
  const revoke = await service('/events', event('distribution.revoked', { linkId, externalId: ext }))
  const closed = await service('/read/market', { externalIds: [ext] })
  check('revocation closes sharing', revoke.json?.applied === true && closed.json.properties[0].eligible === false)
  check('another agency key is refused', (await service('/events', { ...event('distribution.revoked', { linkId, externalId: ext }), agencyKey: 'benestates' })).status === 403)

  const failed = results.filter(r => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error('smoke test aborted:', e.message); process.exit(1) })
