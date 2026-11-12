'use strict'
// Divider-terminated upload packages — state machine and package assembly.
// No database, no WhatsApp: db, waha and the upload pipeline are fakes.
//   node --test test/dividerUpload.unit.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('module')
const path = require('path')

const rows = []            // upload_packages
const events = []          // automation events
let history = []           // what WAHA would return
const sql = async (q, p = []) => {
  q = q.replace(/\s+/g, ' ').trim()
  if (q.startsWith('SELECT group_id FROM group_config')) return { rows: [{ group_id: 'G@g.us' }] }
  if (q.startsWith('SELECT COALESCE(MAX(divider_ts)')) {
    const ts = Math.max(0, ...rows.filter(r => r.chat_id === p[0] && r.sender_jid === p[1] && r.divider_ts < p[2]).map(r => r.divider_ts))
    return { rows: [{ ts }] }
  }
  if (q.startsWith('SELECT id, username, name, display_name, alias, role, post_tag FROM agents WHERE id')) return { rows: p[0] === 7 ? [{ id: 7, username: 'olga' }] : [] }
  if (q.startsWith('INSERT INTO upload_packages')) {
    if (rows.some(r => r.chat_id === p[0] && r.divider_stanza_id === p[3])) return { rows: [] }
    const r = { id: rows.length + 1, chat_id: p[0], session: p[1], divider_message_id: p[2], divider_stanza_id: p[3], divider_ts: p[4], sender_jid: p[5],
      uploader_phone: p[6], agent_id: p[7], media_expected: p[8], text_chars: p[9], first_message_ts: p[10], summary: p[11], state: 'RECEIVED', attempts: 0, updated_at: Date.now() }
    rows.push(r); return { rows: [{ ...r }] }
  }
  if (q.startsWith("UPDATE upload_packages SET state = 'PROCESSING'")) {
    const r = rows.find(x => x.id === p[0] && ['RECEIVED', 'FAILED'].includes(x.state))
    if (!r) return { rows: [] }
    r.state = 'PROCESSING'; r.attempts++; r.failure_reason = null; return { rows: [{ ...r }] }
  }
  if (q.startsWith('UPDATE upload_packages SET state = $2')) {
    const r = rows.find(x => x.id === p[0]); Object.assign(r, { state: p[1], failure_reason: p[2], media_imported: p[3], property_ids: p[4], property_refs: p[5] })
    return { rows: [{ ...r }] }
  }
  if (q.startsWith('SELECT * FROM upload_packages WHERE chat_id = $1 AND state = \'FAILED\'')) {
    const r = rows.filter(x => x.chat_id === p[0] && x.state === 'FAILED').pop(); return { rows: r ? [{ ...r }] : [] }
  }
  if (q.startsWith("UPDATE upload_packages SET state = 'FAILED', failure_reason = 'interrupted")) {
    const hit = rows.filter(x => ['RECEIVED', 'PROCESSING'].includes(x.state) && x.old)
    hit.forEach(x => { x.state = 'FAILED'; x.failure_reason = 'interrupted (restart or crash) before completion' })
    return { rows: hit.map(x => ({ id: x.id, chat_id: x.chat_id })) }
  }
  throw new Error('unexpected SQL in unit test: ' + q.slice(0, 80))
}
const stubs = {
  '../db': { query: sql },
  '../logger': { info() {}, warn() {}, error() {}, debug() {} },
  '../waha': { getChatMessages: async () => history },
  './automationEvents': { record: async e => { events.push(e) } },
  './senderIdentity': { senderDigits: m => String(m.participant || '').replace(/\D/g, '') },
}
const original = Module._load
Module._load = function (request, parent) {
  if (parent && /dividerUpload\.js$/.test(parent.filename || '') && stubs[request]) return stubs[request]
  return original.apply(this, arguments)
}
const du = require(path.join(__dirname, '..', 'services', 'dividerUpload.js'))

const OLGA = '111@lid', OTHER = '222@lid', BOT = '999@lid'
let seq = 0
const msg = (ts, from, body, hasMedia = false) => ({ id: `false_G@g.us_ID${++seq}_${from}`, timestamp: ts, from: 'G@g.us', participant: from, fromMe: false, body, hasMedia })
const AD = 'Rabat Townhouse - 3 bedrooms, 3 bathrooms, EUR 2,200 per month, available from 15 February 2027. Owner: 9900 0000'
// 38 photos sent as separate messages over 25 minutes (WhatsApp splits a big album), then the description, then "..."
function rabatPackage(t0) {
  const out = []
  for (let i = 0; i < 38; i++) out.push(msg(t0 + i * 40, OLGA, '', true))
  out.push(msg(t0 + 38 * 40 + 5, OLGA, AD))
  const divider = msg(t0 + 38 * 40 + 9, OLGA, '...')
  return { out, divider }
}
const replies = []
const reply = async (s, c, text) => { replies.push(text) }
const agent = { id: 7, username: 'olga' }
const reset = () => { rows.length = 0; events.length = 0; replies.length = 0; history = [] }

