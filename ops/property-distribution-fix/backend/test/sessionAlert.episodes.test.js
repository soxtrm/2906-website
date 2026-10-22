'use strict'
// Kev, 2026-10-22 (P1): "Session Gabriela needs a QR rescan — it cannot
// self-heal by restarting." arrived again and again. Drives the REAL waha.js
// health pass (ensureAllSessionsWorking) against a simulated WAHA: fetch,
// clock and Redis are the only fakes. A "backend restart" is simulated by
// dropping waha.js from the require cache (its in-memory state is gone) while
// the Redis fake keeps its data, exactly like production.
//   node test/sessionAlert.episodes.test.js [path/to/waha.js]
const assert = require('assert')
const path = require('path')
const Module = require('module')

const BOT = '35699270699'
const wahaPath = path.resolve(process.argv[2] || path.join(__dirname, '../waha.js'))
let clock = Date.parse('2026-10-22T08:00:00Z')
let wahaState = 'WORKING'
const alerts = []
let starts = 0
const redisData = new Map()
const fakeRedis = {
  get: async k => (redisData.has(k) ? redisData.get(k) : null),
  set: async (k, v) => { redisData.set(k, v); return 'OK' },
}

Date.now = () => clock
const realSetTimeout = global.setTimeout
global.setTimeout = (fn, ms, ...a) => (ms <= 5000 ? (Promise.resolve().then(() => fn(...a)), 0) : realSetTimeout(fn, ms, ...a))
global.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET'
  const body = opts.body ? JSON.parse(opts.body) : null
  const json = data => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data), arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => null } })
  if (/\/auth\/qr$/.test(url)) return { ok: false, status: 404, text: async () => 'no qr', headers: { get: () => null } }
  if (method === 'GET' && /\/api\/sessions$/.test(url)) return json([{ name: 'Gabriela', status: wahaState }])
  if (method === 'GET' && /\/api\/sessions\/Gabriela$/.test(url)) return json({ name: 'Gabriela', status: wahaState, me: wahaState === 'WORKING' ? { id: '356@c.us' } : null, config: {} })
  if (method === 'POST' && /\/start$/.test(url)) { starts++; wahaState = 'SCAN_QR_CODE'; return json({}) }
  if (method === 'POST' && /\/api\/sendText$/.test(url)) { if (body.chatId === `${BOT}@c.us`) alerts.push(body.text); return json({ id: 'x' }) }
  return json({})
}

const original = Module._load
Module._load = function (request, parent) {
  const fromWaha = parent && path.resolve(parent.filename) === wahaPath
  if (request === './config') return { waha: { url: 'http://waha', apiKey: 'k', session1: 'Kevsecond' }, admin: { botNumber: BOT } }
  if (request === './logger') return { info() {}, warn() {}, error() {}, debug() {} }
  if (request === './telegram') return { sendAlert: async () => {} }
  if (request === './redis') return fakeRedis
  if (request === './services/sessionRoles') return { BRIDGE_PRIORITY: ['Kevsecond'], same: (a, b) => String(a).toLowerCase() === String(b).toLowerCase() }
  if (request === './services/wahaMediaPager') return { collectMessagePages: async () => [] }
  if (request === './lib/sessionRouter') return { getWorkingSessionNames: async () => ['Kevsecond'] }
  if (request === './services/outreachIdentity') return { assertOutboundIdentity: async () => {} }
  if (request === './services/contactTouch') return { recordOutbound: async () => {} }
  if (fromWaha && request === './services/sessionAlertState') return original.call(this, path.join(path.dirname(wahaPath), 'services/sessionAlertState.js'), parent)
  return original.apply(this, arguments)
}

const loadWaha = () => { delete require.cache[wahaPath]; return require(wahaPath) }
let waha = loadWaha()
const tick = async (state, minutes = 2) => { clock += minutes * 60_000; wahaState = state; await waha.ensureAllSessionsWorking() }
const qrAlerts = () => alerts.filter(t => /^📷 Session .* needs a QR (re)?scan/.test(t))

let passed = 0, failed = 0
const run = async (name, fn) => { try { await fn(); console.log(`  ok   ${name}`); passed++ } catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++ } }

;(async () => {
  console.log('=== session alert episodes 2026-10-22 ===')

  await run('T17 a QR episode produces ONE operator alert, with the action to take, despite QR/FAILED flapping', async () => {
    await tick('WORKING', 0)
    await tick('SCAN_QR_CODE')
    for (let i = 0; i < 20; i++) await tick(['FAILED', 'SCAN_QR_CODE', 'STARTING', 'STOPPED'][i % 4])   // 40 min of flapping
    assert.strictEqual(qrAlerts().length, 1, alerts.join('\n'))
    assert.ok(/WAHA dashboard → Sessions → Gabriela/.test(qrAlerts()[0]))
  })

  await run('a session that needs a QR scan is not restarted every few minutes (≤1 restart per hour)', async () => {
    assert.ok(starts <= 1, `starts=${starts}`)
  })

  await run('T18 a backend restart does not reset the deduplication', async () => {
    waha = loadWaha()            // fresh module: the old in-memory throttle would be empty here
    await tick('SCAN_QR_CODE')
    await tick('FAILED')
    assert.strictEqual(qrAlerts().length, 1, alerts.join('\n'))
  })

  await run('controlled escalation: exactly one reminder after 6 h unresolved', async () => {
    await tick('SCAN_QR_CODE', 6 * 60)
    await tick('SCAN_QR_CODE', 60)
    await tick('FAILED', 60)
    assert.strictEqual(alerts.filter(t => /Still unresolved/.test(t)).length, 1, alerts.join('\n'))
  })

  await run('genuine recovery closes the episode once; a NEW failure alerts again', async () => {
    await tick('WORKING')
    await tick('WORKING')
    assert.strictEqual(alerts.filter(t => /connected again/.test(t)).length, 1)
    await tick('SCAN_QR_CODE')
    assert.strictEqual(qrAlerts().length, 2)
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})()
