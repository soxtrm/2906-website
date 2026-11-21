import { ARGUS_ORIGIN } from '@/lib/argus-origin'
import 'server-only'
import { cache } from 'react'
import { isPubliclyPlausibleProperty } from './public-property-safety'
import type { Property } from './types'

type PublicPropertyDetail = Property & {
  listingType?: string
  size?: number | null
  priceAfter?: string
  summary?: string
  fullDescription?: string
  documents?: Array<{ filename: string; url: string }>
}

// 2026-11-21: always read live. With a 60 s data cache, a property taken off the
// website (unpublished, rented, deleted) kept being served from the cache long after
// the API answered 404. React cache() keeps it to ONE API call per page view
// (generateMetadata + the page share it).
const load = cache(async (slug: string): Promise<PublicPropertyDetail | null> => {
  if (!slug || slug.length > 240 || /[\\/]/.test(slug) || slug === '.' || slug === '..') return null
  try {
    const response = await fetch(`${ARGUS_ORIGIN}/api/properties/${encodeURIComponent(slug)}`, { cache: 'no-store', signal: AbortSignal.timeout(5000) })
    if (!response.ok) return null
    const property = await response.json()
    return property?.slug === slug && isPubliclyPlausibleProperty(property) ? property : null
  } catch {
    return null
  }
})

export async function getPublicProperty(slug: string, _opts: { fresh?: boolean } = {}): Promise<PublicPropertyDetail | null> {
  return load(slug)
}
