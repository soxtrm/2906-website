'use strict'
// Regression for the 2026-10-17 approval incident, driven through the REAL
// services/adminCommands.js handleAdminMessage(): the same WhatsApp event
// shapes the production log shows (Cedric notes chat, message.any, fromMe,
// body "Yes", 2 s / 4 s / 9 s after the preview), quoted replies, !yes,
// expiry, !cancel, numbers without WhatsApp and a WAHA send failure.
//
// Every dependency outside adminCommands.js / outreachApproval.js is a stub:
// nothing reaches WAHA, Postgres, Redis or a real phone. enqueueOutreachRun
// is idempotent on (source, trigger_id) exactly like the production SQL.

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('module')
const path = require('path')

const SERVICES = path.join(__dirname, '..', 'services')
const REAL = new Set([path.join(SERVICES, 'adminCommands.js'), path.join(SERVICES, 'outreachApproval.js')])
const NOTES_PHONE = '491772889021'
const SESSION = 'Cedric'

let activeStubs = {}
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  const resolved = (() => { try { return Module._resolveFilename(request, parent) } catch { return null } })()
  if (resolved && REAL.has(resolved)) return originalLoad.apply(this, arguments)
  if (request.startsWith('.')) return activeStubs[request] || genericStub()
  return originalLoad.apply(this, arguments)
}

function genericStub() {
  const fn = async () => undefined
  return new Proxy(fn, { get: (target, key) => (key === 'then' ? undefined : key in target ? target[key] : genericStub()) })
}

