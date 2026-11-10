'use strict'
// Owner AI recalibration (Claude, 2026-11-10) — founder screenshot and live-DB
// conversations through the REAL autoOwnerConversation.processStep worker on
// the isolated test DB (argus_test). WAHA and queues are stubbed by the
// harness: nothing reaches WhatsApp.
//
// The same scenarios run twice:
//   OWNER_AI_LABEL=before  → production code as deployed (evidence only)
//   OWNER_AI_LABEL=after   → recalibrated code (evidence + assertions)
// Evidence: test/out/runtime-<label>.json
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const H = require('./helpers/ownerHarness')
const Auto = H.load('services/autoOwnerConversation')

const LABEL = process.env.OWNER_AI_LABEL || 'after'
const AFTER = LABEL === 'after'
const OWNER = '35699000777'
const evidence = []

const RealDate = Date
function pinClock(iso) {
  const fixed = new RealDate(iso).getTime()
  global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [fixed])) } static now() { return fixed } }
}
const row = async id => (await H.db.query(`SELECT status, cancelled_reason, automation_disabled, checklist, scheduled_response_at FROM owner_auto_conversations WHERE id=$1`, [id])).rows[0]

async function conversation(session, pending, checklist = {}) {
  return (await H.db.query(
    `INSERT INTO owner_auto_conversations (phone, session, status, checklist) VALUES ($1, $2, 'active_collecting', $3::jsonb) RETURNING id`,
    [OWNER, session, JSON.stringify({ ...checklist, _pending: pending })])).rows[0].id
}

const PERSONAS = { Cedric: 'cedric', Gabriela: 'gabriela', default: 'kev', kevthirdd: 'kev', Argus4: 'kev', Argus3: 'kev' }
async function run({ id, title, session, pending, checklist = {}, at = '2026-11-10T13:30:00Z', beforePending = null }) {
  await H.reset()
  for (const t of ['owner_auto_conversations', 'global_contact_suppressions', 'outreach_log', 'owner_privacy_requests', 'owner_automation_blocks', 'owner_assistant_state', 'blacklist']) await H.db.query(`TRUNCATE ${t} RESTART IDENTITY CASCADE`).catch(() => {})
  await H.db.query(`TRUNCATE owner_ai_decisions RESTART IDENTITY`).catch(() => {})
  await H.owner(OWNER)
  await H.account(session, PERSONAS[session] || 'kev')
  pinClock(at)
  const turn = AFTER || !beforePending ? pending : beforePending
  const convId = await conversation(session, turn, checklist)
  try { await Auto.processStep({ conversationId: convId, phone: OWNER, session }) } finally { global.Date = RealDate }
  const r = await row(convId)
  const c = r.checklist || {}
  const facts = Object.fromEntries(['price', 'previous_price', 'bedrooms', 'bathrooms', 'property_subtype', 'listing_kind', 'property_category', 'available_date',
    'tenant_departure_date', 'availability_status', 'viewing_status', 'pets', 'size_sqm', 'callback_requested', '_media_pending', 'do_not_contact'].filter(k => c[k] != null).map(k => [k, c[k]]))
  const decision = (await H.db.query(`SELECT next_action, reason_code, sent, block_reason FROM owner_ai_decisions ORDER BY id DESC LIMIT 1`).catch(() => ({ rows: [] }))).rows[0] || null
  const dnc = (await H.db.query(`SELECT count(*)::int n FROM global_contact_suppressions WHERE active`).catch(() => ({ rows: [{ n: null }] }))).rows[0].n
  const out = { id, title, session, inbound: turn, sent: H.sent.map(s => s.text), status: r.status, reason: r.cancelled_reason, deferred_until: r.scheduled_response_at, facts, decision, global_suppressions: dnc,
    pending_kept: Array.isArray(c._pending) && c._pending.length > 0 }
  evidence.push(out)
  return out
}

test.after(async () => {
  const dir = path.join(__dirname, 'out'); fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `runtime-${LABEL}.json`), JSON.stringify(evidence, null, 2))
  // Real modules keep timers/pools open; end the run once evidence is written.
  await H.db.end?.().catch(() => {})
  setTimeout(() => process.exit(process.exitCode || 0), 500).unref()
})

