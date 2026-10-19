'use strict'
// Save & Repost (ARGUS functional UI, 2026-10-19): POST
// /listings/:ref/av-date-confirm must queue ONE category-group repost. Before
// the fix a double tap or a retry queued a second full repost and a second
// "still on the market" line. Drives the real route handler; I/O is stubbed.
//   node --test ops/owner-group-flow/backend/test/
//   AV_ROUTE=/path/to/old/crmScheduleBoard.js node --test …   (old code fails)
const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('module')
const path = require('path')

const routes = {}
const routerStub = new Proxy({}, {
  get: (_, method) => (route, ...handlers) => { routes[`${String(method).toUpperCase()} ${route}`] = handlers[handlers.length - 1] },
})
// Anything the route file pulls in at load time that this test does not care
// about resolves to an inert callable.
const inert = new Proxy(function () {}, {
  get: (_, key) => (key === 'then' ? undefined : inert),
  apply: () => inert,
  construct: () => inert,
})

const activities = []   // property_activities rows written by the handler
let distributions = 0
const sent = []
const db = {
  query: async (sql, params = []) => {
    if (/FROM agents WHERE id/.test(sql)) return { rows: [{ id: 1, username: 'kevin', role: 'admin', active: true }] }
    if (/FROM properties p\s+LEFT JOIN agents/.test(sql)) return { rows: [{ id: 501, ref: '2906-9501' }] }
    if (/SELECT id, ref, available_date, viewing_date, public_payload/.test(sql)) return { rows: [{ id: 501, ref: '2906-9501', available_date: '2026-11-01', viewing_date: null, public_payload: {} }] }
    if (/SELECT created_at FROM property_activities/.test(sql)) {
      const cutoff = Date.now() - params[1] * 60_000
      return { rows: activities.filter(a => a.property_id === params[0] && a.created_at.getTime() > cutoff).map(a => ({ created_at: a.created_at })) }
    }
    if (/INSERT INTO property_activities/.test(sql)) { activities.push({ property_id: params[0], created_at: new Date(), details: JSON.parse(params[2]) }); return { rows: [] } }
    return { rows: [] }
  },
}
const stubs = {
  express: Object.assign(() => inert, { Router: () => routerStub, json: () => inert }),
  '../db': db,
  '../logger': { info() {}, warn() {}, error() {}, debug() {} },
  '../config': { admin: { botNumber: '35699811819' }, waha: { session1: 'default' } },
  '../waha': { pickActiveAdminSession: async () => 'default', sendText: async (s, to, text) => { sent.push([to, text]) } },
  '../handlers/upload': { runCategoryDistribution: async () => { distributions++; return { results: [{ status: 'posted', group_id: 'test-group@g.us' }] } } },
}
const original = Module._load
Module._load = function (request, parent) {
  if (stubs[request]) return stubs[request]
  if (request.startsWith('.') || ['jsonwebtoken', 'multer', 'cloudinary'].includes(request)) return inert
  return original.apply(this, arguments)
}
require(process.env.AV_ROUTE || path.join(__dirname, '../routes/crmScheduleBoard.js'))
const handler = routes['POST /listings/:ref/av-date-confirm']

function call() {
  return new Promise(resolve => {
    const res = { code: 200, status(c) { this.code = c; return this }, json(body) { resolve({ code: this.code, body }) } }
    handler({ params: { ref: '2906-9501' }, agent: { id: 1 }, body: {} }, res)
  })
}
const settle = () => new Promise(r => setTimeout(r, 30))

test('the first Save & Repost queues exactly one repost', async () => {
  const r = await call()
  assert.equal(r.code, 200)
  await settle()
  assert.equal(distributions, 1)
  assert.equal(sent.length, 1, 'one "still on the market" line')
})

test('a second Save & Repost within the cooldown is refused, not reposted', async () => {
  const r = await call()
  assert.equal(r.code, 409)
  assert.equal(r.body.deduped, true)
  await settle()
  assert.equal(distributions, 1, 'no second category-group repost')
  assert.equal(sent.length, 1)
  assert.equal(activities.length, 1, 'no second confirmation row / created_at bump')
})

test('two simultaneous taps still give one repost', async () => {
  activities.length = 0; distributions = 0; sent.length = 0
  const [a, b] = await Promise.all([call(), call()])
  assert.deepEqual([a.code, b.code].sort(), [200, 409])
  await settle()
  assert.equal(distributions, 1)
})