function harness({ onWhatsApp = () => true, sendError = null } = {}) {
  const sent = []         // every WhatsApp text the bot would have sent
  const runs = new Map()  // trigger_id → run (production: ON CONFLICT DO NOTHING)
  const logs = []
  const stubs = {
    '../waha': {
      sendText: async (session, to, text) => {
        const failure = String(to) !== NOTES_PHONE && sendError ? sendError(String(to)) : null
        if (failure) throw new Error(failure)
        sent.push({ session, to, text })
        return { id: `m${sent.length}` }
      },
      getSessionPhone: async () => NOTES_PHONE,
      getActiveSession: async () => SESSION,
      checkNumberStatus: async (_session, phone) => onWhatsApp(phone),
      getChatMessages: async () => [],
    },
    '../config': {
      admin: { adminNumbers: [NOTES_PHONE], botNumber: '35699811819' },
      waha: { kevinAccounts: ['default', 'Kevsecond', 'kevthirdd'], sessions: [SESSION] },
      timings: { kevinCooldownDays: 10 },
      system: { active: true, outreachActive: true },
      gemini: {}, sheets: {}, telegram: {},
    },
    '../db': { query: async sql => (/RETURNING/i.test(sql) ? { rows: [{ id: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 }) },
    '../logger': new Proxy({}, { get: (_, level) => (msg, meta) => logs.push({ level, msg, meta }) }),
    './outreachRunEngine': {
      DEFAULT_PACING_MODE: 'mixed',
      enqueueOutreachRun: async ({ triggerId, contacts, session }) => {
        if (!runs.has(triggerId)) runs.set(triggerId, { run_id: `run-${runs.size + 1}-0000`, status: 'ready', contacts, session })
        return runs.get(triggerId)
      },
    },
    './superadmins': { isSuperAdmin: async () => true },
    './cooldownRules': { checkOwnerEligibilityViaWAHA: async () => ({ eligible: true }), canContact: async () => ({ allowed: true }) },
    './outreachIdentity': {
      resolveSenderIdentity: async session => ({ accountId: 7, persona: 'Cedric', session, names: ['Cedric'] }),
      findForeignSignatures: () => [],
      describeMismatch: () => 'mismatch',
    },
    './auth': { isAdminAccount: async () => true },
    './senderIdentity': { realSenderJid: () => null, phoneFromJid: () => '' },
    './matchEngine': { handleMatchReply: async () => false, handleMatchCommand: async () => {} },
    './pmPost': { handlePmPostAdminReply: () => false, postPropertyToPropertyMarket: async () => {}, cancelPmPostPending: () => {} },
  }
  // adminCommands.js also requires lazily inside functions (e.g. the run
  // engine on YES), so the stub table stays active for the whole test file.
  activeStubs = stubs
  for (const file of REAL) delete require.cache[file]
  const admin = require(path.join(SERVICES, 'adminCommands.js'))

  const notes = body => ({ body, fromMe: true, from: `${NOTES_PHONE}@c.us`, to: `${NOTES_PHONE}@c.us`, id: `in-${Math.random()}` })
  const say = async (body, extra = {}) => admin.handleAdminMessage({ ...notes(body), ...extra }, SESSION, true)
  const lastReply = () => sent.at(-1)?.text || ''
  return { admin, say, sent, runs, logs, lastReply }
}

// Same two-step flow and spacing as the incident: list at 15:07:00, message
// text at 15:07:10 (the preview goes out right after it).
let currentClock = null
async function preview(h, list = '+35679070465 Tancredi\n+35699100135 Ton') {
  await h.say(`!outreach \n\n${list}`)
  currentClock.advance(10000)
  await h.say("Good Evening, hope you're well.\n\nMy Name is Cedric")
}

function withClock(t, start = Date.parse('2026-10-17T15:07:00Z')) {
  let now = start
  const real = Date.now
  Date.now = () => now
  t.after(() => { Date.now = real })
  currentClock = { advance: ms => { now += ms } }
  return currentClock
}

test('plain "Yes" 2 s after the preview is accepted, acknowledged and enqueued once', async t => {
  const clock = withClock(t)
  const h = harness()
  await preview(h)
  assert.match(h.lastReply(), /Reply \*YES\* to send/)
  clock.advance(2000)                       // the swallowed "Yes" at 15:07:12
  await h.say('Yes')
  assert.equal(h.runs.size, 1)
  assert.match(h.lastReply(), /✅ Approved — 2 message\(s\) will go out via \*Cedric\* \(run run-1-00\)/)
})

test('repeated YES never starts a second run and gets an explicit answer', async t => {
  const clock = withClock(t)
  const h = harness()
  await preview(h)
  clock.advance(5000); await h.say('Yes')
  clock.advance(2000); await h.say('Yes')
  clock.advance(5000); await h.say('YES')
  assert.equal(h.runs.size, 1)
  assert.match(h.lastReply(), /Already approved .* runs once; another YES changes nothing/)
})

test('quoted reply "Yes" (reply to the preview message) is the same approval', async t => {
  const clock = withClock(t)
  const h = harness()
  await preview(h)
  clock.advance(6000)
  await h.say('Yes', { replyTo: { id: 'preview-msg', body: 'Reply *YES* to send' }, hasQuotedMsg: true })
  assert.equal(h.runs.size, 1)
})

test('"!yes" approves while pending and is never "Unknown command"', async t => {
  const clock = withClock(t)
  const h = harness()
  await preview(h)
  clock.advance(6000)
  await h.say('!yes')
  assert.equal(h.runs.size, 1)
  assert.ok(!h.sent.some(m => /Unknown command/.test(m.text)))
})

test('YES / !yes without a pending approval: nothing starts, operator is told', async t => {
  const clock = withClock(t)
  const h = harness()
  await h.say('!yes')
  assert.equal(h.runs.size, 0)
  assert.match(h.lastReply(), /no outreach waiting for approval/)
  assert.ok(!h.sent.some(m => /Unknown command/.test(m.text)))
})

test('expired preview: late YES is answered, nothing is sent', async t => {
  const clock = withClock(t)
  const h = harness()
  await preview(h)
  clock.advance(5 * 60 * 1000 + 1000)
  await h.say('Yes')
  assert.equal(h.runs.size, 0)
  assert.match(h.lastReply(), /expired after 5 minutes — nothing was sent/)
})

test('!cancel clears the pending approval; a later YES starts nothing', async t => {
  const clock = withClock(t)
  const h = harness()
  await preview(h)
  clock.advance(6000); await h.say('!cancel')
  clock.advance(1000); await h.say('Yes')
  assert.equal(h.runs.size, 0)
})

test('list with no WhatsApp numbers is not armed (batch 276)', async t => {
  const clock = withClock(t)
  const h = harness({ onWhatsApp: () => false })
  await preview(h)
  assert.match(h.lastReply(), /📵 Not armed — none of the 2 numbers is on WhatsApp/)
  clock.advance(6000); await h.say('Yes')
  assert.equal(h.runs.size, 0)
})

test('numbers without WhatsApp are removed in the preview and never enqueued', async t => {
  const clock = withClock(t)
  const h = harness({ onWhatsApp: phone => !phone.endsWith('0465') })
  await preview(h)
  assert.match(h.lastReply(), /📵 1 number\(s\) without WhatsApp removed: \+35679070465 Tancredi/)
  clock.advance(6000); await h.say('Yes')
  const run = [...h.runs.values()][0]
  assert.deepEqual(run.contacts.map(c => c.phone), ['35699100135'])
})

test('a genuine bot echo inside 4 s is still suppressed (no double prompt)', async t => {
  const clock = withClock(t)
  const h = harness()
  await preview(h)
  const before = h.sent.length
  clock.advance(1000)
  await h.say('📨 Ready to send 2 outreaches')   // the bot's own preview coming back
  assert.equal(h.sent.length, before)
  assert.equal(h.runs.size, 0)
})

// ── Transport (runDirectOutreach) — what happens after the approval ──────────
const NO_LID = number => `WAHA POST /api/sendText → 500: {"exception":{"message":"2 UNKNOWN: no LID found for ${number}@s.whatsapp.net from server"}}`
const contactsOf = count => Array.from({ length: count }, (_, i) => ({ phone: `3567900${String(i).padStart(4, '0')}`, name: `Owner${i}` }))

function instantTimers(t) {
  const realSetTimeout = global.setTimeout
  global.setTimeout = (fn, _ms, ...args) => realSetTimeout(fn, 0, ...args)
  t.after(() => { global.setTimeout = realSetTimeout })
}

test('a batch whose numbers are not on WhatsApp stops after 5 and reports it (batch 276)', async t => {
  withClock(t); instantTimers(t)
  const h = harness({ sendError: to => NO_LID(to.replace('@c.us', '')) })
  const result = await h.admin.runDirectOutreach(NOTES_PHONE, SESSION, SESSION, contactsOf(40), 'Hi [name]', { pacingType: 'mixed' })
  assert.equal(result.sent, 0)
  assert.equal(result.skipped, 5, 'only the first 5 were attempted')
  const texts = h.sent.map(m => m.text).join('\n---\n')
  assert.match(texts, /stopped — the first 5 numbers are not on WhatsApp/)
  assert.match(texts, /nothing was delivered/)
  assert.match(texts, /Skipped: 5 \(5 not on WhatsApp\)/)
})

test('other WAHA send failures are reported as failed, not hidden', async t => {
  withClock(t); instantTimers(t)
  const h = harness({ sendError: to => (to.endsWith('0001') ? 'WAHA POST /api/sendText → 500: session not ready' : null) })
  const result = await h.admin.runDirectOutreach(NOTES_PHONE, SESSION, SESSION, contactsOf(3), 'Hi [name]', { pacingType: 'mixed' })
  assert.equal(result.sent, 2)
  assert.equal(result.failed, 1)
  assert.match(h.sent.at(-1).text, /✅ \*Outreach complete:\*[\s\S]*- Sent: 2[\s\S]*- Failed: 1 \(send errors\)/)
})
