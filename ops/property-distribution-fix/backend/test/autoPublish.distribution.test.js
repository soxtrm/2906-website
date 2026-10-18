'use strict'
// Auto-published listings (and !upload5 claiming an owner-checklist draft,
// which cmdUpload routes through runAutoPublishJob) were created in the CRM
// and announced as "AUTO-PUBLISHED" but never distributed: category_groups
// stayed 'pending' with zero group posts (#2906-9453, 9350..9344, ...).
// Drives the REAL runAutoPublishJob with every collaborator stubbed.
const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('module')
const path = require('path')

const calls = []
const anything = () => new Proxy(function () {}, {
  get: (t, k) => (k === 'then' ? undefined : k === '__esModule' ? false : anything()),
  apply: () => Promise.resolve(null),
})

const convo = {
  id: 77, phone: '35699811819', status: 'awaiting_auto_publish', draft_property_id: null,
  checklist: { town: 'Gzira', beds: 3, baths: 2, price: 2300, property_type: 'house', available_date: '2026-11-01', _photos: ['https://img.example/1.jpg'] },
}
const db = {
  query: async (sql, params) => {
    if (/FROM owner_auto_conversations WHERE id/.test(sql)) return { rows: [convo] }
    if (/FROM agents/.test(sql)) return { rows: [{ id: 1, username: 'kev', name: 'Kevin' }] }
    return { rows: [], rowCount: 0 }
  },
}
const upload = {
  AV_CENTRAL_GROUP: 'avcentral@g.us',
  pickUploadSession: async () => 'Cedric',
  createListing: async () => ({ propId: 29452, ref: '2906-9481', channels: ['crm', 'website', 'facebook', 'category_groups', 'fb_groups'] }),
  runCategoryDistribution: async (session, chatId, propId, ref) => { calls.push(['category', session, chatId, propId, ref]); return { results: [] } },
  autoShareToGroups: async (o) => { calls.push(['share', o.created[0].ref, o.noAd]) },
}
const stubs = {
  '../db': db,
  '../config': { automation: { autoPublishTimerMinutes: 7, autoPublishVariant: '5' }, waha: {} },
  '../logger': { info() {}, warn() {}, error() {}, debug() {} },
  '../handlers/upload': upload,
  '../handlers/uploadListing': { alertKev: async (t) => { calls.push(['alert', t.slice(0, 20)]) } },
  './facebookCampaign': { postCountFrom: (v) => Number(v) || 3, scheduleFacebookCampaign: async (id, n) => { calls.push(['fb', id, n]); return { scheduled: n } } },
  './canonical2906Renderer': { render2906Listing: async () => ({ ok: true, text: 'MODERN TOWNHOUSE' }) },
}
const original = Module._load
Module._load = function (request, parent) {
  if (stubs[request]) return stubs[request]
  if (request.startsWith('.') && !/autoOwnerConversation/.test(request) && /property-distribution-fix/.test(parent?.filename || '')) return anything()
  if (/^(cloudinary|@google\/genai)$/.test(request)) return anything()
  return original.apply(this, arguments)
}
global.fetch = async () => ({ arrayBuffer: async () => new ArrayBuffer(4), headers: { get: () => 'image/jpeg' } })
const aoc = require('../services/autoOwnerConversation')

test('runAutoPublishJob distributes what it publishes (FB campaign, category groups, FB share)', async () => {
  assert.deepEqual(aoc.buildSanityWarnings(convo.checklist), [], 'fixture checklist is publishable')
  await aoc.runAutoPublishJob(77)
  await new Promise(r => setTimeout(r, 20))   // distribution runs detached
  const kinds = calls.map(c => c[0])
  assert.ok(kinds.includes('alert'), 'operator still gets the AUTO-PUBLISHED note')
  assert.deepEqual(calls.find(c => c[0] === 'fb'), ['fb', 29452, 5], 'variant upload5 → 5 page posts')
  assert.deepEqual(calls.find(c => c[0] === 'category'), ['category', 'Cedric', 'avcentral@g.us', 29452, '2906-9481'])
  assert.deepEqual(calls.find(c => c[0] === 'share'), ['share', '2906-9481', false])
  assert.ok(kinds.indexOf('category') < kinds.indexOf('share'), 'categories before the FB group share, like !upload')
})
