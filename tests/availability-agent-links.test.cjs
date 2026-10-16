'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const helperPath = path.join(__dirname, '..', 'ops', 'owner-group-flow', 'backend', 'services', 'agentPropertyLinks.js')
const { propertyActionLinks, withAvailableActions } = require(helperPath)

const links = propertyActionLinks('2906-9426')
assert.deepEqual(links, {
  book: 'https://crm.2906.estate/schedule-board?ref=2906-9426&action=book',
  media: 'https://crm.2906.estate/schedule-board?ref=2906-9426&action=media',
})

const message = withAvailableActions('Apartment #2906-9426 is available in Sliema.', '2906-9426')
assert.match(message, /Apartment #2906-9426 is available in Sliema\./)
assert.match(message, /action=book/)
assert.match(message, /action=media/)
assert.equal((message.match(/https:\/\//g) || []).length, 2)

console.log('availability agent links: 5 checks passed')
