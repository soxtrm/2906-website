'use strict'
// 2026-10-18 (Kev): "only 8/15 eligible found", Cedric and Gabriela drawing
// the same people, and the database should rotate every 20-30 days.
// Real listBuilder.js; fake DB.
const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('module')
const path = require('path')

const FILE = path.join(__dirname, '..', 'services', 'listBuilder.js')

function load(candidates, { pool = 'top', cursorId = 0 } = {}) {
  const state = { cursor: cursorId, cycle: 1, sql: [], params: [] }
  const db = {
    query: async (sql, params = []) => {
      if (/FROM whatsapp_accounts WHERE session_name/.test(sql)) return { rows: [{ pool }] }
      if (/SELECT cursor_id, cycle_count FROM pool_cursors/.test(sql)) return { rows: [{ cursor_id: state.cursor, cycle_count: state.cycle }] }
      if (/MAX\(id\)/.test(sql)) return { rows: [{ m: Math.max(0, ...candidates.map(c => c.id)) }] }
      if (/FROM owner_contacts oc/.test(sql)) {
        state.sql.push(sql); state.params.push(params)
        const rows = pool === 'top' ? candidates.filter(c => c.id > params[0]).sort((a, b) => a.id - b.id) : candidates.filter(c => c.id < params[0]).sort((a, b) => b.id - a.id)
        return { rows: rows.slice(0, params[1]) }
      }
      if (/SELECT last_outreach_at FROM owner_account_labels/.test(sql)) return { rows: [] }
      if (/UPDATE pool_cursors SET cursor_id/.test(sql)) { state.cursor = params[0]; if (/cycle_count = cycle_count \+ 1/.test(sql)) state.cycle++; return { rows: [] } }
      return { rows: [] }
    },
  }
  const stubs = { '../db': db, '../logger': { info() {}, warn() {}, error() {} }, './affinityCalculator': { recomputeAllAffinity: async () => {} }, './cooldownRules': new Proxy({}, { get: () => async () => ({ allowed: true }) }) }
  const original = Module._load
  Module._load = function (request) { return stubs[request] || original.apply(this, arguments) }
  delete require.cache[FILE]
  try { return { lb: require(FILE), state } } finally { Module._load = original }
}
const owners = n => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `Owner ${i + 1}`, phone_normalized: `356990000${String(i + 1).padStart(2, '0')}` }))
const opts = { verifyWhatsApp: false }

test('end of the pool mid-list: wraps and fills the list in the SAME request', async () => {
  const { lb, state } = load(owners(10), { cursorId: 7 })
  const r = await lb.buildPoolBatch('Cedric', 5, opts)
  assert.deepEqual(r.list.map(o => o.id), [8, 9, 10, 1, 2])
  assert.equal(r.wrapped, true)
  assert.equal(state.cycle, 2, 'a new rotation cycle started')
  assert.equal(state.cursor, 2, 'cursor continues from where the wrapped part stopped')
})

test('bottom pool (Z→A) wraps to the top end the same way', async () => {
  const { lb, state } = load(owners(10), { pool: 'bottom', cursorId: 4 })
  const r = await lb.buildPoolBatch('Argus2', 5, opts)
  assert.deepEqual(r.list.map(o => o.id), [3, 2, 1, 10, 9])
  assert.equal(state.cursor, 9)
})

test('a completely empty pool returns empty instead of recursing forever', async () => {
  const { lb } = load([], { cursorId: 0 })
  const r = await lb.buildPoolBatch('Cedric', 5, opts)
  assert.deepEqual(r.list, [])
})

test('eligibility is a 25-day rotation across ALL accounts, not "never contacted"', async () => {
  const { lb, state } = load(owners(3))
  await lb.buildPoolBatch('Gabriela', 2, opts)
  const sql = state.sql[0]
  assert.doesNotMatch(sql, /last_outreach_at IS NOT NULL/, 'no permanent exclusion for anyone ever contacted')
  assert.doesNotMatch(sql, /total_messages_we_sent, 0\) > 0/, 'no permanent exclusion for any old chat')
  assert.match(sql, /oal\.last_outreach_at > NOW\(\) - make_interval\(days => \$3\)/)
  assert.match(sql, /label IN \('dnc', 'angry'\)/)
  assert.match(sql, /outreach_unreachable/)
  assert.deepEqual(state.params[0].slice(2), [25, 30], 'recycle 25 days, live-conversation hold 30 days')
})
