'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const helperPath = path.join(__dirname, '..', 'ops', 'owner-group-flow', 'backend', 'services', 'agentPropertyLinks.js')
const {
  propertyActionLinks,
  withPropertyLink,
  withAvailableActions,
  classifyAgentAvailabilityDecision,
  agentDecisionPrompt,
} = require(helperPath)

const links = propertyActionLinks('2906-9426')
assert.deepEqual(links, {
  detail: 'https://crm.2906.estate/schedule-board?ref=2906-9426&action=detail',
  book: 'https://crm.2906.estate/schedule-board?ref=2906-9426&action=book',
  media: 'https://crm.2906.estate/schedule-board?ref=2906-9426&action=media',
})

const message = withAvailableActions('Apartment #2906-9426 is available in Sliema.', '2906-9426')
assert.match(message, /Apartment #2906-9426 is available in Sliema\./)
assert.match(message, /action=book/)
assert.match(message, /action=media/)
assert.match(message, /Open property \/ ask again:/)
assert.equal((message.match(/https:\/\//g) || []).length, 3)

const ambiguous = withPropertyLink(
  '🟡 #2906-9426 — the owner reply needs a manual check. No status changed.',
  '2906-9426')
assert.match(ambiguous, /action=detail/)
assert.equal((ambiguous.match(/https:\/\//g) || []).length, 1)
assert.doesNotMatch(ambiguous, /phone|owner name|reply text/i)

assert.equal(classifyAgentAvailabilityDecision('Still av'), 'available')
assert.equal(classifyAgentAvailabilityDecision('still available.'), 'available')
assert.equal(classifyAgentAvailabilityDecision('Rented'), 'rented')
assert.equal(classifyAgentAvailabilityDecision('Not sure'), 'not_sure')
assert.equal(classifyAgentAvailabilityDecision('maybe'), null)

const prompt = agentDecisionPrompt('2906-9426')
assert.match(prompt, /Still available\nRented\nNot sure/)
assert.match(prompt, /action=detail/)
assert.doesNotMatch(prompt, /owner|phone|address|reply text/i)

console.log('availability agent links: 17 checks passed')
