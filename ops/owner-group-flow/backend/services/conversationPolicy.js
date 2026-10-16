'use strict'

const { agencyAnswer, clientTypeAnswer } = require('./agentIdentityRegistry')

const FACT_STATUS = Object.freeze({
  KNOWN: 'KNOWN', UNKNOWN: 'UNKNOWN', CONFLICTING: 'CONFLICTING',
  CONDITIONAL: 'CONDITIONAL', SUPERSEDED: 'SUPERSEDED',
})
const OPERATIONAL_STATUS = Object.freeze({
  AVAILABLE: 'AVAILABLE', UPCOMING: 'UPCOMING', NOT_READY: 'NOT_READY',
  COMPLIANCE_PENDING: 'COMPLIANCE_PENDING', RENTED: 'RENTED', SOLD: 'SOLD',
  WITHDRAWN: 'WITHDRAWN', NEEDS_HUMAN_REVIEW: 'NEEDS_HUMAN_REVIEW',
})

const OPT_OUT_RE = /\b(stop (?:contacting|messaging|texting) me|don'?t (?:contact|message|text) me again|do not (?:contact|message|text) me|unsubscribe)\b/i
const PROPERTY_REMOVAL_RE = /\b(remove (?:it|the (?:property|place|listing))|take (?:it|the (?:property|place|listing)) off|remove me from the list)\b/i
const RENTED_RE = /\b(?:just\s+)?(?:been\s+)?rented\b|\balready rented\b|\bplace (?:is|has been) taken\b/i
const SOLD_RE = /\b(?:just\s+)?sold\b|\balready sold\b/i
const AGENCY_QUESTION_RE = /\b(which|what) (agency|company)|\bwho do you (?:work for|represent)|\bare you (?:an? )?(?:agent|freelancer)\b/i
const CLIENT_QUESTION_RE = /\bwhat (?:type|kind)s? of clients? (?:do )?you (?:have|work with)|\bwhich clients? (?:do )?you (?:have|work with)\b/i
const CONTACT_REASON_RE = /\bwhy (?:are|do) you (?:contacting|message|text|write)|\bwhat are you contacting me (?:about|for)\b/i
const CONTRACT_ONLY_RE = /\bcontract only\b|\bneed(?:s|ed)? (?:a )?contract only\b|\bpay(?:s|ing)? monthly for (?:the )?(?:contract|address|documents?)\b|\b(?:paper|document)[ -]?only lease\b/i
const COMPLIANCE_PENDING_RE = /\b(?:no|without|still (?:no|waiting for)) (?:building )?compliance\b|\bcompliance (?:is )?(?:pending|outstanding|not ready)\b/i

function cleanText(text) { return String(text || '').replace(/\s+/g, ' ').trim() }
function lower(text) { return cleanText(text).toLowerCase() }
function uniq(values) { return [...new Set((values || []).filter(Boolean))] }

function extractMoney(text) {
  const s = cleanText(text)
  const matches = [...s.matchAll(/(?:€|eur\s*)?([1-9]\d{2,4})(?:\s*(?:euro|eur))?/ig)]
    .map(m => Number(m[1])).filter(n => n >= 300 && n <= 50000)
  if (!matches.length) return null
  const correction = /\b(?:not|instead of|rather than|correction|actually)\b/i.test(s)
  // In "2100, not 2000" the first amount is the corrected value; in
  // "not 2000, it is 2100" the amount after the correction marker is.
  // Do not use a generic "last number wins" rule: it reverses the first form.
  const positiveThenRejected = s.match(/(?:€|eur\s*)?([1-9]\d{2,4})\s*(?:euro|eur)?\s*[,;:-]?\s*not\s+(?:€|eur\s*)?([1-9]\d{2,4})/i)
  const rejectedThenPositive = s.match(/not\s+(?:€|eur\s*)?([1-9]\d{2,4}).{0,40}?(?:actually|now|is|should be|but)\s*(?:€|eur\s*)?([1-9]\d{2,4})/i)
  const value = positiveThenRejected ? Number(positiveThenRejected[1])
    : rejectedThenPositive ? Number(rejectedThenPositive[2])
    : correction ? matches[matches.length - 1] : matches[0]
  return { value, correction, mentioned: matches }
}

function extractAddress(text) {
  const s = cleanText(text)
  if (!s || s.length > 240) return null
  const labelled = s.match(/(?:full\s+)?address\s*(?:is|:|-)?\s*(.+)$/i)
  if (labelled?.[1] && /\b(?:street|road|triq|sqaq|avenue|court|block|flat|apartment|residence|zabbar|sliema|swieqi|ibragg|st\.? julian|mqabba)\b/i.test(labelled[1])) return labelled[1].trim()
  if (/\b(?:triq|sqaq|street|road|avenue|court)\b/i.test(s) && /\d|\b(?:flat|block|apartment)\b/i.test(s)) return s
  return null
}

function extractTentativeWindow(text) {
  const s = lower(text)
  const months = [...s.matchAll(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/g)].map(m => m[1])
  if (!months.length) return null
  const tentative = /\b(hopefully|probably|maybe|around|tentative|expect|should be|almost ready)\b/.test(s) || months.length > 1
  return { label: uniq(months).join('/'), tentative }
}

function extractLocalityCorrection(text) {
  const places = "St\\.? Julian'?s|Sliema|Swieqi|Ibragg|Ta Ibragg|Mqabba|Mosta|Gzira|Gżira|Valletta|Zabbar|Żabbar|Madliena|Pembroke"
  const hit = cleanText(text).match(new RegExp(`\\bin\\s+(${places})\\s*[,;:-]?\\s*not\\s+(${places})\\b`, 'i'))
  return hit ? { value: hit[1], supersedes: hit[2] } : null
}

function makeFact(fieldName, fieldValue, opts = {}) {
  return {
    fieldName, fieldValue,
    factStatus: opts.factStatus || FACT_STATUS.KNOWN,
    confidence: opts.confidence == null ? 1 : opts.confidence,
    correction: !!opts.correction,
    negative: !!opts.negative,
    evidence: opts.evidence || null,
  }
}

function interpretInbound(input = {}) {
  const text = cleanText(input.text)
  const s = text.toLowerCase()
  const context = input.context || {}
  const facts = []
  const actions = []
  const questions = []
  let terminal = false
  let suppressAutomation = false
  let complianceReview = false

  if (AGENCY_QUESTION_RE.test(text)) questions.push('agency_identity')
  if (CLIENT_QUESTION_RE.test(text)) questions.push('client_types')
  if (CONTACT_REASON_RE.test(text)) questions.push('contact_reason')

  const globalOptOut = OPT_OUT_RE.test(text)
  const rented = RENTED_RE.test(text)
  const sold = SOLD_RE.test(text)
  const propertyRemoval = PROPERTY_REMOVAL_RE.test(text)
  const replyNone = /^none[.!\s]*$/i.test(text)
  const referencedPropertyIds = uniq(context.referencedPropertyIds)

  if (globalOptOut) {
    actions.push({ type: 'CONTACT_OPT_OUT', scope: 'CONTACT', reason: text })
    terminal = true
    suppressAutomation = true
  }
  if (rented || sold || propertyRemoval) {
    if (referencedPropertyIds.length) {
      actions.push({
        type: 'PROPERTY_STATUS', scope: 'PROPERTY',
        status: sold ? OPERATIONAL_STATUS.SOLD : rented ? OPERATIONAL_STATUS.RENTED : OPERATIONAL_STATUS.WITHDRAWN,
        propertyIds: referencedPropertyIds,
        reason: text,
      })
    } else {
      actions.push({ type: 'HUMAN_REVIEW', status: OPERATIONAL_STATUS.NEEDS_HUMAN_REVIEW, reason: 'ambiguous_property_status' })
    }
    terminal = true
    suppressAutomation = true
  }
  if (replyNone && context.lastQuestionType === 'numbered_availability' && referencedPropertyIds.length) {
    actions.push({ type: 'PROPERTY_STATUS', scope: 'REFERENCED_PROPERTIES', status: OPERATIONAL_STATUS.WITHDRAWN, propertyIds: referencedPropertyIds, reason: text })
    terminal = true
    suppressAutomation = true
  }

  if (/\bno pets?\b|\bpets? (?:are )?not allowed\b/i.test(text)) facts.push(makeFact('petsAllowed', false, { negative: true, evidence: text }))
  if (/\bno sharing\b|\b(?:don'?t|do not|won'?t|will not) (?:allow|accept|consider) sharing\b/i.test(text)) facts.push(makeFact('sharingAllowed', false, { negative: true, evidence: text }))
  if (/\b(?:only )?famil(?:y|ies)(?: or close friends?)?\b|\bclose friends?\b/i.test(text)) facts.push(makeFact('occupancyRestriction', /close friends?/i.test(text) ? 'family_or_close_friends' : 'families_only', { evidence: text }))
  if (/\bno (?:company )?subletting\b|\b(?:don'?t|do not|won'?t|will not) (?:allow|accept|consider) (?:company )?subletting\b|\bcompany (?:cannot|can'?t|may not) sublet\b/i.test(text)) facts.push(makeFact('companySubletting', false, { negative: true, evidence: text }))
  if (/\bno compan(?:y|ies)\b/i.test(text)) facts.push(makeFact('companiesAllowed', false, { negative: true, evidence: text }))

  const money = extractMoney(text)
  if (money) {
    facts.push(makeFact('askingPrice', money.value, { correction: money.correction, evidence: text }))
    if (/\bnegotiable\b/i.test(text) && !/\bnot\s+\d{3,5}\s+negotiable\b/i.test(text)) facts.push(makeFact('priceNegotiable', true, { evidence: text }))
    else if (money.correction) facts.push(makeFact('priceNegotiable', null, { factStatus: FACT_STATUS.UNKNOWN, correction: true, evidence: text }))
  }

  const address = extractAddress(text)
  if (address) facts.push(makeFact('address', address, { confidence: 0.95, evidence: text }))

  const localityCorrection = extractLocalityCorrection(text)
  if (localityCorrection) facts.push(makeFact('locality', localityCorrection.value, { correction: true, evidence: text }))

  if (CONTRACT_ONLY_RE.test(text)) {
    facts.push(makeFact('specialLeaseScenario', 'contract_only_or_non_occupancy', { factStatus: FACT_STATUS.CONDITIONAL, confidence: 0.9, evidence: text }))
    actions.push({ type: 'HUMAN_COMPLIANCE_REVIEW', status: OPERATIONAL_STATUS.NEEDS_HUMAN_REVIEW, reason: text })
    complianceReview = true
    suppressAutomation = true
  }

  const window = extractTentativeWindow(text)
  if (/\balmost ready\b|\bnot ready\b/i.test(text)) {
    facts.push(makeFact('availabilityStatus', OPERATIONAL_STATUS.NOT_READY, { evidence: text }))
    facts.push(makeFact('confirmedBookable', false, { negative: true, evidence: text }))
  }
  if (COMPLIANCE_PENDING_RE.test(text)) {
    facts.push(makeFact('complianceStatus', OPERATIONAL_STATUS.COMPLIANCE_PENDING, { evidence: text }))
    facts.push(makeFact('confirmedBookable', false, { negative: true, evidence: text }))
    suppressAutomation = true
  }
  if (window) facts.push(makeFact('availabilityFrom', window.label, { factStatus: window.tentative ? FACT_STATUS.CONDITIONAL : FACT_STATUS.KNOWN, confidence: window.tentative ? 0.65 : 0.95, evidence: text }))

  if (/\bnew property\b/i.test(text)) facts.push(makeFact('listingCondition', 'new', { evidence: text }))
  const beds = s.match(/\b(\d+)\s*(?:bed|bedroom)s?\b/)
  const baths = s.match(/\b(\d+)\s*(?:bath|bathroom)s?\b/)
  if (beds) facts.push(makeFact('bedrooms', Number(beds[1]), { evidence: text }))
  if (baths) facts.push(makeFact('bathrooms', Number(baths[1]), { evidence: text }))
  if (!localityCorrection && /\bmqabba\b/i.test(text)) facts.push(makeFact('locality', 'Mqabba', { evidence: text }))

  if (/^(no|none|yes|yeah|yep)[.!\s]*$/i.test(text) && context.lastAskedField) {
    const negative = /^(no|none)/i.test(text)
    facts.push(makeFact(context.lastAskedField, !negative, { negative, evidence: text }))
  }

  const priority = actions.some(a => a.type === 'CONTACT_OPT_OUT' || a.type === 'PROPERTY_STATUS') ? 1
    : questions.length ? 2
    : facts.some(f => f.correction) ? 3
    : facts.some(f => f.negative) ? 4
    : facts.length ? 5 : 6

  return { text, priority, facts, actions, questions, terminal, suppressAutomation, complianceReview, edited: !!input.edited }
}

function activeFactMap(facts = []) {
  const map = new Map()
  for (const fact of facts) {
    if (fact.factStatus === FACT_STATUS.SUPERSEDED) continue
    map.set(fact.fieldName, fact)
  }
  return map
}

function applyDecision(state = {}, decision, meta = {}) {
  const next = JSON.parse(JSON.stringify(state || {}))
  next.facts = Array.isArray(next.facts) ? next.facts : []
  next.properties = next.properties || {}
  next.conversationVersion = Number(next.conversationVersion || 0) + 1
  next.lastIncomingMessageId = meta.sourceMessageId || null
  next.lastIncomingAt = meta.sourceTimestamp || new Date().toISOString()
  const effectiveAt = meta.effectiveTimestamp || next.lastIncomingAt

  for (const incoming of decision.facts) {
    const current = next.facts.filter(f => f.fieldName === incoming.fieldName && f.factStatus !== FACT_STATUS.SUPERSEDED).sort((a, b) => String(b.effectiveTimestamp || '').localeCompare(String(a.effectiveTimestamp || '')))[0]
    if (current) {
      current.factStatus = FACT_STATUS.SUPERSEDED
      current.supersededBy = meta.sourceMessageId || `version:${next.conversationVersion}`
    }
    next.facts.push({
      entityId: meta.entityId || next.entityId || null,
      propertyId: meta.propertyId || null,
      senderAccountId: meta.senderAccountId || null,
      fieldName: incoming.fieldName,
      fieldValue: incoming.fieldValue,
      factStatus: incoming.factStatus,
      sourceMessageId: meta.sourceMessageId || null,
      sourceTimestamp: meta.sourceTimestamp || null,
      confidence: incoming.confidence,
      effectiveTimestamp: effectiveAt,
      supersededBy: null,
      lastConfirmedAt: incoming.factStatus === FACT_STATUS.KNOWN ? effectiveAt : null,
      evidence: incoming.evidence,
    })
  }

  for (const action of decision.actions) {
    if (action.type === 'CONTACT_OPT_OUT') next.contactOptOut = true
    if (action.type === 'HUMAN_COMPLIANCE_REVIEW') next.humanComplianceReview = true
    if (action.type === 'PROPERTY_STATUS') {
      for (const id of action.propertyIds || []) next.properties[id] = { ...(next.properties[id] || {}), status: action.status, updatedAt: effectiveAt }
    }
  }
  return next
}

function planDirectReply(decision, identity, state = {}) {
  if (decision.actions.some(a => a.type === 'CONTACT_OPT_OUT')) return 'Understood. I will not contact you again.'
  if (decision.actions.some(a => a.type === 'PROPERTY_STATUS' && a.propertyIds?.length)) return "Thanks for letting me know. I've updated our records and removed the property from our available listings."
  if (decision.complianceReview) return null
  if (decision.questions.includes('agency_identity')) return agencyAnswer(identity)
  if (decision.questions.includes('client_types')) return clientTypeAnswer(identity)
  if (decision.questions.includes('contact_reason')) return "I'm contacting you to check the property's current availability for suitable long-term rental clients."
  if (decision.facts.some(f => ['petsAllowed', 'sharingAllowed', 'companySubletting', 'occupancyRestriction'].includes(f.fieldName))) return "Understood, thank you. I'll only consider suitable tenants who meet those conditions."
  return null
}

function draftAsksField(draft, field) {
  const d = lower(draft)
  const rules = {
    address: /\b(address|map pin|location)\b.*\?|\bcan you (?:send|confirm).*(?:address|location)/,
    sharingAllowed: /\b(sharing|share the apartment)\b.*\?/,
    companySubletting: /\b(company|sublett)\b.*\?/,
    petsAllowed: /\bpets?\b.*\?/,
    askingPrice: /\b(price|rent|per month)\b.*\?/,
  }
  return !!rules[field]?.test(d)
}

function validateDraft({ draft, state = {}, identity = null, expectedConversationVersion = null } = {}) {
  const text = cleanText(draft)
  if (!text) return { allow: false, reason: 'empty_draft' }
  if ((text.match(/\?/g) || []).length > 1) return { allow: false, reason: 'multiple_substantive_questions' }
  if (expectedConversationVersion != null && Number(expectedConversationVersion) !== Number(state.conversationVersion || 0)) return { allow: false, reason: 'stale_conversation_version' }
  if (state.contactOptOut) return { allow: false, reason: 'contact_opt_out' }
  if (state.humanActive) return { allow: false, reason: 'human_operator_active' }
  if (state.humanComplianceReview && /\b(offer|market|client|passport|residen|contract)\b/i.test(text)) return { allow: false, reason: 'compliance_review_required' }
  const facts = activeFactMap(state.facts)
  for (const field of ['address', 'sharingAllowed', 'companySubletting', 'petsAllowed', 'askingPrice']) {
    if (facts.has(field) && draftAsksField(text, field)) return { allow: false, reason: `known_field_reasked:${field}` }
  }
  if (facts.get('sharingAllowed')?.fieldValue === false && /\bconsider sharing|sharing.*(?:possible|option)|professional sharing\b/i.test(text)) return { allow: false, reason: 'sharing_refusal_conflict' }
  if (facts.get('companySubletting')?.fieldValue === false && /\bsublett|company lease\b/i.test(text)) return { allow: false, reason: 'subletting_refusal_conflict' }
  if (facts.get('askingPrice')) {
    const price = extractMoney(text)
    if (price && price.value !== Number(facts.get('askingPrice').fieldValue)) return { allow: false, reason: 'outdated_price' }
  }
  if (facts.get('confirmedBookable')?.fieldValue === false && /\bavailable now|ready to (?:view|occupy|move)|immediately available\b/i.test(text)) return { allow: false, reason: 'tentative_treated_as_confirmed' }
  if (/\bpassport clients?\b|\bfalse address\b|\bsham lease\b/i.test(text)) return { allow: false, reason: 'unauthorized_document_only_transaction' }
  if (/\b(?:i am|i'm|we are|we're) (?:with|from)\b/i.test(text) && identity) {
    const agency = String(identity.agency || '').toLowerCase()
    if (agency && !lower(text).includes(agency)) return { allow: false, reason: 'sender_identity_mismatch' }
  }
  return { allow: true, reason: null }
}

module.exports = {
  FACT_STATUS, OPERATIONAL_STATUS, interpretInbound, applyDecision,
  planDirectReply, validateDraft, extractMoney, extractAddress, activeFactMap,
}
