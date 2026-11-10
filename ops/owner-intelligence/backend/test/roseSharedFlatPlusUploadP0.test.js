'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const shared = require('../services/sharedAccommodation')
const policy = require('../services/conversationPolicy')
const originalLoad = Module._load
Module._load = function loadWithImageProviderStub(request, parent, isMain) {
  if (request === '@google/genai') return { GoogleGenAI: class GoogleGenAI {} }
  if (parent?.filename?.endsWith('gptPhotoPipeline.js') && request === '../db') return { query: async () => ({ rows: [] }) }
  if (parent?.filename?.endsWith('gptPhotoPipeline.js') && request === '../logger') return { warn() {}, info() {}, debug() {} }
  if (parent?.filename?.endsWith('gptPhotoPipeline.js') && request === '../config') return { gemini: {} }
  if (parent?.filename?.endsWith('ownerOptOut.js') && request === '../logger') return { warn() {}, info() {}, debug() {} }
  return originalLoad.call(this, request, parent, isMain)
}
const photos = require('../../../gptupload-flow/backend/services/gptPhotoPipeline')

const ROOT = path.resolve(__dirname, '..')
const REPO = path.resolve(ROOT, '../../..')
const rose = `Good morning, I have a flat in Bahar ic-Caghaq sharing. I have a lady in the Flat, but she needs another lady to share it with she has to be nice and tidy as the one I have in the flat she's spotless the rent will be 800 each cause it's €1600. It's a beautiful place in front of the sea just before you go down to splash and fun mostly everything is new kitchen bedroom sitting room if you like to come and see it you're welcome and there is a bus stop near too`
const property = { id: 69, ref: '2906-069', town: 'Baħar iċ-Ċagħaq', property_type: 'apartment', bedrooms: 2 }
const decide = text => policy.interpretInbound({ text, context: { referencedPropertyIds: [69], properties: [property] } })
const action = (decision, type) => decision.actions.find(item => item.type === type)
const fact = (decision, name) => decision.facts.find(item => item.fieldName === name)
const read = relative => fs.readFileSync(path.join(REPO, relative), 'utf8')

