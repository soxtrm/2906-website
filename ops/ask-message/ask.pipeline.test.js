'use strict'

const assert = require('node:assert/strict')
const Module = require('node:module')

const composedText = `Good afternoon, I hope you're well. Regarding #2906-9416, would you consider a Russian couple working in IT with a budget of €1,600–€1,700?`
const replies = []
const relayed = []
const queries = []

const db = {
  async query(sql, args) {
    queries.push({ sql, args })
    if (/FROM properties p LEFT JOIN agents/.test(sql)) return { rows: [{
      id: 9416, ref: '2906-9416', listed_by_agent_id: 7,
      agent_id: 7, agent_username: 'Kevin', agent_name: 'Kevin',
      whatsapp_phones: ['35600000000'], whatsapp_session: 'default', agent_active: true,
    }] }
    if (/INSERT INTO owner_contact_log/.test(sql)) return { rows: [{ id: 101 }] }
    return { rows: [], rowCount: 0 }
  },
}

const mocks = {
  '../db': db,
  '../logger': { warn() {}, info() {}, error() {}, debug() {} },
  '../waha': { async sendText(_session, _chatId, text) { replies.push(text); return { id: 'preview-id' } } },
  '../services/boardAsk': {
    async composeQuestion() { return { text: composedText, rewritten: true, dropped: null } },
    insideWindow() { return true },
    nextSendTime(d) { return d },
    maltaDay() { return '2026-10-10' },
    WINDOW_START_HOUR: 8, WINDOW_END_HOUR: 21,
  },
  '../services/ownerAsk': {
    QUESTIONS_PER_DAY: 2,
    async resolveAgentByPhone() { return { id: 7, name: 'Kevin', username: 'Kevin', notify_whatsapp: '35600000000', whatsapp_phones: [] } },
    async questionsUsedFor() { return 0 },
    async ownerFor() { return { id: 55, phone_normalized: '35611111111', do_not_contact: false } },
    async isReachout() { return false },
    humanName(v) { return v },
  },
  '../services/bookRelay': {
    async openBoardThread(payload) { relayed.push(payload); return { ok: true, threadId: 501 } },
  },
}

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request]
  return originalLoad.call(this, request, parent, isMain)
}

const handlerPath = process.env.ASK_HANDLER_PATH || '/app/handlers/ask.js'
const { cmdAsk, cmdAskConfirm } = require(handlerPath)

;(async () => {
  await cmdAsk('default', 'agent-chat@g.us',
    '9416 Hi, would you consider a russian Couple Working in IT? their budget is more like 1600-1700€',
    { senderPhone: '35600000000' })

  assert.equal(replies.length, 1)
  assert.match(replies[0], /Reply \*Yes\* to send/)
  assert.ok(replies[0].includes(composedText), 'preview must show the complete composed text')

  const consumed = await cmdAskConfirm({ session: 'default', chatId: 'agent-chat@g.us', text: 'Yes' })
  assert.equal(consumed, true)
  assert.equal(relayed.length, 1)
  assert.equal(relayed[0].initialText, composedText, 'confirmed send must use the exact preview text')
  const insert = queries.find(q => /INSERT INTO owner_contact_log/.test(q.sql))
  assert.ok(insert)
  assert.ok(insert.args.includes(composedText), 'audit log must store the exact preview text')
  assert.match(replies.at(-1), /Sent to the owner/)
  console.log('ask preview-confirm-send identity test passed (all external sends mocked)')
})().catch(err => {
  console.error(err)
  process.exitCode = 1
}).finally(() => { Module._load = originalLoad })
