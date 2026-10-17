'use strict'
// !createlist / buildPoolBatch with WhatsApp reachability (batch 276).
// Real listBuilder.js; the DB and the WAHA lookup are fakes.
const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('module')
const path = require('path')

const FILE = path.join(__dirname, '..', 'services', 'listBuilder.js')

function load(candidates) {
  const writes = []
  const cursor = { top: 0 }
  const db = {
    query: async (sql, params = []) => {
      if (/FROM whatsapp_accounts WHERE session_name/.test(sql)) return { rows: [{ pool: 'top' }] }
      if (/SELECT cursor_id, cycle_count FROM pool_cursors/.test(sql)) return { rows: [{ cursor_id: cursor.top, cycle_count: 3 }] }
      if (/FROM owner_contacts oc/.test(sql)) return { rows: candidates.filter(c => c.id > params[0]).slice(0, params[1]) }
      if (/SELECT last_outreach_at FROM owner_account_labels/.test(sql)) return { rows: [] }
      if (/UPDATE pool_cursors SET cursor_id/.test(sql)) { cursor.top = params[0]; return { rows: [] } }
      if (/INSERT INTO outreach_unreachable/.test(sql)) { writes.push(params[0]); return { rows: [] } }
      return { rows: [] }
    },
  }
  const stubs = { '../db': db, '../logger': { info() {}, warn() {}, error() {} }, './affinityCalculator': { recomputeAllAffinity: async () => {} }, './cooldownRules': new Proxy({}, { get: () => async () => ({ allowed: true }) }) }
  const original = Module._load
  Module._load = function (request) { return stubs[request] || original.apply(this, arguments) }
  delete require.cache[FILE]
  try { return { lb: require(FILE), writes, cursor } } finally { Module._load = original }
}

const owners = n => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `Owner ${i + 1}`, phone_normalized: `356990000${String(i + 1).padStart(2, '0')}` }))
const reachability = statusOf => ({ classifyMany: async (_s, phones) => phones.map(p => ({ status: statusOf(p), phone: p })) })

test('only VALID numbers enter the list; NOT_REGISTERED is recorded', async () => {
  const { lb, writes } = load(owners(10))
  const notOnWa = new Set(['35699000002', '35699000004'])
  const result = await lb.buildPoolBatch('Cedric', 5, { reachability: reachability(p => (notOnWa.has(p) ? 'NOT_REGISTERED' : 'VALID')) })
  assert.deepEqual(result.list.map(o => o.id), [1, 3, 5, 6, 7])
  assert.deepEqual(result.reachability, { notRegistered: 2, unverified: 0 })
  await new Promise(r => setImmediate(r))
  assert.deepEqual(writes.sort(), [...notOnWa].sort())
})

test('a technical lookup failure is never treated as "no WhatsApp"', async () => {
  const { lb, writes } = load(owners(6))
  const result = await lb.buildPoolBatch('Cedric', 6, { reachability: reachability(p => (p.endsWith('03') ? 'TEMPORARILY_UNAVAILABLE' : p.endsWith('05') ? 'RESOLUTION_FAILED' : 'VALID')) })
  assert.deepEqual(result.list.map(o => o.id), [1, 2, 4, 6])
  assert.deepEqual(result.reachability, { notRegistered: 0, unverified: 2 })
  await new Promise(r => setImmediate(r))
  assert.deepEqual(writes, [], 'nothing marked unreachable')
})

test('a full list never skips a valid owner past the cursor', async () => {
  const { lb, cursor } = load(owners(12))
  const first = await lb.buildPoolBatch('Cedric', 3, { reachability: reachability(() => 'VALID') })
  assert.deepEqual(first.list.map(o => o.id), [1, 2, 3])
  assert.equal(cursor.top, 3, 'cursor stops at the last owner actually used')
  const second = await lb.buildPoolBatch('Cedric', 3, { reachability: reachability(() => 'VALID') })
  assert.deepEqual(second.list.map(o => o.id), [4, 5, 6])
})

test('batch 276 shape: a list where nobody is on WhatsApp yields an empty list', async () => {
  const { lb } = load(owners(40))
  const result = await lb.buildPoolBatch('Cedric', 40, { reachability: reachability(() => 'NOT_REGISTERED') })
  assert.equal(result.list.length, 0)
  assert.equal(result.reachability.notRegistered, 40)
})

test('verifyWhatsApp:false keeps the previous behaviour', async () => {
  const { lb } = load(owners(5))
  const result = await lb.buildPoolBatch('Cedric', 5, { verifyWhatsApp: false })
  assert.deepEqual(result.list.map(o => o.id), [1, 2, 3, 4, 5])
})
