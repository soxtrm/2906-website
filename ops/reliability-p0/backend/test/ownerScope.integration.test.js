'use strict'
// Owner-wide "nothing available" — integration test against a real ARGUS schema.
//
// Runs the REAL production services (ARGUS_BASE_DIR) with the two files of this
// change overlaid, against a throw-away database (never production). WhatsApp is
// not reachable: waha and fetch throw, queued sends are only recorded.
//
//   ARGUS_BASE_DIR=<production backend mirror> TEST_DB_HOST=… TEST_DB_NAME=… \
//   TEST_DB_USER=… TEST_DB_PASSWORD=… node --test --test-concurrency=1 test/ownerScope.integration.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const Module = require('module')

const ROOT = path.join(__dirname, '..')
const BASE = process.env.ARGUS_BASE_DIR
if (!BASE || !fs.existsSync(path.join(BASE, 'db.js'))) throw new Error('ARGUS_BASE_DIR must point to a production backend mirror')
if (/^(2906_postgres|postgres)$/i.test(process.env.TEST_DB_HOST || '')) throw new Error('refusing to run against the production database host')

const queued = []                 // humanDelay sends that WOULD go out
const delayedJobs = []            // fake BullMQ delayed jobs (queued follow-ups)
const kv = new Map()
const forbidden = name => new Proxy({}, { get: (_, k) => (k === 'then' ? undefined : () => { throw new Error(`${name}.${String(k)} must not be called in this test`) }) })
const stubs = {
  config: {
    db: { host: process.env.TEST_DB_HOST || '127.0.0.1', port: Number(process.env.TEST_DB_PORT || 5432), database: process.env.TEST_DB_NAME || 'argus_test', user: process.env.TEST_DB_USER || 'test', password: process.env.TEST_DB_PASSWORD || 'test' },
    redis: {}, waha: { url: 'http://waha.invalid', apiKey: 'x' }, telegram: {},
  },
  logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return stubs.logger } },
  telegram: { sendAlert: async t => { stubs.alerts.push(String(t)) } },
  alerts: [],
  redis: {
    get: async k => (kv.has(k) ? kv.get(k) : null),
    set: async (k, v, ...rest) => { if (rest.includes('NX') && kv.has(k)) return null; kv.set(k, String(v)); return 'OK' },
    del: async k => kv.delete(k), on() {}, expire: async () => 1, incr: async k => { const n = Number(kv.get(k) || 0) + 1; kv.set(k, String(n)); return n },
  },
  waha: forbidden('waha'),
  queues: {
    QUEUES: { availability: { getDelayed: async () => delayedJobs.filter(j => !j.removed), add: async () => ({}) } },
    addJob: async (name, data, opts) => { queued.push({ name, data, opts }); return { id: opts?.jobId || String(queued.length) } },
    connection: {},
  },
}
globalThis.fetch = async url => { throw new Error('network is not available in this test: ' + String(url).slice(0, 60)) }

const exists = p => fs.existsSync(p) || fs.existsSync(p + '.js')
const original = Module._load
Module._load = function (request, parent) {
  if (parent && parent.filename && (request.startsWith('./') || request.startsWith('../'))) {
    const resolved = path.resolve(path.dirname(parent.filename), request)
    for (const root of [ROOT, BASE]) {
      const rel = path.relative(root, resolved).replace(/\\/g, '/').replace(/\.js$/, '')
      if (rel.startsWith('..')) continue
      if (Object.prototype.hasOwnProperty.call(stubs, rel) && rel !== 'alerts') return stubs[rel]
      // this change's files win over production; everything else is the production file
      if (root === BASE && exists(path.join(ROOT, rel))) return original.call(this, path.join(ROOT, rel), parent)
      if (root === ROOT && !exists(resolved) && exists(path.join(BASE, rel))) return original.call(this, path.join(BASE, rel), parent)
    }
  }
  return original.apply(this, arguments)
}

const db = require(path.join(BASE, 'db'))
const av = require(path.join(ROOT, 'services', 'availability.js'))
const scope = require(path.join(ROOT, 'services', 'ownerScopeReply.js'))
const ownerSendGate = require(path.join(BASE, 'services', 'ownerSendGate'))

