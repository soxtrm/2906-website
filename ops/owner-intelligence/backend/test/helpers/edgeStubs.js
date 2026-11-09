'use strict'
// Preload for `node --test --require ./test/helpers/edgeStubs.js` (Claude, 2026-11-09).
//
// Production modules require ../logger and ../telegram, which live only in
// /opt/2906-system/backend and are not part of this mirror. Tests that load a
// service directly (without ownerHarness) used to fail with MODULE_NOT_FOUND
// before asserting anything. This stubs only those two edges; ownerHarness
// still owns config/db/waha/queues for the integration tests.
const path = require('path')
const Module = require('module')

const ROOT = path.join(__dirname, '..', '..')
const quiet = () => {}
const logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, child() { return logger } }
const EDGES = { logger, telegram: { sendAlert: async () => {} } }

const original = Module._load
Module._load = function (request, parent, isMain) {
  if (parent && parent.filename && (request.startsWith('./') || request.startsWith('../'))) {
    const rel = path.relative(ROOT, path.resolve(path.dirname(parent.filename), request)).replace(/\\/g, '/').replace(/\.js$/, '')
    if (Object.prototype.hasOwnProperty.call(EDGES, rel)) {
      try { return original.apply(this, arguments) } catch (err) { if (err.code !== 'MODULE_NOT_FOUND') throw err }
      return EDGES[rel]
    }
  }
  return original.apply(this, arguments)
}
