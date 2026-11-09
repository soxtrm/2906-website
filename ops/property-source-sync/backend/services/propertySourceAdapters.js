'use strict'
// ============================================================================
// services/propertySourceAdapters.js — ARGUS Property Source Sync, pure parts
// (Claude, 2026-11-09). Ported from the verified prototype
// (reference/prototype/source_adapter.py) so the 31 prototype tests keep their
// meaning in the real backend. No I/O here: URL policy, HTML → evidence lines,
// listing extraction, the founder's lower-price rule, fingerprints.
//
// Source data is EVIDENCE, never truth. Nothing here grants permission to copy
// third-party photos or prose; media URLs are kept as references only.
// ============================================================================
const crypto = require('crypto')

// One adapter per approved provider. A source registration must match an
// adapter's host + category entry point exactly; arbitrary URLs are refused.
const ADAPTERS = {
  mynexthome: {
    label: 'My Next Home',
    website: 'https://www.mynexthome.mt/',
    canonicalHost: 'www.mynexthome.mt',
    hosts: ['www.mynexthome.mt', 'mynexthome.mt'],
    categories: { long_let: '/long-let/', sale: '/for-sale/' }, // short let = different connector
    listingPrefix: '/directory-apartments/listing/',
    mediaPrefix: '/wp-content/uploads/',
  },
}
const CATEGORIES = ['long_let', 'sale']

function adapterFor(key) {
  const a = ADAPTERS[key]
  if (!a) throw new Error('Unknown source adapter')
  return a
}

// Canonical HTTPS URL on an approved host. Query, fragment, credentials and
// non-default ports are refused or dropped; path is normalised. IP literals and
// every host outside the adapter's allow-list fail.
function canonicalUrl(raw, adapterKey, base) {
  const a = adapterFor(adapterKey)
  let u
  try { u = new URL(String(raw || ''), base || `https://${a.canonicalHost}/`) } catch { throw new Error('Invalid URL') }
  if (u.protocol !== 'https:') throw new Error('Only HTTPS source URLs are allowed')
  if (u.username || u.password) throw new Error('Credentials in URLs are not allowed')
  if (u.port && u.port !== '443') throw new Error('Non-standard ports are not allowed')
  const host = u.hostname.toLowerCase()
  if (!a.hosts.includes(host)) throw new Error('Unapproved source host')
  let path
  try { path = decodeURIComponent(u.pathname) } catch { throw new Error('Invalid URL encoding') }
  if (/[\0\\]/.test(path) || path.split('/').includes('..')) throw new Error('Invalid source path')
  path = path.replace(/\/+/g, '/').replace(/\/?$/, '/')
  return `https://${a.canonicalHost}${encodeURI(path)}`
}

// Registration rule: URL must be exactly the adapter's category entry point.
function validateRegistration({ adapter, category, url }) {
  if (!CATEGORIES.includes(category)) throw new Error('Only Long Let and Sale are supported here; Short Let is a separate connector')
  const a = adapterFor(adapter)
  const canonical = canonicalUrl(url, adapter)
  if (canonical !== `https://${a.canonicalHost}${a.categories[category]}`) {
    throw new Error(`URL must be the approved ${category === 'sale' ? 'Sale' : 'Long Let'} collection: https://${a.canonicalHost}${a.categories[category]}`)
  }
  return canonical
}

