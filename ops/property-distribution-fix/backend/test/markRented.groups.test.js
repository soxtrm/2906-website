'use strict'
// !rented / a group 😡 / a quoted "rented" all end in rentedDetector.markRented.
// It flipped the status and told the admin, but never touched the category
// groups -- every other group kept showing the listing as a live offer. The AV
// paths already react 😡 and reply "now rented" under the stored message id;
// this proves markRented now does the same. Real markRented, stubbed I/O.
const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('module')

const calls = []
const stubs = {
  '../config': { admin: { botNumber: '35699811819' }, waha: {} },
  '../db': { query: async (sql) => (/UPDATE properties/.test(sql) ? { rows: [{ id: 501 }] } : { rows: [] }) },
  '../waha': { sendText: async (s, to, text) => { calls.push(['admin', text]) } },
  '../logger': { info() {}, warn() {}, error() {}, debug() {} },
  './killSwitch': { cancelAllPending: async () => ({ cancelledFb: 2, unpublishedWeb: true }) },
  './googleAgentSheet': { syncInventoryTab: async () => {} },
  './rentedPlan': {},
  '../lib/quotedMessage': { quotedFromPayload: () => null },
  './agentPropertyLinks': { withPropertyLink: (t) => t, withAvailableActions: (t) => t },
  './matchEngine': { invalidateMatchesForProperty: async () => {} },
  './availability': {
    reactAngryInPropertyGroups: async (id) => { calls.push(['react', id]); return { total: 2, reacted: 2 } },
    replyUnderListing: async (id, text) => { calls.push(['reply', id, text]); return { total: 2, replied: 2, plain: 0 } },
  },
}
const original = Module._load
Module._load = function (request) { return stubs[request] || original.apply(this, arguments) }
const rd = require('../services/rentedDetector')

test('markRented reacts 😡 and replies under every stored listing message', async () => {
  const out = await rd.markRented(501, '2906-9481', '35699811819', 'Cedric', { property_id: 501, available_status: 'available' }, { source: 'admin_command' })
  assert.deepEqual(out, { marked: true })
  assert.deepEqual(calls.find(c => c[0] === 'react'), ['react', 501])
  const reply = calls.find(c => c[0] === 'reply')
  assert.ok(reply, 'threaded reply under the listing')
  assert.match(reply[2], /#2906-9481 — now rented/)
  assert.match(calls.find(c => c[0] === 'admin')[1], /Groups: 😡 2\/2 · reply 2\/2/)
})

test('a failing group notice never undoes the status flip', async () => {
  calls.length = 0
  stubs['./availability'].reactAngryInPropertyGroups = async () => { throw new Error('WAHA down') }
  const out = await rd.markRented(501, '2906-9481', null, 'Cedric', { property_id: 501 }, {})
  assert.deepEqual(out, { marked: true })
  assert.ok(calls.some(c => c[0] === 'admin'), 'admin still told')
})
