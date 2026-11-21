// NEXUS Marketplace shared model (2026-11-21): one listing shape for Studios, the NEXUS App and Booking.
// Relationships: listing -> provider (agency + listing agent, or later the owner directly). Owner identity and
// contact data are never part of a public listing. Agency associations come only from the source system
// (ARGUS instance = agency 2906); nothing is inferred. Cooperation terms are shown only once agreed.
import { buildLifeOverview, type NexusPlace, type PropertyLifeOverview } from '@/lib/nexus-property-context'
import { cooperationFor } from './cooperation'

// verified = the listings come from the agency's own system (its ARGUS instance), not from scraping or a third party
export type Agency = { key: string; name: string; verified: boolean; verifiedBasis: string; logo: string | null; website: string | null; island: string }
export type Agent = { id: number; name: string }
export type Provider =
  | { kind: 'agency'; agency: Agency; agent: Agent | null }
  | { kind: 'owner_direct' }                        // not used yet: direct-from-owner listings come with the upload assistant
  | { kind: 'unconfirmed' }                         // reference not from a registered agency: no agency or owner is claimed
// Co-agency terms appear only once the listing agency has agreed them in writing (lib/marketplace/cooperation.ts).
export type Cooperation =
  | { status: 'not_published'; note: string }
  | { status: 'confirmed'; headline: string; basis: string; conditions: string[]; agreedAt: string; reference: string }

// Agencies whose inventory this marketplace shows. Source: the ARGUS instance itself, not a guess.
export const AGENCIES: Record<string, Agency> = {
  '2906': { key: '2906', name: '2906 Estate', verified: true, verifiedBasis: 'Listings come directly from the agency’s own ARGUS system.', logo: '/logo-wide.png', website: 'https://www.2906.estate', island: 'Malta & Gozo' },
}

export type Market = 'longlets' | 'stays' | 'sales'
export type SmartFact = { key: 'shop' | 'coast' | 'health' | 'gym'; label: string; name: string; km: number }
// Feature dictionary (ARGUS nexus_feature_dictionary, standard entries): labels, aliases, and the ARGUS tag each maps to.
export type FeatureEntry = { key: string; label: string; group: string; kind: 'boolean' | 'count' | 'choice'; filterable: boolean; aliases: string[] }
export type Dict = { entries: FeatureEntry[]; byTag: Record<string, string> }
export const toDict = (entries: (FeatureEntry & { argusTag?: string | null })[]): Dict => ({ entries, byTag: Object.fromEntries(entries.filter(e => e.argusTag).map(e => [e.argusTag as string, e.key])) })
export type Evidenced = { key: string; label: string; text: string; evidence: 'agent_confirmed' | 'document' | 'verified'; evidenceLabel: string }
export type Availability = { kind: 'now' | 'confirmed' | 'from'; label: string; from: string | null }

export type ListingCard = {
  id: string
  title: string
  market: Market
  marketLabel: string
  propertyType: string | null
  area: string
  areaKey: string
  regions: string[]
  price: number | null
  pricePeriod: 'month' | 'night' | null
  bedrooms: number | null
  bathrooms: number | null
  size: number | null
  images: string[]
  imageCount: number
  availability: Availability
  updatedAt: string | null
  features: string[]
  featureKeys: string[]
  evidenced: Evidenced[]
  smart: SmartFact[]
  provider: Provider
  cooperation: Cooperation
}
export type ListingDetail = ListingCard & { description: string | null; allImages: string[]; overview: PropertyLifeOverview | null; locationNote: string }

type Raw = Record<string, any>
const TYPE: Record<string, string> = { apartment: 'apartment', penthouse: 'penthouse', house: 'house', maisonette: 'maisonette', villa: 'villa', townhouse: 'townhouse', studio: 'studio' }
const MARKET_LABEL: Record<Market, string> = { longlets: 'Long let', stays: 'Short let', sales: 'For sale' }
const FEATURE_LABEL: Record<string, string> = {
  sea_view: 'Sea view', seafront: 'Seafront', pool: 'Pool', terrace: 'Terrace', balcony: 'Balcony', garden: 'Garden', lift: 'Lift', air_conditioning: 'Air conditioning',
  furnished: 'Furnished', parking: 'Parking', garage: 'Garage', garage_or_parking: 'Parking', gym: 'Gym', jacuzzi: 'Jacuzzi', rooftop_access: 'Roof access', pets: 'Pets considered',
  concierge: 'Concierge', fireplace: 'Fireplace', study: 'Study', bathtub: 'Bathtub',
}

