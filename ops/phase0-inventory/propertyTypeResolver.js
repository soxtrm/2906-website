'use strict'
// ============================================================================
// services/propertyTypeResolver.js — the kind of property, from evidence only (2026-11-20).
//
// The upload stored "apartment" whenever the reader returned no type, and the reader could only answer
// apartment / penthouse / house / maisonette / commercial. A studio or a villa could not be stored as what
// it is, and a listing whose text names no kind at all became an apartment.
//
// resolve(extracted, text) returns one of the existing types, or null when the text does not say.
//   - the text decides: a type counts only if the listing's own words name it
//   - a specific word beats the generic one: "studio apartment" is a studio, "penthouse apartment" a penthouse
//   - two different specific kinds in the headline ("maisonette / penthouse") stay unresolved for review
//   - nothing named -> null. Never a default.
// ============================================================================
const TYPES = ['studio', 'apartment', 'penthouse', 'maisonette', 'house', 'villa']
const WORDS = [
  ['studio', /\bstudios?\b(?!\s*(?:room|space)\b)/i],
  ['penthouse', /\bpent\s?houses?\b/i],
  ['maisonette', /\bmaison+et+es?\b/i],
  ['villa', /\b(?:villas?|bungalows?)\b/i],
  ['house', /\b(?:town\s?houses?|terraced\s+houses?|houses?\s+of\s+character|farm\s?houses?|house)\b/i],
  ['apartment', /\b(?:apartments?|flats?|apts?)\b/i],
]
const clean = s => String(s || '').replace(/[*_~`]+/g, ' ').replace(/\bpenthouse\b/gi, m => m).trim()

function namedIn(text) {
  // "penthouse" contains "house": look for house only where no penthouse stands
  const t = String(text || '')
  const found = new Set()
  for (const [type, re] of WORDS) {
    if (type === 'house') { if (re.test(t.replace(/\bpent\s?houses?\b/gi, ' '))) found.add(type) }
    else if (re.test(t)) found.add(type)
  }
  return found
}
// one kind out of the words found; generic "apartment" gives way to a specific kind
function pick(found) {
  const specific = [...found].filter(t => t !== 'apartment')
  if (specific.length === 1) return specific[0]
  if (specific.length > 1) return null
  return found.has('apartment') ? 'apartment' : null
}

function fromText(text) {
  const lines = clean(text).split('\n').map(l => l.trim()).filter(Boolean)
  if (!lines.length) return { type: null, why: 'no text' }
  const head = namedIn(lines.slice(0, 2).join('\n'))
  if (head.size) {
    const t = pick(head)
    return t ? { type: t, why: 'headline' } : { type: null, why: `headline names ${[...head].filter(x => x !== 'apartment').join(' and ')}` }
  }
  const body = namedIn(lines.join('\n'))
  if (!body.size) return { type: null, why: 'the text names no kind of property' }
  const t = pick(body)
  return t ? { type: t, why: 'text' } : { type: null, why: `text names ${[...body].filter(x => x !== 'apartment').join(' and ')}` }
}

// extracted: what the reader returned (may be empty); text: the listing text
function resolve(extracted, text) {
  const seen = fromText(text)
  if (seen.type) return seen
  const ex = String(extracted || '').toLowerCase().trim()
  // the reader's word is kept only when the text itself carries it (it was told to answer apartment by default for years)
  if (TYPES.includes(ex) && namedIn(text).has(ex) && !/ and /.test(seen.why)) return { type: ex, why: 'reader, named in the text' }
  return { type: null, why: seen.why }
}

module.exports = { resolve, fromText, TYPES }
