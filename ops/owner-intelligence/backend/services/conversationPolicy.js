'use strict'

const { agencyAnswer, clientTypeAnswer } = require('./agentIdentityRegistry')
const { parseSharedAccommodation } = require('./sharedAccommodation')

const FACT_STATUS = Object.freeze({
  KNOWN: 'KNOWN', UNKNOWN: 'UNKNOWN', CONFLICTING: 'CONFLICTING',
  CONDITIONAL: 'CONDITIONAL', SUPERSEDED: 'SUPERSEDED',
})
const OPERATIONAL_STATUS = Object.freeze({
  AVAILABLE: 'AVAILABLE', UPCOMING: 'UPCOMING', NOT_READY: 'NOT_READY',
  COMPLIANCE_PENDING: 'COMPLIANCE_PENDING', RENTED: 'RENTED', SOLD: 'SOLD',
  WITHDRAWN: 'WITHDRAWN', VIEWING_PAUSED: 'VIEWING_PAUSED',
  NEEDS_HUMAN_REVIEW: 'NEEDS_HUMAN_REVIEW',
})

const OPT_OUT_RE = /\b(stop (?:contacting|messaging|texting) me|don'?t (?:contact|message|text) me again|do not (?:contact|message|text) me|unsubscribe)\b/i
const PROPERTY_REMOVAL_RE = /\b(remove (?:it|the (?:property|place|listing))|take (?:it|the (?:property|place|listing)) off|remove me from the list)\b/i
const RENTED_RE = /\b(?:just\s+)?(?:been\s+)?rented\b|\balready rented\b|\bplace (?:is|has been) taken\b/i
const SOLD_RE = /\b(?:just\s+)?sold\b|\balready sold\b/i
const HISTORICAL_RE = /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+years?\s+ago\b|\b(?:previously|formerly|back then|used to be|when (?:it|the (?:flat|apartment|property|place)) (?:was|had been|got) (?:finished|completed|built|renovated))\b/i
const CURRENT_AVAILABLE_RE = /\b(?:is|are)\s+(?:still\s+|currently\s+|now\s+)?available\b|\b(?:remains?|still|currently|now)\s+(?:both\s+|all\s+)?available\b|\b(?:studio|apartment|flat|unit|number\s*(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)|no\.?\s*\d+)\b.{0,45}\bavailable\b|^\s*available\b/i
const FUTURE_AVAILABLE_RE = /\bavailable\s+(?:again\s+)?from\b/i
const VIEWING_ONLY_RE = /\bnot\s+available\s+for\s+viewings?\b|\bviewings?\s+(?:are\s+)?(?:not\s+possible|paused|unavailable)\b/i
const REFURBISHMENT_RE = /\b(?:currently\s+)?(?:being\s+)?(?:refurbished|renovated|painted|cleaned)\b|\b(?:painting|cleaning|refurbishment|renovation)\s+(?:is\s+)?(?:ongoing|in progress|pending)\b/i
const PHOTOS_PENDING_RE = /\b(?:new\s+)?photos?\s+(?:will be|to be|are being)\s+(?:taken|made|done)\b|\bphotos?\s+(?:after|once|when)\b/i
const TENANT_MOVED_OUT_RE = /\b(?:the\s+)?tenant\s+(?:has\s+)?moved\s+out\b/i
const PROTECTED_PREFERENCE_RE = /\b(?:no|not|won'?t accept|do not accept|only)\s+(?:[a-z]+\s+){0,3}(?:nationalit(?:y|ies)|ethnic(?:ity|ities)|race|racial|africans?|arabs?|asians?|indians?|pakistanis?|maltese|italians?|british|germans?|french|russians?|ukrainians?)\b/i
// Kev, 2026-10-22: one shared detector (agentIdentityRegistry) for both
// conversation paths; this local copy missed "name of your agency" etc.
const { AGENCY_QUESTION_RE, EMAIL_QUESTION_RE, emailAnswer, unapprovedEmails } = require('./agentIdentityRegistry')
const CLIENT_QUESTION_RE = /\bwhat (?:type|kind)s? of clients? (?:do )?you (?:have|work with)|\bwhich clients? (?:do )?you (?:have|work with)\b/i
const CONTACT_REASON_RE = /\bwhy (?:are|do) you (?:contacting|message|text|write)|\bwhat are you contacting me (?:about|for)\b/i
const CONTRACT_ONLY_RE = /\bcontract only\b|\bneed(?:s|ed)? (?:a )?contract only\b|\bpay(?:s|ing)? monthly for (?:the )?(?:contract|address|documents?)\b|\b(?:paper|document)[ -]?only lease\b/i
const COMPLIANCE_PENDING_RE = /\b(?:no|without|still (?:no|waiting for)) (?:building )?compliance\b|\bcompliance (?:is )?(?:pending|outstanding|not ready)\b/i

function cleanText(text) { return String(text || '').replace(/\s+/g, ' ').trim() }
function lower(text) { return cleanText(text).toLowerCase() }
function uniq(values) { return [...new Set((values || []).filter(Boolean))] }

function extractMoney(text) {
  const s = cleanText(text)
  const amount = /(?:€|eur\s*)?([1-9](?:\d{2,4}|\d{0,2}(?:,|\s)\d{3}))(?:\s*(?:euro|eur))?/ig
  const matches = [...s.matchAll(amount)]
    .map(m => Number(m[1].replace(/[,\s]/g, ''))).filter(n => n >= 300 && n <= 50000)
  if (!matches.length) return null
  const correction = /\b(?:not|instead of|rather than|correction|actually)\b/i.test(s)
  // In "2100, not 2000" the first amount is the corrected value; in
  // "not 2000, it is 2100" the amount after the correction marker is.
  // Do not use a generic "last number wins" rule: it reverses the first form.
  const positiveThenRejected = s.match(/(?:€|eur\s*)?([1-9][\d,\s]{2,6})\s*(?:euro|eur)?\s*[,;:-]?\s*not\s+(?:€|eur\s*)?([1-9][\d,\s]{2,6})/i)
  const rejectedThenPositive = s.match(/not\s+(?:€|eur\s*)?([1-9][\d,\s]{2,6}).{0,40}?(?:actually|now|is|should be|but)\s*(?:€|eur\s*)?([1-9][\d,\s]{2,6})/i)
  const value = positiveThenRejected ? Number(positiveThenRejected[1].replace(/[,\s]/g, ''))
    : rejectedThenPositive ? Number(rejectedThenPositive[2].replace(/[,\s]/g, ''))
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
    propertyIds: uniq(opts.propertyIds),
    restricted: !!opts.restricted,
  }
}

function propertyNumber(p) {
  const candidates = [p.apt, p.unit_number, p.unitNumber, p.floor_unit]
  for (const value of candidates) {
    const hit = String(value || '').match(/\b(\d{1,3})\b/)
    if (hit) return Number(hit[1])
  }
  return null
}

function propertyFloor(p) {
  const raw = String(p.floor_level ?? p.floor ?? '').toLowerCase().trim()
  const words = { ground: 0, first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 }
  if (Object.prototype.hasOwnProperty.call(words, raw)) return words[raw]
  const hit = raw.match(/\d{1,2}/)
  return hit ? Number(hit[0]) : null
}

function unitSelector(text, properties = []) {
  const s = lower(text)
  let candidates = properties.slice()
  let constrained = false
  const explicitRefs = candidates.filter(p => {
    const ref = String(p.ref || '')
    const suffix = ref.replace(/^2906-/i, '')
    return (ref && new RegExp(`\\b${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text))
      || (suffix && new RegExp(`\\b${suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text))
  })
  if (explicitRefs.length) return { ids: explicitRefs.map(p => p.id), reason: 'explicit_reference', constrained: true }

  if (/\bstudio\b/i.test(text)) {
    candidates = candidates.filter(p => /\bstudio\b/i.test(String(p.property_type || p.type || '')) || Number(p.bedrooms) === 0)
    constrained = true
  }
  const bed = s.match(/\b(?:one|1)[ -]?beds?\b|\b1\s*(?:bed|bedroom)s?\b/)
  if (bed) {
    candidates = candidates.filter(p => Number(p.bedrooms) === 1)
    constrained = true
  }
  const floorWords = { ground: 0, first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 }
  const floorHit = s.match(/\b(ground|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d{1,2}(?:st|nd|rd|th)?)\s+floor\b/)
  if (floorHit) {
    const floor = floorWords[floorHit[1]] ?? Number(floorHit[1].replace(/\D/g, ''))
    candidates = candidates.filter(p => propertyFloor(p) === floor)
    constrained = true
  }
  const numberHit = s.match(/\b(?:number|no\.?|unit|apartment|flat)\s*#?\s*(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten)\b/)
  if (numberHit) {
    const numberWords = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10 }
    const number = numberWords[numberHit[1]] ?? Number(numberHit[1])
    candidates = candidates.filter(p => propertyNumber(p) === number)
    constrained = true
  }
  return { ids: candidates.map(p => p.id), reason: constrained ? 'unit_descriptor' : 'conversation_context', constrained }
}

function addReview(actions, reason, text, details = {}) {
  actions.push({
    type: 'HUMAN_REVIEW', status: OPERATIONAL_STATUS.NEEDS_HUMAN_REVIEW,
    reason, evidence: text, details,
  })
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
  if (EMAIL_QUESTION_RE.test(text)) questions.push('email_request')

  const globalOptOut = OPT_OUT_RE.test(text) || require('./ownerOptOut').isOptOut(text)
  const rented = RENTED_RE.test(text)
  const sold = SOLD_RE.test(text)
  const propertyRemoval = PROPERTY_REMOVAL_RE.test(text)
  const replyNone = /^none[.!\s]*$/i.test(text)
  const referencedPropertyIds = uniq(context.referencedPropertyIds)
  const properties = Array.isArray(context.properties) ? context.properties : []
  const historical = HISTORICAL_RE.test(text)
  const viewingOnly = VIEWING_ONLY_RE.test(text)
  const currentAvailable = !viewingOnly && CURRENT_AVAILABLE_RE.test(text)
  const futureAvailable = FUTURE_AVAILABLE_RE.test(text)
  // Unit descriptors remain useful even when the owner did not quote a
  // listing reference. An unconstrained status statement, however, must
  // remain inside the already-resolved conversation context so a bare
  // "rented" can never mutate the owner's whole portfolio.
  const referencedProperties = properties.filter(p => referencedPropertyIds.includes(p.id))
  const selector = unitSelector(text, referencedProperties.length ? referencedProperties : properties)
  const selectedIds = uniq(selector.constrained ? selector.ids : referencedPropertyIds)
  const shared = parseSharedAccommodation(text)

  if (globalOptOut) {
    actions.push({ type: 'CONTACT_OPT_OUT', scope: 'CONTACT', reason: text })
    terminal = true
    suppressAutomation = true
  }
  if (shared.isOffer) {
    const sharedDetails = {
      occupancyState: shared.occupancyState,
      wholePropertyAvailable: false,
      availablePlaceCount: shared.availablePlaceCount,
      availableRoomCount: shared.availableRoomCount,
      occupiedPersonCount: shared.occupiedPersonCount,
      perPersonRent: shared.perPersonRent,
      wholePropertyTotalRent: shared.wholePropertyTotalRent,
      availableFrom: shared.availableFrom,
      viewingInvited: shared.viewingInvited,
      viewingProposal: shared.viewingProposal,
      protectedPreference: shared.protectedPreference,
    }
    facts.push(makeFact('occupancyState', shared.occupancyState || 'SHARED_OCCUPANCY_UNKNOWN', { evidence: text, propertyIds: selectedIds }))
    facts.push(makeFact('wholePropertyAvailable', false, { negative: true, evidence: text, propertyIds: selectedIds }))
    facts.push(makeFact('sharingAllowed', true, { evidence: text, propertyIds: selectedIds }))
    if (shared.availablePlaceCount != null) facts.push(makeFact('availablePlaceCount', shared.availablePlaceCount, { evidence: text, propertyIds: selectedIds }))
    if (shared.availableRoomCount != null) facts.push(makeFact('availableRoomCount', shared.availableRoomCount, { evidence: text, propertyIds: selectedIds }))
    if (shared.occupiedPersonCount != null) facts.push(makeFact('occupiedPersonCount', shared.occupiedPersonCount, { evidence: text, propertyIds: selectedIds }))
    if (shared.perPersonRent != null) facts.push(makeFact('perPersonRent', shared.perPersonRent, { evidence: text, propertyIds: selectedIds }))
    if (shared.wholePropertyTotalRent != null) facts.push(makeFact('wholePropertyTotalRent', shared.wholePropertyTotalRent, { evidence: text, propertyIds: selectedIds }))
    if (shared.availableFrom) facts.push(makeFact('availableFrom', shared.availableFrom, { factStatus: FACT_STATUS.CONDITIONAL, confidence: 0.9, evidence: text, propertyIds: selectedIds }))
    if (shared.viewingInvited) facts.push(makeFact('viewingInvited', true, { evidence: text, propertyIds: selectedIds }))
    if (shared.viewingProposal) facts.push(makeFact('viewingProposal', shared.viewingProposal, { factStatus: FACT_STATUS.CONDITIONAL, confidence: 0.9, evidence: text, propertyIds: selectedIds }))
    if (shared.protectedPreference) facts.push(makeFact('restrictedComplianceNote', shared.protectedPreference, { factStatus: FACT_STATUS.CONDITIONAL, confidence: 1, evidence: text, restricted: true, propertyIds: selectedIds }))
    actions.push({
      type: 'SHARED_PLACE_OFFER', scope: 'PROPERTY', propertyIds: selectedIds,
      status: OPERATIONAL_STATUS.NEEDS_HUMAN_REVIEW, reason: text, details: sharedDetails,
    })
    terminal = true
    suppressAutomation = true
    if (shared.protectedPreference) complianceReview = true
  } else if (shared.unavailablePlace) {
    facts.push(makeFact('availablePlaceCount', 0, { negative: true, evidence: text, propertyIds: selectedIds }))
    actions.push({
      type: 'SHARED_PLACE_STATUS', scope: 'PROPERTY', propertyIds: selectedIds,
      status: OPERATIONAL_STATUS.NEEDS_HUMAN_REVIEW, reason: text,
      details: { availablePlaceCount: 0, wholePropertyAvailable: null },
    })
    terminal = true
    suppressAutomation = true
  } else if (historical && (rented || sold)) {
    facts.push(makeFact('historicalPropertyEvent', sold ? 'sold' : 'rented', {
      factStatus: FACT_STATUS.KNOWN, confidence: 0.98, evidence: text, propertyIds: selectedIds.length === 1 ? selectedIds : [],
    }))
  } else if (rented || sold || propertyRemoval) {
    const countedMixedState = /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:of\s+the\s+)?(?:apartments?|flats?|units?)?\s*(?:have\s+been\s+|are\s+)?rented\b/i.test(text)
      && /\b(?:one|a|the|studio|apartment|flat|unit)\b.{0,50}\bavailable\b/i.test(text)
    const explicitAll = /\ball\s+(?:of\s+them\s+)?(?:are\s+|have\s+been\s+)?rented\b/i.test(text)
    const targetIds = selectedIds
    const safeTargets = targetIds.length === 1 || (explicitAll && targetIds.length > 1) || (selector.constrained && targetIds.length > 0)
    if (countedMixedState || !safeTargets) {
      addReview(actions, countedMixedState ? 'mixed_unit_status_requires_mapping' : 'ambiguous_property_status', text, {
        candidatePropertyIds: referencedPropertyIds, selectedPropertyIds: targetIds,
      })
    } else {
      actions.push({
        type: 'PROPERTY_STATUS', scope: 'PROPERTY',
        status: sold ? OPERATIONAL_STATUS.SOLD : rented ? OPERATIONAL_STATUS.RENTED : OPERATIONAL_STATUS.WITHDRAWN,
        propertyIds: targetIds,
        reason: text,
      })
    }
    terminal = true
    suppressAutomation = true
  }

  if (currentAvailable && !shared.isOffer) {
    const targetIds = selectedIds
    if (targetIds.length === 1 || (selector.constrained && targetIds.length > 0)) {
      actions.push({ type: 'PROPERTY_STATUS', scope: 'PROPERTY', status: OPERATIONAL_STATUS.AVAILABLE, propertyIds: targetIds, reason: text, correction: /\bstill\b|\bactually\b|\bcorrection\b/i.test(text) })
      facts.push(makeFact('availabilityStatus', OPERATIONAL_STATUS.AVAILABLE, { correction: true, evidence: text, propertyIds: targetIds }))
      facts.push(makeFact('confirmedBookable', true, { correction: true, evidence: text, propertyIds: targetIds }))
    } else {
      addReview(actions, 'available_unit_requires_mapping', text, { candidatePropertyIds: referencedPropertyIds })
      suppressAutomation = true
    }
  }

  if (TENANT_MOVED_OUT_RE.test(text)) {
    facts.push(makeFact('tenancyStatus', 'VACATED', { evidence: text, propertyIds: selectedIds }))
    if (selectedIds.length !== 1) addReview(actions, 'vacated_unit_requires_mapping', text, { candidatePropertyIds: referencedPropertyIds })
  }
  if (replyNone && context.lastQuestionType === 'numbered_availability' && referencedPropertyIds.length) {
    actions.push({ type: 'PROPERTY_STATUS', scope: 'REFERENCED_PROPERTIES', status: OPERATIONAL_STATUS.WITHDRAWN, propertyIds: referencedPropertyIds, reason: text })
    terminal = true
    suppressAutomation = true
  }

  if (/\bno pets?\b|\bpets? (?:are )?not allowed\b/i.test(text)) facts.push(makeFact('petsAllowed', false, { negative: true, evidence: text }))
  if (/\bno sharing\b|\b(?:don'?t|do not|won'?t|will not) (?:allow|accept|consider) sharing\b/i.test(text)) facts.push(makeFact('sharingAllowed', false, { negative: true, evidence: text }))
  if (PROTECTED_PREFERENCE_RE.test(text)) {
    facts.push(makeFact('restrictedComplianceNote', text, { factStatus: FACT_STATUS.CONDITIONAL, confidence: 1, evidence: text, restricted: true, propertyIds: selectedIds }))
    actions.push({ type: 'HUMAN_COMPLIANCE_REVIEW', status: OPERATIONAL_STATUS.NEEDS_HUMAN_REVIEW, reason: 'protected_group_preference', evidence: text })
    complianceReview = true
    suppressAutomation = true
  } else if (/\b(?:only )?famil(?:y|ies)(?: or close friends?)?\b|\bclose friends?\b/i.test(text)) facts.push(makeFact('occupancyRestriction', /close friends?/i.test(text) ? 'family_or_close_friends' : 'families_only', { evidence: text, propertyIds: selectedIds }))
  if (/\bno (?:company )?subletting\b|\b(?:don'?t|do not|won'?t|will not) (?:allow|accept|consider) (?:company )?subletting\b|\bcompany (?:cannot|can'?t|may not) sublet\b/i.test(text)) facts.push(makeFact('companySubletting', false, { negative: true, evidence: text }))
  if (/\bno compan(?:y|ies)\b/i.test(text)) facts.push(makeFact('companiesAllowed', false, { negative: true, evidence: text }))

  const money = extractMoney(text)
  if (money && !shared.isOffer) {
    facts.push(makeFact('askingPrice', money.value, { correction: money.correction, evidence: text, propertyIds: selectedIds }))
    if (/\bnegotiable\b/i.test(text) && !/\bnot\s+\d{3,5}\s+negotiable\b/i.test(text)) facts.push(makeFact('priceNegotiable', true, { evidence: text, propertyIds: selectedIds }))
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
  if (/\b(?:please\s+)?call me\b|\bcan you call\b/i.test(text)) {
    actions.push({ type: 'HUMAN_REVIEW', status: OPERATIONAL_STATUS.NEEDS_HUMAN_REVIEW, reason: 'owner_requested_call', evidence: text })
    suppressAutomation = true
  }

  const window = extractTentativeWindow(text)
  if (REFURBISHMENT_RE.test(text)) {
    facts.push(makeFact('refurbishmentStatus', 'IN_PROGRESS', { evidence: text, propertyIds: selectedIds }))
    facts.push(makeFact('photosStatus', 'PENDING', { evidence: text, propertyIds: selectedIds }))
    facts.push(makeFact('confirmedBookable', false, { negative: true, evidence: text, propertyIds: selectedIds }))
  } else if (PHOTOS_PENDING_RE.test(text)) {
    facts.push(makeFact('photosStatus', 'PENDING', { evidence: text, propertyIds: selectedIds }))
  }
  if (viewingOnly) {
    facts.push(makeFact('viewingStatus', OPERATIONAL_STATUS.VIEWING_PAUSED, { evidence: text, propertyIds: selectedIds }))
    const until = /\buntil\s+(.+)$/i.exec(text)?.[1]?.replace(/[.!]+$/, '').trim() || null
    if (until) facts.push(makeFact('viewingsFrom', until, { factStatus: FACT_STATUS.CONDITIONAL, confidence: 0.8, evidence: text, propertyIds: selectedIds }))
  }
  if (/\balmost ready\b|\bnot ready\b/i.test(text)) {
    facts.push(makeFact('availabilityStatus', OPERATIONAL_STATUS.NOT_READY, { evidence: text }))
    facts.push(makeFact('confirmedBookable', false, { negative: true, evidence: text }))
  }
  if (COMPLIANCE_PENDING_RE.test(text)) {
    facts.push(makeFact('complianceStatus', OPERATIONAL_STATUS.COMPLIANCE_PENDING, { evidence: text }))
    facts.push(makeFact('confirmedBookable', false, { negative: true, evidence: text }))
    suppressAutomation = true
  }
  if (window && !historical) facts.push(makeFact(viewingOnly ? 'viewingsFrom' : 'availabilityFrom', window.label, { factStatus: window.tentative || futureAvailable ? FACT_STATUS.CONDITIONAL : FACT_STATUS.KNOWN, confidence: window.tentative ? 0.65 : 0.95, evidence: text, propertyIds: selectedIds }))

  if (/\bnew property\b/i.test(text)) facts.push(makeFact('listingCondition', 'new', { evidence: text }))
  if (/\bstudio\b/i.test(text)) facts.push(makeFact('propertyType', 'STUDIO', { evidence: text, propertyIds: selectedIds }))
  const beds = s.match(/\b(\d+)\s*(?:bed|bedroom)s?\b/)
  const baths = s.match(/\b(\d+)\s*(?:bath|bathroom)s?\b/)
  if (beds) facts.push(makeFact('bedrooms', Number(beds[1]), { evidence: text }))
  if (baths) facts.push(makeFact('bathrooms', Number(baths[1]), { evidence: text }))
  if (!localityCorrection && /\bmqabba\b/i.test(text)) facts.push(makeFact('locality', 'Mqabba', { evidence: text }))

  if (/^(no|none|yes|yeah|yep)[.!\s]*$/i.test(text) && context.lastAskedField) {
    const negative = /^(no|none)/i.test(text)
    facts.push(makeFact(context.lastAskedField, !negative, { negative, evidence: text }))
  }

  if (actions.some(a => a.type === 'HUMAN_REVIEW' || a.type === 'HUMAN_COMPLIANCE_REVIEW')) suppressAutomation = true

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
  if (decision.actions.some(a => a.type === 'SHARED_PLACE_OFFER' || a.type === 'SHARED_PLACE_STATUS')) return null
  if (decision.actions.some(a => a.type === 'PROPERTY_STATUS' && [OPERATIONAL_STATUS.RENTED, OPERATIONAL_STATUS.SOLD, OPERATIONAL_STATUS.WITHDRAWN].includes(a.status) && a.propertyIds?.length)) return "Thanks for letting me know. I've updated our records and removed the property from our available listings."
  if (decision.complianceReview) return null
  if (decision.questions.includes('agency_identity')) return agencyAnswer(identity)
  if (decision.questions.includes('client_types')) return clientTypeAnswer(identity)
  if (decision.questions.includes('email_request')) return emailAnswer(identity)
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
  if (/\b(?:i(?:'ve| have)\s+updated|updated\s+(?:our|the)\s+records?|removed\s+the\s+property|notified\s+(?:my|our)\s+colleagues?|let\s+(?:my|our)\s+colleagues\s+know)\b/i.test(text)) {
    const committed = new Set(state.committedActions || [])
    const removal = /removed\s+the\s+property|updated\s+(?:our|the)\s+records?/i.test(text)
    const notified = /colleagues/i.test(text)
    if ((removal && !committed.has('PROPERTY_STATUS')) || (notified && !committed.has('INTERNAL_TASK_COMMITTED'))) {
      return { allow: false, reason: 'uncommitted_completion_claim' }
    }
  }
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
  // Never an email address the sender has not verified (Kev, 2026-10-30).
  if (unapprovedEmails(text, identity).length) return { allow: false, reason: 'unverified_email' }
  if (/\b(?:i am|i'm|we are|we're) (?:with|from)\b/i.test(text) && identity) {
    const agency = String(identity.agency || '').toLowerCase()
    if (agency && !lower(text).includes(agency)) return { allow: false, reason: 'sender_identity_mismatch' }
  }
  return { allow: true, reason: null }
}

module.exports = {
  FACT_STATUS, OPERATIONAL_STATUS, interpretInbound, applyDecision,
  planDirectReply, validateDraft, extractMoney, extractAddress, activeFactMap,
  unitSelector,
}
