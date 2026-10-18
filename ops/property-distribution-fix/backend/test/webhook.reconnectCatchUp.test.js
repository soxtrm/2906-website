'use strict'
// A session coming back (session.status WORKING) flushed every outbound queue
// but never read what owners sent while it was down -- that waited for the
// 04:00/07:15/22:00 cron. Drives the REAL /waha route with a session.status
// event and checks the inbound recovery runs once, after the settle delay,
// and not again on the flapping that follows.
const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('module')

const recoveries = []
const handlers = {}
const anything = () => new Proxy(function () {}, {
  get: (t, k) => (k === 'then' ? undefined : anything()),
  apply: () => Promise.resolve(null),
})
const stubs = {
  express: { Router: () => ({ post: (p, fn) => { handlers[p] = fn }, get: () => {}, use: () => {} }) },
  ioredis: function () { return { on() {}, set: async () => 'OK' } },
  '../logger': { info() {}, warn(...a) { if (process.env.DBG) console.log('WARN', ...a) }, error(...a) { if (process.env.DBG) console.log('ERR', ...a) }, debug() {} },
  '../config': { redis: {}, waha: { kevinAccounts: [] }, admin: {}, system: { active: true } },
  '../services/historySync': { recoverActiveOwnerConversations: async () => { recoveries.push(Date.now()); return { checked: 1, recovered: 1 } } },
  '../lib/sessionRouter': { updateState() {}, flushQueue: async () => {}, flushWaitingDeliveries: async () => {} },
  '../services/availability': { flushQueuedChecks: async () => {} },
  '../services/outreachPlanner': { reconcileOverdueArmedPlans: async () => {} },
}
const original = Module._load
Module._load = function (request, parent) {
  if (stubs[request]) return stubs[request]
  if (request.startsWith('.') && /property-distribution-fix[\\/]backend[\\/]routes/.test(parent?.filename || '')) return anything()
  return original.apply(this, arguments)
}

test('reconnect triggers one inbound catch-up after 60 s, debounced', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-18T01:00:00Z') })
  const router = require('../routes/webhook')
  const post = handlers['/waha']
  assert.ok(post, 'route registered')
  const fire = (status) => post({ body: { event: 'session.status', session: 'Cedric', payload: { name: 'Cedric', status } }, headers: {} },
    { status() { return this }, json() { return this }, sendStatus() { return this }, send() { return this }, end() {} })

  await fire('WORKING')
  assert.equal(recoveries.length, 0, 'not immediately: live redelivery lands first')
  t.mock.timers.tick(60_000)
  await new Promise(r => setImmediate(r))
  assert.equal(recoveries.length, 1, 'recovery ran')

  await fire('STARTING'); await fire('WORKING')
  t.mock.timers.tick(60_000)
  await new Promise(r => setImmediate(r))
  assert.equal(recoveries.length, 1, 'flap within 10 min does not rerun')

  t.mock.timers.tick(10 * 60_000)
  await fire('WORKING')
  t.mock.timers.tick(60_000)
  await new Promise(r => setImmediate(r))
  assert.equal(recoveries.length, 2, 'next reconnect after 10 min runs again')
  assert.equal(typeof router._catchUpAfterReconnect, 'function')
})
