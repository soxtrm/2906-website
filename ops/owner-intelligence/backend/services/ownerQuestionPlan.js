'use strict'
// ============================================================================
// services/ownerQuestionPlan.js — ask only for what is missing, and ask
// related things together (Kev, 2026-10-31).
//
// autoOwnerConversation picks ONE next field (nextMissingField: stages,
// ask-once, stop rule — unchanged). This module turns that field into the
// message's question set:
//   address + floor          ask both if both missing; else only the missing one
//   rent type + available    "long let or winter let, and from when?"
//   parking + subletting     garage/parking first, Kev's verbatim subletting
//                            question after it (never rephrased)
// A companion joins only when it is unknown, not asked before and eligible
// (the caller's own gate — e.g. subletting stays Stage 4). Known facts are
// never asked again; pets never implies subletting.
// Pure: no DB, no network.
// ============================================================================

// checklist key that answers each planning field
const ANSWER_KEY = { map: 'address', floor: 'floor', rent_type: 'rent_type', available_date: 'available_date', parking: 'parking', subletting: 'subletting' }

const GROUPS = [
  { fields: ['map', 'floor'],
    label: { both: 'the exact address (or a map pin) and which floor the apartment is on', map: 'the exact address or a map pin', floor: 'which floor the apartment is on' },
    text: { both: 'Could you share the exact address or a map pin, and which floor the apartment is on?', map: 'Could you share the exact address or a map pin?', floor: 'Which floor is the apartment on?' } },
  { fields: ['available_date', 'rent_type'],
    label: { both: 'whether it is for a long let or a winter let, and from when it is available', available_date: 'when the property will be available / the move-in date', rent_type: 'whether it is for a long let or a winter let' },
    text: { both: 'Is it for a long let or a winter let, and from when would it be available?', available_date: 'And when would it be available from?', rent_type: 'Is it for a long let or a winter let?' } },
  { fields: ['parking', 'subletting'],
    label: { both: 'whether there is a garage or parking space, and (as the last, carefully-framed question) whether they would consider subletting through a serious company', parking: 'whether there is a garage or parking space', subletting: 'whether they would consider subletting through a serious company, as a very last, carefully-framed question' },
    text: { parking: 'Is there a garage or a parking space with it?' } },
]

function isKnown(checklist, field) {
  const key = ANSWER_KEY[field] || field
  const v = checklist ? checklist[key] : undefined
  return v !== undefined && v !== null && v !== ''
}

// field: what nextMissingField chose. eligible(field) → may it be asked now?
// verbatim: { subletting: '<Kev's text>' } for wording that must not change.
function bundleFor(field, checklist = {}, { eligible = () => true, verbatim = {} } = {}) {
  const group = GROUPS.find(g => g.fields.includes(field))
  if (!group) return { fields: [field], label: null, text: null }
  const missing = group.fields.filter(f => f === field
    || (!isKnown(checklist, f) && !checklist[`_asked_${f}`] && !checklist[`_unresolved_${f}`] && eligible(f)))
  if (missing.length === 1) {
    const only = missing[0]
    return { fields: [only], label: group.label[only] || null, text: group.text[only] || verbatim[only] || null }
  }
  if (group.fields[0] === 'parking') {
    // Parking first, then Kev's own subletting wording — unchanged.
    const sub = verbatim.subletting || null
    return { fields: missing, label: group.label.both, text: sub ? `${group.text.parking} ${sub}` : null }
  }
  return { fields: missing, label: group.label.both, text: group.text.both }
}

// Checklist values from the deterministic owner-fact extractor
// (services/ownerFacts): floor, parking (+type) and rent type, only when not
// already known — an earlier explicit answer is never overwritten here.
function factsIntoChecklist(checklist, facts) {
  const next = { ...checklist }
  for (const f of facts || []) {
    if (f.field === 'floor' && !isKnown(next, 'floor')) next.floor = f.value
    if (f.field === 'parking' && !isKnown(next, 'parking')) next.parking = f.value ? 'yes' : 'no'
    if (f.field === 'parking_type' && !next.parking_type) next.parking_type = f.value
    if (f.field === 'rental_modes' && !isKnown(next, 'rent_type')) next.rent_type = f.value
  }
  return next
}

module.exports = { GROUPS, bundleFor, factsIntoChecklist, isKnown }
