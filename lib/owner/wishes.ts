// Owner wishes: what an owner wants and does not want in a tenant, collected
// from what they write to ARGUS Main and kept as a plus/minus list per property.
// When the same wish shows up on several properties it is promoted to "all
// your properties". Pure functions, no I/O, so the backend can reuse them.
//
// Never recorded: nationality, ethnic origin, skin colour, religion or similar.
// Choosing tenants by these is unlawful discrimination in Malta and the EU
// (Equal Treatment of Persons Order, Directive 2000/43/EC). Such a remark is
// not stored and never filters anyone; the owner is told once, politely, and
// whatever else the sentence says (for example "couple") is still kept.

export type Polarity = 'plus' | 'minus'

export interface Wish {
  id: string
  key: string            // canonical id, e.g. 'pets'
  polarity: Polarity
  label: string          // what the owner sees, e.g. 'Pets welcome'
  propertyId: number | null   // null = said for all properties
  quote: string          // the owner's own words it came from
  at: string
}

interface Rule { key: string; plus?: string; minus?: string; re: RegExp; neg?: RegExp; pos?: RegExp }

const NEG = /\b(no|not|without|don'?t|do not|never|avoid|nobody|none)\b/

// key, labels and the words that point to it. `neg`/`pos` force the polarity.
const RULES: Rule[] = [
  { key: 'pets', plus: 'Pets welcome', minus: 'No pets', re: /\b(pets?|dogs?|cats?|animals?)\b/, pos: /\b(pets?|dogs?|cats?) (are )?(ok|okay|fine|welcome|allowed)\b/ },
  { key: 'smoking', plus: 'Smokers ok', minus: 'Non-smokers only', re: /\b(smok\w*|non[- ]?smok\w*)\b/, neg: /\bnon[- ]?smok\w*|no smok\w*|not smok\w*/ },
  { key: 'couple', plus: 'Couple', minus: 'No couples', re: /\bcouples?\b/ },
  { key: 'single', plus: 'Single person', minus: 'No single tenants', re: /\b(single (person|professional|tenant|lady|man|woman)|one person)\b/ },
  { key: 'family', plus: 'Family', minus: 'No families', re: /\bfamil(y|ies)\b/ },
  { key: 'children', plus: 'Children welcome', minus: 'No children', re: /\b(kids?|children|child|baby|babies)\b/ },
  { key: 'professionals', plus: 'Working professionals', minus: 'No working professionals', re: /\b(working|professionals?|employed|full[- ]time job)\b/ },
  { key: 'students', plus: 'Students ok', minus: 'No students', re: /\bstudents?\b/ },
  { key: 'sharers', plus: 'Sharers ok', minus: 'No sharers or groups', re: /\b(sharers?|flat ?shares?|groups?|friends sharing)\b/ },
  { key: 'company', plus: 'Company let', minus: 'No company lets', re: /\b(company( let)?|corporate)\b/ },
  { key: 'long_stay', plus: 'Long stay (12 months+)', minus: 'No long stays', re: /\b(long[- ]?term|long[- ]?stay|12 months|one year|1 year|a year)\b/ },
  { key: 'short_stay', plus: 'Short stays ok', minus: 'No short stays', re: /\b(short[- ]?term|short[- ]?stay|few months|less than (6|six) months)\b/ },
  { key: 'quiet', plus: 'Quiet tenants', re: /\bquiet\b/ },
]

// Protected characteristics. Matched words are removed from the sentence before
// anything else is read, so "European couple" still yields "Couple".
const PROTECTED = new RegExp('\\b(' + [
  'nationality', 'nationalities', 'race', 'racial', 'ethnic\\w*', 'skin', 'colou?red', 'religion', 'religious',
  'muslims?', 'christians?', 'jews?', 'jewish', 'hindus?', 'catholics?',
  'europeans?', 'africans?', 'asians?', 'arabs?', 'arabic', 'blacks?', 'whites?', 'locals? only', 'foreigners?', 'expats?',
  'pakistan\\w*', 'indians?', 'india', 'nepal\\w*', 'bangladesh\\w*', 'filipin\\w*', 'philippin\\w*', 'chinese', 'nigerian?s?',
  'syrians?', 'libyans?', 'turks?', 'turkish', 'russians?', 'ukrainians?', 'italians?', 'maltese', 'british', 'english',
  'germans?', 'french', 'spanish', 'serbians?', 'colombians?', 'brazilians?', 'eritreans?', 'somalis?', 'sudanese',
].join('|') + ')\\b', 'gi')

export interface Extracted { wishes: Omit<Wish, 'id' | 'at' | 'propertyId'>[]; protectedRemark: boolean }

export function extractWishes(text: string): Extracted {
  const out: Extracted['wishes'] = []
  let protectedRemark = false
  for (const raw of text.split(/[.;!?\n]+|,\s*(?:but|and)\s+|\bbut\b/i)) {
    const quote = raw.trim()
    if (!quote) continue
    let clause = quote.toLowerCase()
    if (PROTECTED.test(clause)) { protectedRemark = true; clause = clause.replace(PROTECTED, ' ') }
    PROTECTED.lastIndex = 0
    for (const r of RULES) {
      const m = clause.match(r.re)
      if (!m) continue
      let polarity: Polarity
      if (r.pos && r.pos.test(clause)) polarity = 'plus'
      else if (r.neg && r.neg.test(clause)) polarity = 'minus'
      else {
        // a negation in the few words before the match flips it ("no pets", "don't want students")
        const before = clause.slice(Math.max(0, (m.index || 0) - 28), m.index)
        polarity = NEG.test(before) ? 'minus' : 'plus'
      }
      const label = polarity === 'plus' ? r.plus : r.minus
      if (!label) continue
      if (!out.some(w => w.key === r.key)) out.push({ key: r.key, polarity, label, quote })
    }
  }
  return { wishes: out, protectedRemark }
}

/** Adds new wishes; a newer statement about the same thing on the same property replaces the older one. */
export function mergeWishes(list: Wish[], add: Wish[]): Wish[] {
  let next = [...list]
  for (const w of add) {
    next = next.filter(x => !(x.key === w.key && x.propertyId === w.propertyId))
    next.push(w)
  }
  return next
}

export interface WishView { key: string; polarity: Polarity; label: string; scope: 'all' | 'property'; properties: number[]; quote: string }

/**
 * The list one property shows: its own wishes plus wishes that hold for the
 * owner in general. A wish counts as general when it was said for all
 * properties, or when it appears with the same polarity on at least
 * `promoteAt` (default 3, or every property if the owner has fewer).
 */
export function wishesFor(list: Wish[], propertyIds: number[], propertyId: number | null, promoteAt = 3): WishView[] {
  const need = Math.min(promoteAt, Math.max(1, propertyIds.length))
  const byKey = new Map<string, Wish[]>()
  for (const w of list) byKey.set(`${w.key}:${w.polarity}`, [...(byKey.get(`${w.key}:${w.polarity}`) || []), w])
  const out: WishView[] = []
  for (const [, ws] of byKey) {
    const props = [...new Set(ws.map(w => w.propertyId).filter((x): x is number => x !== null))]
    const general = ws.some(w => w.propertyId === null) || props.length >= need
    const latest = ws[ws.length - 1]
    if (propertyId === null ? general : general || props.includes(propertyId)) {
      out.push({ key: latest.key, polarity: latest.polarity, label: latest.label, scope: general ? 'all' : 'property', properties: props, quote: latest.quote })
    }
  }
  // the same key with both polarities: the property's own statement wins over the general one
  const seen = new Map<string, WishView>()
  for (const v of out) {
    const prev = seen.get(v.key)
    if (!prev || (prev.scope === 'all' && v.scope === 'property')) seen.set(v.key, v)
  }
  return [...seen.values()].sort((a, b) => (a.polarity === b.polarity ? a.label.localeCompare(b.label) : a.polarity === 'plus' ? -1 : 1))
}