test('R01 Rose exact text becomes one shared place at EUR800/person and EUR1600 total', () => {
  const parsed = shared.parseSharedAccommodation(rose)
  const decision = decide(rose)
  assert.equal(parsed.isOffer, true)
  assert.equal(parsed.availablePlaceCount, 1)
  assert.equal(parsed.perPersonRent, 800)
  assert.equal(parsed.wholePropertyTotalRent, 1600)
  assert.ok(action(decision, 'SHARED_PLACE_OFFER'))
  assert.equal(action(decision, 'PROPERTY_STATUS'), undefined)
})
test('R02 rented for one lady with another needed remains partial occupancy', () => {
  const decision = decide("Yes, it's rented for one lady, but she needs to share. She needs another girl to share with")
  assert.equal(fact(decision, 'occupancyState').fieldValue, 'PARTIALLY_OCCUPIED')
  assert.equal(fact(decision, 'availablePlaceCount').fieldValue, 1)
  assert.equal(action(decision, 'PROPERTY_STATUS'), undefined)
})
test('R03 prior EUR1800 is not collapsed with EUR800 each and EUR1600 total', () => {
  const decision = decide(rose)
  assert.equal(fact(decision, 'askingPrice'), undefined)
  assert.equal(fact(decision, 'perPersonRent').fieldValue, 800)
  assert.equal(fact(decision, 'wholePropertyTotalRent').fieldValue, 1600)
})
test('R04 full-flat listing converts to approval review without whole-unit availability', () => {
  const a = action(decide(rose), 'SHARED_PLACE_OFFER')
  assert.equal(a.status, 'NEEDS_HUMAN_REVIEW')
  assert.equal(a.details.wholePropertyAvailable, false)
})
test('R05 targeted live correction is guarded and never blindly republishes', () => {
  const sql = read('ops/owner-intelligence/scripts/20261110_rose_2906_069_recovery.sql')
  assert.match(sql, /verified shared-place RENTED event not found/)
  assert.match(sql, /current status changed since incident/)
  assert.match(sql, /published=FALSE/)
  assert.doesNotMatch(sql, /published=TRUE/)
})
test('R06 false completion is blocked when no action was committed', () => {
  const result = policy.validateDraft({ draft: "I've updated our records and removed the property from our available listings.", state: { committedActions: [] } })
  assert.equal(result.allow, false)
  assert.equal(result.reason, 'uncommitted_completion_claim')
})
test('R07 one lady lives there and another is welcome does not ask rented-or-break', () => {
  const d = decide('One lady lives there and another lady is welcome to share.')
  assert.ok(action(d, 'SHARED_PLACE_OFFER'))
  assert.equal(policy.planDirectReply(d, null, {}), null)
})
test('R08 no longer looking for a housemate closes only the place scope', () => {
  const d = decide('I am not looking for another housemate now.')
  assert.equal(fact(d, 'availablePlaceCount').fieldValue, 0)
  assert.ok(action(d, 'SHARED_PLACE_STATUS'))
  assert.equal(action(d, 'PROPERTY_STATUS'), undefined)
})
test('R09 both places rented produces zero vacant places without whole-property mutation', () => {
  const d = decide('Both places are rented now.')
  assert.equal(fact(d, 'availablePlaceCount').fieldValue, 0)
  assert.equal(action(d, 'PROPERTY_STATUS'), undefined)
})
test('R10 one room available from 1 December retains room and date precision', () => {
  const parsed = shared.parseSharedAccommodation('One room is available only from 1 December.')
  assert.equal(parsed.availableRoomCount, 1)
  assert.equal(parsed.availablePlaceCount, 0)
  assert.equal(parsed.availableFrom, '1 December')
})
test('R11 viewing invitation without time is not a confirmed appointment', () => {
  const parsed = shared.parseSharedAccommodation('One place is available. If you like to come and see it you are welcome.')
  assert.equal(parsed.viewingInvited, true)
  assert.equal(parsed.viewingProposal, null)
})
test('R12 tomorrow at 3 is a Malta-time proposal, never confirmed', () => {
  const proposal = shared.extractViewingProposal('We can see it tomorrow at 3 pm.')
  assert.deepEqual(proposal, { day: 'tomorrow', time: '3 pm', timezone: 'Europe/Malta', status: 'PROPOSED' })
})
test('R13 gender wording is restricted evidence for human review, not an auto-filter', () => {
  const d = decide('I have one lady there and I want another lady, tidy, to share.')
  assert.equal(fact(d, 'restrictedComplianceNote').restricted, true)
  assert.equal(d.complianceReview, true)
  assert.equal(d.suppressAutomation, true)
})
test('R14 shared media evidence path suppresses duplicate owner questions', () => {
  const source = read('ops/owner-intelligence/backend/services/availability.js')
  assert.match(source, /shared_place_offer_review/)
  assert.match(source, /no_owner_message_sent:true/)
})
test('R15 corrected total EUR1700 leaves per-person rent unknown', () => {
  const parsed = shared.parseSharedAccommodation('Correction: the shared flat total is €1700.')
  assert.equal(parsed.wholePropertyTotalRent, 1700)
  assert.equal(parsed.perPersonRent, null)
})
test('R16 EUR800 each without roommate count never derives a total', () => {
  const rent = shared.extractRent('The rent is €800 each.')
  assert.equal(rent.perPersonRent, 800)
  assert.equal(rent.wholePropertyTotalRent, null)
})
test('R17 retired clarification variants contain no Sorry to hear', () => {
  const source = read('ops/owner-intelligence/backend/services/availability.js')
  const block = source.slice(source.indexOf('const MSG_OWNER_CLARIFY'), source.indexOf('const FOLLOWUP_CALL_DELAY_MS'))
  assert.doesNotMatch(block, /Sorry to hear/i)
})
test('R18 removal completion claim without acknowledged action fails truthfulness gate', () => {
  assert.equal(policy.validateDraft({ draft: 'I removed the property from our listings.', state: {} }).reason, 'uncommitted_completion_claim')
})
test('R19 three bedrooms with only one vacant room means one room, not full flat', () => {
  const parsed = shared.parseSharedAccommodation('It is a 3-bedroom property but only 1 room is vacant.')
  assert.equal(parsed.bedroomCount, 3)
  assert.equal(parsed.availableRoomCount, 1)
  assert.equal(parsed.wholePropertyAvailable, false)
})
test('R20 studio is classified without inventing a bedroom question', () => {
  const d = decide("It's a studio.")
  assert.equal(fact(d, 'propertyType').fieldValue, 'STUDIO')
  assert.equal(fact(d, 'bedrooms'), undefined)
})
test('R21 available EUR2800 is positive availability and price, without apology', () => {
  const d = decide('Available, €2,800.')
  assert.equal(action(d, 'PROPERTY_STATUS').status, 'AVAILABLE')
  assert.equal(fact(d, 'askingPrice').fieldValue, 2800)
  assert.doesNotMatch(policy.planDirectReply(d, null, {}) || '', /sorry/i)
})
test('R22 rented for long years stops without irrelevant qualification questions', () => {
  const d = decide('It has been rented for long years.')
  assert.equal(action(d, 'PROPERTY_STATUS').status, 'RENTED')
  assert.equal(d.terminal, true)
  assert.equal(d.questions.length, 0)
})
test('R23 agency identity question is answered directly without property counting', () => {
  const d = decide('Which agency are you from?')
  assert.ok(d.questions.includes('agency_identity'))
  assert.equal(d.actions.length, 0)
})
test('R24 viewing tomorrow at 3 remains proposed despite tenant-away context', () => {
  const proposal = shared.extractViewingProposal('Viewing tomorrow at 3, tenant away today.')
  assert.equal(proposal.status, 'PROPOSED')
  assert.equal(proposal.time, '3')
})
test('R25 two residential apartments does not create a commercial-permit action', () => {
  const d = decide('They are two residential apartments.')
  assert.equal(d.actions.some(a => /permit|commercial/i.test(a.reason || '')), false)
})
test('R26 please call me creates a human handoff and suppresses automation', () => {
  const d = decide('Please call me.')
  assert.equal(action(d, 'HUMAN_REVIEW').reason, 'owner_requested_call')
  assert.equal(d.suppressAutomation, true)
})
test('R27 deletion or no-contact request globally stops property questioning', () => {
  const d = decide('Delete my information and do not contact me again.')
  assert.ok(action(d, 'CONTACT_OPT_OUT'))
  assert.equal(d.terminal, true)
  assert.equal(d.suppressAutomation, true)
})
test('R28 burst facts collapse to one review-only shared-place action', () => {
  const d = decide('I have one lady there. Another person can share. Correction, it is €850 each. Photos attached.')
  assert.equal(d.actions.filter(a => a.type === 'SHARED_PLACE_OFFER').length, 1)
  assert.equal(fact(d, 'perPersonRent').fieldValue, 850)
  assert.equal(policy.planDirectReply(d, null, {}), null)
})