const BOT_PERMIT_Q = { from: 'bot', text: 'Perfect, thank you, what permits or licences does the property currently have?', at: '2026-11-09T14:35:37.787Z' }
const BOT_SHARING_Q = { from: 'bot', text: 'Do you consider professional sharing in the apartment?', at: '2026-11-09T09:31:21.091Z' }
const BOT_SUBLET_Q = { from: 'bot', text: "One last question, sorry for the spam, but I want to make sure I ask before I don't and you somehow accept it. If I have super serious subletting companies with very interesting offers for you, would you may consider it?", at: '2026-11-09T09:40:33.733Z' }
const NO_FORBIDDEN = /sorry to hear|on appointments|sorry for the spam|one last question|sublet/i

test('S01 Cedric: auto-reply + "are you an agent" → verified Cedric/QuickLets answer, no intake question', async () => {
  const e = await run({ id: 'S01', title: 'identity question behind a third-party auto-reply', session: 'Cedric',
    pending: ['Thank you for contacting Gabriella! Please let us know how we can help.', "Are you an agent in Malta or do you own properties? I'm an agent also; I asked a question."],
    checklist: { _classified: true, _log: [{ from: 'bot', text: 'How many bedrooms does it have?', at: '2026-11-10T08:00:00Z' }] } })
  if (!AFTER) return
  assert.equal(e.sent.length, 1)
  assert.match(e.sent[0], /Cedric/); assert.match(e.sent[0], /QuickLets/); assert.match(e.sent[0], /\bagent\b/i)
  assert.doesNotMatch(e.sent[0], /bedroom|bathroom|rent per month|Gabriel/i)
})

test('S04 "I\'m not sure what you mean" after a permit question for residential flats → apology + withdrawal', async () => {
  const e = await run({ id: 'S04', title: 'clarification after wrong permit question', session: 'default',
    pending: ["I'm not sure what you mean."],
    checklist: { _classified: true, property_category: 'commercial', _log: [{ from: 'owner', text: "They're both residential apartments.", at: '2026-11-09T14:30:00Z' }, BOT_PERMIT_Q] } })
  if (!AFTER) return
  assert.equal(e.sent.length, 1)
  assert.match(e.sent[0], /sorry/i); assert.match(e.sent[0], /residential/i)
  assert.doesNotMatch(e.sent[0], /permit status|approximate size/i)
})

test('S05 "Both around 90sqm. Give me a call" → handoff, call acknowledged, area saved, no permit question', async () => {
  const e = await run({ id: 'S05', title: 'callback request with area', session: 'default',
    pending: ['Both around 90sqm. Give me a call if you need more info.'],
    checklist: { _classified: true, property_category: 'residential', _log: [{ from: 'owner', text: 'Two residential apartments', at: '2026-11-09T14:00:00Z' }] } })
  if (!AFTER) return
  assert.equal(e.status, 'needs_human_contact')
  assert.ok(e.sent.length <= 1); if (e.sent[0]) { assert.match(e.sent[0], /call/i); assert.doesNotMatch(e.sent[0], /permit|licen/i) }
  assert.equal(e.facts.size_sqm, 90); assert.equal(e.facts.callback_requested, true)
})

test('S06 "It\'s €2,800. And yes, it\'s available." → price corrected to 2800 (old 2649 kept), no "sorry to hear"', async () => {
  const e = await run({ id: 'S06', title: 'price correction + available', session: 'Gabriela',
    pending: ["It's €2,800. And yes, it's available."], checklist: { _classified: true, price: 2649, town: 'Sliema', bedrooms: 3, bathrooms: 2 } })
  if (!AFTER) return
  assert.equal(e.facts.price, 2800); assert.equal(e.facts.previous_price, 2649)
  assert.equal(e.facts.availability_status, 'AVAILABLE_MARKETING')
  assert.equal(e.sent.length, 1); assert.match(e.sent[0], /2,800/); assert.doesNotMatch(e.sent[0], NO_FORBIDDEN)
  assert.equal(e.facts.available_date, 'available (owner confirmed; exact date not given)')
})

