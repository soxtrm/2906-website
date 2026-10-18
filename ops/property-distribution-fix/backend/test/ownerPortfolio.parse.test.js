'use strict'
// The first 5 live portfolio checks all stayed 'awaiting_reply': 12 owner
// replies were dropped as not_a_selection. These are those replies verbatim
// (production owner_portfolio_events, 2026-10-15..17) plus the old shapes.
const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('module')

const alerts = []
const db = { query: async () => ({ rows: [] }) }
const stubs = {
  '/app/db': db, '/app/logger': { info() {}, warn() {}, error() {} }, '/app/waha': {},
  '/app/services/ownerChatScan': {}, '/app/services/shareLinks': {}, '/app/services/humanDelay': {},
  '/app/services/ownerSendGate': { resolveChatPhone: async () => null },
  '/app/handlers/uploadListing': { alertKev: async (t) => { alerts.push(t) } },
}
const original = Module._load
Module._load = function (request) { return stubs[request] || original.apply(this, arguments) }
const opc = require('../services/ownerPortfolioCheck')

const sel = (t, n) => { const r = opc.parseSelection(t, n); return r.ok ? r.numbers : r.reason }

test('real replies that were dropped are now understood', () => {
  assert.deepEqual(sel('Nr 3 available only', 3), [3], 'Michael, check 1')
  assert.deepEqual(sel('The links have expired\nBoth are rented', 2), [], 'Jovana, check 2')
  assert.deepEqual(sel('Nothing is available now', 2), [], 'Mario, check 5')
  assert.deepEqual(sel('No sorry, been rented', 1), [], 'one listing: unambiguous')
  assert.deepEqual(sel('Hello, it has been rented unfortunately', 1), [])
})

test('unclear replies are never guessed', () => {
  assert.equal(sel('Hello, it has been rented unfortunately', 3), 'ambiguous_which', 'Michael has 3 listings: which one?')
  assert.equal(sel('Remove it from your listing', 3), 'not_a_selection')
  assert.equal(sel('Works for me', 1), 'not_a_selection')
  assert.equal(sel('I’m afraid that I’m going to be quite strict about no pets in these apartments', 1), 'not_a_selection')
  assert.equal(sel('3 bedrooms available from November', 3), 'not_a_selection')
})

test('existing shapes unchanged', () => {
  assert.deepEqual(sel('ALL', 3), [1, 2, 3])
  assert.deepEqual(sel('all still available', 2), [1, 2])
  assert.deepEqual(sel('none', 2), [])
  assert.deepEqual(sel('1, 3', 3), [1, 3])
  assert.deepEqual(sel('1 and 2', 3), [1, 2])
  assert.equal(sel('7', 3), 'out_of_range')
  assert.deepEqual(sel('only #2 and #3 are still available', 3), [2, 3])
  assert.deepEqual(sel('nur 2', 3), [2])
  assert.deepEqual(sel('Both still available', 2), [1, 2])
})

test('a not-understood reply reaches Kev with the numbered list', async () => {
  db.query = async (sql) => {
    if (/FROM owner_contacts/.test(sql)) return { rows: [{ id: 9, phone_normalized: '35699811819', name: 'Michael' }] }
    if (/FROM owner_portfolio_checks/.test(sql)) return { rows: [{ id: 1, property_snapshot: { included: [{ number: 1, ref: '2906-1', town: 'Sliema' }, { number: 2, ref: '2906-2' }, { number: 3, ref: '2906-3' }] } }] }
    return { rows: [] }
  }
  const out = await opc.handleOwnerReply({ senderPhone: '35699811819', text: 'Remove it from your listing', session: 'Cedric' })
  assert.equal(out.understood, false)
  assert.equal(alerts.length, 1)
  assert.match(alerts[0], /Portfolio check 1 — owner Michael/)
  assert.match(alerts[0], /1\. #2906-1 · Sliema\n2\. #2906-2\n3\. #2906-3/)
})
