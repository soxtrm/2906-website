import anchors from '../ops/property-routing/anchors.json'
import placeBindings from '../public/Link/argus-export/place-bindings.json'
export type SmartPriority = 'weekly-shop' | 'swimming' | 'health' | 'gym'

export type NexusPlace = {
  id: string
  name: string
  kind: string
  category?: string
  coordinates: [number, number]
  mapVisible?: boolean
  searchable?: boolean
  quality?: Record<string, unknown>
}

export type NexusInventoryProperty = {
  id: string
  coordinates: [number, number]
  locationDisclosure?: string
  areaLabel?: string
}

export type PlaceDistance = {
  id: string
  coordinates: [number, number]
  name: string
  kind: string
  distanceKm: number
  role: 'weekly-shop' | 'top-up' | 'swimming' | 'health' | 'gym' | 'mobility' | 'school' | 'commute' | 'restaurant' | 'cafe'
  rating?: number | null
  reviews?: number | null
}

export type PropertyLifeOverview = {
  reference: string
  origin: [number, number]
  requestedReference: string
  area: string
  precision: string
  sourceBasis: 'property' | 'locality'
  mappedCount: number
  advantages: string[]
  considerations: string[]
  categories: Array<{
    key: 'groceries' | 'coast' | 'health' | 'movement' | 'school' | 'commute' | 'restaurant' | 'cafe'
    label: string
    summary: string
    places: PlaceDistance[]
  }>
}

type NexusContext = { properties: NexusInventoryProperty[]; places: NexusPlace[] }
let memoryContext: NexusContext | null = null
let memoryContextExpires = 0
let pendingContext: Promise<NexusContext> | null = null