const TAG = `${process.pid}${Date.now() % 100000}`
let seq = 0
const q = (sql, params) => db.query(sql, params)
async function owner() {
  seq++
  const phone = `+35699${String(TAG).slice(-4)}${String(seq).padStart(2, '0')}`.slice(0, 13)
  return (await q(`INSERT INTO owner_contacts (name, phone_normalized) VALUES ($1,$2) RETURNING *`, [`P0 Test Owner ${TAG}-${seq}`, phone])).rows[0]
}
async function property(ownerId, status = 'available', published = true) {
  seq++
  return (await q(
    `INSERT INTO properties (ref, owner_id, town, property_type, bedrooms, longlet_price, available_status, published, street)
     VALUES ($1,$2,'Sliema','apartment',1,1250,$3,$4,'1 Test Street') RETURNING *`, [`P0T-${TAG}-${seq}`, ownerId, status, published])).rows[0]
}
async function check(prop, o, { hoursAgo = 20, session = 'p0testsess', source = 'manual' } = {}) {
  return (await q(
    `INSERT INTO availability_checks (property_id, owner_id, account_session, owner_chat_id, sent_at, status, source)
     VALUES ($1,$2,$3,$4, NOW() - ($5 || ' hours')::interval, 'awaiting', $6) RETURNING *`,
    [prop.id, o.id, session, o.phone_normalized.replace(/\D/g, '') + '@c.us', String(hoursAgo), source])).rows[0]
}
const reload = async (table, id) => (await q(`SELECT * FROM ${table} WHERE id = $1`, [id])).rows[0]
const inbound = (o, text, id) => av.handleOwnerReply({
  payload: { id, fromMe: false, type: 'chat', body: text, timestamp: Math.floor(Date.now() / 1000) },
  session: 'p0testsess', text, senderPhone: o.phone_normalized.replace(/\D/g, ''), chatId: o.phone_normalized.replace(/\D/g, '') + '@c.us',
})
const ownerTexts = () => queued.filter(j => j.data && j.data.kind === 'human_send' && j.data.text).map(j => j.data.text)

test.after(async () => {
  await q(`DELETE FROM property_activities WHERE property_id IN (SELECT id FROM properties WHERE ref LIKE $1)`, [`P0T-${TAG}-%`])
  await q(`DELETE FROM availability_checks WHERE owner_id IN (SELECT id FROM owner_contacts WHERE name LIKE $1)`, [`P0 Test Owner ${TAG}-%`])
  await q(`DELETE FROM reminders WHERE original_note LIKE $1`, [`P0 test ${TAG}%`])
  await q(`DELETE FROM properties WHERE ref LIKE $1`, [`P0T-${TAG}-%`])
  await q(`DELETE FROM owner_contacts WHERE name LIKE $1`, [`P0 Test Owner ${TAG}-%`])
  await db.end?.()
})

