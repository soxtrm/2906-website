'use strict'
// Test harness for the owner-intelligence repair (Kev, 2026-10-30).
//
// Loads the REAL backend modules of this mirror against the isolated test
// Postgres (production schema, no production data) on the --internal Docker
// network argus-outreach-testnet. Stubbed edges only: config (db → test DB),
// logger, telegram, queues (records jobs) and waha (records sends — nothing
// reaches WhatsApp). Relative modules that are not part of this mirror become
// an inert stub so a service loads without its neighbours.
const fs = require('fs')
const path = require('path')
const Module = require('module')

const ROOT = path.join(__dirname, '..', '..')

const inert = new Proxy(function () {}, {
  get: (_, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : inert),
  apply: () => inert,
  construct: () => inert,
})

const sent = []
const jobs = []

const stubs = {
  config: {
    db: {
      host: process.env.TEST_DB_HOST || 'argus-outreach-testdb', port: Number(process.env.TEST_DB_PORT || 5432),
      database: 'argus_test', user: 'test', password: 'test',
    },
    admin: { adminNumbers: ['35699811819'], botNumber: '' },
    waha: {}, redis: {}, telegram: {}, system: { active: true },
  },
  logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return stubs.logger } },
  telegram: { sendAlert: async () => {} },
  queues: {
    addJob: async (name, data, opts = {}) => { jobs.push({ name, data, opts }); return { id: opts.jobId || `job-${jobs.length}` } },
    QUEUES: new Proxy({}, { get: () => ({ getJob: async () => null, add: async () => ({}) }) }),
  },
  waha: {
    sendText: async (session, chatId, text) => {
      sent.push({ session, chatId: String(chatId), text, at: new Date() })
      return { id: `msg-${sent.length}` }
    },
    markChatUnread: async () => {},
    getChatMessages: async () => [],
    getSessionStatus: async () => ({ status: 'WORKING' }),
  },
}

const original = Module._load
Module._load = function (request, parent, isMain) {
  if (parent && parent.filename && (request.startsWith('./') || request.startsWith('../'))) {
    const resolved = path.resolve(path.dirname(parent.filename), request)
    const rel = path.relative(ROOT, resolved).replace(/\\/g, '/').replace(/\.js$/, '')
    if (Object.prototype.hasOwnProperty.call(stubs, rel)) return stubs[rel]
    if (!fs.existsSync(resolved) && !fs.existsSync(`${resolved}.js`) && !fs.existsSync(path.join(resolved, 'index.js'))) return inert
  }
  try {
    return original.apply(this, arguments)
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND' && !request.startsWith('.')) return inert
    throw err
  }
}

const db = require(path.join(ROOT, 'db'))

async function reset() {
  await db.query(`TRUNCATE conversation_outbound_guard, conversation_message_revisions, conversation_facts,
                  conversation_intelligence_state, owner_contacts, whatsapp_accounts RESTART IDENTITY CASCADE`)
  sent.length = 0
  jobs.length = 0
  require(path.join(ROOT, 'services/agentIdentityRegistry'))._clearCache()
}

async function account(session, persona) {
  return (await db.query(
    `INSERT INTO whatsapp_accounts(session_name, phone, label, account_persona, outreach_enabled, is_active)
     VALUES ($1, $2, $1, $3, TRUE, TRUE) RETURNING *`,
    [session, `3567${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`, persona])).rows[0]
}

async function owner(phone, name = 'Test Owner') {
  return (await db.query(
    `INSERT INTO owner_contacts(phone_normalized, name, status) VALUES ($1, $2, 'new') RETURNING *`, [phone, name])).rows[0]
}

const load = rel => require(path.join(ROOT, rel))

module.exports = { ROOT, db, stubs, sent, jobs, reset, account, owner, load, inert }
