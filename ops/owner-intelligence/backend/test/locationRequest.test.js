'use strict'
// Kev, 2026-10-30 — acceptance tests E, F and I for "Ask for Location", on the
// REAL services/locationRequest.js + test DB. The owner's source-account
// picker (availability.pickSourceSession, unchanged production rule) is
// stubbed to a fixed account; sends are recorded, nothing reaches WhatsApp.
//   node --test test/locationRequest.test.js
const test = require('node:test')
const assert = require('node:assert')
const H = require('./helpers/ownerHarness')
H.stubs['services/availability'] = {
  pickSourceSession: async () => H.stubs.__pick || { session: 'Kevsecond', dbSession: 'Kevsecond', reason: 'source_session' },
}
const L = H.load('services/locationRequest')
const { maltaLocalToUTC } = H.load('services/outreachSchedule')

const OWNER = '35699000777'
let ids
async function seed({ street = null, viewingAt = null } = {}) {
  await H.db.query(`TRUNCATE property_location_requests, agent_listing_notifications, property_activities, property_viewings RESTART IDENTITY CASCADE`)
  await H.reset()
  await H.db.query(`DELETE FROM properties WHERE ref = '2906-9520'`)
  await H.db.query(`DELETE FROM agents WHERE username IN ('jason-test','listing-test')`)
  const owner = await H.owner(OWNER, 'Owner Test')
  const jason = (await H.db.query(`INSERT INTO agents(username, name, role, active) VALUES ('jason-test','Jason','agent',TRUE) RETURNING *`)).rows[0]
  const lister = (await H.db.query(`INSERT INTO agents(username, name, role, active) VALUES ('listing-test','Listing Agent','agent',TRUE) RETURNING *`)).rows[0]
  const prop = (await H.db.query(
    `INSERT INTO properties(ref, owner_id, town, street, listed_by_agent_id) VALUES ('2906-9520', $1, 'St Julians', $2, $3) RETURNING *`,
    [owner.id, street, lister.id])).rows[0]
  let viewing = null
  if (viewingAt) {
    viewing = (await H.db.query(
      `INSERT INTO property_viewings(property_id, viewing_date, starts_at, status, viewing_agent_id, viewing_agent_name)
       VALUES ($1, $2::timestamptz::date, $2, 'confirmed', $3, 'Jason') RETURNING *`, [prop.id, viewingAt.toISOString(), jason.id])).rows[0]
  }
  delete H.stubs.__pick
  ids = { owner, jason: { ...jason, role: 'agent' }, lister: { ...lister, role: 'agent' }, prop, viewing }
}

test('Test E: request persisted with owner, account and requester; sent only after the provider accepted; no duplicate on repeated clicks', async () => {
  await seed()
  const r = await L.requestLocation({ ref: '2906-9520', agent: ids.jason })
  assert.strictEqual(r.ok, true, JSON.stringify(r))
  assert.strictEqual(r.request.status, 'awaiting_owner')
  assert.strictEqual(r.request.account, 'Kevsecond')
  assert.strictEqual(r.request.requestedBy, 'Jason')
  assert.ok(r.request.sentAt)
  assert.strictEqual(H.sent.length, 1)
  assert.strictEqual(H.sent[0].chatId, `${OWNER}@c.us`, 'the OWNER is asked, not the listing agent')
  assert.match(H.sent[0].text, /exact address or location pin|exact location or a Google Maps pin/)
  const row = (await H.db.query(`SELECT * FROM property_location_requests`)).rows[0]
  assert.strictEqual(row.owner_contact_id, ids.owner.id)
  assert.strictEqual(row.requested_by_agent_id, ids.jason.id)
  // repeated clicks, sequential and concurrent
  const again = await L.requestLocation({ ref: '2906-9520', agent: ids.jason })
  assert.strictEqual(again.existing, true)
  await Promise.all([1, 2, 3].map(() => L.requestLocation({ ref: '2906-9520', agent: ids.jason })))
  assert.strictEqual(H.sent.length, 1, 'exactly one owner message')
  assert.strictEqual((await H.db.query(`SELECT COUNT(*)::int n FROM property_location_requests`)).rows[0].n, 1)
  // visible to the listing agent (in-app) and on the property timeline
  const notes = (await H.db.query(`SELECT agent_id, kind FROM agent_listing_notifications`)).rows
  assert.deepStrictEqual(notes, [{ agent_id: ids.lister.id, kind: 'location_requested' }])
  const acts = (await H.db.query(`SELECT activity_type FROM property_activities ORDER BY id`)).rows.map(x => x.activity_type)
  assert.deepStrictEqual(acts, ['location_requested', 'location_request_sent'])
  // status survives a reload
  assert.strictEqual((await L.getStatus({ ref: '2906-9520', agent: ids.jason })).request.status, 'awaiting_owner')
})

test('a failed send is shown as Failed with the reason — never as Sent; retry is possible afterwards', async () => {
  await seed()
  const realSend = H.stubs.waha.sendText
  H.stubs.waha.sendText = async () => { throw new Error('WAHA 500: session not working') }
  try {
    const r = await L.requestLocation({ ref: '2906-9520', agent: ids.jason })
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.request.status, 'failed')
    assert.match(r.request.error, /send_failed/)
    assert.strictEqual(r.request.sentAt, null)
  } finally { H.stubs.waha.sendText = realSend }
  const retry = await L.requestLocation({ ref: '2906-9520', agent: ids.jason })
  assert.strictEqual(retry.request.status, 'awaiting_owner')
})

