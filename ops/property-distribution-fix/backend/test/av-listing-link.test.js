'use strict'
// Kev, 2026-10-19: an owner who answers the availability check with the link to
// their own live ad means "still available". #2906-934x sat in "needs recheck"
// with: Owner replied twice but the classifier could not read it:
// "https://www.facebook.com/share/1E7K6AFWBd/".
// Loads the REAL services/availability.js (I/O stubbed) and calls classifyReply.
//   node test/av-listing-link.test.js [path/to/availability.js]
const assert = require('assert')
const path = require('path')
const Module = require('module')
const inert = new Proxy(function () {}, { get: (_, k) => (k === 'then' ? undefined : inert), apply: () => inert, construct: () => inert })
const original = Module._load
Module._load = function (request) {
  if (request.startsWith('.') || ['ioredis', 'bullmq', 'axios', '@google/genai', 'openai'].includes(request)) return inert
  return original.apply(this, arguments)
}
const { classifyReply } = require(process.argv[2] || path.join(__dirname, '../services/availability.js'))

let passed = 0, failed = 0
const check = (name, text, status) => {
  try { assert.strictEqual(classifyReply(text).status, status); console.log(`  ok   ${name}`); passed++ }
  catch (e) { console.error(`  FAIL ${name} → ${classifyReply(text).status}`); failed++ }
}

check('bare Facebook share link → available', 'https://www.facebook.com/share/1E7K6AFWBd/', 'replied_available')
check('Marketplace link with "here" → available', 'here https://m.facebook.com/marketplace/item/123456789/', 'replied_available')
check('MaltaPark link → available', 'https://www.maltapark.com/item/details/1234567', 'replied_available')
check('link + "rented" → NOT available', 'rented sorry https://www.facebook.com/share/abc/', 'replied_no')
check('link + "no longer available" → NOT available', 'no longer available https://www.facebook.com/share/abc/', 'replied_no')
check('unrelated link (youtube) → still unclear', 'https://www.youtube.com/watch?v=abc', 'unclear')
check('plain "still available" unchanged', 'still available', 'replied_available')
check('plain "rented" unchanged', 'it is rented', 'replied_no')

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