test('"Nothing available" closes the whole current offer of the owner, once, and stops further inquiries', async () => {
  const o = await owner()
  const a = await property(o.id, 'pending_check'), b = await property(o.id, 'available_confirmed')
  const rentedBefore = await property(o.id, 'rented', false), archived = await property(o.id, 'archived', false)
  const cA = await check(a, o, { hoursAgo: 2 }), cOld = await check(b, o, { hoursAgo: 24 * 60 })
  const rem = (await q(`INSERT INTO reminders (owner_phone, owner_name, original_note, contact_due_date, status, auto_send_status, auto_send_enabled)
                        VALUES ($1,'x',$2, CURRENT_DATE, 'pending', 'queued', TRUE) RETURNING id`, [o.phone_normalized, `P0 test ${TAG} reminder`])).rows[0]
  // a next-morning follow-up for the open check and a delayed send to this chat are already queued
  const jobs = [{ data: { kind: 'morning', checkId: cA.id }, removed: false }, { data: { kind: 'human_send', chatId: o.phone_normalized.replace(/\D/g, '') + '@c.us', text: 'queued earlier' }, removed: false },
                { data: { kind: 'morning', checkId: 999999999 }, removed: false }]
  for (const j of jobs) { j.remove = async () => { j.removed = true }; delayedJobs.push(j) }
  queued.length = 0; stubs.alerts.length = 0

  const res = await inbound(o, 'Nothing available', `P0MSG-${TAG}-1`)
  assert.equal(res.handled, 'owner_all_unavailable')

  for (const p of [a, b]) {
    const row = await reload('properties', p.id)
    assert.equal(row.available_status, 'not_available', 'listing is not available')
    assert.equal(row.published, false, 'listing is out of public marketing')
    assert.notEqual(row.available_status, 'rented', 'never invents a rented status')
    assert.match(row.status_change_reason, /Owner said nothing is available/)
    const act = (await q(`SELECT details FROM property_activities WHERE property_id=$1 AND activity_type='owner_all_unavailable'`, [p.id])).rows
    assert.equal(act.length, 1); assert.equal(act[0].details.source_message_id, `P0MSG-${TAG}-1`); assert.equal(act[0].details.old_status, p.available_status)
  }
  assert.equal((await reload('properties', rentedBefore.id)).available_status, 'rented', 'history untouched')
  assert.equal((await reload('properties', archived.id)).available_status, 'archived', 'history untouched')
  for (const c of [cA, cOld]) { const row = await reload('availability_checks', c.id); assert.equal(row.status, 'replied_no'); assert.ok(row.reply_at); assert.equal(row.reply_message_id, `P0MSG-${TAG}-1`) }
  const r = await reload('reminders', rem.id); assert.equal(r.auto_send_status, 'blocked'); assert.equal(r.auto_send_enabled, false); assert.match(r.auto_send_block_reason, /OWNER_SAID_NOTHING_AVAILABLE/)
  const oc = await reload('owner_contacts', o.id); assert.ok(oc.owner_contact_paused_until > new Date(Date.now() + 100 * 86400e3)); assert.match(oc.owner_contact_pause_note, /^OWNER_SAID_NOTHING_AVAILABLE/)
  assert.equal(oc.do_not_contact === true, false, 'not a do-not-contact: only availability questions stop')
  assert.equal(jobs[0].removed, true, 'queued next-morning follow-up removed'); assert.equal(jobs[1].removed, true, 'queued delayed send to this chat removed'); assert.equal(jobs[2].removed, false, 'other owners untouched')
  const texts = ownerTexts()
  assert.equal(texts.length, 1, 'exactly one acknowledgement'); assert.doesNotMatch(texts[0], /which one|\?/i, 'no clarifying question')
  assert.equal(stubs.alerts.length, 1, 'staff is told once')

  // the same inbound message again (webhook redelivery): nothing changes, nothing is sent
  const before = JSON.stringify([await reload('properties', a.id), await reload('owner_contacts', o.id)])
  const again = await inbound(o, 'Nothing available', `P0MSG-${TAG}-1`)
  assert.equal(again.handled, 'owner_all_unavailable')
  assert.equal(JSON.stringify([await reload('properties', a.id), await reload('owner_contacts', o.id)]), before)
  assert.equal(ownerTexts().length, 1, 'no second acknowledgement'); assert.equal(stubs.alerts.length, 1)
  assert.equal((await q(`SELECT COUNT(*)::int n FROM property_activities WHERE property_id=$1 AND activity_type='owner_all_unavailable'`, [a.id])).rows[0].n, 1)

  // the follow-up that was queued for the next morning would not send even if it still existed
  const fu = await av.processAvailabilityJob({ kind: 'morning', checkId: cA.id })
  assert.equal(fu.skipped, 'already_replied')
  // and every automatic owner contact is refused by the shared pre-send gate
  for (const kind of ['followup', 'reminder']) {
    const g = await ownerSendGate.checkOwnerSend({ ownerId: o.id, propertyId: a.id, kind, automated: true, reviewRequired: false })
    assert.equal(g.allow, false, `${kind} blocked`); assert.match(String(g.reason), /owner_contact_paused/)
  }
})

test('a property-specific or unclear answer is never applied owner-wide', async () => {
  const o = await owner(); const a = await property(o.id, 'available'), b = await property(o.id, 'available')
  for (const text of ['Nothing available until February', 'All rented except number 3', `#${a.ref} is rented`, 'ok thanks']) {
    const res = await scope.maybeHandleInbound({ text, phones: [o.phone_normalized] })
    assert.equal(res.handled, false, text)
  }
  for (const p of [a, b]) { const row = await reload('properties', p.id); assert.equal(row.available_status, 'available'); assert.equal(row.published, true) }
  assert.equal((await reload('owner_contacts', o.id)).owner_contact_paused_until, null)
})

