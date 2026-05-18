// Category descriptors + fallback copy for SEO location/category pages.
// Each descriptor: slug, label, matches() predicate, h1/title/description templates.

import type { SeoProperty } from './filters'
import { toNumber } from './filters'

export interface CategoryDescriptor {
  slug: string
  aliases?: string[]
  kind: 'bedroom' | 'feature' | 'budget' | 'type'
  label: string
  h1: string
  title: string
  description: string
  intro: string
  matches: (p: SeoProperty) => boolean
}

const isApartmentLike = (p: SeoProperty) => {
  const t = (p.propertyType || '').toLowerCase()
  return t === 'apartment' || t === 'penthouse' || t === 'maisonette' || t === 'studio'
}

const isHouseLike = (p: SeoProperty) => {
  const t = (p.propertyType || '').toLowerCase()
  return (
    t === 'semi-detached villa' ||
    t === 'detached villa' ||
    t === 'townhouse' ||
    t === 'terraced house' ||
    t === 'farmhouse' ||
    t === 'villa'
  )
}

const matchesFeature = (p: SeoProperty, patterns: RegExp[]) => {
  const haystack = [
    p.summary,
    p.description,
    p.fullDescription,
    p.title,
    ...(p.features || []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return patterns.some(re => re.test(haystack))
}

export const CATEGORY_DESCRIPTORS: CategoryDescriptor[] = [
  // ---- bedrooms ----
  {
    slug: 'studio-apartments-malta',
    kind: 'bedroom',
    label: 'Studio apartments',
    h1: 'Studio Apartments for Rent in Malta',
    title: 'Studio Apartments for Rent in Malta | 2906 Estate',
    description:
      'Studio apartments for rent across Malta. Browse current studio rentals updated regularly by 2906 Estate.',
    intro:
      'Studio apartments for rent in Malta. 2906 Estate keeps an updated list of compact, well-located studios across Sliema, St Julian’s, Gzira and central Malta.',
    matches: p => isApartmentLike(p) && ((p.bedrooms ?? 0) === 0 || /studio/i.test(p.propertyType || '')),
  },
  {
    slug: '1-bedroom-apartments-malta',
    kind: 'bedroom',
    label: '1 bedroom apartments',
    h1: '1 Bedroom Apartments for Rent in Malta',
    title: '1 Bedroom Apartments for Rent in Malta | 2906 Estate',
    description:
      '1 bedroom apartments for rent in Malta. Current one-bedroom rentals across Malta and Gozo, updated regularly by 2906 Estate.',
    intro:
      'Browse one-bedroom rental apartments across Malta. 2906 Estate updates listings regularly across Sliema, St Julian’s, Gzira, Msida and central locations.',
    matches: p => isApartmentLike(p) && (p.bedrooms ?? 0) === 1,
  },
  {
    slug: '2-bedroom-apartments-malta',
    kind: 'bedroom',
    label: '2 bedroom apartments',
    h1: '2 Bedroom Apartments for Rent in Malta',
    title: '2 Bedroom Apartments for Rent in Malta | 2906 Estate',
    description:
      '2 bedroom apartments for rent across Malta. Updated regularly by 2906 Estate.',
    intro:
      'Two-bedroom rental apartments across Malta. Apartments, penthouses and maisonettes updated regularly by 2906 Estate.',
    matches: p => isApartmentLike(p) && (p.bedrooms ?? 0) === 2,
  },
  {
    slug: '3-bedroom-apartments-malta',
    kind: 'bedroom',
    label: '3 bedroom apartments',
    h1: '3 Bedroom Apartments for Rent in Malta',
    title: '3 Bedroom Apartments for Rent in Malta | 2906 Estate',
    description:
      '3 bedroom apartments for rent across Malta. Updated regularly by 2906 Estate.',
    intro:
      'Three-bedroom rental apartments across Malta. Family-sized apartments, penthouses and maisonettes across all regions.',
    matches: p => isApartmentLike(p) && (p.bedrooms ?? 0) === 3,
  },
  {
    slug: '4-bedroom-apartments-malta',
    kind: 'bedroom',
    label: '4 bedroom apartments',
    h1: '4 Bedroom Apartments for Rent in Malta',
    title: '4 Bedroom Apartments for Rent in Malta | 2906 Estate',
    description:
      '4 bedroom apartments and penthouses for rent across Malta. Updated regularly by 2906 Estate.',
    intro:
      'Four-bedroom rental apartments and penthouses across Malta. Larger residences for families or shared accommodation.',
    matches: p => isApartmentLike(p) && (p.bedrooms ?? 0) >= 4,
  },

  // ---- feature ----
  {
    slug: 'luxury-apartments-malta',
    kind: 'feature',
    label: 'Luxury apartments',
    h1: 'Luxury Apartments for Rent in Malta',
    title: 'Luxury Apartments for Rent in Malta | 2906 Estate',
    description:
      'Luxury apartments for rent in Malta. Premium residences across Sliema, St Julian’s and prime locations, curated by 2906 Estate.',
    intro:
      'Premium apartments and penthouses for rent in Malta. The 2906 Estate Aesthetics collection focuses on higher-end residences in prime locations.',
    matches: p => {
      const cat = (p.category || '').toLowerCase()
      if (cat === 'aesthetics') return true
      const price = toNumber(p.price)
      return price >= 2500 && isApartmentLike(p)
    },
  },
  {
    slug: 'seafront-apartments-malta',
    kind: 'feature',
    label: 'Seafront apartments',
    h1: 'Seafront Apartments for Rent in Malta',
    title: 'Seafront Apartments for Rent in Malta | 2906 Estate',
    description:
      'Seafront and sea-view apartments for rent in Malta. Current coastal rentals updated regularly by 2906 Estate.',
    intro:
      'Seafront and sea-view rental apartments in Malta. Properties along the coast in Sliema, St Julian’s, Gzira, Marsascala, Bugibba and other coastal villages.',
    matches: p =>
      isApartmentLike(p) &&
      matchesFeature(p, [/sea\s*front/, /seaview/, /sea\s*view/, /direct sea/, /front\s*line\s*sea/]),
  },
  {
    slug: 'pet-friendly-apartments-malta',
    kind: 'feature',
    label: 'Pet-friendly apartments',
    h1: 'Pet-Friendly Apartments for Rent in Malta',
    title: 'Pet-Friendly Apartments for Rent in Malta | 2906 Estate',
    description:
      'Pet-friendly rental apartments in Malta. Listings that explicitly allow pets, updated regularly by 2906 Estate.',
    intro:
      'Rental apartments in Malta where pets are explicitly accepted. Always confirm pet policy with the agent before signing.',
    matches: p => matchesFeature(p, [/pet[s]?\s*friendly/, /pets?\s+(allowed|welcome|accepted)/]),
  },
  {
    slug: 'furnished-apartments-malta',
    kind: 'feature',
    label: 'Furnished apartments',
    h1: 'Furnished Apartments for Rent in Malta',
    title: 'Furnished Apartments for Rent in Malta | 2906 Estate',
    description:
      'Furnished apartments for rent in Malta. Move-in ready rentals updated regularly by 2906 Estate.',
    intro:
      'Furnished rental apartments across Malta. Move-in-ready properties with furniture, appliances and ready utilities.',
    matches: p => isApartmentLike(p) && matchesFeature(p, [/furnished/, /fully\s+equipped/, /fully\s+furnished/]),
  },
  {
    slug: 'penthouses-malta',
    aliases: ['penthouse-apartments-malta'],
    kind: 'type',
    label: 'Penthouses',
    h1: 'Penthouses for Rent in Malta',
    title: 'Penthouses for Rent in Malta | 2906 Estate',
    description:
      'Penthouses for rent across Malta. Top-floor residences with terraces and views, updated regularly by 2906 Estate.',
    intro:
      'Penthouses for rent across Malta. Top-floor apartments with private terraces, often with sea or city views.',
    matches: p => (p.propertyType || '').toLowerCase() === 'penthouse',
  },
  {
    slug: 'villas-malta',
    aliases: ['villas-and-houses-malta'],
    kind: 'type',
    label: 'Villas and houses',
    h1: 'Villas and Houses for Rent in Malta',
    title: 'Villas and Houses for Rent in Malta | 2906 Estate',
    description:
      'Villas, townhouses and houses for rent across Malta. Updated regularly by 2906 Estate.',
    intro:
      'Villas, townhouses, maisonettes and farmhouses for rent across Malta. Standalone homes with outdoor space, often in quieter villages.',
    matches: p => isHouseLike(p),
  },

  // ---- budget ----
  {
    slug: 'apartments-under-1500-malta',
    kind: 'budget',
    label: 'Apartments under €1,500',
    h1: 'Apartments for Rent Under €1,500 in Malta',
    title: 'Apartments for Rent Under €1,500 in Malta | 2906 Estate',
    description:
      'Apartments for rent under €1,500/month in Malta. Updated regularly by 2906 Estate.',
    intro:
      'Rental apartments in Malta priced under €1,500 per month. Budget-conscious one and two-bedroom rentals across all regions.',
    matches: p => isApartmentLike(p) && toNumber(p.price) > 0 && toNumber(p.price) < 1500,
  },
  {
    slug: 'apartments-under-2000-malta',
    kind: 'budget',
    label: 'Apartments under €2,000',
    h1: 'Apartments for Rent Under €2,000 in Malta',
    title: 'Apartments for Rent Under €2,000 in Malta | 2906 Estate',
    description:
      'Apartments for rent under €2,000/month in Malta. Updated regularly by 2906 Estate.',
    intro:
      'Rental apartments in Malta priced under €2,000 per month. Mid-range rentals across Sliema, St Julian’s, central Malta and the north.',
    matches: p => isApartmentLike(p) && toNumber(p.price) > 0 && toNumber(p.price) < 2000,
  },
  {
    slug: 'apartments-under-2500-malta',
    kind: 'budget',
    label: 'Apartments under €2,500',
    h1: 'Apartments for Rent Under €2,500 in Malta',
    title: 'Apartments for Rent Under €2,500 in Malta | 2906 Estate',
    description:
      'Apartments for rent under €2,500/month in Malta. Updated regularly by 2906 Estate.',
    intro:
      'Rental apartments in Malta priced under €2,500 per month. Higher-spec rentals across prime locations.',
    matches: p => isApartmentLike(p) && toNumber(p.price) > 0 && toNumber(p.price) < 2500,
  },
  {
    slug: 'apartments-under-3000-malta',
    kind: 'budget',
    label: 'Apartments under €3,000',
    h1: 'Apartments for Rent Under €3,000 in Malta',
    title: 'Apartments for Rent Under €3,000 in Malta | 2906 Estate',
    description:
      'Apartments for rent under €3,000/month in Malta. Updated regularly by 2906 Estate.',
    intro:
      'Rental apartments in Malta priced under €3,000 per month. Higher-end residences across prime coastal and central locations.',
    matches: p => isApartmentLike(p) && toNumber(p.price) > 0 && toNumber(p.price) < 3000,
  },
]

export function locationFallbackIntro(locationName: string): string {
  return `Browse available rental properties in ${locationName}, Malta. 2906 Estate updates listings regularly across apartments, penthouses, maisonettes, villas and selected luxury homes.`
}

export function locationH1(locationName: string): string {
  return `Apartments for Rent in ${locationName}, Malta`
}

export function locationTitle(locationName: string): string {
  return `Apartments for Rent in ${locationName}, Malta | 2906 Estate`
}

export function locationDescription(locationName: string): string {
  return `Apartments and properties for rent in ${locationName}, Malta. Current listings curated by 2906 Estate, updated regularly.`
}

// Generic FAQ items used on category/location pages
export function defaultFaq(label: string): { q: string; a: string }[] {
  return [
    {
      q: `How often are ${label.toLowerCase()} listings updated?`,
      a: '2906 Estate updates listings as properties become available or rented, typically daily. Listings marked Rented are removed from indexed pages.',
    },
    {
      q: 'How do I arrange a viewing?',
      a: 'Tap WhatsApp on any listing to message the 2906 Estate team directly. Viewings are usually arranged within 24–48 hours.',
    },
    {
      q: 'Are agency fees charged to tenants?',
      a: 'Standard Malta market practice is one month of rent plus VAT as agency commission, paid by the tenant on contract signature. Confirm exact terms with the agent.',
    },
  ]
}
