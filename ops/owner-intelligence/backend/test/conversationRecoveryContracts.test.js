'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { UI_STATUS, deriveAutomationStatus } = require('../services/automationStatus')

test('6: connected session plus human message is Agent Takeover, with an explicit reason', () => {
  const state = deriveAutomationStatus({ connection:'WORKING',assistant:{ enabled:true,status:'HUMAN_ACTIVE' },intelligence:{} })
  assert.equal(state.status, UI_STATUS.TAKEOVER)
  assert.match(state.reason, /agent replied manually/i)
})

test('7: explicit persisted pause is resumable AI Paused, not a connection failure', () => {
  const state = deriveAutomationStatus({
    connection:'WORKING',assistant:{ enabled:true,status:'ARMED' },
    intelligence:{ automation_status:UI_STATUS.PAUSED,automation_reason:'Paused by Olga' },
  })
  assert.deepEqual(state, { status:UI_STATUS.PAUSED,reason:'Paused by Olga' })
})

test('8: a connected but disabled assistant is distinct from a broken WAHA session', () => {
  const paused = deriveAutomationStatus({ connection:'CONNECTED',assistant:{ enabled:false,status:'DISABLED',disabled_reason:'Manual pause' } })
  const broken = deriveAutomationStatus({ connection:'FAILED',assistant:{ enabled:true,status:'ARMED' } })
  assert.equal(paused.status, UI_STATUS.PAUSED)
  assert.equal(broken.status, UI_STATUS.CONNECTION_ERROR)
})

const ROOT = path.join(__dirname, '..')
const route = fs.readFileSync(path.join(ROOT, 'routes', 'crmScheduleBoard.js'), 'utf8')
const migration = fs.readFileSync(path.join(ROOT, 'migrations', '20261104_conversation_recovery.sql'), 'utf8')
const recovery = fs.readFileSync(path.join(ROOT, 'services', 'conversationRecovery.js'), 'utf8')
const intelligence = fs.readFileSync(path.join(ROOT, 'services', 'conversationIntelligence.js'), 'utf8')

test('7b: explicit authorized Resume AI passes the owner gate and re-enables the existing assistant state', () => {
  assert.match(recovery, /action === 'resume'/)
  assert.match(recovery, /ownerSendGate\.resumeOwnerFlow/)
  assert.match(recovery, /ownerAssistant\.enable\(state\)/)
  assert.match(route, /setAutomationStatus\(\{ \.\.\.ctx, agentId:loaded\.me\.id, action/)
})

test('9/10/14: reopening is agent-scoped and changes only relay workflow state', () => {
  const start = route.indexOf("router.post('/listings/:ref/relay/reopen'")
  const end = route.indexOf("router.get('/listings/:ref/owner-facts'", start)
  const block = route.slice(start, end)
  assert.match(block, /book_relay_threads/)
  assert.match(block, /agent_id=\$2/)
  assert.match(block, /status='relaying'/)
  assert.doesNotMatch(block, /UPDATE\s+properties/i)
})

test('11/12: durable relay source IDs have a per-thread idempotency constraint', () => {
  assert.match(migration, /source_message_id\s+TEXT/)
  assert.match(migration, /UNIQUE INDEX[\s\S]*book_relay_messages\(thread_id, source_message_id\)/i)
  assert.match(migration, /CREATE TRIGGER book_relay_message_audit_trigger/)
  assert.match(migration, /referenced_property_ids/)
  assert.match(migration, /delivery_status/)
  assert.match(intelligence, /ON CONFLICT\(state_id,source_message_id,body_hash\) DO NOTHING/)
  assert.match(intelligence, /ON CONFLICT \(idempotency_key\) DO NOTHING/)
})

test('13: Owner Facts preserve source, confidence, correction and dismissal fields', () => {
  for (const token of ['source_message_id','source_timestamp','confidence','dismissed_at','correction_note','access_scope']) {
    assert.match(`${migration}\n${recovery}`, new RegExp(token), token)
  }
  assert.match(route, /owner-facts\/:factId/)
  assert.match(route, /s\.owner_contact_id=\$2/)
})

test('14: conversation and fact access stay scoped to the authorized agent and owner/property', () => {
  assert.match(route, /WHERE property_id=\$1 AND agent_id=\$2/)
  assert.match(route, /f\.id=\$1 AND s\.owner_contact_id=\$2 AND \(f\.property_id IS NULL OR f\.property_id=\$3\)/)
})

test('manual Board messages and attachments put the owner automation into Agent Takeover', () => {
  assert.match(route, /async function markBoardAgentTakeover/)
  assert.match(route, /handleHumanMessage\(\{/)
  assert.ok((route.match(/markBoardAgentTakeover\(/g) || []).length >= 4)
})