test('a follow-up never goes out after the owner has written, even if the reply could not be classified', async () => {
  const o = await owner(); const a = await property(o.id, 'available'); const c = await check(a, o, { hoursAgo: 18 })
  queued.length = 0
  await inbound(o, 'I am abroad, my wife will call you', `P0MSG-${TAG}-2`)      // not an availability verdict
  assert.equal((await reload('availability_checks', c.id)).status, 'awaiting', 'the question is still open')
  for (const kind of ['morning', 'call_ping']) {
    const res = await av.processAvailabilityJob({ kind, checkId: c.id })
    assert.equal(res.skipped, 'owner_wrote_since_question', kind)
  }
  assert.equal((await reload('availability_checks', c.id)).needs_review, true, 'handed to a human instead')
  assert.equal((await reload('availability_checks', c.id)).morning_sent_at, null)
})

test('a new explicit offer lifts the pause but re-lists nothing by itself', async () => {
  const o = await owner(); const a = await property(o.id, 'available')
  await scope.maybeHandleInbound({ text: 'all rented', phones: [o.phone_normalized], messageId: `P0MSG-${TAG}-3`, deps: { invalidateQueuedForOwner: async () => 0, alertAdmin: async () => {} } })
  assert.ok((await reload('owner_contacts', o.id)).owner_contact_paused_until)
  const res = await scope.maybeHandleInbound({ text: 'I have a new apartment available in Gzira', phones: [o.phone_normalized] })
  assert.equal(res.pauseLifted, true); assert.equal(res.handled, false)
  assert.equal((await reload('owner_contacts', o.id)).owner_contact_paused_until, null)
  assert.equal((await reload('properties', a.id)).available_status, 'not_available', 'old listing stays off until staff or the normal flow re-lists it')
})

// Replay of the real incident on a COPY of production data (never production):
//   P0_REPLAY_OWNER=3573 P0_REPLAY_CHECK=1068
test('incident replay on copied data: the 2026-11-11 reply closes both listings and the morning nudge does not send', { skip: !process.env.P0_REPLAY_OWNER }, async () => {
  const ownerId = Number(process.env.P0_REPLAY_OWNER), checkId = Number(process.env.P0_REPLAY_CHECK)
  const o = await reload('owner_contacts', ownerId)
  const before = (await q(`SELECT id, ref, available_status, published FROM properties WHERE owner_id=$1 ORDER BY id`, [ownerId])).rows
  const c = await reload('availability_checks', checkId)
  assert.equal(c.status, 'awaiting', 'the copy still has the open question')
  queued.length = 0
  const res = await av.handleOwnerReply({
    payload: { id: `REPLAY-${TAG}`, fromMe: false, type: 'chat', body: 'Nothing available', timestamp: Math.floor(Date.now() / 1000) },
    session: c.account_session, text: 'Nothing available', senderPhone: o.phone_normalized.replace(/\D/g, ''), chatId: o.phone_normalized.replace(/\D/g, '') + '@c.us',
  })
  assert.equal(res.handled, 'owner_all_unavailable')
  const after = (await q(`SELECT id, ref, available_status, published FROM properties WHERE owner_id=$1 ORDER BY id`, [ownerId])).rows
  console.log('replay:', before.map(p => `${p.ref} ${p.available_status}/${p.published}`).join(', '), '=>', after.map(p => `${p.ref} ${p.available_status}/${p.published}`).join(', '))
  assert.ok(after.length >= 2 && after.every(p => p.available_status === 'not_available' && p.published === false))
  assert.equal((await q(`SELECT COUNT(*)::int n FROM availability_checks WHERE owner_id=$1 AND status='awaiting'`, [ownerId])).rows[0].n, 0)
  assert.equal((await av.processAvailabilityJob({ kind: 'morning', checkId })).skipped, 'already_replied')
  const texts = ownerTexts(); assert.equal(texts.length, 1); assert.doesNotMatch(texts[0], /which one/i)
})
