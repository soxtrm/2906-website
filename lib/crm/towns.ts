// ============================================================================
// lib/crm/towns.ts — canonical Malta towns + coordinates for the Schedule Board
//
// WHY THIS EXISTS
//   `properties.town` is free text and the same place is stored several ways:
//   "St Paul's Bay", "St Paul’s Bay", "St. Paul's Bay", "St. Pauls Bay" and
//   "St Paul's Bay / Qawra" are all in the live table, as are Gzira/Gżira,
//   San Gwann/San Ġwann, Mellieha/Mellieħa and Mgarr/Mġarr. Without folding
//   them, one village becomes five map pins and a village filter silently
//   misses most of its own listings.
//
//   There is deliberately no lat/lng column on `properties` (town-level
//   precision is the point — the board must never pinpoint an address), so
//   coordinates live here as a static table. That also means zero Geocoding
//   API calls at runtime: the Maps bill is the map tiles only.
// ============================================================================

export type TownCoord = { label: string; lat: number; lng: number }

// Combining accent range, built from escapes so the source stays ASCII-safe.
const COMBINING = new RegExp('[\\u0300-\\u036f]', 'g')

// Fold diacritics, punctuation and case so "Ta’ Xbiex" and "Ta' Xbiex" agree.
function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(COMBINING, '')
    .replace(/[ħĦ]/g, 'h')            // Maltese ħ is not a combining form
    .replace(/[żŻ]/g, 'z')
    .replace(/[ġĠ]/g, 'g')
    .replace(/[ċĊ]/g, 'c')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// Folded form → canonical key. Only entries that do NOT already fold to their
// canonical key need listing here (compound and parenthesised names).
const ALIASES: Record<string, string> = {
  'bormla cospicua': 'bormla',
  'swatar birkirkara': 'swatar',
  'ibragg swieqi': 'ibragg',
  'ta l ibragg': 'ibragg',
  'ibrag': 'ibragg',
  'st julian s balluta': 'st julians',
  'st julian s': 'st julians',
  'st paul s bay qawra': 'st pauls bay',
  'st paul s bay': 'st pauls bay',
  'st pauls bay qawra': 'st pauls bay',
  'saint pauls bay': 'st pauls bay',
}

// Canonical key → display label + town-centre coordinates.
export const TOWNS: Record<string, TownCoord> = {
  'attard':          { label: 'Attard',            lat: 35.8917, lng: 14.4425 },
  'bahar ic caghaq': { label: 'Baħar iċ-Ċagħaq',    lat: 35.9384, lng: 14.4586 },
  'balzan':          { label: 'Balzan',             lat: 35.8956, lng: 14.4531 },
  'birkirkara':      { label: 'Birkirkara',         lat: 35.8972, lng: 14.4611 },
  'bormla':          { label: 'Bormla',             lat: 35.8836, lng: 14.5297 },
  'gharghur':        { label: 'Għargħur',           lat: 35.9231, lng: 14.4531 },
  'gzira':           { label: 'Gżira',              lat: 35.9042, lng: 14.4897 },
  'hamrun':          { label: 'Ħamrun',             lat: 35.8853, lng: 14.4842 },
  'ibragg':          { label: 'Ibraġġ',             lat: 35.9236, lng: 14.4842 },
  'iklin':           { label: 'Iklin',              lat: 35.9058, lng: 14.4525 },
  'kalkara':         { label: 'Kalkara',            lat: 35.8894, lng: 14.5325 },
  'kappara':         { label: 'Kappara',            lat: 35.9019, lng: 14.4744 },
  'lija':            { label: 'Lija',               lat: 35.9008, lng: 14.4453 },
  'madliena':        { label: 'Madliena',           lat: 35.9264, lng: 14.4772 },
  'marsaskala':      { label: 'Marsaskala',         lat: 35.8622, lng: 14.5661 },
  'mellieha':        { label: 'Mellieħa',           lat: 35.9564, lng: 14.3625 },
  'mgarr':           { label: 'Mġarr',              lat: 35.9192, lng: 14.3661 },
  'mosta':           { label: 'Mosta',              lat: 35.9092, lng: 14.4256 },
  'mqabba':          { label: 'Mqabba',             lat: 35.8497, lng: 14.4664 },
  'msida':           { label: 'Msida',              lat: 35.8956, lng: 14.4842 },
  'naxxar':          { label: 'Naxxar',             lat: 35.9139, lng: 14.4433 },
  'paola':           { label: 'Paola',              lat: 35.8722, lng: 14.4989 },
  'pieta':           { label: 'Pietà',              lat: 35.8933, lng: 14.4939 },
  'qawra':           { label: 'Qawra',              lat: 35.9539, lng: 14.4197 },
  'rabat':           { label: 'Rabat',              lat: 35.8811, lng: 14.3983 },
  'san gwann':       { label: 'San Ġwann',          lat: 35.9075, lng: 14.4783 },
  'siggiewi':        { label: 'Siġġiewi',           lat: 35.8558, lng: 14.4364 },
  'sliema':          { label: 'Sliema',             lat: 35.9122, lng: 14.5019 },
  'st julians':      { label: "St Julian's",        lat: 35.9186, lng: 14.4894 },
  'st pauls bay':    { label: "St Paul's Bay",      lat: 35.9500, lng: 14.4014 },
  'swatar':          { label: 'Swatar',             lat: 35.8944, lng: 14.4692 },
  'swieqi':          { label: 'Swieqi',             lat: 35.9203, lng: 14.4808 },
  'ta xbiex':        { label: "Ta' Xbiex",          lat: 35.8992, lng: 14.4931 },
  'tigne':           { label: 'Tigné',              lat: 35.9114, lng: 14.5089 },
  'valletta':        { label: 'Valletta',           lat: 35.8989, lng: 14.5146 },
  'wardija':         { label: 'Wardija',            lat: 35.9375, lng: 14.3833 },
  'xemxija':         { label: 'Xemxija',            lat: 35.9497, lng: 14.3839 },
  'zabbar':          { label: 'Żabbar',             lat: 35.8756, lng: 14.5361 },
}

/** Free-text town → canonical key. Returns null for unmappable values
 *  (the live table contains a literal "Malta", which is not a town). */
export function townKey(raw?: string | null): string | null {
  if (!raw) return null
  const f = fold(raw)
  if (!f) return null
  const key = ALIASES[f] || f
  return TOWNS[key] ? key : null
}

export function townLabel(raw?: string | null): string {
  const k = townKey(raw)
  return k ? TOWNS[k].label : (raw || '—')
}

export function townCoord(raw?: string | null): TownCoord | null {
  const k = townKey(raw)
  return k ? TOWNS[k] : null
}

/** Deterministic spread for several listings sharing one town centre.
 *  Must not use Math.random — the marker set is rebuilt on every filter
 *  change and pins jumping around reads as a bug. ~120 m ring. */
export function spread(base: TownCoord, index: number, total: number) {
  if (total <= 1) return { lat: base.lat, lng: base.lng }
  const golden = 2.399963229728653 // radians, keeps successive points apart
  const angle = index * golden
  const radius = 0.0009 * Math.sqrt(index + 1)
  return {
    lat: base.lat + radius * Math.sin(angle),
    lng: base.lng + radius * Math.cos(angle) * 1.22, // lng degrees are shorter at 35°N
  }
}