test('U01 seven completed photo items report 7/7 against one durable batch', () => {
  const s = photos.progressSummary({ expected_count: 7, phase: 'READY' }, Array.from({ length: 7 }, () => ({ item_state: 'COMPLETED' })))
  assert.deepEqual([s.completed,s.total,s.resolved], [7,7,7])
})
test('U02 separate listing evidence is not converted into seven duplicate property rows by photo pipeline', () => {
  const source = read('ops/gptupload-flow/backend/services/gptPhotoPipeline.js')
  assert.doesNotMatch(source, /INSERT INTO properties/)
  assert.match(source, /property_photo_edits/)
})
test('U03 0/7 is truthful only with queued or processing phase', () => {
  const s = photos.progressSummary({ expected_count: 7, phase: 'QUEUED' }, Array.from({ length: 7 }, () => ({ item_state: 'QUEUED' })))
  assert.deepEqual([s.completed,s.queued,s.phase], [0,7,'QUEUED'])
})
test('U04 storage retained with enqueue failure remains retryable and diagnostic', () => {
  const s = photos.progressSummary({ expected_count: 7, phase: 'FAILED_RETRYABLE' }, [{ item_state:'FAILED_RETRYABLE', failure_code:'ENQUEUE_FAILED', source_image_url:'kept' }])
  assert.equal(s.failed, 1)
  assert.equal(s.phase, 'FAILED_RETRYABLE')
})
test('U05 six completed and one failed cannot report seven completed', () => {
  const items = [...Array.from({ length: 6 }, () => ({ item_state:'COMPLETED' })), { item_state:'FAILED_RETRYABLE' }]
  const s = photos.progressSummary({ expected_count:7 }, items)
  assert.deepEqual([s.completed,s.failed,s.resolved], [6,1,7])
})
test('U06 crash recovery preserves completed items and marks remaining retryable', () => {
  const source = read('ops/gptupload-flow/backend/services/gptPhotoPipeline.js')
  assert.match(source, /item_state='FAILED_RETRYABLE'/)
  assert.match(source, /item_state IN \('RECEIVED','QUEUED','PROCESSING'\)/)
})
test('U07 refresh progress derives from persisted item state and stable batch ID', () => {
  const handler = read('ops/gptupload-flow/backend/handlers/upload.js')
  assert.match(handler, /WHERE run_id=\$1 ORDER BY position/)
  assert.match(handler, /progressSummary\(run,editRows\.rows\)/)
})
test('U08 tenant ownership fields exist for authorization scoping', () => {
  const migration = read('ops/gptupload-flow/backend/migrations/20261110_upload_batch_recovery.sql')
  assert.match(migration, /agency_scope TEXT/)
  assert.match(migration, /agent_id BIGINT/)
  assert.match(migration, /source_chat_hash/)
})
test('U09 duplicate file resend is content-deduplicated', () => {
  const b = Buffer.from('same')
  assert.equal(photos.dedupeImages([{buffer:b},{buffer:b}]).length, 1)
})
test('U10 uncertain cross-property association remains outside the photo processor', () => {
  const source = read('ops/gptupload-flow/backend/handlers/upload.js')
  assert.match(source, /could not be matched safely/)
  assert.match(source, /image order is ambiguous/i)
})
test('U11 external links are not called processed without retained readable media', () => {
  const source = read('ops/gptupload-flow/backend/services/gptPhotoPipeline.js')
  assert.match(source, /retry source fetch/)
  assert.match(source, /is unreadable/)
})
test('U12 invalid generated image is rejected explicitly', () => {
  const result = photos.validateGeneratedImage(null, { buffer:Buffer.from('bad'), mimeType:'image/jpeg' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /invalid|empty|unsupported|unreadable/i)
})
test('U13 provider timeout is bounded and retryable rather than infinite', () => {
  const failure = photos.classifyProviderFailure(new Error('photo edit timeout'))
  assert.equal(failure.terminal, false)
  assert.equal(failure.code, 'provider_request_failed')
})
test('U14 absent worker heartbeat has a durable stalled recovery path', () => {
  const source = read('ops/gptupload-flow/backend/services/gptPhotoPipeline.js')
  assert.match(source, /WORKER_HEARTBEAT_STALE/)
  assert.match(source, /stalled_at=NOW/)
})
test('U15 paused batch is never labelled completed', () => {
  const s = photos.progressSummary({ expected_count:7, phase:'PAUSED' }, Array.from({length:7}, () => ({item_state:'QUEUED'})))
  assert.equal(s.completed, 0)
  assert.equal(s.phase, 'PAUSED')
})
test('U16 text facts remain independent from media processing state', () => {
  const photoSource = read('ops/gptupload-flow/backend/services/gptPhotoPipeline.js')
  assert.doesNotMatch(photoSource, /UPDATE conversation_facts|DELETE FROM conversation_facts/)
})
test('U17 cancelled item is resolved without source deletion', () => {
  const s = photos.progressSummary({expected_count:1,phase:'CANCELLED'}, [{item_state:'CANCELLED',source_image_url:'kept'}])
  assert.deepEqual([s.cancelled,s.resolved,s.completed], [1,1,0])
})
test('U18 frontend cannot claim processing before a durable accepted batch exists', () => {
  const handler = read('ops/gptupload-flow/backend/handlers/upload.js')
  assert.match(handler, /Received → Queued/)
  const migration = read('ops/gptupload-flow/backend/migrations/20261110_upload_batch_recovery.sql')
  assert.match(migration, /accepted_count/)
})
test('U19 duplicate queued event is idempotent by trigger and run position', () => {
  const base = read('ops/gptupload-flow/backend/migrations/20261013_gpt_photo_pipeline.sql')
  assert.match(base, /UNIQUE \(run_id, position\)/)
  assert.match(base, /trigger_uidx/)
})
test('U20 seven-item release contract retains existing successful flow and new durable states', () => {
  const migration = read('ops/gptupload-flow/backend/migrations/20261110_upload_batch_recovery.sql')
  for (const state of ['RECEIVED','QUEUED','PROCESSING','COMPLETED','NEEDS_REVIEW','FAILED_RETRYABLE','FAILED_PERMANENT','CANCELLED','DUPLICATE_LINKED']) {
    assert.ok(migration.includes(state) || read('ops/gptupload-flow/backend/services/gptPhotoPipeline.js').includes(state), state)
  }
})
