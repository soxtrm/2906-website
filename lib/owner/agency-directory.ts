// Real estate agencies in Malta and Gozo, for the owner's "who may sell or let
// my home" picker. Researched 19 Nov 2026 from public sources (agency sites,
// malta-homes.com/agencies, djar.ai guide, gov.mt). Biggest first so owners
// pick them quickly; then freelance agents; then everyone else. Agencies can
// register themselves and upload their own logo; until then a monogram is
// shown (no copied logos). Listing an agency here says nothing about whether it
// is connected to ARGUS: `connected` comes from the agency's own sign-up.

export type Focus = 'rentals' | 'sales' | 'commercial' | 'luxury' | 'gozo'
export interface DirectoryAgency {
  id: string
  name: string
  tier: 'major' | 'other'
  focus: Focus[]
  note: string
  color: string
  site?: string
}

export const DIRECTORY: DirectoryAgency[] = [
  { id: 'frank-salt', name: 'Frank Salt', tier: 'major', focus: ['sales', 'rentals', 'commercial'], note: 'Since 1969, 20+ branches, own commercial team', color: '#0d3b66', site: 'franksalt.com.mt' },
  { id: 'remax', name: 'RE/MAX Malta', tier: 'major', focus: ['sales', 'rentals', 'commercial'], note: 'Franchise, 250+ associates island-wide', color: '#c8102e', site: 'remax-malta.com' },
  { id: 'dhalia', name: 'Dhalia', tier: 'major', focus: ['sales', 'rentals', 'commercial'], note: 'Since 1982, about 15 offices in Malta and Gozo', color: '#1b4d89', site: 'dhalia.com' },
  { id: 'quicklets', name: 'QuickLets', tier: 'major', focus: ['rentals'], note: 'Lettings arm of the Zanzi Homes group', color: '#e4002b' },
  { id: 'zanzi', name: 'Zanzi Homes', tier: 'major', focus: ['sales'], note: 'Sales arm of the group, about 36 offices with QuickLets', color: '#00857c' },
  { id: 'alliance', name: 'Alliance Real Estate', tier: 'major', focus: ['sales', 'rentals'], note: '25 branches, 300+ advisors', color: '#002f6c' },
  { id: 'simon-mamo', name: 'Simon Mamo Real Estate', tier: 'major', focus: ['sales', 'rentals'], note: 'Family-run since 1987', color: '#7a1f2b' },
  { id: 'belair', name: 'Belair Property', tier: 'major', focus: ['sales', 'rentals', 'gozo'], note: 'Since 1967, branches in Malta and Gozo', color: '#1f6f8b' },
  { id: 'perry', name: 'Perry', tier: 'major', focus: ['sales', 'rentals'], note: 'Personal service, experienced local agents', color: '#2d2d2d' },
  { id: 'ev-sara-grech', name: 'Engel & Völkers Sara Grech', tier: 'major', focus: ['sales', 'rentals', 'luxury'], note: 'Formerly SaraGrech, Engel & Völkers since 2013', color: '#b40000' },
  { id: 'sothebys', name: "Malta Sotheby's International Realty", tier: 'major', focus: ['luxury', 'sales'], note: 'Since 2013, high-end homes', color: '#002349' },
  { id: 'christies', name: "Christie's International Real Estate Malta", tier: 'major', focus: ['luxury', 'commercial'], note: 'Luxury homes and commercial advice', color: '#8b0000' },
  { id: 'benestates', name: 'Benestates', tier: 'major', focus: ['rentals', 'commercial'], note: 'Offices, shops, restaurants, warehouses and homes', color: '#14532d', site: 'benestates.com' },
  { id: 'excel', name: 'Excel Homes', tier: 'other', focus: ['sales', 'rentals'], note: 'Sales and lettings', color: '#5b21b6' },
  { id: 'gozo-prime', name: 'Gozo Prime', tier: 'other', focus: ['gozo', 'sales', 'rentals', 'commercial'], note: 'Gozo specialist, office in Victoria', color: '#0e7490' },
  { id: '77-great-estates', name: '77 Great Estates', tier: 'other', focus: ['sales', 'rentals', 'commercial'], note: 'Residential and commercial, own magazine', color: '#9a3412' },
]

export const FOCUS_LABEL: Record<Focus, string> = { rentals: 'Rentals', sales: 'Sales', commercial: 'Commercial', luxury: 'Luxury', gozo: 'Gozo' }

export const monogram = (name: string) =>
  name.replace(/[^A-Za-z0-9& ]/g, ' ').split(/\s+/).filter(w => w && !['Malta', 'Real', 'Estate', 'International', 'Realty', 'Property'].includes(w))
    .slice(0, 2).map(w => w[0]).join('').toUpperCase() || name[0]

/** for an owner who rents out, the rental and all-round agencies come first */
export function rankFor(list: DirectoryAgency[], wants: Focus[]) {
  const score = (a: DirectoryAgency) => (a.tier === 'major' ? 100 : 0) + a.focus.filter(f => wants.includes(f)).length * 10
  return [...list].sort((a, b) => score(b) - score(a) || DIRECTORY.indexOf(a) - DIRECTORY.indexOf(b))
}
