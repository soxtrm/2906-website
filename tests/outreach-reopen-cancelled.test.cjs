'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')

const plannerPath = path.resolve(__dirname, '../ops/outreach-p0/backend/services/outreachPlanner.js')

function loadPlanner({ sent = 0, accepted = sent } = {}) {
  const state = {
    plan: {
      id: 91,
      status: 'cancelled',
      armed: false,
      job_id: null,
      outcome: 'cancelled',
      outcome_reason: 'cancelled_by_user',
      accepted_count: accepted,
      failed_count: 0,
      skipped_count: 0,
      dispatch_started_at: null,
      executed_at: null,
      retry_attempt: 0,
      message_template: 'Quick availability check.',
    },
    entries: Array.from({ length: Math.max(1, sent) }, (_, index) => ({
      id: index + 1,
      plan_id: 91,
      normalized_phone: `3567999999${index}`,
      send_status: index < sent ? 'sent' : 'pending',
    })),
    transitions: [],
  }

  const result = rows => ({ rows })
  const globalQuery = async (sql, values = []) => {
    if (/SELECT \* FROM outreach_plans WHERE id = \$1(?! FOR UPDATE)/.test(sql)) return result(state.plan ? [{ ...state.plan }] : [])
    if (/SELECT \* FROM outreach_plan_entries/.test(sql)) return result(state.entries.map(entry => ({ ...entry })))
    if (/INSERT INTO outreach_plan_transitions/.test(sql)) {
      state.transitions.push({
        plan_id: values[0], from_state: values[1], to_state: values[2],
        reason: values[3], actor: values[4], job_id: values[5],
      })
      return result([])
    }
    throw new Error(`Unexpected global query: ${sql}`)
  }
  const client = {
    async query(sql) {
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return result([])
      if (/SELECT \* FROM outreach_plans WHERE id = \$1 FOR UPDATE/.test(sql)) return result(state.plan ? [{ ...state.plan }] : [])
      if (/COUNT\(\*\).*outreach_plan_entries/s.test(sql)) return result([{ total: sent }])
      if (/UPDATE outreach_plans SET/s.test(sql)) {
        Object.assign(state.plan, {
          status: 'draft', armed: false, job_id: null,
          outcome: null, outcome_reason: null,
          accepted_count: 0, failed_count: 0, skipped_count: 0,
          dispatch_started_at: null, executed_at: null, retry_attempt: 0,
        })
        return result([])
      }
      throw new Error(`Unexpected transaction query: ${sql}`)
    },
    release() {},
  }
  const db = { query: globalQuery, connect: async () => client }
  const inert = new Proxy(function () {}, { get: () => inert, apply: () => inert })
  const log = { info() {}, warn() {}, error() {}, debug() {} }
  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (parent?.filename === plannerPath) {
      if (request === '../db') return db
      if (request === '../logger') return log
      if (request === './outreachQuota') return { HARD_DAILY_CAP: 40 }
      if (request === '../queues') return { addJob: inert, QUEUES: {} }
      if (request === './listBuilder') return { buildPoolBatch: inert }
      if (request === './cooldownRules') return { canContact: inert, normalizePhone: value => value }
      return inert
    }
    return originalLoad.call(this, request, parent, isMain)
  }
  delete require.cache[plannerPath]
  try {
    return { planner: require(plannerPath), state }
  } finally {
    Module._load = originalLoad
  }
}

test('reopenPlan makes a zero-send cancellation editable without arming or losing its draft', async () => {
  const { planner, state } = loadPlanner()
  const reopened = await planner.reopenPlan(91, 'kevin')

  assert.equal(reopened.status, 'draft')
  assert.equal(reopened.armed, false)
  assert.equal(reopened.job_id, null)
  assert.equal(reopened.message_template, 'Quick availability check.')
  assert.equal(reopened.entries.length, 1)
  assert.deepEqual(state.transitions, [{
    plan_id: 91, from_state: 'cancelled', to_state: 'draft',
    reason: 'reopened_by_user', actor: 'kevin', job_id: null,
  }])

  const retry = await planner.reopenPlan(91, 'kevin')
  assert.equal(retry.status, 'draft')
  assert.equal(state.transitions.length, 1, 'browser retry is idempotent')
})

test('reopenPlan refuses a cancelled plan that already sent a contact', async () => {
  const { planner, state } = loadPlanner({ sent: 1 })
  await assert.rejects(
    () => planner.reopenPlan(91, 'kevin'),
    error => error.code === 'plan_has_sent_contacts' && error.status === 409)
  assert.equal(state.plan.status, 'cancelled')
  assert.equal(state.transitions.length, 0)
})
