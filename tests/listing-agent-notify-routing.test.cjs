'use strict'
const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')

const target = path.resolve(__dirname, '../ops/owner-group-flow/backend/services/listingAgentNotify.js')
const originalLoad = Module._load
const calls = []
let routeState = 'DELIVERED'
const db = { query: async (sql, params) => { calls.push({ kind: 'db', sql, params }); return { rows: [] } } }
const sessionRouter = {
  SESSIONS_PRIORITY: ['Argus2', 'Argus1'],
  getWorkingSessionNames: async () => ['Argus2'],
  sendWhatsApp: async input => {
    calls.push({ kind: 'send', input })
    return routeState === 'DELIVERED'
      ? { state: 'DELIVERED', deliveredSession: 'Argus2', deliveredMessageId: 'msg-1' }
      : { state: 'WAITING_FOR_WHATSAPP', deliveryId: 9 }
  },
}
Module._load = function(request, parent, isMain) {
  if (parent?.filename === target && request === '../db') return db
  if (parent?.filename === target && request === '../logger') return { info() {}, warn() {} }
  if (parent?.filename === target && request === '../lib/sessionRouter') return sessionRouter
  return originalLoad.call(this, request, parent, isMain)
}

;(async () => {
  try {
    const notify = require(target)
    const agentRow = {
      id: 44,
      username: 'recipient-agent',
      whatsapp_phones: ['35699112233'],
      whatsapp_session: 'RecipientOwnSession',
    }
    const delivered = await notify.sendComment({
      operator: { email: 'requester@example.test', name: 'Requester' },
      ref: '2906-ASK', note: 'Can we view tomorrow?', agentRow,
    })
    const first = calls.find(call => call.kind === 'send').input
    assert.equal(first.destination, '35699112233@c.us')
    assert.equal(first.preferredSession, 'Argus2')
    assert.notEqual(first.preferredSession, agentRow.whatsapp_session)
    assert.deepEqual(first.context, {
      source: 'schedule-board-comment', ref: '2906-ASK', recipientAgentId: 44,
    })
    assert.equal(delivered.queued, false)
    assert.equal(delivered.session, 'Argus2')

    routeState = 'WAITING_FOR_WHATSAPP'
    const queued = await notify.sendComment({
      operator: { email: 'requester@example.test', name: 'Requester' },
      ref: '2906-ASK-2', note: 'Any update?', agentRow,
    })
    assert.equal(queued.queued, true)
    assert.equal(queued.state, 'WAITING_FOR_WHATSAPP')
    console.log('listing-agent ASK uses ARGUS bridge routing and queues safely')
  } finally {
    Module._load = originalLoad
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
