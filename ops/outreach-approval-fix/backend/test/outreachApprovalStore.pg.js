'use strict'
// Runs outreachApprovalStore.js against a REAL Postgres with the real
// migration applied. Needs PG_URL pointing at a throwaway database, e.g.:
//   docker run --rm -d --name pgtest -e POSTGRES_PASSWORD=t -p 55432:5432 postgres:16-alpine
//   PG_URL=postgres://postgres:t@127.0.0.1:55432/postgres node test/outreachApprovalStore.pg.js
// Never point it at production.
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const Module = require('module')
const { Pool } = require('pg')

;(async () => {
  if (!process.env.PG_URL) { console.log('SKIP: set PG_URL to a throwaway database'); return }
  const pool = new Pool({ connectionString: process.env.PG_URL })
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '20261017_outreach_pending_approvals.sql'), 'utf8')
  await pool.query(sql)
  await pool.query(sql) // idempotent re-run
  const stubs = { '../db': { query: (q, p) => pool.query(q, p) }, '../logger': { warn: console.warn, info() {}, error: console.error } }
  const load = Module._load
  Module._load = function (request) { return stubs[request] || load.apply(this, arguments) }
  const store = require('../services/outreachApprovalStore')
  Module._load = load

  const base = { adminPhone: '491772889021', replySession: 'Cedric', sendingSession: 'Cedric', listType: 'unknown', contacts: [{ phone: '35699811819', name: 'Kev' }], messageText: 'Hi [name]', fromNotesChat: true }
  const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003']

  await store.savePending({ ...base, approvalId: ids[0], expiresAt: Date.now() + 300000 })
  await store.savePending({ ...base, approvalId: ids[1], expiresAt: Date.now() + 300000 })
  assert.equal((await store.loadPending(base.adminPhone)).approvalId, ids[1], 'newest preview is the actionable one')
  assert.equal((await pool.query('SELECT state FROM outreach_pending_approvals WHERE approval_id=$1', [ids[0]])).rows[0].state, 'SUPERSEDED')

  const claims = await Promise.all(Array.from({ length: 8 }, () => store.claim(ids[1])))
  assert.equal(claims.filter(c => c === 'claimed').length, 1, `8 concurrent claims, exactly one wins: ${claims}`)
  assert.ok(claims.filter(c => c !== 'claimed').every(c => c === 'already_decided'))
  await store.attachRun(ids[1], '11111111-1111-4111-8111-111111111111')
  const decision = await store.lastDecision(base.adminPhone)
  assert.equal(decision.outcome, 'approved')
  assert.equal(decision.runId, '11111111-1111-4111-8111-111111111111')
  assert.equal(await store.loadPending(base.adminPhone), null, 'nothing pending after approval')

  await store.savePending({ ...base, approvalId: ids[2], expiresAt: Date.now() - 1000 })
  assert.equal(await store.claim(ids[2]), 'expired')
  assert.equal((await pool.query('SELECT state FROM outreach_pending_approvals WHERE approval_id=$1', [ids[2]])).rows[0].state, 'EXPIRED')

  console.log('PASS outreachApprovalStore against real Postgres: supersede, 8-way concurrent claim, run link, last decision, expiry')
  await pool.end()
})().catch(err => { console.error('FAIL', err); process.exit(1) })
