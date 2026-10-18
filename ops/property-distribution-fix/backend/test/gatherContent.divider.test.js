'use strict'
// #2906-9484 (2026-10-18): 24 forwarded photos, then Kev's own "...", then 8
// photos + the ad + !upload6 — all 32 photos went into the listing. Replays
// that exact chat order through the REAL gatherContent.
const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('module')
const path = require('path')

let chat = []
const anything = () => new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : anything()), apply: () => anything(), construct: () => anything() })
const stubs = {
  '../db': { query: async () => ({ rows: [{ ts: 0 }] }) },
  '../logger': { info() {}, warn() {}, error() {}, debug() {} },
  '../waha': { getChatMessagesWithMedia: async () => chat },
  '../config': new Proxy({}, { get: () => ({}) }),
  cloudinary: { v2: { config() {}, uploader: {} } },
  '@google/genai': { GoogleGenAI: class {} },
}
const original = Module._load
Module._load = function (request, parent) {
  if (stubs[request]) return stubs[request]
  if (request.startsWith('../') && /property-distribution-fix[\\/]backend[\\/]handlers/.test(parent?.filename || '')) {
    try { return original.apply(this, arguments) } catch { return anything() }
  }
  return original.apply(this, arguments)
}
const ul = require(path.join(__dirname, '..', 'handlers', 'uploadListing.js'))
Module._load = original

let n = 0
const T0 = 1792335000
const img = t => ({ id: `m${++n}`, fromMe: true, timestamp: t, body: '', mediaData: { data: Buffer.from(`p${n}`).toString('base64'), mimetype: 'image/jpeg' } })
const txt = (t, body) => ({ id: `m${++n}`, fromMe: true, timestamp: t, body })
const cmd = t => ({ id: 'cmd', fromMe: true, timestamp: t, body: '!upload6' })

test('#2906-9484: photos before the "..." with no text of their own are left out', async () => {
  chat = [
    ...Array.from({ length: 24 }, (_, i) => img(T0 + i)),          // forwarded, other flat
    txt(T0 + 130, '...'),
    ...Array.from({ length: 8 }, (_, i) => img(T0 + 150 + i)),
    txt(T0 + 170, '🌊 LUXURY SEAFRONT APARTMENT'),
    txt(T0 + 190, 'Chris +35679058073'),
  ]
  const g = await ul.gatherContent(cmd(T0 + 200), 'default', 'g@g.us', true, '35699270699', T0 + 200, { allUploadImages: true })
  assert.equal(g.imageItems.length, 8)
  assert.match(g.combinedText, /LUXURY SEAFRONT/)
})

test('multi-property upload ("...." between properties, each with text) keeps every block', async () => {
  chat = [
    txt(T0, 'Flat A Sliema 2 bed €1200'), ...Array.from({ length: 5 }, (_, i) => img(T0 + 1 + i)),
    txt(T0 + 20, '....'),
    txt(T0 + 30, 'Flat B Gzira 3 bed €1500'), ...Array.from({ length: 6 }, (_, i) => img(T0 + 31 + i)),
  ]
  const g = await ul.gatherContent(cmd(T0 + 60), 'default', 'g@g.us', true, '35699270699', T0 + 60, { allUploadImages: true })
  assert.equal(g.imageItems.length, 11)
  assert.match(g.combinedText, /Flat A[\s\S]*Flat B/)
})

test('no divider: unchanged — everything in the 10-minute window', async () => {
  chat = [...Array.from({ length: 4 }, (_, i) => img(T0 + i)), txt(T0 + 10, 'Flat C')]
  const g = await ul.gatherContent(cmd(T0 + 20), 'default', 'g@g.us', true, '35699270699', T0 + 20, { allUploadImages: true })
  assert.equal(g.imageItems.length, 4)
})
