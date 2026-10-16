'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const route = fs.readFileSync(path.join(root, 'ops/owner-group-flow/backend/routes/crmScheduleBoard.js'), 'utf8')
const page = fs.readFileSync(path.join(root, 'app/crm/schedule-board/page.tsx'), 'utf8')
const listingAgentNotify = fs.readFileSync(path.join(root, 'ops/owner-group-flow/backend/services/listingAgentNotify.js'), 'utf8')

const availabilityRoute = route.slice(
  route.indexOf("router.post('/listings/:ref/request-availability'"),
  route.indexOf("router.post('/listings/:ref/request-location'")
)

assert.match(availabilityRoute, /requestOwnerAvailability\s*\(/)
assert.doesNotMatch(availabilityRoute, /relayToListingAgent/)
assert.doesNotMatch(availabilityRoute, /listed_by_agent_id\s*===\s*me\.id/)
assert.match(availabilityRoute, /mode:\s*'owner'/)

assert.match(route, /availabilityContact:\s*contactState\(row,\s*true,\s*questionsUsed\)/)
assert.match(page, /const avContact = r\.availabilityContact \|\| c/)
assert.match(page, /kind === 'request-availability'[\s\S]{0,100}Contacting the owner/)
assert.match(page, />\s*Ask the owner\s*</)
assert.doesNotMatch(listingAgentNotify, /requestAvailability|availabilityTemplate/)

console.log('schedule-board availability always routes through the guarded owner flow')