test('S07 "My tenant leaves on 20 November" → departure saved, NOT the available-from date', async () => {
  const e = await run({ id: 'S07', title: 'tenant move-out date', session: 'Gabriela',
    pending: ['My tenant leaves on 20 November.'], checklist: { _classified: true, price: 2800, town: 'Sliema', bedrooms: 3, bathrooms: 2 } })
  if (!AFTER) return
  assert.equal(e.facts.tenant_departure_date, '2026-11-20')
  assert.match(String(e.facts.available_date), /^after 2026-11-20 \(current tenant leaves; to confirm\)$/)
  assert.equal(e.sent.length, 1); assert.match(e.sent[0], /20 November/); assert.doesNotMatch(e.sent[0], /rented\?|on a break|sorry to hear/i)
})

test('S08 "not available, rented for many years. Thanks." → NO_SEND, declined, long-term unavailable stored', async () => {
  const e = await run({ id: 'S08', title: 'long-term rented', session: 'kevthirdd',
    pending: ['No pets', "It's not available, it's rented for many years. Thanks."], checklist: { _classified: true, town: 'Msida', photos: null } })
  if (!AFTER) return
  assert.equal(e.sent.length, 0); assert.equal(e.status, 'declined')
  assert.equal(e.facts.availability_status, 'UNAVAILABLE_LONG_TERM'); assert.equal(e.facts.pets, 'no')
})

test('S09 "No thanks for now" after the subletting pitch → NO_SEND', async () => {
  const e = await run({ id: 'S09', title: 'decline after subletting pitch', session: 'Gabriela',
    pending: ['No thanks for now.'], checklist: { _classified: true, _log: [BOT_SUBLET_Q] } })
  if (!AFTER) return
  assert.equal(e.sent.length, 0); assert.equal(e.status, 'declined')
})

test('S10 room in a 3-bedroom shared flat → one ROOM, €900, no sharing/bedroom question', async () => {
  const e = await run({ id: 'S10', title: 'room in shared apartment', session: 'Cedric',
    pending: ['Double room available 1 Dec, €900 all inclusive, in a three-bedroom sharing apartment. Only one room is available; other two are rented. Two bathrooms', 'No pets'],
    checklist: { _classified: true } })
  if (!AFTER) return
  assert.equal(e.facts.listing_kind, 'room'); assert.equal(e.facts.price, 900); assert.equal(e.facts.pets, 'no')
  assert.equal(e.sent.length, 1); assert.match(e.sent[0], /room/i)
  assert.doesNotMatch(e.sent[0], /professional sharing|how many bedrooms|sorry/i)
})

test('S11 "What do you mean please? It\'s a good room." after the sharing question → apology, room kept', async () => {
  const e = await run({ id: 'S11', title: 'clarification after sharing question to a room', session: 'Gabriela',
    pending: ["What do you mean please? It's a good room."], checklist: { _classified: true, listing_kind: 'room', _log: [BOT_SHARING_Q] } })
  if (!AFTER) return
  assert.equal(e.sent.length, 1); assert.match(e.sent[0], /sorry/i); assert.match(e.sent[0], /room/i)
  assert.doesNotMatch(e.sent[0], /would you consider professional sharing/i)
})

test('S12 "Valletta studio, 1100e" → studio, €1,100, never "how many bedrooms"', async () => {
  const e = await run({ id: 'S12', title: 'studio with price', session: 'default', pending: ['Valletta studio, 1100e.'], checklist: { _classified: true } })
  if (!AFTER) return
  assert.equal(e.facts.property_subtype, 'studio'); assert.equal(e.facts.price, 1100); assert.equal(e.facts.bedrooms, 0)
  assert.equal(e.sent.length, 1); assert.match(e.sent[0], /studio/i); assert.doesNotMatch(e.sent[0], /how many bedrooms/i)
})

test('S14 video of the studio → wait for media, nothing re-asked', async () => {
  const e = await run({ id: 'S14', title: 'video attachment', session: 'default', pending: ['[video]'], beforePending: ['[document]'],
    checklist: { _classified: true, property_subtype: 'studio', town: 'Valletta', price: 1100, _file_unreadable: true } })
  if (!AFTER) return
  assert.equal(e.sent.length, 0); assert.equal(e.facts._media_pending, 'PENDING'); assert.equal(e.status, 'active_collecting')
})

