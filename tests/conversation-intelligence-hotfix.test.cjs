'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  FACT_STATUS, OPERATIONAL_STATUS, interpretInbound, applyDecision,
  planDirectReply, validateDraft, activeFactMap, extractMoney,
} = require('../ops/owner-group-flow/backend/services/conversationPolicy')
const { resolveAgentIdentity, agencyAnswer } = require('../ops/owner-group-flow/backend/services/agentIdentityRegistry')
const crypto = require('crypto')

const ctx = (ids=['p1'], extra={}) => ({ context: { referencedPropertyIds: ids, ...extra } })
const stateWith = (facts, extra={}) => ({ conversationVersion: 4, facts, ...extra })
const fact = (fieldName, fieldValue, factStatus=FACT_STATUS.KNOWN) => ({ fieldName, fieldValue, factStatus })

test('01 rented/remove is property-scoped and suppresses queued automation', () => {
  const d = interpretInbound({ text: 'It has been rented, remove me from the list', ...ctx(['p9']) })
  assert.equal(d.actions[0].type, 'PROPERTY_STATUS')
  assert.equal(d.actions[0].status, OPERATIONAL_STATUS.RENTED)
  assert.deepEqual(d.actions[0].propertyIds, ['p9'])
  assert.equal(d.actions.some(a => a.type === 'CONTACT_OPT_OUT'), false)
  assert.equal(d.suppressAutomation, true)
})

test('02 None after numbered availability only withdraws referenced properties', () => {
  const d = interpretInbound({ text: 'None', ...ctx(['p1','p3'], { lastQuestionType: 'numbered_availability' }) })
  assert.deepEqual(d.actions[0].propertyIds, ['p1','p3'])
  assert.equal(d.actions[0].scope, 'REFERENCED_PROPERTIES')
  const productionPath = fs.readFileSync(path.join(__dirname, '../ops/owner-group-flow/backend/services/ownerPortfolioCheck.js'), 'utf8')
  assert.match(productionPath, /WHERE id=ANY\(\$1::int\[\]\)/)
  assert.match(productionPath, /operational_status='WITHDRAWN'/)
  assert.doesNotMatch(productionPath, /UPDATE properties SET available_status='not_available' WHERE owner_id/)
})

test('03 owner-reported address becomes known and is not re-asked', () => {
  const d = interpretInbound({ text: 'Full address: Flat 3, Winter Court, Sqaq Burzett, Zabbar', ...ctx() })
  const next = applyDecision({}, d, { sourceMessageId: 'm-address', propertyId: 'p1' })
  assert.equal(activeFactMap(next.facts).get('address').factStatus, FACT_STATUS.KNOWN)
  assert.equal(validateDraft({ draft: 'Can you send the full address?', state: next }).reason, 'known_field_reasked:address')
})

test('04 price correction keeps EUR 2100, supersedes old price, resets negotiability', () => {
  const old = applyDecision({}, { facts: [fact('askingPrice',2000),fact('priceNegotiable',true)], actions: [] }, { sourceMessageId:'m1' })
  const d = interpretInbound({ text: 'Price is €2100, not €2000', ...ctx() })
  assert.equal(extractMoney(d.text).value, 2100)
  const next = applyDecision(old, d, { sourceMessageId:'m2' })
  assert.equal(activeFactMap(next.facts).get('askingPrice').fieldValue, 2100)
  assert.equal(activeFactMap(next.facts).get('priceNegotiable').factStatus, FACT_STATUS.UNKNOWN)
  assert.equal(next.facts.find(f => f.fieldName==='askingPrice' && f.fieldValue===2000).factStatus, FACT_STATUS.SUPERSEDED)
})

test('05 owner says no sharing: no repeated sharing question', () => {
  const d = interpretInbound({ text: 'Only families or close friends, no sharing', ...ctx() })
  const next = applyDecision({}, d, { sourceMessageId:'m-sharing' })
  assert.equal(activeFactMap(next.facts).get('sharingAllowed').fieldValue, false)
  assert.equal(activeFactMap(next.facts).get('occupancyRestriction').fieldValue, 'family_or_close_friends')
  assert.match(validateDraft({ draft:'Would you consider professional sharing?', state:next }).reason, /sharing/)
})

