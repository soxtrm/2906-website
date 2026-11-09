'use strict'
// Test harness for the outreach automation (Kev, 2026-10-29).
//
// Loads the REAL backend modules from this mirror against a REAL, isolated
// Postgres (production schema, no production data) on an --internal Docker
// network. Only the edges are stubbed: config (points db.js at the test DB),
// logger, waha (records sends, never reaches WhatsApp), telegram and queues
// (records jobs). Any other relative module that is not part of this mirror
// becomes an inert stub, so adminCommands.js loads without its 40 neighbours.
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
const wahaBehaviour = { failFor: new Map(), sessionStatus: 'WORKING' }

const stubs = {
  config: {
    db: {
      host: process.env.TEST_DB_HOST || 'argus-outreach-testdb', port: Number(process.env.TEST_DB_PORT || 5432),
      database: 'argus_test', user: 'test', password: 'test',
    },
    admin: { adminNumbers: ['35699811819'], botNumber: '' },
    waha: {}, redis: {}, telegram: {},
    system: { outreachActive: true, active: true },
    timings: { kevinCooldownDays: 10 },
  },
  logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return stubs.logger } },
  telegram: { sendAlert: async () => {} },
  queues: {
    addJob: async (name, data, opts = {}) => { jobs.push({ name, data, opts }); return { id: opts.jobId || `job-${jobs.length}` } },
    QUEUES: new Proxy({}, { get: () => ({ getJob: async () => null, add: async () => ({}) }) }),
  },
  // The pool's WhatsApp reachability check (services/whatsappReachability.js
  // is not part of this mirror): every number counts as on WhatsApp.
  'services/whatsappReachability': {
    classifyMany: async (_session, phones) => phones.map(() => ({ status: 'VALID' })),
  },
  waha: {
    sendText: async (session, phone, text) => {
      const fail = wahaBehaviour.failFor.get(String(phone))
      if (fail) throw fail
      sent.push({ session, phone: String(phone), text, at: new Date() })
      return { id: `msg-${sent.length}` }
    },
    getChatMessages: async () => [],
    getChatMessagesStrict: async () => [],
    getSessionStatus: async () => ({ status: wahaBehaviour.sessionStatus }),
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

// Tables this suite owns; truncated before each test.
const TABLES = [
  'outreach_daily_recipients', 'outreach_daily_quota', 'outreach_template_usage',
  'outreach_run_recipients', 'outreach_runs', 'outreach_batch_items', 'outreach_batches',
  'outreach_plan_entries', 'outreach_plan_transitions', 'outreach_reservations', 'outreach_plans',
  'outreach_log', 'owner_account_labels', 'owner_automation_blocks', 'outreach_unreachable',
  'owner_contacts', 'owners', 'outreach_account_events', 'whatsapp_accounts',
]

async function reset() {
  await db.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`)
  sent.length = 0
  jobs.length = 0
  wahaBehaviour.failFor.clear()
  wahaBehaviour.sessionStatus = 'WORKING'
}

async function account({ session, persona, pace = 30, paceMin = null, paceMax = null, label = null, phone = null } = {}) {
  const r = await db.query(
    `INSERT INTO whatsapp_accounts(session_name, phone, label, account_persona, outreach_enabled, is_active,
       outreach_volume_percent, outreach_pace_min, outreach_pace_max)
     VALUES ($1,$2,$3,$4,TRUE,TRUE,$5,$6,$7) RETURNING *`,
    [session, phone || `3567${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`, label || session, persona, pace, paceMin ?? pace, paceMax ?? pace])
  return r.rows[0]
}

async function contact(phone, extra = {}) {
  const r = await db.query(
    `INSERT INTO owner_contacts(phone_normalized, name, status, do_not_contact, owner_contact_paused_until, last_reply_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [phone, extra.name || `Owner ${phone.slice(-3)}`, extra.status || 'new', extra.do_not_contact || false,
     extra.paused_until || null, extra.last_reply_at || null])
  return r.rows[0]
}

function load(rel) {
  return require(path.join(ROOT, rel))
}

module.exports = { ROOT, db, stubs, sent, jobs, wahaBehaviour, reset, account, contact, load, inert }
