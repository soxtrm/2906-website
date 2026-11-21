// Title, description and share image for a public 2906 property page (Kev 21 Nov 2026):
// "2-Bedroom Penthouse in Swieqi" in Title Case, never a "Selected Apartment" placeholder,
// and Open Graph data that belongs to the home instead of the site-wide default.
// Pure functions (no server imports) so they can be unit-tested.

type P = {
  title?: string | null
  propertyType?: string | null
  location?: string | null
  bedrooms?: number | string | null
  category?: string | null
  price?: number | string | null
  priceAfter?: string | null
  priceType?: string | null
  listingType?: string | null
  fullDescription?: string | null
  description?: string | null
  summary?: string | null
  images?: string[] | null
}

const SMALL = new Set(['a', 'an', 'and', 'or', 'of', 'in', 'on', 'to', 'with', 'for', 'the', 'by'])
const KEEP = /^(?:[A-Z]{2,3}|\d+[a-z]*|St)$/ // short acronyms (BBQ, AC), numbers, "St"; longer shouting is normalised
export function titleCase(s: string) {
  return String(s || '').replace(/_/g, ' ').trim().split(/\s+/).filter(Boolean)
    .map((w, i) => (KEEP.test(w) ? w : i > 0 && SMALL.has(w.toLowerCase()) ? w.toLowerCase()
      : w.split('-').map(x => (x ? x[0].toUpperCase() + x.slice(1).toLowerCase() : x)).join('-')))
    .join(' ')
}

const COMMERCIAL = /office|retail|shop|warehouse|commercial|garage|plot|land|restaurant|catering|industrial/i
const NO_ROOMS = /studio|garage|plot|land|parking|office|retail|shop|warehouse/i

export function publicPropertyTitle(p: P) {
  const rawType = String(p.propertyType || '').trim()
  const type = rawType ? titleCase(rawType) : p.category === 'commercial' ? 'Commercial Property' : 'Home'
  const beds = Number(p.bedrooms)
  const rooms = beds > 0 && !NO_ROOMS.test(rawType) && !COMMERCIAL.test(rawType) && p.category !== 'commercial' ? `${beds}-Bedroom ` : ''
  const place = String(p.location || '').trim()
  return `${rooms}${type}${place ? ` in ${titleCase(place)}` : ' in Malta'}`
}

// A short marketing headline from the ARGUS title ("Seafront | €2,000 | 2 Bedrooms"), without the parts
// the structured title already says (place, price, rooms). Null when nothing useful is left.
export function publicPropertyHeadline(p: P) {
  const place = String(p.location || '').trim().toLowerCase()
  const parts = String(p.title || '').split('|').map(x => x.trim()).filter(x => {
    const n = x.toLowerCase()
    return n && n !== place && !/€|\bbed(room)?s?\b|\bbath(room)?s?\b|^\d[\d,.]*$|^(to rent|for sale|to let)$/.test(n)
  })
  const s = parts.join(' · ')
  return s && s.length <= 70 ? titleCase(s) : null
}

export function publicPriceLabel(p: P) {
  const n = Number(p.price)
  if (!Number.isFinite(n) || n <= 0) return null
  const per = String(p.priceAfter || p.priceType || '').replace(/^per\s+/i, '').trim().toLowerCase()
  return `€${n.toLocaleString('en-GB')}${per && per !== 'total' ? `/${per}` : ''}`
}

// First real sentences of the description, without the header lines that repeat title/place/price/rooms.
export function publicPropertyDescription(p: P, max = 158) {
  const lines = String(p.fullDescription || p.description || p.summary || '').split(/\n+/).map(l => l.trim()).filter(Boolean)
  const place = String(p.location || '').trim().toLowerCase()
  const body = lines.filter(l => {
    const n = l.toLowerCase()
    if (n === place || /€\s?\d|^\d+\s*bed|bedrooms?\s*-|^[^a-z]*$/.test(n)) return false // price, rooms, ALL-CAPS headers
    return l.length > 25
  }).join(' ')
  let s = body.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ').replace(/[*_#~|•►✔✅]+/g, ' ').replace(/\s+/g, ' ').trim()
  const lead = [publicPropertyTitle(p), publicPriceLabel(p)].filter(Boolean).join(', ')
  if (!s) return `${lead}. A home listed by 2906 Real Estate Malta.`
  if (s.length > max) { const cut = s.slice(0, max); s = cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 30)).replace(/[,;:.\s-]+$/, '') + '…' }
  return s
}

// 1200×630 share card from the first Cloudinary photo (the same public photo the page shows).
export function publicShareImage(p: P) {
  const first = (p.images || []).find(u => typeof u === 'string' && /^https:\/\//.test(u))
  if (!first) return null
  return /res\.cloudinary\.com\/[^/]+\/image\/upload\//.test(first)
    ? first.replace('/image/upload/', '/image/upload/c_fill,g_auto,w_1200,h_630,q_auto,f_jpg/')
    : first
}
