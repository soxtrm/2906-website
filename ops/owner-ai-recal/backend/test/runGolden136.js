'use strict'
// Runs the 136 golden owner cases (2026-11-10) through the REAL
// services/ownerDecision.js and writes evaluator traces:
//   node test/runGolden136.js [out.jsonl]
// then: python qa/evaluate_decisions.py --actual out.jsonl
// No DB, no network, no WhatsApp: did_send is always false here; the runtime
// dispatch path is covered separately by the worker integration test.
const fs = require('fs')
const path = require('path')
const { decide, POLICY_VERSION } = require('../services/ownerDecision')
const { contextFor, burstFor } = require('./goldenContext')

const FIXTURE = path.join(__dirname, 'fixtures', 'ARGUS_GOLDEN_OWNER_CASES_2026-11-10.jsonl')

function runAll() {
  const cases = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  return cases.map(fx => {
    const { context, priorOwnerLines } = contextFor(fx)
    const d = decide({ messages: burstFor(fx, priorOwnerLines), context })
    return {
      id: fx.id, next_action: d.next_action, reason_code: d.reason_code, fact_mutations: d.fact_mutations,
      draft_reply: d.draft_reply, did_send: false, send_eligible: d.send_eligible, intent: d.intent,
      policy_version: POLICY_VERSION, gates: d.gates,
    }
  })
}

if (require.main === module) {
  const out = process.argv[2] || path.join(__dirname, 'out', 'golden136-traces.jsonl')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const traces = runAll()
  fs.writeFileSync(out, traces.map(t => JSON.stringify(t)).join('\n') + '\n')
  console.log(`wrote ${traces.length} traces -> ${out}`)
}

module.exports = { runAll }
