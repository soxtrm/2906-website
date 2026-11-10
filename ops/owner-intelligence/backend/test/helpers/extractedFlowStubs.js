'use strict'

// The recovery-pack checkout contains service snapshots, while production
// supplies the shared backend logger beside them. Keep pure policy/golden tests
// portable without masking any other missing dependency.
const Module = require('node:module')
const originalLoad = Module._load
Module._load = function extractedFlowLoad(request, parent, isMain) {
  if (request === '../logger' && /ownerOptOut\.js$/.test(parent?.filename || '')) {
    return { info() {}, warn() {}, debug() {}, error() {} }
  }
  return originalLoad.call(this, request, parent, isMain)
}
