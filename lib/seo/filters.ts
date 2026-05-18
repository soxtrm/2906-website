// Category slug parser + property filtering for SEO category/location pages.

import type { CategoryDescriptor } from './content'
import { CATEGORY_DESCRIPTORS } from './content'
import { normalizeLocationKey } from './slug'

export interface SeoProperty {
  id: string
  slug: string
  title?: string
  price?: number | string | null
  priceAfter?: string | null
  priceType?: string | null
  bedrooms?: number | null
  bathrooms?: number | null
  area?: number | null
  size?: number | null
  propertyType?: string | null
  category?: string | null
  region?: string | null
  location?: string | null
  status?: string | null
  images?: string[]
  summary?: string | null
  description?: string | null
  fullDescription?: string | null
  features?: string[]
  availableFrom?: string | null
  propertyReference?: string | null
  featured?: boolean
}

export type SlugMatch =
  | { kind: 'category'; descriptor: CategoryDescriptor }
  | { kind: 'location'; locationName: string }
  | { kind: 'none' }

export function isActive(p: SeoProperty): boolean {
  const s = (p.status || '').toLowerCase()
  return s === 'available' || s === 'viewings'
}

export function isRental(p: SeoProperty): boolean {
  const cat = (p.category || '').toLowerCase()
  return cat === 'letting' || cat === 'aesthetics'
}

export function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0
  if (typeof value === 'number') return value
  const parsed = parseFloat(String(value))
  return Number.isFinite(parsed) ? parsed : 0
}

export function findCategoryDescriptor(slug: string): CategoryDescriptor | null {
  if (!slug) return null
  const lower = slug.toLowerCase()
  return CATEGORY_DESCRIPTORS.find(d => d.slug === lower || d.aliases?.includes(lower)) ?? null
}

export function applyCategoryFilter(
  properties: SeoProperty[],
  descriptor: CategoryDescriptor,
): SeoProperty[] {
  return properties.filter(p => descriptor.matches(p))
}

export function uniqueActiveLocations(properties: SeoProperty[]): { name: string; slug: string; count: number }[] {
  const map = new Map<string, { name: string; slug: string; count: number }>()
  for (const p of properties) {
    if (!isActive(p) || !isRental(p)) continue
    const name = (p.location || '').trim()
    if (!name) continue
    const slug = normalizeLocationKey(name)
    if (!slug) continue
    const existing = map.get(slug)
    if (existing) {
      existing.count += 1
    } else {
      map.set(slug, { name, slug, count: 1 })
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count)
}

export function matchSlugToLocation(
  slug: string,
  properties: SeoProperty[],
): { name: string; matches: SeoProperty[] } | null {
  if (!slug) return null
  const target = slug.toLowerCase()
  const buckets = new Map<string, SeoProperty[]>()
  for (const p of properties) {
    const key = normalizeLocationKey(p.location || '')
    if (!key) continue
    const arr = buckets.get(key) ?? []
    arr.push(p)
    buckets.set(key, arr)
  }
  const direct = buckets.get(target)
  if (direct && direct.length) {
    const name = direct.find(p => p.location)?.location?.trim() || target
    return { name, matches: direct }
  }
  return null
}

export function resolveSlug(slug: string, properties: SeoProperty[]): SlugMatch {
  const category = findCategoryDescriptor(slug)
  if (category) return { kind: 'category', descriptor: category }

  const rentals = properties.filter(isRental)
  const loc = matchSlugToLocation(slug, rentals)
  if (loc) return { kind: 'location', locationName: loc.name }

  return { kind: 'none' }
}

export function activeRentalsInLocation(properties: SeoProperty[], locationName: string): SeoProperty[] {
  const target = normalizeLocationKey(locationName)
  return properties.filter(
    p => isRental(p) && isActive(p) && normalizeLocationKey(p.location || '') === target,
  )
}

export function indexabilityFor(count: number): {
  index: boolean
  robotsContent: string
} {
  if (count >= 3) return { index: true, robotsContent: 'index, follow' }
  return { index: false, robotsContent: 'noindex, follow' }
}
