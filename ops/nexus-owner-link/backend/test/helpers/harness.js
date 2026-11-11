'use strict'
// Test harness for the ARGUS × NEXUS owner link (Claude, 2026-11-11).
// Real modules from this mirror; db.js and services/boardAction.js are the REAL
// production files, loaded from a production mirror (ARGUS_BASE_DIR) so the
// availability path is tested against the code that actually runs. The database
// is a local throw-away Postgres with the production schema and no production
// rows. config/logger/telegram are inert; WAHA and queues THROW, so any attempt
// to message anyone or enqueue a send fails the suite.
const path = require('path')
const Module = require('module')
const fs = require('fs')

const ROOT = path.join(__dirname, '..', '..')
const BASE = process.env.ARGUS_BASE_DIR
if (!BASE || !fs.existsSync(path.join(BASE, 'db.js'))) throw new Error('ARGUS_BASE_DIR must point to a production mirror containing db.js')

const forbidden = name => new Proxy({}, { get: (_, k) => () => { throw new Error(`${name}.${String(k)} must never be called by the owner link`) } })
const stubs = {
  config: { db: { host: process.env.TEST_DB_HOST || '127.0.0.1', port: Number(process.env.ARGUS_TEST_PGPORT || 55439), database: process.env.TEST_DB_NAME || 'argus_test', user: 'test', password: 'test' } },
  logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return stubs.logger } },
  telegram: { sendAlert: async () => {} },
  waha: forbidden('waha'),
  queues: forbidden('queues'),
}
const exists = p => fs.existsSync(p) || fs.existsSync(`${p}.js`)
const original = Module._load
Module._load = function (request, parent) {
  if (parent && parent.filename && (request.startsWith('./') || request.startsWith('../'))) {
    const resolved = path.resolve(path.dirname(parent.filename), request)
    for (const root of [ROOT, BASE]) {
      const rel = path.relative(root, resolved).replace(/\\/g, '/').replace(/\.js$/, '')
      if (rel.startsWith('..')) continue
      if (Object.prototype.hasOwnProperty.call(stubs, rel)) return stubs[rel]
      // Not in this mirror → take the production file of the same path.
      if (root === ROOT && !exists(resolved) && exists(path.join(BASE, rel))) return original.call(this, path.join(BASE, rel), parent)
    }
  }
  return original.apply(this, arguments)
}

const db = require(path.join(BASE, 'db'))
const load = rel => require(path.join(ROOT, rel))

async function migrate(direction = 'up') {
  const file = direction === 'down' ? '20261111_nexus_owner_link.down.sql' : '20261111_nexus_owner_link.sql'
  const b = direction === 'down' ? '20261111b_nexus_distribution_routes.down.sql' : '20261111b_nexus_distribution_routes.sql'
  // down: routes first (it depends on nothing but properties/agents, kept symmetrical)
  for (const f of direction === 'down' ? [b, file] : [file, b]) await db.query(fs.readFileSync(path.join(ROOT, 'migrations', f), 'utf8'))
}
const TABLES = ['nexus_distribution_routes', 'owner_availability_answers', 'nexus_inbound_events', 'nexus_sync_outbox', 'nexus_distribution_grants', 'nexus_property_links', 'nexus_owner_property_claims', 'nexus_owner_invitations', 'nexus_owner_links']
async function reset() {
  for (const t of TABLES) await db.query(`DELETE FROM ${t}`)
  await db.query(`DELETE FROM property_activities WHERE property_id IN (SELECT id FROM properties WHERE ref LIKE 'NXT-%')`)
  await db.query(`DELETE FROM properties WHERE ref LIKE 'NXT-%'`)
  await db.query(`DELETE FROM owner_contacts WHERE phone_normalized LIKE '+3569900%'`)
  await db.query(`DELETE FROM agent_activity_log WHERE action_type LIKE 'NEXUS_%'`)
}
let seq = 0
async function agent(role = 'admin', entitlements = {}) {
  seq++
  const u = `nxt_${role}_${process.pid}_${seq}_${Date.now()}`
  const { rows: [a] } = await db.query(`INSERT INTO agents (username, name, role, active, feature_entitlements) VALUES ($1,$1,$2,true,$3::jsonb) RETURNING id, role, name`, [u, role, JSON.stringify(entitlements)])
  return a
}
async function owner(fields = {}) {
  seq++
  const row = { name: `Test Owner ${seq}`, phone_normalized: `+3569900${String(process.pid % 1000).padStart(3, '0')}${String(seq).padStart(3, '0')}`.slice(0, 20), ...fields }
  const cols = Object.keys(row)
  const { rows: [o] } = await db.query(`INSERT INTO owner_contacts (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, Object.values(row))
  return o
}
async function property(ownerId, fields = {}) {
  seq++
  const row = { ref: `NXT-${process.pid}-${seq}`, owner_id: ownerId, town: 'Sliema', property_type: 'apartment', bedrooms: 2, longlet_price: 1500, available_status: 'available', street: '12 Secret Street', ...fields }
  const cols = Object.keys(row)
  const { rows: [p] } = await db.query(`INSERT INTO properties (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, Object.values(row))
  return p
}
module.exports = { db, load, migrate, reset, agent, owner, property, ROOT, BASE, TABLES }