test('no owner contact, opted-out owner, owner account offline → explicit failure, nothing sent', async () => {
  await seed()
  await H.db.query(`UPDATE owner_contacts SET status = 'do_not_contact'`)
  const dnc = await L.requestLocation({ ref: '2906-9520', agent: ids.jason })
  assert.deepStrictEqual([dnc.request.status, dnc.request.error], ['failed', 'owner_dnc'])
  await seed()
  H.stubs.__pick = { session: null, dbSession: 'kevthirdd', waiting: true, reason: 'source_offline' }
  const off = await L.requestLocation({ ref: '2906-9520', agent: ids.jason })
  assert.deepStrictEqual([off.request.status, off.request.error], ['failed', 'owner_account_offline:kevthirdd'])
  await seed()
  await H.db.query(`UPDATE properties SET owner_id = NULL`)
  const none = await L.requestLocation({ ref: '2906-9520', agent: ids.jason })
  assert.deepStrictEqual([none.request.status, none.request.error], ['failed', 'no_owner_contact'])
  assert.strictEqual(H.sent.length, 0)
})

test('an address already on file is not asked again', async () => {
  await seed({ street: 'Triq il-Kbira' })
  const r = await L.requestLocation({ ref: '2906-9520', agent: ids.jason })
  assert.strictEqual(r.request.status, 'location_available')
  assert.strictEqual(H.sent.length, 0)
})

test('Test F: owner sends a map link → linked to the request, provenance kept, requester notified, location visible to the viewing agent only', async () => {
  const now = new Date()
  await seed({ viewingAt: new Date(now.getTime() + 3 * 3600000) })
  await L.requestLocation({ ref: '2906-9520', agent: ids.jason })
  assert.match(H.sent[0].text, /viewing we've arranged/, 'viewing wording because a viewing is recorded')
  const vague = await L.handleOwnerMessage({ phone: OWNER, text: 'It is near the church, you will see it', messageId: 'm1' })
  assert.deepStrictEqual([vague.matched, vague.received], [true, false], 'a vague description is not a location')
  assert.strictEqual((await L.getStatus({ ref: '2906-9520', agent: ids.jason })).request.status, 'awaiting_owner')
  const reply = await L.handleOwnerMessage({ phone: `+${OWNER}`, text: 'Here: https://maps.app.goo.gl/AbC123xyz', messageId: 'm2' })
  assert.deepStrictEqual([reply.received, reply.kind], [true, 'maps_link'])
  const forJason = (await L.getStatus({ ref: '2906-9520', agent: ids.jason })).request
  assert.strictEqual(forJason.status, 'agent_notified')
  assert.strictEqual(forJason.location.mapsUrl, 'https://maps.app.goo.gl/AbC123xyz')
  assert.strictEqual(forJason.location.sourceMessageId, 'm2')
  assert.strictEqual(forJason.location.verified, false)
  const note = (await H.db.query(`SELECT kind FROM agent_listing_notifications WHERE agent_id = $1`, [ids.jason.id])).rows
  assert.deepStrictEqual(note, [{ kind: 'location_received' }])
  const stranger = { id: 999999, role: 'agent', name: 'Other' }
  const forOther = (await L.getStatus({ ref: '2906-9520', agent: stranger })).request
  assert.strictEqual(forOther.location, null)
  assert.strictEqual(forOther.locationHidden, true)
  const street = (await H.db.query(`SELECT street FROM properties WHERE ref = '2906-9520'`)).rows[0].street
  assert.strictEqual(street, null, 'canonical address is not overwritten by a chat message')
})

test('a WhatsApp location pin (no text) answers the request', async () => {
  await seed()
  await L.requestLocation({ ref: '2906-9520', agent: ids.jason })
  const r = await L.handleOwnerMessage({ phone: OWNER, text: '', payload: { location: { latitude: 35.9187, longitude: 14.4893 } }, messageId: 'pin1' })
  assert.deepStrictEqual([r.received, r.kind], [true, 'pin'])
  const loc = (await L.getStatus({ ref: '2906-9520', agent: { ...ids.lister } })).request.location
  assert.strictEqual(loc.mapsUrl, 'https://www.google.com/maps?q=35.9187000,14.4893000')
})

test('Test I: confirmed viewing at 19:30 without an address → visible warning for that agent, with the request state', async () => {
  const now = maltaLocalToUTC('2026-10-30', '16:00')
  await seed({ viewingAt: maltaLocalToUTC('2026-10-30', '19:30') })
  const w = await L.viewingLocationWarnings({ agent: ids.jason, now })
  assert.strictEqual(w.length, 1)
  assert.strictEqual(w[0].warning, 'Viewing scheduled — exact location missing')
  assert.strictEqual(w[0].ref, '2906-9520')
  assert.strictEqual(w[0].urgency, 'urgent')
  assert.strictEqual(w[0].request, null)
  await L.requestLocation({ ref: '2906-9520', agent: ids.jason, now })
  assert.strictEqual(H.sent[0].text.startsWith('Good afternoon! Just following up regarding the viewing we\'ve arranged for this evening.'), true, H.sent[0].text)
  const w2 = await L.viewingLocationWarnings({ agent: ids.jason, now })
  assert.strictEqual(w2[0].request.status, 'awaiting_owner')
  await L.handleOwnerMessage({ phone: OWNER, text: 'Triq il-Kbira 45, Flat 3, St Julians', messageId: 'a1', now })
  assert.strictEqual((await L.viewingLocationWarnings({ agent: ids.jason, now })).length, 0, 'warning resolved')
  assert.strictEqual((await L.viewingLocationWarnings({ agent: ids.lister, now })).length, 0, 'not shown to an unrelated agent')
})
