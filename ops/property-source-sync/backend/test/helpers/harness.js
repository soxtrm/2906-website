'use strict'
// Test harness for Property Source Sync (Claude, 2026-11-09). Real modules from
// this mirror against an ISOLATED Postgres (production schema, no production
// data) on an internal Docker network. Edges are stubbed: config points db.js
// at the test DB; logger and telegram are inert; WAHA throws, so any attempt
// to message anyone fails the suite.
const path = require('path')
const Module = require('module')
const fs = require('fs')

const ROOT = path.join(__dirname, '..', '..')
const wahaCalls = []
const stubs = {
  config: { db: { host: process.env.TEST_DB_HOST || 'argus-outreach-testdb', port: 5432, database: process.env.TEST_DB_NAME || 'source_sync_test', user: 'test', password: 'test' } },
  logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return stubs.logger } },
  telegram: { sendAlert: async () => {} },
  waha: new Proxy({}, { get: (_, k) => async (...args) => { wahaCalls.push({ k, args }); throw new Error('WAHA must never be called by source sync') } }),
}
const original = Module._load
Module._load = function (request, parent) {
  if (parent && parent.filename && (request.startsWith('./') || request.startsWith('../'))) {
    const resolved = path.resolve(path.dirname(parent.filename), request)
    const rel = path.relative(ROOT, resolved).replace(/\\/g, '/').replace(/\.js$/, '')
    if (Object.prototype.hasOwnProperty.call(stubs, rel)) return stubs[rel]
    if (!fs.existsSync(resolved) && !fs.existsSync(`${resolved}.js`)) throw new Error(`Unexpected dependency ${rel}`)
  }
  return original.apply(this, arguments)
}

const db = require(path.join(ROOT, 'db'))
const load = rel => require(path.join(ROOT, rel))

async function migrate() {
  const sql = fs.readFileSync(path.join(ROOT, 'migrations', '20261109_property_source_sync.sql'), 'utf8')
  await db.query(sql)
}
async function reset() {
  await db.query(`DELETE FROM property_source_events`)
  await db.query(`DELETE FROM property_source_scans`)
  await db.query(`UPDATE website_source_inventory SET canonical_property_id=NULL WHERE source_id IS NOT NULL`)
  await db.query(`DELETE FROM website_source_inventory WHERE source_id IS NOT NULL OR source_domain IN ('www.mynexthome.mt','other-agency.example')`)
  await db.query(`DELETE FROM property_sources`)
  await db.query(`DELETE FROM properties WHERE ref LIKE 'WSI-MYNEXTHOME-%' OR ref LIKE 'SST-%'`)
  await db.query(`DELETE FROM agent_activity_log WHERE action_type LIKE 'PROPERTY_SOURCE%' OR action_type='SOURCE_SYNC_DIGEST'`)
}
let agentSeq = 0
async function agent(role = 'admin') {
  agentSeq++
  const u = `sst_${role}_${process.pid}_${agentSeq}_${Date.now()}`
  const { rows: [a] } = await db.query(`INSERT INTO agents (username, name, role, active) VALUES ($1,$1,$2,true) RETURNING id, role, name`, [u, role])
  return a
}
async function property(fields) {
  const cols = Object.keys(fields), vals = Object.values(fields)
  const { rows: [p] } = await db.query(`INSERT INTO properties (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, vals.map(v => (v && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v)))
  return p
}
module.exports = { db, load, migrate, reset, agent, property, wahaCalls, ROOT }
