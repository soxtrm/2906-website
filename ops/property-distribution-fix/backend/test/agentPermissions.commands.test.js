'use strict'
// Kev, 2026-10-22 (P1): routine property actions by agents. Drives the REAL
// handlers/upload.js handleWebhookMessage + services/agentPermissions.js; the
// rented/available/category side effects are captured at their service
// boundary (rentedDetector / priority / categoryPublisher), db is a fixture.
// Olga is modelled WITHOUT admin rights here (role 'board', not in
// ADMIN_NUMBERS) to prove routine work never needs global admin.
//   node test/agentPermissions.commands.test.js [path/to/handlers/upload.js]
const assert = require('assert')
const path = require('path')
const Module = require('module')

const AGENTS = [
  { id: 2, username: 'olga', name: 'Olga', role: 'board', whatsapp_phones: ['35679010070'], notify_whatsapp: '35679010070' },
  { id: 13, username: 'katya', name: 'Katya', role: 'board', whatsapp_phones: [], notify_whatsapp: '+356 7776 0202' },
  { id: 3, username: 'tatyana', name: 'Tatyana', role: 'agent', whatsapp_phones: ['35677535977'], notify_whatsapp: null },
]
const PROPS = {
  '2906-9515': { id: 9515, ref: '2906-9515', listed_by_agent_id: 2, activity_agent_id: null, available_status: 'pending_check' },
  '2906-9300': { id: 9300, ref: '2906-9300', listed_by_agent_id: 1, activity_agent_id: null, available_status: 'available' },
}
const t8 = s => String(s || '').replace(/\D/g, '').slice(-8)
const db = {
  query: async (q, p = []) => {
    if (/FROM agents/.test(q)) {
      const a = AGENTS.find(x => t8(x.notify_whatsapp) === p[0] || x.whatsapp_phones.some(w => t8(w) === p[0]))
      return { rows: a ? [a] : [] }
    }
    if (/FROM properties WHERE ref=\$1/.test(q)) { const r = PROPS[p[0]]; return { rows: r ? [{ ...r, town: 'Sliema', bedrooms: null }] : [] } }
    if (/FROM properties WHERE id = \$1/.test(q)) { const r = Object.values(PROPS).find(x => x.id === p[0]); return { rows: r ? [r] : [] } }
    return { rows: [] }
  },
}
const calls = { replies: [], rented: [], returned: [], overrides: [], kev: [] }
const refOf = s => { const m = String(s || '').match(/(?:2906-)?(\d{3,6})/); return m ? `2906-${m[1]}` : null }
const inert = new Proxy(function () {}, { get: (_, k) => (k === 'then' ? undefined : inert), apply: () => inert, construct: () => inert })
const never = async () => false

const original = Module._load
Module._load = function (request) {
  if (request === '../db') return db
  if (request === '../logger') return { info() {}, warn() {}, error() {}, debug() {} }
  if (request === '../config') return { admin: { adminNumbers: ['35699270699'] }, waha: {} }
  if (request === '../lib/sessionRouter') return { sendVia: async (s, c, text) => { calls.replies.push(text) } }
  if (request === '../services/senderIdentity') return { realSenderJid: p => p?._jid || null, phoneFromJid: j => (j ? String(j).replace(/\D/g, '') : null) }
  if (request === '../lib/quotedMessage') return { quotedFromPayload: p => ({ id: p?.replyTo?.id || null, body: p?.replyTo?.body || null }) }
  if (request === './uploadListing') return new Proxy({
    extractSenderPhone: async p => p._phone,
    alertKev: async text => { calls.kev.push(text) },
    // production rule: EXACT match on agents.whatsapp_phones (no notify_whatsapp)
    resolveAgent: async phone => AGENTS.find(a => a.whatsapp_phones.includes(String(phone).replace(/\D/g, ''))) || null,
  }, { get: (t, k) => (k in t ? t[k] : inert) })
  if (request === './priority') return { cmdReturnToMarket: async a => { calls.returned.push(a.arg) }, cmdArchive: never, cmdPriority: never, cmdMarkRecentlyRented: never }
  if (request === '../services/rentedDetector') return {
    resolveRentedTarget: async ({ text, quotedBody }) => { const r = PROPS[refOf(text.replace(/^!rented\s*/, '')) || refOf(quotedBody)]; return r ? { property_id: r.id, ref: r.ref, available_status: r.available_status } : null },
    handleRentedCommand: async (payload) => { calls.rented.push(payload.body) },
  }
  if (request === '../services/categoryPublisher') return {
    RECATEGORIZE_TOKEN_MAP: { 1: 'bed1', 2: 'bed2', 3: 'bed3', 4: 'bed3', c: 'commercial', commercial: 'commercial', lux: 'luxury', luxury: 'luxury' },
    setCategoryOverride: async (id, key, agentId, reason) => { calls.overrides.push({ id, key, agentId, reason }) },
  }
  if (['./av', './book', './ask', './chat'].includes(request)) return { cmdAvConfirm: never, cmdBookConfirm: never, cmdAskConfirm: never, cmdChatConfirm: never }
  if (request === '../services/bookRelay') return { handleAgentMessage: never }
  if (request === '../services/gptUploadCommand') return { parseUploadCommand: () => null, groupCommandDedupKey: () => null, stripUploadCommands: s => s }
  if (request === '../services/agentPermissions') return original.apply(this, arguments)
  if (request.startsWith('.') || ['ioredis', 'bullmq', 'axios', '@google/genai', 'openai', 'cloudinary', 'sharp', 'node-cron'].includes(request)) return inert
  return original.apply(this, arguments)
}
const uploadPath = process.argv[2] || path.join(__dirname, '../handlers/upload.js')
// agentPermissions must resolve next to the handler under test
const upload = require(uploadPath)

