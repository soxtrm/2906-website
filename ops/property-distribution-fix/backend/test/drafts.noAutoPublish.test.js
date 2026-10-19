'use strict'
// Kev, 2026-10-19: "the drafts SHOULD NEVER auto-upload a property, and cards
// created for the property have to connect into the upload". Drives the REAL
// services/autoOwnerConversation.js (I/O stubbed).
//   node test/drafts.noAutoPublish.test.js [path/to/autoOwnerConversation.js]
const assert = require('assert')
const path = require('path')
const Module = require('module')

const sql = []
const jobs = []
let convo = null
const db = {
  query: async (q, p = []) => {
    sql.push({ q: q.replace(/\s+/g, ' '), p })
    if (/SELECT \* FROM owner_auto_conversations WHERE id/.test(q)) return { rows: convo ? [convo] : [] }
    if (/UPDATE properties p\s+SET available_status = 'archived'/.test(q)) return { rows: [{ id: 501 }, { id: 502 }] }
    if (/FROM owner_auto_conversations/.test(q)) return { rows: [] }
    return { rows: [] }
  },
}
const inert = new Proxy(function () {}, { get: (_, k) => (k === 'then' ? undefined : inert), apply: () => inert, construct: () => inert })
const original = Module._load
Module._load = function (request) {
  if (request === '../db') return db
  if (request === '../logger') return { info() {}, warn() {}, error() {}, debug() {} }
  if (request === '../queues') return { addJob: async (...a) => { jobs.push(a); return { id: 'job1' } }, QUEUES: {} }
  if (request === '../config') return { automation: { autoPublishTimerMinutes: 10, autoPublishVariant: 5 }, waha: {} }
  if (request === '../handlers/upload') return new Proxy({}, { get: (_, k) => (k === 'createListing' ? async () => { throw new Error('createListing must not run') } : inert) })
  if (request.startsWith('.') || ['ioredis', 'bullmq', 'axios', '@google/genai', 'openai', 'cloudinary', 'sharp', 'node-cron'].includes(request)) return inert
  return original.apply(this, arguments)
}
delete process.env.AUTO_PUBLISH_DRAFTS
const aoc = require(process.argv[2] || path.join(__dirname, '../services/autoOwnerConversation.js'))

let passed = 0, failed = 0
const run = async (name, fn) => { try { await fn(); console.log(`  ok   ${name}`); passed++ } catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++ } }

;(async () => {
  await run('an already-armed timer firing never publishes — the draft is parked', async () => {
    sql.length = 0
    convo = { id: 15, status: 'awaiting_auto_publish', phone: '35679010070', checklist: { town: 'Sliema', _photos: ['a'] } }
    await aoc.runAutoPublishJob(15)
    assert.ok(sql.some(s => /SET status = 'ready_for_kev'/.test(s.q)), 'parked as ready_for_kev')
  })
  await run('an upload takes over the owner\'s ref-less draft cards', async () => {
    sql.length = 0
    assert.equal(typeof aoc.takeOverOwnerDrafts, 'function')
    const n = await aoc.takeOverOwnerDrafts({ ownerId: 8907, phone: '35699426374', propertyId: 29475, ref: '2906-9502' })
    assert.equal(n, 2)
    const upd = sql.find(s => /UPDATE properties p/.test(s.q))
    assert.match(upd.q, /p\.ref IS NULL AND p\.is_staging IS TRUE/)
    assert.match(upd.p[3], /taken over by upload #2906-9502/i)
  })
  await run('completeConversationAfterOperatorUpload runs the take-over', async () => {
    sql.length = 0
    const out = await aoc.completeConversationAfterOperatorUpload({ ownerId: 8907, phone: '35699426374', propertyId: 29475, ref: '2906-9502' })
    assert.equal(out.draftsTaken, 2)
  })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})()
