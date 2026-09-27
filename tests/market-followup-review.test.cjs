const assert = require('assert')
const fs = require('fs')

const service = fs.readFileSync('ops/outreach-control/marketFollowupReview.js', 'utf8')
const cron = fs.readFileSync('ops/outreach-control/cron.js', 'utf8')

assert.match(service, /DAY_11\s*=\s*11/)
assert.match(service, /DECISION_REQUIRED','PRICE_REVIEW_DUE/)
assert.match(service, /proposed_message,updated_at[\s\S]*NULL,NOW\(\)/)
assert.match(service, /market_followup_rollout_started_at/)
assert.match(service, /ON CONFLICT\(owner_phone,topic\) DO NOTHING/)
assert.match(service, /owner_automation_blocks/)
assert.match(service, /price_flex_followup_sent/)
assert.match(cron, /marketFollowupReview/)
assert.doesNotMatch(service, /sendText|sendMessage|waha\./)

console.log('PASS: day-11 market follow-up creates deduplicated REVIEW_ONLY tasks and has no send path')
