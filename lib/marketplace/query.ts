// Plain-language search for the Marketplace (2026-11-21):
//   "2 bed sliema sea view under 1500"  ->  2+ bedrooms · Sliema · Sea view · max €1,500
// Pure function: it only understands what is in the text and in the live lists it is given (areas, types,
// feature dictionary with multilingual aliases); everything else stays free text.
export type QueryContext = { areas: string[]; types: string[]; features: { key: string; label: string; aliases: string[] }[]; agencyKeys?: string[] }
export type Understood = { beds?: string; min?: string; max?: string; area?: string; type?: string; feat: string[]; now?: boolean; rest: string }

export const nrm = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’`]/g, "'")
const TYPE_WORDS: Record<string, string> = { flat: 'apartment', flats: 'apartment', apartment: 'apartment', apartments: 'apartment', wohnung: 'apartment', penthouse: 'penthouse', penthouses: 'penthouse', house: 'house', houses: 'house', haus: 'house', maisonette: 'maisonette', maisonettes: 'maisonette', villa: 'villa', villas: 'villa', townhouse: 'townhouse', 'town house': 'townhouse', studio: 'studio' }
const STOP = new Set(['in', 'at', 'with', 'a', 'an', 'the', 'and', 'for', 'near', 'to', 'of', 'mit', 'in', 'und', 'eine', 'ein', 'bedroom', 'bedrooms', 'home', 'homes', 'rent', 'let', 'long', 'property'])
const amount = (s: string) => { const k = /k$/i.test(s); const n = Number(s.replace(/[k,.\s€]/gi, '')); return Number.isFinite(n) && n > 0 ? String(k ? n * 1000 : n) : undefined }

export function understand(input: string, ctx: QueryContext): Understood {
  // punctuation becomes a space, except a comma inside a number ("1,500")
  let t = ` ${nrm(input).replace(/[;:!?()[\]"]+/g, ' ').replace(/,(?!\d)/g, ' ').replace(/\s+/g, ' ').trim()} `
  const out: Understood = { feat: [], rest: '' }
  const take = (re: RegExp, fn: (m: RegExpMatchArray) => void) => { const m = t.match(re); if (m) { fn(m); t = t.replace(m[0], ' ') } }
  // listing references (agency key + number, e.g. 2906-1234) stay free text and are never read as a price range
  const refs: string[] = []
  const refRe = new RegExp(`\\b(?:${(ctx.agencyKeys || ['2906']).join('|')})-\\d{1,6}\\b`, 'g')
  t = t.replace(refRe, r => { refs.push(r); return ' ' })

  take(/\b(\d)\s*\+?\s*(?:bed(?:room)?s?|br|bhk|schlafzimmer|zimmer)\b/, m => { out.beds = m[1] })
  take(/€?\s*(\d[\d,.]*k?)\s*(?:-|to|bis)\s*€?\s*(\d[\d,.]*k?)\s*(?:€|eur|euro)?/, m => { const a = amount(m[1]), b = amount(m[2]); if (a && b && Number(b) > Number(a)) { out.min = a; out.max = b } })
  take(/\b(?:under|below|max(?:imum)?|up to|less than|bis|unter|<)\s*€?\s*(\d[\d,.]*k?)\b/, m => { out.max = amount(m[1]) })
  take(/\b(?:over|above|min(?:imum)?|from|more than|ab|>)\s*€?\s*(\d[\d,.]*k?)\b/, m => { out.min = amount(m[1]) })
  take(/\b(?:available now|available immediately|immediately|move in now|sofort)\b/, () => { out.now = true })

  // longest area names first, so "St Julian's" wins over "St"
  for (const a of [...ctx.areas].sort((x, y) => y.length - x.length)) {
    const n = nrm(a).replace(/[^a-z0-9' ]/g, ' ').trim(); if (n.length < 3) continue
    const re = new RegExp(`(^|\\s)${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "'?")}(?=\\s|$)`)
    if (re.test(t)) { out.area = a; t = t.replace(re, ' '); break }
  }
  for (const [w, type] of Object.entries(TYPE_WORDS).sort((x, y) => y[0].length - x[0].length)) {
    const re = new RegExp(`(^|\\s)${w}(?=\\s|$)`)
    if (re.test(t) && ctx.types.includes(type)) { out.type = type; t = t.replace(re, ' '); break }
  }
  // features: label or any alias as whole words, longest phrase first
  const phrases = ctx.features.flatMap(f => [f.label, ...f.aliases].map(p => ({ key: f.key, p: nrm(p).trim() }))).filter(x => x.p.length >= 3).sort((a, b) => b.p.length - a.p.length)
  for (const { key, p } of phrases) {
    const re = new RegExp(`(^|\\s)${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`)
    if (re.test(t)) { if (!out.feat.includes(key)) out.feat.push(key); t = t.replace(re, ' ') }
  }
  out.rest = [...refs, ...t.split(' ').filter(w => w && !STOP.has(w) && !/^[€,.+-]+$/.test(w))].join(' ')
  return out
}