test('a 38-photo album spread over 25 minutes is one complete package', () => {
  const { out, divider } = rabatPackage(1_000_000)
  const earlier = [msg(999_000, OLGA, '', true), msg(999_010, OLGA, 'Spinola Bay Penthouse, 2 bedrooms, EUR 3,900, available mid January 2027, lovely terrace'), msg(999_020, OLGA, '...')]
  const noise = [msg(1_000_100, OTHER, 'when is the viewing tomorrow? please tell me the exact time', false), msg(1_000_200, OTHER, '', true)]
  const pack = du.assemblePackage([...earlier, ...out, ...noise, divider].reverse(), divider, { keyOf: du.senderKey })
  assert.equal(pack.mediaCount, 38)
  assert.equal(pack.complete, true)
  assert.equal(pack.text, AD)
  assert.equal(pack.firstTs, 1_000_000)
  assert.ok(pack.lastTs - pack.firstTs > 600, 'longer than the old 10-minute window')
})

test('an opening divider, chatter and our own confirmations are not a package', () => {
  const opening = msg(500, OLGA, '...')
  assert.equal(du.assemblePackage([opening], opening).complete, false)
  const photosOnly = [msg(600, OLGA, '', true), msg(601, OLGA, '', true)], d2 = msg(610, OLGA, '....')
  assert.equal(du.assemblePackage([...photosOnly, d2], d2).complete, false)
  // another logged-in session sees the bot's own confirmation + divider as a group message
  const bot = [msg(700, BOT, '✅ #2906-9800 → CRM\nRabat · 3BR/3BA · €2200\n38 images'), msg(701, BOT, '📝 IMPORTED as internal draft — #2906-9800 (ID 9800, 38 media). Not published.')]
  const d3 = msg(702, BOT, '...')
  assert.equal(du.assemblePackage([...bot, d3], d3).complete, false)
  assert.equal(du.isDivider('...'), true); assert.equal(du.isDivider('.....'), true); assert.equal(du.isDivider('ok...'), false)
})

test('the stanza id is the same whichever session reports the message', () => {
  assert.equal(du.stanzaOf({ id: 'false_G@g.us_3EB0AA_111@lid' }), '3EB0AA')
  assert.equal(du.stanzaOf({ id: 'false_G@g.us_3EB0AA_35699000000@c.us' }), '3EB0AA')
  assert.equal(du.stanzaOf({ id: 'false_G@g.us_3EB0AA' }), '3EB0AA')
})

test('IMPORTED: real property id and media count, exactly once, with the package window handed to the pipeline', async () => {
  reset()
  const { out, divider } = rabatPackage(2_000_000); history = [...out, divider]
  const calls = []
  const run = async a => { calls.push(a); a.onResult({ created: [{ propId: 9800, ref: '2906-9800', imageCount: 38, videoCount: 0 }], dupes: [], errors: [] }); return true }
  assert.equal(await du.handleDivider({ payload: divider, session: 'Argus3', chatId: 'G@g.us', uploaderPhone: '111', agent, run, reply, settleMs: 0 }), true)
  // WAHA redelivers the same divider (other session id form) and the backend restarts in between
  const again = { ...divider, id: divider.id.replace('_111@lid', '_35679000000@c.us') }
  assert.equal(await du.handleDivider({ payload: again, session: 'Argus3', chatId: 'G@g.us', uploaderPhone: '111', agent, run, reply, settleMs: 0 }), true)
  assert.equal(calls.length, 1, 'imported once')
  assert.equal(calls[0].agentOverride.username, 'olga', 'the package keeps its uploader on every run')
  assert.equal(calls[0].intakeMode, 'review'); assert.equal(calls[0].noAd, true); assert.equal(calls[0].wantsGroup, false)
  assert.equal(calls[0].payload._windowStartTs, 2_000_000 - 1)
  assert.equal(calls[0].payload._historyLimit, 120)
  assert.equal(rows.length, 1)
  assert.deepEqual([rows[0].state, rows[0].media_expected, rows[0].media_imported, rows[0].property_ids, rows[0].property_refs], ['IMPORTED', 38, 38, [9800], ['2906-9800']])
  assert.match(replies[0], /RECEIVED — 38 photos/)
  assert.deepEqual(events.map(e => e.action), ['RECEIVED', 'PROCESSING', 'IMPORTED'])
  assert.equal(events[2].propertyId, 9800)
})