test('06 owner explicitly refuses company subletting: no more follow-ups', () => {
  const d = interpretInbound({ text:'No company subletting', ...ctx() })
  const next = applyDecision({}, d, { sourceMessageId:'m-sublet' })
  assert.equal(activeFactMap(next.facts).get('companySubletting').fieldValue, false)
  assert.equal(validateDraft({ draft:'Could a company sublet it?', state:next }).reason, 'known_field_reasked:companySubletting')
})

test('07 agency question receives the correct account-scoped identity', () => {
  const d = interpretInbound({ text:'Which agency do you represent?', ...ctx() })
  assert.match(planDirectReply(d, resolveAgentIdentity('default')), /Kevin.*2906.*Independent Real Estate Agent.*four years/i)
  assert.match(planDirectReply(d, resolveAgentIdentity('cedric')), /Cedric.*QuickLets/i)
  assert.match(planDirectReply(d, resolveAgentIdentity('gabriella')), /Gabriella.*Sotheby's/i)
  assert.equal(resolveAgentIdentity('unconfigured-account'), null)
})

test('08 client-type question is answered before field collection', () => {
  const d = interpretInbound({ text:'What type of clients do you have? New 2 bedroom in Mqabba.', ...ctx() })
  assert.equal(d.priority, 2)
  assert.match(planDirectReply(d, resolveAgentIdentity('default')), /clients looking for long-term rentals/i)
})

test('09 outstanding compliance and tentative readiness are never advertised as ready', () => {
  const d = interpretInbound({ text:'Almost ready but still no compliance of building. Hopefully November or December. New 2 bedroom 2 bathroom in Mqabba, expected rent EUR 1400.', ...ctx() })
  const next = applyDecision({}, d, { sourceMessageId:'m-mqabba' })
  const fields = activeFactMap(next.facts)
  assert.equal(fields.get('confirmedBookable').fieldValue, false)
  assert.equal(fields.get('availabilityFrom').factStatus, FACT_STATUS.CONDITIONAL)
  assert.equal(validateDraft({ draft:'It is immediately available and ready to occupy.', state:next }).reason, 'tentative_treated_as_confirmed')
})

test('10 contract-only arrangement requires human compliance review and blocks matching', () => {
  const d = interpretInbound({ text:'Someone who needs a contract only and pays monthly for it', ...ctx() })
  assert.equal(d.actions.some(a=>a.type==='HUMAN_COMPLIANCE_REVIEW'), true)
  const next = applyDecision({}, d, { sourceMessageId:'m-contract' })
  assert.equal(validateDraft({ draft:'We can offer this to passport clients.', state:next }).allow, false)
})

test('11 operator replies manually: bot yields to human activity', () => {
  assert.equal(validateDraft({ draft:'Hello', state:stateWith([], {humanActive:true}), expectedConversationVersion:4 }).reason, 'human_operator_active')
})

test('12 correction arriving while a question is queued invalidates the stale draft', () => {
  const before = stateWith([fact('askingPrice',2000)], {})
  const corrected = applyDecision(before, interpretInbound({ text:'Actually EUR 2100, not EUR 2000', ...ctx() }), { sourceMessageId:'m-new' })
  assert.equal(corrected.conversationVersion, 5)
  assert.equal(validateDraft({ draft:'Is the rent still EUR 2000?', state:corrected, expectedConversationVersion:4 }).reason, 'stale_conversation_version')
})

test('13 edited WhatsApp message revises facts without a duplicate outgoing answer', () => {
  const first = applyDecision({}, interpretInbound({ text:'Price is €2000', ...ctx() }), { sourceMessageId:'same-message' })
  const second = applyDecision(first, interpretInbound({ text:'Actually price is €2100', edited:true, ...ctx() }), { sourceMessageId:'same-message' })
  assert.equal(activeFactMap(second.facts).get('askingPrice').fieldValue, 2100)
  assert.equal(second.facts.filter(f=>f.fieldName==='askingPrice' && f.factStatus===FACT_STATUS.KNOWN).length, 1)
  const replyA = planDirectReply(interpretInbound({ text:'Which agency?', ...ctx() }), resolveAgentIdentity('default'))
  const replyB = planDirectReply(interpretInbound({ text:'Which agency?', edited:true, ...ctx() }), resolveAgentIdentity('default'))
  assert.equal(replyA, replyB)
  const key = (reply) => crypto.createHash('sha256').update(`state-1:same-message:${reply}`).digest('hex')
  assert.equal(key(replyA), key(replyB))
})
