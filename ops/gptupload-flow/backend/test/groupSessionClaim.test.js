'use strict'

const assert = require('node:assert/strict')
const Module = require('node:module')

const values = new Map()
const redis = {
  async get(key) { return values.get(key) || null },
  async set(key, value, ...args) {
    if (args.includes('NX') && values.has(key)) return null
    values.set(key, value)
    return 'OK'
  },
}

let fallbackCalls = 0
const waha = {
  async pickActiveAdminSession() { fallbackCalls += 1; return 'healthy-but-not-in-group' },
  async getSessionStatus() { return { status: 'WORKING' } },
}

const blank = new Proxy({}, { get: () => (() => {}) })
const mocks = {
  '../db': blank,
  '../logger': { warn() {}, info() {}, error() {}, debug() {} },
  '../waha': waha,
  '../config': { admin: { adminNumbers: [] } },
  '../lib/sessionRouter': blank,
  '../redis': redis,
  '@google/genai': { GoogleGenAI: class {} },
  '../services/sanitizer': blank,
  '../services/categoryClassifier': blank,
  '../services/categoryPublisher': blank,
  '../services/futureAvailability': blank,
  '../services/agentTag': blank,
  '../services/colleagueAgents': blank,
  '../services/facebookCampaign': blank,
  '../services/fbAutomationStatus': blank,
  '../services/fbShareQueue': blank,
  './uploadListing': blank,
  '../services/uploadImageAssociation': blank,
  '../services/unwatermark': blank,
  '../services/gptPhotoPipeline': blank,
  '../services/gptUploadCommand': blank,
  '../services/viewingGroupPlan': blank,
  '../services/senderIdentity': blank,
  '../services/fbgroupsCommand': blank,
  '../services/priceChange': blank,
}

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request]
  return originalLoad.call(this, request, parent, isMain)
}

;(async () => {
  const { pickUploadSessionSticky } = require('../handlers/upload')

  const first = await pickUploadSessionSticky('same-message', 'Argus1')
  const duplicate = await pickUploadSessionSticky('same-message', 'Argus5')
  const handlerGate = await pickUploadSessionSticky('same-message')

  assert.equal(first, 'Argus1')
  assert.equal(duplicate, 'Argus1')
  assert.equal(handlerGate, 'Argus1')
  assert.equal(fallbackCalls, 0, 'must not nominate an account that did not observe the group')

  const withoutId = await pickUploadSessionSticky(null, 'default')
  assert.equal(withoutId, 'default')
  assert.equal(fallbackCalls, 0)

  console.log('group command claims the first session that actually observed it')
})().catch(err => {
  console.error(err)
  process.exitCode = 1
}).finally(() => { Module._load = originalLoad })