// ── HTML → evidence lines (no external parser dependency in production) ─────
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', euro: '€', pound: '£', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', hellip: '…' }
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e.toLowerCase()) ? ENTITIES[e.toLowerCase()] : m
  })
}
function stripBlocks(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(footer|header|nav)\b[\s\S]*?<\/\1\s*>/gi, ' ')
}
function cleanLines(html) {
  const text = stripBlocks(html)
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/td|\/th|\/section|\/article|\/button|\/span|\/a|\/dt|\/dd|\/label|p|div|li|h[1-6]|tr|section|article|button|dt|dd)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  return decodeEntities(text).split('\n').map(v => v.replace(/\s+/g, ' ').trim()).filter(Boolean)
}
function attrValues(html, tag, attr) {
  const out = []
  const re = new RegExp(`<${tag}\\b[^>]*?\\s${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'gi')
  let m
  while ((m = re.exec(html))) out.push(decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''))
  return out
}
function firstHeading(html) {
  const m = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(stripBlocks(html))
  return m ? decodeEntities(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : null
}

// ── Founder's price rule (docs/PRICE_POLICY_AND_EXAMPLES.md) ───────────────
const MONEY_RE = /(?:€\s*([\d][\d,. ]*)|([\d][\d,. ]*)\s*€)/gi
const EXCLUDED_CONTEXT = ['wifi', 'wi-fi', 'internet', 'utilities', 'security deposit', 'deposit', 'water', 'electricity', 'common area', 'charges', 'per person', 'agent fee', 'agency fee', 'maintenance']

// Malta punctuation: 1,500 / 1.500 / 1500.00 / 1,300.50. Returns a number or null.
function amount(text) {
  let raw = String(text || '').trim().replace(/\s/g, '')
  if (!raw || !/^\d/.test(raw)) return null
  if (raw.includes(',') && raw.includes('.')) raw = raw.replace(/,/g, '')
  else if ((raw.match(/,/g) || []).length === 1 && raw.split(',')[1].length === 3) raw = raw.replace(',', '')
  else if ((raw.match(/\./g) || []).length === 1 && raw.split('.')[1].length === 3) raw = raw.replace('.', '')
  else raw = raw.replace(/,/g, '')
  raw = raw.replace(/[.,]+$/, '')
  if (!/^\d+(\.\d+)?$/.test(raw)) return null
  return Number(raw)
}
const fmt = n => (Number.isInteger(n) ? String(n) : String(n))

// Only explicitly advertised headline/rent/asking prices. Never add-ons,
// deposits, weekly/nightly rates or a different transaction basis.
function candidatePrices(lines, category) {
  const out = []
  lines.forEach((line, pos) => {
    const low = line.toLowerCase().trim()
    if (EXCLUDED_CONTEXT.some(t => low.includes(t))) return
    for (const m of line.matchAll(MONEY_RE)) {
      const v = amount(m[1] || m[2])
      if (v == null || v <= 0) continue
      let basis
      if (category === 'long_let') {
        if (/week|night|\bday\b|daily/.test(low)) continue
        if (!(low.includes('monthly') || low.includes('per month') || low.startsWith('rent:') || low.startsWith('rent ') || low.startsWith('for rent at') || low.includes('monthly rent'))) continue
        if (v < 100 || v > 100000) continue
        basis = 'EUR_MONTH'
      } else if (category === 'sale') {
        if (/month|week|night/.test(low)) continue
        if (v < 20000) continue
        if (!(low.length < 30 || low.includes('asking') || low.includes('sale price') || low.includes('for sale') || low.startsWith('price'))) continue
        basis = 'EUR_SALE'
      } else continue
      out.push({ amount: fmt(v), basis, evidence: line.slice(0, 210), line_index: pos })
    }
  })
  const uniq = new Map()
  for (const p of out) if (!uniq.has(`${p.amount}|${p.basis}`)) uniq.set(`${p.amount}|${p.basis}`, p)
  return [...uniq.values()]
}

// Lower explicit comparable price wins; two or more distinct quotes raise
// PRICE_CONFLICT for accountable review. No comparable price → unknown.
function selectPrice(lines, category) {
  const candidates = candidatePrices(lines, category)
  if (!candidates.length) return { amount: null, basis: null, candidate_prices: [], review_required: true, conflict: false, reason: 'No unambiguous comparable advertised amount' }
  const chosen = candidates.reduce((a, b) => (Number(b.amount) < Number(a.amount) ? b : a))
  const conflict = candidates.length > 1
  return { amount: chosen.amount, basis: chosen.basis, candidate_prices: candidates, review_required: conflict, conflict,
           reason: conflict ? 'Lowest explicitly advertised comparable price in current snapshot' : 'One supported advertised price' }
}

// ── Listing extraction ───────────────────────────────────────────────────────
function linksFromCategory(html, categoryUrl, adapterKey) {
  const a = adapterFor(adapterKey)
  const urls = []
  for (const href of attrValues(String(html || ''), 'a', 'href')) {
    let url
    try { url = canonicalUrl(href, adapterKey, categoryUrl) } catch { continue }
    if (new URL(url).pathname.startsWith(a.listingPrefix) && new URL(url).pathname !== a.listingPrefix && !urls.includes(url)) urls.push(url)
  }
  return urls
}

const DATE_RE = /\bavailable\s+(?:as\s+from\s+|from\s+)?(\d{1,2}\/\d{1,2}\/20\d{2})\b/gi
const BEDS_RE = /\b(\d+)\s*[- ]bed(?:room)?s?\b/i
const TYPE_RE = /\b(penthouse|maisonette|apartment|studio|townhouse|town house|house of character|villa|bungalow|flat|office|shop|commercial building|building|garage|land)\b/i
const LOCALITY_STOP = /^(\d|first|second|third|fourth|fifth|ground|top|upper|lower|penthouse|maisonette|apartment|studio|townhouse|villa|flat|office|shop|commercial|building|bungalow|house|garage|luxury|modern|spacious|bright|new|brand|furnished|unfurnished|seafront|sea|large|lovely|beautiful|\d+-bedroom)/i
const FOREIGN_MARKERS = /\b(libya|tripoli|benghazi|tunisia|italy|sicily|egypt|cyprus|greece|spain|portugal|dubai|uae|united kingdom|london)\b/i

function localityFromTitle(title) {
  const words = String(title || '').split(/\s+/)
  const out = []
  for (const w of words) { if (LOCALITY_STOP.test(w)) break; out.push(w) }
  return out.length && out.length <= 4 ? out.join(' ').replace(/[,–-]+$/, '') : null
}
function maltaDate(d) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(20\d{2})$/.exec(d || '')
  if (!m) return null
  const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  return Number.isNaN(Date.parse(iso)) ? null : iso
}
function labelledValue(lines, label) {
  const i = lines.findIndex(l => l.toLowerCase().replace(/:$/, '') === label)
  return i >= 0 && i + 1 < lines.length ? lines[i + 1] : null
}
function externalRef(canonical) {
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 20)
}

// The CATEGORY comes from the source collection, never from the generic
// For Sale / Long Let / Short Let buttons every detail page shows.
function parseDetail(html, url, category, adapterKey) {
  if (!CATEGORIES.includes(category)) throw new Error('Unsupported source category')
  const a = adapterFor(adapterKey)
  const canonical = canonicalUrl(url, adapterKey)
  if (!new URL(canonical).pathname.startsWith(a.listingPrefix)) throw new Error('Listing URL outside the approved source section')
  const title = firstHeading(html) || 'Untitled'
  const lines = cleanLines(html)
  const media = []
  for (const src of attrValues(String(html || ''), 'img', 'src')) {
    let abs
    try { abs = new URL(src, canonical) } catch { continue }
    if (abs.protocol === 'https:' && a.hosts.includes(abs.hostname.toLowerCase()) && abs.pathname.startsWith(a.mediaPrefix) && !media.includes(abs.href)) media.push(abs.href)
  }
  const price = selectPrice(lines, category)
  const dates = [...new Set(lines.flatMap(l => [...l.matchAll(DATE_RE)].map(m => m[1])))]
  let bedrooms = BEDS_RE.test(title) ? Number(BEDS_RE.exec(title)[1]) : null
  const bedsLabel = labelledValue(lines, 'bedrooms'); if (bedsLabel && /^\d+$/.test(bedsLabel)) bedrooms = Number(bedsLabel)
  const bathsLabel = labelledValue(lines, 'bathrooms'); const bathrooms = bathsLabel && /^\d+$/.test(bathsLabel) ? Number(bathsLabel) : null
  const address = labelledValue(lines, 'property address')
  const areaLabel = labelledValue(lines, 'total area'); const area = areaLabel && /\b(\d+(?:\.\d+)?)\s*sqm\b/i.exec(areaLabel)
  const typeMatch = TYPE_RE.exec(title)
  const foreign = FOREIGN_MARKERS.exec(`${title}\n${lines.slice(0, 80).join('\n')}`)
  return {
    external_id: externalRef(canonical),
    source_url: canonical,
    source_domain: a.canonicalHost,
    category,
    title,
    locality: localityFromTitle(title),
    property_type: typeMatch ? typeMatch[1].toLowerCase() : null,
    bedrooms, bathrooms,
    available_from_source: dates[0] || null,
    available_date: maltaDate(dates[0]),
    available_from_conflict: dates.length > 1,
    private_address_candidate: address ? address.slice(0, 300) : null,
    total_area_sqm: area ? Number(area[1]) : null,
    price,
    media_source_urls: media, // references only — not a licence to republish
    market_country: foreign ? 'OUTSIDE_MALTA' : 'MALTA',
    market_evidence: foreign ? foreign[0] : null,
    availability_state: 'SOURCE_LISTED_UNVERIFIED',
    source_evidence: { source_url: canonical, price_evidence: price.candidate_prices.map(c => c.evidence) },
  }
}

// Field fingerprint of stable listing facts; page chrome changes never count.
const WATCHED = ['category', 'title', 'bedrooms', 'bathrooms', 'available_from_source', 'private_address_candidate', 'total_area_sqm', 'price_amount', 'price_basis', 'price_candidates', 'media_source_urls', 'availability_state', 'market_country']
function watchedFacts(item) {
  return {
    category: item.category ?? null, title: item.title ?? null, bedrooms: item.bedrooms ?? null, bathrooms: item.bathrooms ?? null,
    available_from_source: item.available_from_source ?? null, private_address_candidate: item.private_address_candidate ?? null,
    total_area_sqm: item.total_area_sqm ?? (item.total_area ? Number(String(item.total_area).replace(/[^\d.]/g, '')) || null : null),
    price_amount: item.price?.amount ?? null, price_basis: item.price?.basis ?? null,
    price_candidates: (item.price?.candidate_prices || []).map(c => `${c.amount}/${c.basis}`).sort(),
    media_source_urls: [...(item.media_source_urls || [])], availability_state: item.availability_state ?? null,
    market_country: item.market_country ?? 'MALTA',
  }
}
function fingerprint(item) {
  const f = watchedFacts(item)
  return crypto.createHash('sha256').update(JSON.stringify(WATCHED.map(k => [k, f[k]]))).digest('hex')
}
function fieldChanges(previous, current) {
  const a = watchedFacts(previous || {}), b = watchedFacts(current || {})
  const out = {}
  for (const k of WATCHED) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out[k] = { previous: a[k], current: b[k] }
  return out
}
function classifyChange(changes) {
  const keys = Object.keys(changes)
  if (!keys.length) return 'UNCHANGED'
  if (keys.some(k => k.startsWith('price_'))) return 'PRICE_UPDATED'
  if (keys.includes('availability_state') || keys.includes('available_from_source')) return 'AVAILABILITY_CHANGED'
  if (keys.length === 1 && keys[0] === 'media_source_urls') return 'MEDIA_CHANGED'
  return 'DETAILS_CHANGED'
}

// Shared/agent views never see the private address, raw media or evidence prose.
function sanitizedPreview(item) {
  const p = JSON.parse(JSON.stringify(item || {}))
  delete p.private_address_candidate; delete p.media_source_urls; delete p.source_evidence
  if (p.price) p.price = { amount: p.price.amount, basis: p.price.basis, review_required: p.price.review_required, conflict: !!p.price.conflict, quote_count: (p.price.candidate_prices || []).length }
  return p
}

module.exports = {
  ADAPTERS, CATEGORIES, adapterFor, canonicalUrl, validateRegistration,
  cleanLines, decodeEntities, amount, candidatePrices, selectPrice,
  linksFromCategory, parseDetail, localityFromTitle, maltaDate, externalRef,
  fingerprint, fieldChanges, classifyChange, sanitizedPreview, watchedFacts,
}