// Cloudinary listing photos are public on purpose; ask for a card-sized, compressed variant.
export const sized = (url: string, w: number) => (/res\.cloudinary\.com\/[^/]+\/image\/upload\//.test(url) ? url.replace('/image/upload/', `/image/upload/w_${w},q_auto,f_auto,c_limit/`) : url)

export function titleOf(p: Raw) {
  // Title Case for room and property words ("2-Bedroom Apartment in Sliema"), Kev 21 Nov 2026
  const t = TYPE[String(p.propertyType || '').toLowerCase()] || 'home'
  const beds = Number(p.bedrooms)
  return `${beds > 0 && t !== 'studio' ? `${beds}-Bedroom ` : ''}${t[0].toUpperCase()}${t.slice(1)} in ${p.areaLabel || 'Malta'}`
}

function availabilityOf(p: Raw): Availability {
  const from = p.availableFrom ? String(p.availableFrom).slice(0, 10) : null
  const future = from && new Date(from).getTime() > Date.now() + 86400e3
  if (p.status === 'upcoming' || future) return { kind: 'from', label: from ? `From ${new Date(from).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : 'Coming soon', from }
  if (p.status === 'available_confirmed') return { kind: 'confirmed', label: 'Available · confirmed', from }
  return { kind: 'now', label: 'Available', from }
}

function smartOf(overview: PropertyLifeOverview | null): SmartFact[] {
  if (!overview) return []
  const pick = (key: string, role: string | null, label: string, out: SmartFact['key'], max: number) => {
    const c = overview.categories.find(x => x.key === key)
    const p = c?.places.find(x => !role || x.role === role)
    return p && p.distanceKm <= max ? [{ key: out, label, name: p.name, km: Math.round(p.distanceKm * 10) / 10 }] : []
  }
  return [...pick('groceries', 'weekly-shop', 'Supermarket', 'shop', 3), ...pick('coast', null, 'Sea', 'coast', 3), ...pick('health', null, 'Health', 'health', 3), ...pick('movement', 'gym', 'Gym', 'gym', 3)]
}

export function providerOf(p: Raw): Provider {
  const agency = AGENCIES[String(p.id || '').split('-')[0]] || null
  const agent = p.listedBy && Number.isFinite(Number(p.listedBy.id)) ? { id: Number(p.listedBy.id), name: String(p.listedBy.displayName || 'Agent') } : null
  return agency ? { kind: 'agency', agency, agent } : { kind: 'unconfirmed' }
}


function evidencedOf(p: Raw): Evidenced[] {
  return (Array.isArray(p.features) ? p.features : []).map((f: Raw) => ({
    key: String(f.key), label: String(f.label),
    text: f.kind === 'count' ? `${f.value} ${String(f.label).toLowerCase()}` : f.kind === 'choice' ? String(f.value).replace(/_/g, ' ').replace(/^./, (c: string) => c.toUpperCase()) : String(f.label),
    evidence: f.evidence, evidenceLabel: String(f.evidenceLabel || 'Confirmed by the agency'),
  }))
}

export function toCard(p: Raw, places: NexusPlace[], dict?: Dict): ListingCard {
  const market: Market = p.market === 'stays' ? 'stays' : p.market === 'sales' ? 'sales' : 'longlets'
  const images: string[] = Array.isArray(p.images) ? p.images.filter((x: unknown) => typeof x === 'string') : []
  let overview: PropertyLifeOverview | null = null
  if (Array.isArray(p.coordinates) && p.coordinates.length === 2) { try { overview = buildLifeOverview(p as never, places) } catch { overview = null } }
  const facts = p.featureFacts && typeof p.featureFacts === 'object' ? p.featureFacts : {}
  const evidenced = evidencedOf(p)
  const knownTags = Object.entries(facts).filter(([, v]: [string, any]) => v?.status === 'KNOWN' && v?.value === true).map(([k]) => k)
  const featureKeys = [...new Set([...evidenced.map(e => e.key), ...knownTags.map(t => dict?.byTag[t] || t)])]
  const provider = providerOf(p)
  return {
    id: String(p.id), title: titleOf(p), market, marketLabel: MARKET_LABEL[market],
    propertyType: TYPE[String(p.propertyType || '').toLowerCase()] || null,
    area: p.areaLabel || 'Malta', areaKey: String(p.area || ''), regions: Array.isArray(p.regions) ? p.regions : [],
    price: Number(p.rent ?? p.price) || null, pricePeriod: p.rentPeriod === 'night' ? 'night' : market === 'sales' ? null : 'month',
    bedrooms: Number.isFinite(Number(p.bedrooms)) ? Number(p.bedrooms) : null, bathrooms: Number.isFinite(Number(p.bathrooms)) ? Number(p.bathrooms) : null,
    size: Number(p.size) || null, images: images.slice(0, 6).map(u => sized(u, 720)), imageCount: images.length,
    availability: availabilityOf(p), updatedAt: p.updatedAt || null,
    features: [...new Set([...evidenced.map(e => e.text), ...knownTags.map(k => FEATURE_LABEL[k]).filter(Boolean)])].slice(0, 6) as string[],
    featureKeys, evidenced,
    smart: smartOf(overview), provider, cooperation: cooperationFor(provider.kind === 'agency' ? provider.agency.key : null),
  }
}

export function toDetail(p: Raw, places: NexusPlace[], dict?: Dict): ListingDetail {
  const card = toCard(p, places, dict)
  let overview: PropertyLifeOverview | null = null
  try { overview = Array.isArray(p.coordinates) ? buildLifeOverview(p as never, places) : null } catch { overview = null }
  const images: string[] = Array.isArray(p.images) ? p.images.filter((x: unknown) => typeof x === 'string') : []
  return {
    ...card, description: p.description ? String(p.description) : null, allImages: images.map(u => sized(u, 1600)), overview,
    locationNote: p.locationDisclosure === 'exact' ? 'Exact location shown.' : `Shown at ${card.area} level for privacy; the exact address follows with a viewing.`,
  }
}