const PHONES = { olga: '35679010070', katya: '35677760202', stranger: '35699111222' }
async function send(who, text, extra = {}) {
  for (const k of Object.keys(calls)) calls[k].length = 0
  const payload = { id: 'm1', body: text, from: `${PHONES[who]}@c.us`, _phone: PHONES[who], ...extra }
  const consumed = await upload.handleWebhookMessage({ payload, session: 'Kevsecond', text, isGroup: false, chatId: `${PHONES[who]}@c.us`, senderPhone: PHONES[who] })
  return { consumed, ...JSON.parse(JSON.stringify(calls)) }
}

let passed = 0, failed = 0
const run = async (name, fn) => { try { await fn(); console.log(`  ok   ${name}`); passed++ } catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++ } }

;(async () => {
  console.log('=== agent permissions 2026-10-22 ===')

  await run('T13 Olga (no admin rights) can !available her own property', async () => {
    const r = await send('olga', '!available 9515')
    assert.strictEqual(r.consumed, true)
    assert.deepStrictEqual(r.returned, ['9515'])
  })

  await run('T13b a quoted listing reference works without typing the ref', async () => {
    const r = await send('olga', '!available', { replyTo: { id: 'q1', body: '✅ #2906-9515 published' } })
    assert.deepStrictEqual(r.returned, ['2906-9515'])
  })

  await run('T14 Olga can mark her own property RENTED (same rentedDetector path, audit preserved there)', async () => {
    const r = await send('olga', '!rented 2906-9515')
    assert.deepStrictEqual(r.rented, ['!rented 2906-9515'])
  })

  await run('T15 Olga resolves her own draft category by replying "3" to the category question', async () => {
    const r = await send('olga', '3', { replyTo: { id: 'q2', body: '❓ #2906-9515 needs a category before it goes to the groups — the bedroom count is unknown.' } })
    assert.deepStrictEqual(r.overrides.map(o => [o.id, o.key, o.agentId]), [[9515, 'bed3', 2]])
    assert.ok(/by Olga/.test(r.overrides[0].reason))
  })

  await run('T15b a special destination (LUX) is escalated to an admin, the upload is not blocked', async () => {
    const r = await send('olga', '!recategorize 2906-9515 lux')
    assert.deepStrictEqual(r.overrides, [])
    assert.ok(r.replies.some(x => /needs an admin/.test(x)))
    assert.ok(r.kev.some(x => /2906-9515/.test(x)))
  })

  await run('board agent registered only via notify_whatsapp is recognised (was silently ignored)', async () => {
    PROPS['2906-9300'].activity_agent_id = 13
    const r = await send('katya', '!available 9300')
    PROPS['2906-9300'].activity_agent_id = null
    assert.deepStrictEqual(r.returned, ['9300'])
  })

  await run('T16 a board agent cannot change an unrelated property — explicit reason, no side effect', async () => {
    const r = await send('katya', '!rented 2906-9300')
    assert.deepStrictEqual(r.rented, [])
    assert.ok(r.replies.some(x => /only change properties you listed or are assigned to/.test(x)), r.replies.join('|'))
  })

  await run('T16b an outsider in an external chat can never change inventory (and gets no reply)', async () => {
    const r = await send('stranger', '!rented 2906-9515')
    assert.strictEqual(r.consumed, false)
    assert.deepStrictEqual([r.rented, r.returned, r.replies], [[], [], []])
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})()
