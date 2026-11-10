'use strict'
// Historical 486-case recovery pack (2026-11-09) through the NEW
// ownerDecision layer. The pack was written for the older route vocabulary, so
// each expected route maps to the decision family the new contract must land
// in. Hard assertions are the safety invariants; family agreement is reported
// and must stay at or above the frozen baseline (no silent regression).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { decide } = require('../services/ownerDecision')
const { maltaDate } = require('./goldenContext')

const CASES = fs.readFileSync(path.join(__dirname, 'fixtures', 'argus-golden-cases-20261109.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l))
const BASELINE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'historical486-baseline.json'), 'utf8'))

const TWO_REFS = ['#2906-9555', '#2906-9556']
const SEED_CONTEXT = {
  '073': { numberedOptions: TWO_REFS }, '074': { numberedOptions: TWO_REFS }, '075': { numberedOptions: TWO_REFS },
  '083': { numberedOptions: ['#2906-9601', '#2906-9602', '#2906-9603'] },
  '034': { manualPaused: true }, '132': { duplicate: true }, '134': { manualPaused: true },
  '135': { dnc: true }, '136': { humanActive: true }, '137': { senderUnknown: true },
  '138': { now: maltaDate(10, 22, 30) },
}
const FAMILY = {
  PRIVACY_STOP: ['DNC'],
  NO_REPLY_HUMAN_ACTIVE: ['NO_SEND'],
  NO_REPLY: ['NO_SEND', 'DEFER', 'DNC', 'WAIT_FOR_MEDIA'],
  HUMAN_HANDOFF: ['HUMAN_HANDOFF'],
  HUMAN_REVIEW: ['HUMAN_HANDOFF', 'WAIT_FOR_MEDIA', 'NO_SEND', 'DNC'],
  ANSWER_QUESTION: ['ANSWER_DIRECT', 'HUMAN_HANDOFF'],
  FACT_UPDATE: ['ACKNOWLEDGE_UPDATE', 'NO_SEND', 'WAIT_FOR_MEDIA'],
  CORRECT_FACT: ['ACKNOWLEDGE_UPDATE'],
  AVAILABILITY_UPDATE: ['ACKNOWLEDGE_UPDATE'],
  PROPERTY_DRAFT: ['ACKNOWLEDGE_UPDATE', 'WAIT_FOR_MEDIA'],
  ACK_ONLY: ['ACKNOWLEDGE_UPDATE', 'NO_SEND'],
}
const PERSONA = { K: 'kev', C: 'cedric', G: 'gabriela' }
const NAMES = ['Kevin', 'Cedric', 'Gabriela']
const INTERROGATION_RE = /\bhow many (?:bed|bath)rooms\b|\brent per month\b|\bwhat would the monthly rent\b/i

function identityFor(p) {
  return { persona: PERSONA[p.code], name: p.name, fullName: p.name, agency: String(p.agency).replace(/\s*\(verified in fixture\)/, ''),
    roleNoun: p.code === 'C' ? 'a rental agent' : 'a real estate agent', affiliationVerified: true,
    website: p.code === 'K' ? 'https://2906.estate' : null }
}

function run(c) {
  const seed = c.id.split('-')[1]
  const context = { now: maltaDate(10, 11, 0), identity: identityFor(c.persona_fixture), ...(SEED_CONTEXT[seed] || {}),
    ...(c.id.endsWith('-H') ? { humanActive: true } : {}) }
  if (context.senderUnknown) context.identity = null
  return decide({ messages: c.inbound_messages, context })
}

const results = CASES.map(c => ({ c, d: run(c) }))

test('safety invariants on all 486 historical cases', () => {
  const violations = []
  for (const { c, d } of results) {
    const p = c.persona_fixture
    if (['PRIVACY_STOP', 'NO_REPLY_HUMAN_ACTIVE'].includes(c.expected_route) && d.send_eligible) violations.push(`${c.id}: sends on ${c.expected_route}`)
    if (c.expected_route === 'PRIVACY_STOP' && d.next_action !== 'DNC') violations.push(`${c.id}: privacy stop not DNC (${d.next_action})`)
    if (c.id.endsWith('-H') && d.send_eligible) violations.push(`${c.id}: sends during human takeover`)
    if (d.send_eligible && d.draft_reply) {
      if (INTERROGATION_RE.test(d.draft_reply)) violations.push(`${c.id}: interrogation in reply`)
      for (const other of NAMES.filter(n => n !== p.name)) if (new RegExp(`\\b${other}\\b`).test(d.draft_reply)) violations.push(`${c.id}: speaks as ${other}`)
    }
  }
  assert.deepEqual(violations, [])
})

// Deliberate differences: the 2026-11-10 founder pack (136 cases) is newer and wins.
const INTENTIONAL = {
  '034': 'manual pause: 136-pack G099 requires NO_SEND/MANUAL_PAUSE; facts are still recorded, nothing is sent (same safety outcome).',
  '091': '"You can come Tuesday at 18:00" is a proposed viewing slot: 136-pack G076 requires HUMAN_HANDOFF/VIEWING_OFFER, never an auto-booking.',
}

test('every deliberate divergence is still the documented one', () => {
  for (const { c, d } of results) {
    const seed = c.id.split('-')[1]
    if (!INTENTIONAL[seed]) continue
    if (seed === '034') assert.equal(d.next_action, 'NO_SEND', c.id)
    if (seed === '091') assert.equal(d.reason_code, 'VIEWING_OFFER', c.id)
    assert.equal(d.send_eligible && seed === '034', false, c.id)
  }
})

test('route-family agreement does not regress below the frozen baseline', () => {
  const misses = results.filter(({ c, d }) => !(FAMILY[c.expected_route] || []).includes(d.next_action) && !INTENTIONAL[c.id.split('-')[1]])
  const agree = results.length - misses.length
  const byRoute = {}
  for (const { c } of misses) byRoute[c.expected_route] = (byRoute[c.expected_route] || 0) + 1
  console.log(`# historical486 family agreement ${agree}/${results.length}; misses by route ${JSON.stringify(byRoute)}`)
  if (process.env.WRITE_BASELINE) fs.writeFileSync(path.join(__dirname, 'fixtures', 'historical486-baseline.json'), JSON.stringify({ agree, total: results.length, frozen_at: new Date().toISOString() }, null, 2))
  if (process.env.LIST_MISSES) for (const { c, d } of misses) console.log(`# MISS ${c.id} expected=${c.expected_route} got=${d.next_action}/${d.reason_code} :: ${c.inbound_messages.join(' / ').slice(0, 120)}`)
  assert.ok(agree >= BASELINE.agree, `agreement ${agree} < baseline ${BASELINE.agree}`)
})