test('S15 "One bathroom." + voice note → bathroom saved, truthful handoff, no "on appointments"', async () => {
  const e = await run({ id: 'S15', title: 'voice note with a fact', session: 'default', pending: ['One bathroom.', '[voice]'],
    checklist: { _classified: true, property_subtype: 'studio', town: 'Valletta', price: 1100 } })
  if (!AFTER) return
  assert.equal(e.facts.bathrooms, 1); assert.equal(e.status, 'needs_human_contact')
  assert.ok(e.sent.length <= 1); for (const s of e.sent) assert.doesNotMatch(s, /appointments|how many bedrooms/i)
})

test('S16 inbound at 00:47 Malta → DEFER, nothing sent, the burst stays pending for the morning', async () => {
  const e = await run({ id: 'S16', title: 'quiet hours', session: 'default', pending: ['Do you accept pets?'], at: '2026-11-09T23:47:00Z', checklist: { _classified: true } })
  if (!AFTER) return
  assert.equal(e.sent.length, 0); assert.equal(e.decision.next_action, 'DEFER'); assert.ok(e.pending_kept, 'pending kept for re-evaluation')
  assert.ok(e.deferred_until && new RealDate(e.deferred_until) >= new RealDate('2026-11-10T07:30:00Z'))
})

test('S02 villa with viewing tomorrow 3 PM → facts saved, handoff, never "rented"', async () => {
  const e = await run({ id: 'S02', title: 'villa + viewing offer', session: 'Cedric',
    pending: ['Villa available 4 December, 4 bedrooms plus office, 3-car garage, pool, €5,600. Address and photos attached. Viewing tomorrow at 3 PM.'], checklist: {} })
  if (!AFTER) return
  assert.equal(e.status, 'needs_human_contact'); assert.equal(e.facts.price, 5600); assert.equal(e.facts.bedrooms, 4); assert.equal(e.facts.viewing_status, 'PROPOSED')
  assert.equal(e.sent.length, 1); assert.match(e.sent[0], /3:00/); assert.doesNotMatch(e.sent[0], /found the right tenants|it's rented|booked/i)
})

test('S20 privacy complaint → DNC + global suppression, nothing sent', async () => {
  const e = await run({ id: 'S20', title: 'privacy / deletion request', session: 'default',
    pending: ['You obtained my number without my permission. Remove my details from your database.'], checklist: {} })
  if (!AFTER) return
  assert.equal(e.sent.length, 0); assert.ok(['cancelled_chat', 'human_review_required'].includes(e.status), e.status); assert.ok(e.global_suppressions >= 1)
})

test('LIVE-6340 bungalow wrongly classified commercial → no permit question', async () => {
  const e = await run({ id: 'LIVE-6340', title: 'residential bungalow asked for permits (real 10 Nov chat)', session: 'Argus4',
    pending: ['Big pool and garden'],
    checklist: { _classified: true, property_category: 'commercial', town: 'Kappara', price: 4500,
      _log: [{ from: 'owner', text: 'Good day we have a bungalow in kappara 4 bedroom 3 bathrooms big pool', at: '2026-11-10T08:39:38Z' }] } })
  if (!AFTER) return
  for (const s of e.sent) assert.doesNotMatch(s, /permit|licen|how many bedrooms|how many bathrooms/i)
  assert.equal(e.facts.bedrooms, 4); assert.equal(e.facts.bathrooms, 3)
})

test('LIVE-6302 cooperative owner → never the "sorry for the spam" subletting pitch', async () => {
  const e = await run({ id: 'LIVE-6302', title: 'subletting pitch at the end of intake (real 8 Nov chat)', session: 'Gabriela',
    pending: ['Yes sharing is fine'],
    checklist: { _classified: true, price: 1400, bedrooms: 2, bathrooms: 1, town: 'Msida', available_date: '2026-12-01', viewable_date: 'now', photos: true, address: 'given', pets: 'no', _asked_map: true, _asked_pets: true, _asked_sharing: true,
      _log: [BOT_SHARING_Q] } })
  if (!AFTER) return
  for (const s of e.sent) assert.doesNotMatch(s, NO_FORBIDDEN)
})