const NEXUS_ORIGIN = process.env.NEXUS_UPSTREAM_URL || 'http://178.104.162.193:3001'
const LARGE_GROCER = /\b(lidl|welbee|greens|pavi|pama|smart supermarket|tower supermarket|scotts|spar|arkadia|queen'?s?|quick)\b/i

const placeRole = (place: NexusPlace): PlaceDistance['role'] | null => {
  const kind = String(place.kind || '').toLowerCase()
  const primaryType = String(place.quality?.primaryType || '').toLowerCase()
  if (kind === 'supermarket' || primaryType === 'supermarket' || LARGE_GROCER.test(place.name)) return 'weekly-shop'
  if (['grocery', 'convenience', 'shopping'].includes(kind)) return 'top-up'
  if (['beach', 'swimming', 'swimming_spot', 'promenade'].includes(kind)) return 'swimming'
  if (['pharmacy', 'medical', 'healthcare', 'hospital', 'doctor'].includes(kind)) return 'health'
  if (kind==='restaurant') return 'restaurant'
  if (kind==='cafe') return 'cafe'
  if (['education', 'school', 'kindergarten'].includes(kind)) return 'school'
  if (['gym', 'outdoor_gym', 'sport', 'park'].includes(kind)) return 'gym'
  if (['bus_stop', 'ferry', 'transit'].includes(kind)) return 'mobility'
  return null
}

export function distanceKm(a: [number, number], b: [number, number]) {
  const toRad = (value: number) => value * Math.PI / 180
  const dLat = toRad(b[1] - a[1])
  const dLon = toRad(b[0] - a[0])
  const lat1 = toRad(a[1])
  const lat2 = toRad(b[1])
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

function nearestPlaces(origin: [number, number], places: NexusPlace[]) {
  return places.flatMap(place => {
    if (!Array.isArray(place.coordinates) || place.coordinates.length !== 2 || place.mapVisible === false || place.searchable === false) return []
    const role = placeRole(place)
    if (!role) return []
    const distance = distanceKm(origin, place.coordinates)
    if (!Number.isFinite(distance) || distance > 12) return []
    const rating = Number(place.quality?.rating)
    const reviews = Number(place.quality?.userRatingCount)
    return [{
      id: place.id,
      coordinates: place.coordinates,
      name: place.name,
      kind: place.kind,
      distanceKm: distance,
      role,
      rating: Number.isFinite(rating) ? rating : null,
      reviews: Number.isFinite(reviews) ? reviews : null,
    } satisfies PlaceDistance]
  }).sort((a, b) => a.distanceKm - b.distanceKm || a.name.localeCompare(b.name))
}

const first = (places: PlaceDistance[], role: PlaceDistance['role'], limit: number, maxKm = 12) =>
  places.filter(place => place.role === role && place.distanceKm <= maxKm).slice(0, limit)

export function buildLifeOverview(property: NexusInventoryProperty, places: NexusPlace[], options?: { requestedReference?: string; sourceBasis?: 'property' | 'locality' }): PropertyLifeOverview {
  const nearby = nearestPlaces(property.coordinates, places)
  const weekly = first(nearby, 'weekly-shop', 4, 8)
  const topUp = first(nearby, 'top-up', 1, 2.5)
  const coast = first(nearby, 'swimming', 3, 8)
  const health = first(nearby, 'health', 3, 5)
  const movement = [...first(nearby, 'gym', 2, 5), ...first(nearby, 'mobility', 2, 2)].sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 3)
  const advantages: string[] = []
  const considerations: string[] = []

  if (weekly[0]) advantages.push(`${weekly[0].name} gives a mapped weekly-shop option about ${weekly[0].distanceKm.toFixed(1)} km away.`)
  if (topUp[0] && topUp[0].distanceKm <= 1) advantages.push(`${topUp[0].name} covers quick essentials within roughly ${topUp[0].distanceKm.toFixed(1)} km.`)
  if (coast[0] && coast[0].distanceKm <= 2.5) advantages.push(`${coast[0].name} brings the coast within about ${coast[0].distanceKm.toFixed(1)} km.`)
  if (health[0] && health[0].distanceKm <= 2) advantages.push(`${health[0].name} is the nearest mapped health option at about ${health[0].distanceKm.toFixed(1)} km.`)
  if (movement[0] && movement[0].distanceKm <= 1.5) advantages.push(`${movement[0].name} supports everyday movement close to the area.`)

  if (!weekly[0]) considerations.push('A full-size supermarket has not been mapped within 8 km yet.')
  else if (weekly[0].distanceKm > 2.5) considerations.push('The nearest mapped weekly shop is likely more practical by car or delivery.')
  if (!health[0] || health[0].distanceKm > 2) considerations.push('No mapped health option is currently shown within 2 km.')
  if (!movement.some(place => place.role === 'mobility')) considerations.push('A nearby bus or ferry anchor still needs to be connected for this area.')
  if (String(property.locationDisclosure || '').toLowerCase() !== 'exact') considerations.push('Distances start from the privacy-safe area pin; front-door routes can differ.')

  if (!advantages.length) advantages.push('The area is mapped and ready for a personal route comparison.')
  if (!considerations.length) considerations.push('Live traffic and availability still need a final check before deciding.')

  return {
    reference: property.id,
    origin: property.coordinates,
    requestedReference: options?.requestedReference || property.id,
    area: property.areaLabel || 'Malta',
    precision: property.locationDisclosure || 'area',
    sourceBasis: options?.sourceBasis || 'property',
    mappedCount: nearby.filter(place => place.distanceKm <= 3).length,
    advantages: advantages.slice(0, 3),
    considerations: considerations.slice(0, 3),
    categories: [
      {key:'restaurant',label:'Restaurants',summary:'Mapped dining choices; cuisine appears only where supported.',places:first(nearby,'restaurant',24,3)},
      {key:'cafe',label:'Cafés',summary:'Coffee and social stops around the area.',places:first(nearby,'cafe',24,3)},
      { key: 'commute', label: 'The Standards', summary: 'Compare a regular journey. These are area landmarks, not your exact workplace.', places: anchors.map(a => ({id:a.id,name:a.name,coordinates:a.coordinates as [number,number],kind:'destination',role:'commute' as const,distanceKm:distanceKm(property.coordinates,a.coordinates as [number,number])})) },
      { key: 'school', label: 'Schools', summary: 'Mapped education locations; check age range, admission and the exact entrance.', places: first(nearby, 'school', 3, 5) },
      { key: 'groceries', label: 'Weekly shopping', summary: weekly.length ? `${weekly.length} full-size options mapped` : 'Large store coverage incomplete', places: [...weekly, ...topUp] },
      { key: 'coast', label: 'Coast & swimming', summary: coast.length ? `${coast.length} coastal options mapped` : 'No connected coastal option yet', places: coast },
      { key: 'health', label: 'Health', summary: health.length ? `${health.length} nearby options mapped` : 'Health coverage incomplete', places: health },
      { key: 'movement', label: 'Move & connect', summary: movement.length ? `${movement.length} useful anchors mapped` : 'Mobility coverage incomplete', places: movement },
    ],
  }
}

export async function fetchNexusContext() {
  if (memoryContext && Date.now() < memoryContextExpires) return memoryContext
  if (pendingContext) return pendingContext
  pendingContext = Promise.all([
    fetch(`${NEXUS_ORIGIN}/api/nexus/inventory`, { cache: 'no-store' }),
    fetch(`${NEXUS_ORIGIN}/api/nexus/places`, { cache: 'no-store' }),
  ]).then(async ([inventoryResponse, placesResponse]) => {
    if (!inventoryResponse.ok || !placesResponse.ok) throw new Error('Nexus context unavailable')
    const inventory = await inventoryResponse.json()
    const places = await placesResponse.json()
    memoryContext = {
      properties: (inventory.properties || []) as NexusInventoryProperty[],
      places: (places.records || []) as NexusPlace[],
    }
    memoryContextExpires = Date.now() + 15 * 60 * 1000
    return memoryContext
  }).finally(() => { pendingContext = null })
  return pendingContext
}

const normaliseArea = (value?: string | null) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[’']/g, '')
  .replace(/\bst\.?\s+/g, 'saint ')
  .replace(/[^a-z0-9]+/gi, ' ')
  .trim()
  .toLowerCase()

export async function getPropertyLifeOverview(reference?: string | null, area?: string | null, localityId?: number | null) {
  if (!reference) return null
  try {
    const data = await fetchNexusContext()
    const requestedReference = reference.replace(/^#/, '')
    const exact = data.properties.find(item => item.id === requestedReference)
    if (exact) return buildLifeOverview(exact, data.places, { requestedReference, sourceBasis: 'property' })

    const areaKey = normaliseArea(area)
    if (!areaKey) return null
    const requestedTokens = areaKey.split(' ').filter(token => token.length > 1 && token !== 'ta')
    const locality = data.properties
      .map(item => ({ item, key: normaliseArea(item.areaLabel) }))
      .filter(candidate => candidate.key === areaKey || requestedTokens.every(token => candidate.key.split(' ').includes(token)))
      .sort((a, b) => Math.abs(a.key.length - areaKey.length) - Math.abs(b.key.length - areaKey.length))[0]?.item
    if (locality) return buildLifeOverview(locality, data.places, { requestedReference, sourceBasis: 'locality' })

    // New website properties can arrive before the periodic Nexus inventory
    // export. The canonical public locality binding is available immediately,
    // so build an honestly labelled locality model instead of hiding the whole
    // Smart Area Brief until the next export catches up.
    const bindings = (placeBindings as { bindings?: Array<{ argus_village_id?: number; argus_label?: string; public_coordinates?: number[] | null }> }).bindings || []
    const binding = bindings.find(item => localityId != null && item.argus_village_id === localityId)
      || bindings
        .map(item => ({ item, key: normaliseArea(item.argus_label) }))
        .filter(candidate => candidate.key === areaKey || requestedTokens.every(token => candidate.key.split(' ').includes(token)))
        .sort((a, b) => Math.abs(a.key.length - areaKey.length) - Math.abs(b.key.length - areaKey.length))[0]?.item
    if (binding?.public_coordinates?.length === 2) {
      return buildLifeOverview({
        id: requestedReference,
        coordinates: [Number(binding.public_coordinates[0]), Number(binding.public_coordinates[1])],
        locationDisclosure: 'locality',
        areaLabel: binding.argus_label || area || 'Malta',
      }, data.places, { requestedReference, sourceBasis: 'locality' })
    }
    return null
  } catch {
    return null
  }
}

export function contextForPriority(property: NexusInventoryProperty, places: NexusPlace[], priority: SmartPriority) {
  const overview = buildLifeOverview(property, places)
  const categoryKey = priority === 'weekly-shop' ? 'groceries' : priority === 'swimming' ? 'coast' : priority === 'health' ? 'health' : 'movement'
  const category = overview.categories.find(item => item.key === categoryKey)
  const place = category?.places.find(item => priority !== 'weekly-shop' || item.role === 'weekly-shop') || category?.places[0]
  return place ? { name: place.name, distanceKm: place.distanceKm, label: category?.label || priority } : null
}
