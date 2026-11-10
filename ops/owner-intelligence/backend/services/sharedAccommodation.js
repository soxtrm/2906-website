'use strict'

const clean = value => String(value || '').replace(/\s+/g, ' ').trim()

const SHARING_RE = /\b(?:shar(?:e|ed|ing)|roommate|housemate|flatmate|another\s+(?:lady|girl|woman|person|tenant|occupant)|one\s+(?:place|room|bed)\s+(?:is\s+)?available|vacant\s+(?:place|room|bed))\b/i
const EXISTING_OCCUPANT_RE = /\b(?:have|there(?:'s| is)|with)\s+(?:a|one|\d+)\s+(?:lady|girl|woman|man|person|tenant|occupant)\s+(?:in|living|there)|\brented\s+(?:for|to)\s+(?:one|a)\s+(?:lady|girl|woman|man|person|tenant|occupant)|\b(?:one|a)\s+(?:lady|girl|woman|man|person|tenant|occupant)\s+(?:lives|is living|stays|is staying)\s+(?:there|in the (?:flat|apartment|property))\b/i
const OFFER_RE = /\b(?:needs?|looking for|want(?:s)?|welcome(?:s|d)?|accept(?:s|ing)?|there(?:'s| is)|have)\s+(?:one\s+)?another\s+(?:lady|girl|woman|man|person|tenant|occupant|roommate|housemate|flatmate)|\bone\s+(?:additional\s+|more\s+)?(?:place|room|bed)\s+(?:is\s+)?(?:available|vacant|offered)|\b(?:place|room|bed)\s+(?:is\s+)?available\b/i
const NO_OFFER_RE = /\b(?:not|no longer)\s+(?:looking for|accepting|wanting|needing)\s+(?:another|a)\s+(?:housemate|roommate|flatmate|person|tenant|occupant)|\b(?:both|all)\s+(?:places?|rooms?|beds?)\s+(?:are\s+)?(?:rented|taken|occupied)|\bno\s+(?:place|room|bed)s?\s+(?:are\s+)?available\b/i
const ROOM_RE = /\b(?:one|a|1)\s+(?:bed)?room\s+(?:is\s+)?(?:available|vacant)|\bonly\s+(?:one|1)\s+(?:bed)?room\s+(?:is\s+)?(?:available|vacant)|\b(?:bed)?room\s+(?:is\s+)?available\b/i
const PLACE_RE = /\b(?:one|a|1)\s+(?:additional\s+|more\s+)?place\s+(?:is\s+)?(?:available|vacant)|\b(?:another|one more)\s+(?:lady|girl|woman|man|person|tenant|occupant|roommate|housemate|flatmate)\b|\bneeds?\s+(?:one\s+)?another\b/i
const VIEWING_INVITE_RE = /\b(?:if you(?:'d)? like|you(?:'re| are) welcome|feel free)\s+to\s+(?:come\s+(?:and\s+)?(?:see|view)|view)|\bcome\s+(?:and\s+)?(?:see|view)\s+it\b/i
const PROTECTED_PREFERENCE_RE = /\b(?:another|only|prefer(?:s|red)?|want(?:s)?|needs?)\s+(?:a\s+)?(?:lady|girl|woman|man|male|female)\b/i

function numberFrom(value) {
  if (!value) return null
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }
  return words[String(value).toLowerCase()] || Number(value) || null
}

function extractRent(text) {
  const s = clean(text)
  const each = s.match(/(?:€|eur\s*)?([1-9][\d,\s]{2,6})\s*(?:euro|eur)?\s*(?:each|per\s+(?:person|tenant|occupant|month\s+each))\b/i)
    || s.match(/\b(?:rent|price)\s+(?:will\s+be|is|at)\s+(?:€|eur\s*)?([1-9][\d,\s]{2,6}).{0,24}\beach\b/i)
  const total = s.match(/(?:€|eur\s*)?([1-9][\d,\s]{2,6})\s*(?:euro|eur)?\s*(?:in\s+)?total\b/i)
    || s.match(/\b(?:cause|because|as)\s+(?:it(?:'s| is)|the\s+(?:total|whole\s+(?:flat|rent))\s+is)\s*(?:€|eur\s*)?([1-9][\d,\s]{2,6})/i)
    || s.match(/\b(?:the\s+)?(?:shared\s+flat\s+)?total\s+(?:is|will\s+be)\s+(?:€|eur\s*)?([1-9][\d,\s]{2,6})/i)
  const parse = m => m ? Number(m[1].replace(/[,\s]/g, '')) : null
  return { perPersonRent: parse(each), wholePropertyTotalRent: parse(total) }
}

function extractAvailableFrom(text) {
  const hit = clean(text).match(/\bavailable\s+(?:only\s+)?from\s+([^,.!?;]+)/i)
  return hit ? hit[1].trim() : null
}

function extractViewingProposal(text) {
  const source = clean(text)
  const hit = source.match(/\b(?:see|view|viewing|come)\b.{0,30}\b(tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i)
  if (!hit) return null
  const time = source.match(/\b(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i)
  return { day: hit[1], time: time?.[1] || null, timezone: 'Europe/Malta', status: 'PROPOSED' }
}

function parseSharedAccommodation(text) {
  const source = clean(text)
  const explicitlyUnavailable = NO_OFFER_RE.test(source)
  const existingOccupant = EXISTING_OCCUPANT_RE.test(source)
  const explicitRoom = ROOM_RE.test(source)
  const explicitPlace = PLACE_RE.test(source)
  const sharingContext = SHARING_RE.test(source) || explicitlyUnavailable || explicitRoom || explicitPlace
  const offered = !explicitlyUnavailable && sharingContext && (OFFER_RE.test(source) || explicitRoom || explicitPlace)
  const occupiedCountHit = source.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:lad(?:y|ies)|girls?|women|men|persons?|tenants?|occupants?)\b/i)
  const bedroomCountHit = source.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+)[ -]?(?:bed|bedroom)s?\b/i)
  const vacancyCountHit = source.match(/\b(?:only\s+)?(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:bed)?rooms?\s+(?:is|are)?\s*(?:available|vacant)\b/i)
  const rent = extractRent(source)
  return {
    isSharedAccommodation: sharingContext,
    isOffer: offered,
    isPartialOccupancy: offered && existingOccupant,
    occupancyState: offered && existingOccupant ? 'PARTIALLY_OCCUPIED' : null,
    wholePropertyAvailable: offered ? false : null,
    availablePlaceCount: offered && !explicitRoom ? (explicitPlace || existingOccupant ? 1 : null) : 0,
    availableRoomCount: offered && explicitRoom ? (numberFrom(vacancyCountHit?.[1]) || 1) : null,
    occupiedPersonCount: existingOccupant ? (numberFrom(occupiedCountHit?.[1]) || 1) : null,
    bedroomCount: numberFrom(bedroomCountHit?.[1]),
    unavailablePlace: explicitlyUnavailable,
    perPersonRent: rent.perPersonRent,
    wholePropertyTotalRent: rent.wholePropertyTotalRent,
    availableFrom: extractAvailableFrom(source),
    viewingInvited: VIEWING_INVITE_RE.test(source),
    viewingProposal: extractViewingProposal(source),
    protectedPreference: PROTECTED_PREFERENCE_RE.test(source) ? source : null,
    evidence: source,
  }
}

function founderApprovedDraft(details, { corrective = false } = {}) {
  const price = details?.perPersonRent ? ` at €${details.perPersonRent} per person` : ''
  if (corrective) return `Sorry, I misunderstood earlier. I understand the flat is shared and there's still one place available${price}. I'll let my colleagues know and we'll see if we can find someone suitable. Thank you!`
  return `Noted, so it's a shared flat with one place available${price}. I'll let my colleagues know and we'll try to find someone suitable. Thank you!`
}

module.exports = {
  parseSharedAccommodation,
  founderApprovedDraft,
  extractRent,
  extractAvailableFrom,
  extractViewingProposal,
}
