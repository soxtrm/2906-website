'use strict'
// ============================================================================
// test/seafrontHint.test.js
// Kev, 2026-10-19: ONLY "direct seafront" is seafront. Everything else that
// mentions the seafront (seafront apartment, easy access to Sliema seafront,
// close to / near / minutes from the seafront, best seafront addresses) is not.
// Replaces the 2026-08-28 rule ("bare seafront counts").
// ============================================================================
const assert = require('assert')
const { seafrontHint, seafrontEvidence } = require('../services/categoryClassifier')

let passed = 0, failed = 0
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); passed++ }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++ }
}
const yes = (text, type = 'apartment') => check(`"${text}" → seafront`, () => assert.strictEqual(seafrontHint(text, type), true))
const no = (text, type = 'apartment') => check(`"${text}" → NOT seafront`, () => assert.strictEqual(seafrontHint(text, type), false))

yes('Direct seafront apartment in Sliema')
yes('DIRECT SEAFRONT – 3 bedroom penthouse')
yes('Beautiful flat directly on the seafront, Tower Road')
yes('Lovely apartment, direct sea-front, sea views')
check('type "direct seafront apartment" → seafront', () => assert.strictEqual(seafrontHint('Fully furnished', 'direct seafront apartment'), true))

// #2906-9489 (2026-10-19) went to the Sea Front group on this line:
no('🌊 Easy Access to Sliema Seafront')
no('Beautiful seafront apartment with sea access')
no('This lovely flat is seafront, fully furnished')
no('COMING SOON – ONE OF TIGNÉ’S BEST SEAFRONT ADDRESSES')
no('Modern flat near seafront, 5 minutes to everything')
no('Nice apartment near the seafront in Sliema')
no('Close to the seafront and all amenities')
no('Only 2 minutes walk to Tower Road & Seafront')
no('Direct access to the seafront promenade')
no('Few minutes from the seafront')
check('type "seafront apartment" alone → not seafront', () => assert.notStrictEqual(seafrontHint('Fully furnished', 'seafront apartment'), true))
check('"sea view" alone → NOT seafront', () => assert.strictEqual(seafrontHint('Apartment with sea views', 'apartment'), false))
check('no seafront mention → null', () => assert.strictEqual(seafrontHint('2 bedroom flat in Mosta', 'apartment'), null))
check('evidence quotes the direct clause', () => assert.match(seafrontEvidence('Lovely. Direct seafront apartment in Qawra.').evidence, /Direct seafront/))

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