test('REVIEW REQUIRED when fewer media arrive than the package holds', async () => {
  reset()
  const { out, divider } = rabatPackage(3_000_000); history = [...out, divider]
  const run = async a => { a.onResult({ created: [{ propId: 9801, ref: '2906-9801', imageCount: 30, videoCount: 0 }], dupes: [], errors: [] }) }
  await du.handleDivider({ payload: divider, session: 'Argus3', chatId: 'G@g.us', uploaderPhone: '111', agent, run, reply, settleMs: 0 })
  assert.equal(rows[0].state, 'REVIEW_REQUIRED')
  assert.match(rows[0].failure_reason, /30 of 38/)
  assert.ok(replies.some(r => /REVIEW REQUIRED — #2906-9801 \(ID 9801\): saved as an internal draft with 30 of 38 photos\/videos, not published/.test(r)))
})

test('FAILED states the reason, creates nothing, and !retry runs the same package again', async () => {
  reset()
  const { out, divider } = rabatPackage(4_000_000); history = [...out, divider]
  let attempt = 0
  const run = async a => { if (++attempt === 1) throw new Error('media download timed out'); a.onResult({ created: [{ propId: 9802, ref: '2906-9802', imageCount: 38 }], dupes: [], errors: [] }) }
  await du.handleDivider({ payload: divider, session: 'Argus3', chatId: 'G@g.us', uploaderPhone: '111', agent, run, reply, settleMs: 0 })
  assert.equal(rows[0].state, 'FAILED'); assert.match(rows[0].failure_reason, /media download timed out/)
  assert.ok(replies.some(r => /FAILED — package of 38 media was not imported: media download timed out[\s\S]*!retry/.test(r)))
  assert.deepEqual(rows[0].property_ids, [])
  await du.retryLatestFailed({ session: 'Argus3', chatId: 'G@g.us', run, reply })
  assert.deepEqual([rows[0].state, rows[0].attempts, rows[0].property_ids], ['IMPORTED', 2, [9802]])
  // nothing left to retry
  await du.retryLatestFailed({ session: 'Argus3', chatId: 'G@g.us', run, reply })
  assert.equal(attempt, 2); assert.match(replies.at(-1), /Nothing to retry/)
})

test('DUPLICATE creates nothing and names the existing reference', async () => {
  reset()
  const { out, divider } = rabatPackage(5_000_000); history = [...out, divider]
  await du.handleDivider({ payload: divider, session: 'Argus3', chatId: 'G@g.us', uploaderPhone: '111', agent, reply, settleMs: 0,
    run: async a => a.onResult({ created: [], dupes: ['2906-9150'], errors: [] }) })
  assert.equal(rows[0].state, 'DUPLICATE'); assert.match(replies.at(-1), /DUPLICATE — nothing created \(duplicate of #2906-9150\)/)
})

test('a pipeline that reports nothing is FAILED, never a silent success', async () => {
  reset()
  const { out, divider } = rabatPackage(6_000_000); history = [...out, divider]
  await du.handleDivider({ payload: divider, session: 'Argus3', chatId: 'G@g.us', uploaderPhone: '111', agent, reply, settleMs: 0, run: async () => false })
  assert.equal(rows[0].state, 'FAILED'); assert.match(rows[0].failure_reason, /created nothing/)
})

test('an unregistered sender is ignored; a package interrupted by a restart becomes FAILED and retryable', async () => {
  reset()
  const { out, divider } = rabatPackage(7_000_000); history = [...out, divider]
  assert.equal(await du.handleDivider({ payload: divider, session: 'Argus3', chatId: 'G@g.us', uploaderPhone: null, agent: null, reply, settleMs: 0, run: async () => { throw new Error('must not run') } }), false)
  assert.equal(rows.length, 0)
  rows.push({ id: 1, chat_id: 'G@g.us', state: 'PROCESSING', old: true, divider_stanza_id: 'X', divider_message_id: 'X', divider_ts: 1, sender_jid: OLGA, media_expected: 38, attempts: 1 })
  assert.deepEqual((await du.sweepStuck()).map(r => r.id), [1])
  assert.equal(rows[0].state, 'FAILED')
})

test('text from an earlier sitting is not merged in, and chatter ending in "..." is not a package', () => {
  const t0 = 8_000_000
  const stale = [msg(t0 - 14 * 3600, OLGA, 'Not working?'), msg(t0 - 14 * 3600 + 5, OLGA, '', true)]
  const { out, divider } = rabatPackage(t0)
  const pack = du.assemblePackage([...stale, ...out, divider], divider)
  assert.equal(pack.text, AD); assert.equal(pack.mediaCount, 38); assert.equal(pack.orphanMedia, 1)
  const chat = [msg(100, OTHER, 'So many Viewings? There is a 10min rule to upload, just reforward the details please')], d = msg(101, OTHER, '...')
  const c = du.assemblePackage([...chat, d], d)
  assert.equal(c.complete, false); assert.equal(c.reason, 'text is not a property description')
})

test('a draft read without the AI extractor or without an owner contact is REVIEW REQUIRED and says why', async () => {
  reset()
  const { out, divider } = rabatPackage(9_000_000); history = [...out, divider]
  await du.handleDivider({ payload: divider, session: 'Argus3', chatId: 'G@g.us', uploaderPhone: '111', agent, reply, settleMs: 0,
    run: async a => a.onResult({ created: [{ propId: 9803, ref: '2906-9803', imageCount: 38, ownerUnknown: true, explicitFactsOnly: true }], dupes: [], errors: [] }) })
  assert.equal(rows[0].state, 'REVIEW_REQUIRED')
  assert.match(rows[0].failure_reason, /AI extractor unavailable.*; no owner contact in the upload/)
  assert.deepEqual(rows[0].property_ids, [9803]); assert.equal(rows[0].media_imported, 38)
  assert.ok(replies.some(r => /REVIEW REQUIRED — #2906-9803 \(ID 9803\).*38 of 38/.test(r)))
})
