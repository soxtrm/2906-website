'use strict'
// Loads this change's modules on top of a READ-ONLY copy of the production
// backend (ARGUS_BASE_DIR). A module that exists here wins; everything else
// resolves to the base. config and logger are stubbed; the network is closed
// unless a test installs the fake Meta Graph API.
const fs = require('fs')
const path = require('path')
const Module = require('module')

const ROOT = path.join(__dirname, '..', '..')
const BASE = process.env.ARGUS_BASE_DIR
if (!BASE || !fs.existsSync(path.join(BASE, 'services', 'sanitizer.js'))) throw new Error('ARGUS_BASE_DIR must point to a production backend copy')
if (/^(2906_postgres|postgres)$/i.test(process.env.TEST_DB_HOST || '')) throw new Error('refusing to run against the production database host')

const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return logger } }
const stubs = {
  config: {
    db: { host: process.env.TEST_DB_HOST || 'db.invalid', port: Number(process.env.TEST_DB_PORT || 5432), database: process.env.TEST_DB_NAME, user: process.env.TEST_DB_USER, password: process.env.TEST_DB_PASSWORD },
    redis: { host: process.env.TEST_REDIS_HOST || 'redis.invalid', port: 6379 }, waha: { url: 'http://waha.invalid', apiKey: 'x' }, telegram: {},
  },
  logger,
  waha: new Proxy({}, { get: () => async () => { throw new Error('WAHA must never be called by Facebook Pages') } }),
  telegram: { sendAlert: async () => {} },
}
if (process.env.NO_DB === '1') stubs.db = new Proxy({}, { get: () => () => { throw new Error('no database in unit tests') } })

const exists = p => fs.existsSync(p) || fs.existsSync(p + '.js')
const original = Module._load
Module._load = function (request, parent) {
  if (parent && parent.filename && (request.startsWith('./') || request.startsWith('../'))) {
    const resolved = path.resolve(path.dirname(parent.filename), request)
    for (const root of [ROOT, BASE]) {
      const rel = path.relative(root, resolved).replace(/\\/g, '/').replace(/\.js$/, '')
      if (rel.startsWith('..')) continue
      if (Object.prototype.hasOwnProperty.call(stubs, rel)) return stubs[rel]
      if (root === BASE && exists(path.join(ROOT, rel))) return original.call(this, path.join(ROOT, rel), parent)
      if (root === ROOT && !exists(resolved) && exists(path.join(BASE, rel))) return original.call(this, path.join(BASE, rel), parent)
    }
  }
  return original.apply(this, arguments)
}
const realFetch = globalThis.fetch   // only for calling the local test server
globalThis.fetch = async url => { throw new Error('network is not available in this test: ' + String(url).slice(0, 60)) }

const load = rel => require(path.join(ROOT, rel))
const loadBase = rel => require(path.join(BASE, rel))

// Test-only configuration (no real Meta app, a throw-away key).
process.env.META_APP_ID = '1234567890'
process.env.META_APP_SECRET = 'test-app-secret-not-real'
process.env.ARGUS_FB_TOKEN_KEY = Buffer.alloc(32, 7).toString('base64')
process.env.META_GRAPH_VERSION = 'v27.0'
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret'

module.exports = { ROOT, BASE, load, loadBase, logger, realFetch }
